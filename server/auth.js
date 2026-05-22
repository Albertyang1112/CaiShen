const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const { query }  = require('./db');

const JWT_SECRET   = process.env.JWT_SECRET || 'caishen-local-jwt-secret-change-me';
const TOKEN_EXPIRY = '30d';

// In-memory 2FA store: tempId → { userId, deviceId, code, expiresAt }
const pending2FA = new Map();

function generate6CharCode() {
  return crypto.randomInt(100000, 999999).toString();
}

function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}*@${domain}`;
  return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
}

// Map a DB row (snake_case) to the in-memory user shape (camelCase)
function mapUser(row) {
  if (!row) return null;
  return {
    id:             row.id,
    username:       row.username,
    email:          row.email || '',
    passwordHash:   row.password_hash,
    role:           row.role,
    displayName:    row.display_name,
    trustedDevices: row.trusted_devices || [],
    createdAt:      row.created_at,
  };
}

function safeUser(u) {
  return { id: u.id, username: u.username, email: u.email || '', role: u.role, displayName: u.displayName, createdAt: u.createdAt };
}

function issueToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, displayName: user.displayName },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

async function sendVerificationEmail(email, code, displayName) {
  if (!process.env.EMAIL_FROM || !process.env.EMAIL_PASS) {
    console.log(`[2FA] Email not configured — code for ${email}: ${code}`);
    return;
  }
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_SMTP || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: false,
    auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_PASS }
  });
  await transporter.sendMail({
    from: `"CaiShen" <${process.env.EMAIL_FROM}>`,
    to: email,
    subject: 'Your CaiShen login code',
    html: `
      <div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:24px">
        <h2 style="color:#1C2B3A;margin:0 0 8px">CaiShen Login Verification</h2>
        <p style="color:#374151">Hi ${displayName},</p>
        <p style="color:#374151">A sign-in was attempted from a new device. Enter this code to continue:</p>
        <div style="font-size:36px;font-weight:700;letter-spacing:10px;padding:20px;background:#EBF4FC;border-radius:10px;text-align:center;color:#1C2B3A;margin:20px 0">${code}</div>
        <p style="color:#6B7280;font-size:13px">This code expires in 10 minutes. If you didn't attempt to sign in, you can ignore this email — your account is safe.</p>
      </div>
    `
  });
}

// Called once at startup. Migrates users.json → DB if DB is empty, else seeds admin.
async function ensureDefaultAdmin(readData) {
  try {
    const { rows } = await query('SELECT COUNT(*) FROM users');
    if (parseInt(rows[0].count) > 0) return; // DB already populated

    // Try to migrate from users.json (existing local users)
    if (readData) {
      const oldUsers = readData('users.json') || [];
      if (oldUsers.length > 0) {
        for (const u of oldUsers) {
          await query(
            `INSERT INTO users (id, username, email, password_hash, role, display_name, trusted_devices)
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
            [u.id, u.username, u.email || null, u.passwordHash, u.role, u.displayName || u.username, JSON.stringify(u.trustedDevices || [])]
          );
        }
        console.log(`✓ Migrated ${oldUsers.length} user(s) from users.json to database`);
        return;
      }
    }

    // Fresh install — seed default admin from MASTER_PASSWORD
    const pass = process.env.MASTER_PASSWORD;
    if (!pass || pass === 'choose_a_strong_password_here') {
      console.log('⚠ Set MASTER_PASSWORD in .env before using the login system');
      return;
    }
    await query(
      `INSERT INTO users (id, username, email, password_hash, role, display_name, trusted_devices)
       VALUES ($1, $2, $3, $4, $5, $6, '[]')`,
      ['1', 'admin', process.env.ADMIN_EMAIL || null, bcrypt.hashSync(pass, 10), 'admin', 'Albert Yang']
    );
    console.log('✓ Default admin user created in database');
  } catch (e) {
    console.error('[DB] ensureDefaultAdmin error:', e.message);
  }
}

// ── JWT middleware (exported for use in index.js) ──────────────────────
function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── Router factory ─────────────────────────────────────────────────────
module.exports = function() {
  const router = express.Router();

  // ── POST /api/auth/signup ───────────────────────────────────────────
  router.post('/signup', async (req, res) => {
    try {
      const { username, password, email, displayName } = req.body;
      if (!username || !password || !email) return res.status(400).json({ error: 'Username, password, and email are required' });
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });

      const { rows: existU } = await query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
      if (existU.length) return res.status(400).json({ error: 'Username already taken' });

      const { rows: existE } = await query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (existE.length) return res.status(400).json({ error: 'Email already registered' });

      const id = Date.now().toString();
      await query(
        `INSERT INTO users (id, username, email, password_hash, role, display_name, trusted_devices)
         VALUES ($1, $2, $3, $4, 'viewer', $5, '[]')`,
        [id, username, email, bcrypt.hashSync(password, 10), displayName?.trim() || username]
      );
      console.log(`✓ New user registered: ${username} (${email})`);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/auth/login ────────────────────────────────────────────
  router.post('/login', async (req, res) => {
    try {
      const { username, password, deviceId } = req.body;
      const { rows } = await query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
      const row = rows[0];
      if (!row || !bcrypt.compareSync(password, row.password_hash)) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      const user = mapUser(row);
      const trusted = (user.trustedDevices || []).includes(deviceId);

      if (!trusted && user.email) {
        const code   = generate6CharCode();
        const tempId = crypto.randomUUID();
        // Prune expired codes
        for (const [k, v] of pending2FA.entries()) {
          if (Date.now() > v.expiresAt) pending2FA.delete(k);
        }
        pending2FA.set(tempId, { userId: user.id, deviceId: deviceId || null, code, expiresAt: Date.now() + 10 * 60 * 1000 });
        try { await sendVerificationEmail(user.email, code, user.displayName); }
        catch (e) {
          console.error('[2FA] Email send failed:', e.message);
          console.log(`[2FA] Fallback — code for ${user.username}: ${code}`);
        }
        return res.json({ needs2FA: true, tempId, maskedEmail: maskEmail(user.email) });
      }

      res.json({ token: issueToken(user), user: safeUser(user) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/auth/verify-2fa ───────────────────────────────────────
  router.post('/verify-2fa', async (req, res) => {
    try {
      const { tempId, code } = req.body;
      if (!tempId || !code) return res.status(400).json({ error: 'tempId and code required' });

      const pending = pending2FA.get(tempId);
      if (!pending) return res.status(400).json({ error: 'Code expired or invalid. Please sign in again.' });
      if (Date.now() > pending.expiresAt) { pending2FA.delete(tempId); return res.status(400).json({ error: 'Code expired. Please sign in again.' }); }
      if (pending.code !== code.trim()) return res.status(400).json({ error: 'Incorrect code' });
      pending2FA.delete(tempId);

      const { rows } = await query('SELECT * FROM users WHERE id = $1', [pending.userId]);
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      const user = mapUser(rows[0]);

      if (pending.deviceId && !user.trustedDevices.includes(pending.deviceId)) {
        const newDevices = [...user.trustedDevices, pending.deviceId];
        await query('UPDATE users SET trusted_devices = $1 WHERE id = $2', [JSON.stringify(newDevices), user.id]);
        user.trustedDevices = newDevices;
      }

      res.json({ token: issueToken(user), user: safeUser(user) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/auth/me ────────────────────────────────────────────────
  router.get('/me', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      res.json(safeUser(mapUser(rows[0])));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/auth/users (admin) ─────────────────────────────────────
  router.get('/users', verifyToken, requireAdmin, async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM users ORDER BY created_at');
      res.json(rows.map(r => safeUser(mapUser(r))));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/auth/users (admin creates user) ───────────────────────
  router.post('/users', verifyToken, requireAdmin, async (req, res) => {
    try {
      const { username, password, role, displayName, email } = req.body;
      if (!username || !password || !['admin', 'viewer'].includes(role)) {
        return res.status(400).json({ error: 'username, password, and role (admin|viewer) required' });
      }
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

      const { rows: existing } = await query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
      if (existing.length) return res.status(400).json({ error: 'Username already exists' });

      const id = Date.now().toString();
      await query(
        `INSERT INTO users (id, username, email, password_hash, role, display_name, trusted_devices)
         VALUES ($1, $2, $3, $4, $5, $6, '[]')`,
        [id, username, email || null, bcrypt.hashSync(password, 10), role, displayName || username]
      );
      const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
      res.json(safeUser(mapUser(rows[0])));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/auth/users/:id (admin) ─────────────────────────────
  router.delete('/users/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
      const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      if (rows[0].role === 'admin') {
        const { rows: admins } = await query(`SELECT COUNT(*) FROM users WHERE role = 'admin'`);
        if (parseInt(admins[0].count) <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
      }
      await query('DELETE FROM users WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── PATCH /api/auth/users/:id/password ─────────────────────────────
  router.patch('/users/:id/password', verifyToken, async (req, res) => {
    try {
      if (req.user.role !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
      const { newPassword } = req.body;
      if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
      const { rowCount } = await query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(newPassword, 10), req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'Not found' });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/auth/devices/:deviceId ─────────────────────────────
  router.delete('/devices/:deviceId', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT trusted_devices FROM users WHERE id = $1', [req.user.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      const newDevices = (rows[0].trusted_devices || []).filter(d => d !== req.params.deviceId);
      await query('UPDATE users SET trusted_devices = $1 WHERE id = $2', [JSON.stringify(newDevices), req.user.id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { router, verifyToken, requireAdmin };
};

module.exports.ensureDefaultAdmin = ensureDefaultAdmin;
