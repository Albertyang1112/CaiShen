const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const speakeasy  = require('speakeasy');
const QRCode     = require('qrcode');
const { query }  = require('./db');

const JWT_SECRET   = process.env.JWT_SECRET || 'caishen-local-jwt-secret-change-me';
const TOKEN_EXPIRY = '30d';

// In-memory 2FA store: tempId → { userId, deviceId, method, code?, expiresAt, availableMethods }
const pending2FA = new Map();

function twilioConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER &&
    process.env.TWILIO_ACCOUNT_SID !== 'paste_your_sid_here');
}

function generate6DigitCode() {
  return crypto.randomInt(100000, 999999).toString();
}

function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}*@${domain}`;
  return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
}

function maskPhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  return `***-***-${digits.slice(-4)}`;
}

function mapUser(row) {
  if (!row) return null;
  return {
    id:             row.id,
    username:       row.username,
    email:          row.email || '',
    phone:          row.phone || '',
    passwordHash:   row.password_hash,
    role:           row.role,
    displayName:    row.display_name,
    trustedDevices: row.trusted_devices || [],
    createdAt:      row.created_at,
    twoFaMethod:    row.two_fa_method || 'email',
    totpSecret:     row.totp_secret || null,
  };
}

function safeUser(u) {
  return { id: u.id, username: u.username, email: u.email || '', phone: u.phone || '', role: u.role, displayName: u.displayName, createdAt: u.createdAt };
}

function issueToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, displayName: user.displayName },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function validatePassword(password) {
  if (!password || password.length < 8)        return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(password))                 return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(password))                 return 'Password must contain at least one lowercase letter';
  if (!/[0-9]/.test(password))                 return 'Password must contain at least one number';
  if (!/[^A-Za-z0-9]/.test(password))          return 'Password must contain at least one special character (!@#$% etc.)';
  return null;
}

// Returns the set of 2FA methods this user has configured
function getAvailableMethods(user) {
  const methods = [];
  if (user.email) methods.push('email');
  if (user.totpSecret) methods.push('totp');
  return methods.length ? methods : ['email'];
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
        <p style="color:#6B7280;font-size:13px">This code expires in 10 minutes. If you didn't attempt to sign in, you can ignore this email.</p>
      </div>
    `
  });
}

async function sendSMS(phone, code) {
  if (!twilioConfigured()) {
    console.log(`[2FA] Twilio not configured — SMS code for ${phone}: ${code}`);
    return;
  }
  const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await twilio.messages.create({
    body: `Your CaiShen verification code is: ${code}. Expires in 10 minutes.`,
    from: process.env.TWILIO_FROM_NUMBER,
    to: phone,
  });
}

// Called once at startup
async function ensureDefaultAdmin(readData) {
  try {
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_method TEXT NOT NULL DEFAULT 'email'`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone) WHERE phone IS NOT NULL`);

    const { rows } = await query('SELECT COUNT(*) FROM users');
    if (parseInt(rows[0].count) > 0) return;

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

// ── JWT middleware ─────────────────────────────────────────────────────
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
      const { username, password, email, displayName, phone } = req.body;
      if (!username || !password || !email) return res.status(400).json({ error: 'Username, password, and email are required' });
      const pwErr = validatePassword(password);
      if (pwErr) return res.status(400).json({ error: pwErr });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });

      // Phone validation (if provided)
      let normalizedPhone = null;
      if (phone && phone.trim()) {
        normalizedPhone = phone.trim();
        if (!/^\+[1-9]\d{6,14}$/.test(normalizedPhone)) {
          return res.status(400).json({ error: 'Invalid phone number format' });
        }
        const { rows: existP } = await query('SELECT id FROM users WHERE phone = $1', [normalizedPhone]);
        if (existP.length) return res.status(400).json({ error: 'Phone number already registered to another account' });
      }

      const { rows: existU } = await query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
      if (existU.length) return res.status(400).json({ error: 'Username already taken' });

      const { rows: existE } = await query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (existE.length) return res.status(400).json({ error: 'Email already registered' });

      const id = Date.now().toString();
      await query(
        `INSERT INTO users (id, username, email, phone, password_hash, role, display_name, trusted_devices)
         VALUES ($1, $2, $3, $4, $5, 'viewer', $6, '[]')`,
        [id, username, email, normalizedPhone, bcrypt.hashSync(password, 10), displayName?.trim() || username]
      );
      console.log(`✓ New user registered: ${username} (${email})${normalizedPhone ? ` phone: ${normalizedPhone}` : ''}`);
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

      if (!trusted) {
        const availableMethods = getAvailableMethods(user);
        const tempId = crypto.randomUUID();
        for (const [k, v] of pending2FA.entries()) {
          if (Date.now() > v.expiresAt) pending2FA.delete(k);
        }
        pending2FA.set(tempId, {
          userId: user.id, deviceId: deviceId || null,
          method: null, code: null,
          availableMethods,
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
        return res.json({
          needs2FA: true, tempId, availableMethods,
          maskedEmail: maskEmail(user.email),
          maskedPhone: maskPhone(user.phone),
        });
      }

      res.json({ token: issueToken(user), user: safeUser(user) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/auth/2fa/request — user picks a method, server sends code ──
  router.post('/2fa/request', async (req, res) => {
    try {
      const { tempId, method } = req.body;
      const pending = pending2FA.get(tempId);
      if (!pending) return res.status(400).json({ error: 'Session expired. Please sign in again.' });
      if (Date.now() > pending.expiresAt) { pending2FA.delete(tempId); return res.status(400).json({ error: 'Session expired.' }); }
      if (!pending.availableMethods.includes(method)) return res.status(400).json({ error: 'Method not available for this account.' });

      const { rows } = await query('SELECT * FROM users WHERE id = $1', [pending.userId]);
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      const user = mapUser(rows[0]);

      if (method === 'totp') {
        pending.method = 'totp';
        pending2FA.set(tempId, pending);
        return res.json({ sent: true, method: 'totp' });
      }

      const code = generate6DigitCode();
      pending.method = method;
      pending.code = code;
      pending2FA.set(tempId, pending);

      if (method === 'email') {
        try { await sendVerificationEmail(user.email, code, user.displayName || user.username); }
        catch (e) { console.error('[2FA] Email send failed:', e.message); console.log(`[2FA] Fallback code: ${code}`); }
        return res.json({ sent: true, method: 'email', maskedEmail: maskEmail(user.email) });
      }

      if (method === 'sms') {
        try { await sendSMS(user.phone, code); }
        catch (e) { console.error('[2FA] SMS send failed:', e.message); console.log(`[2FA] Fallback SMS code: ${code}`); }
        return res.json({ sent: true, method: 'sms', maskedPhone: maskPhone(user.phone) });
      }

      res.status(400).json({ error: 'Unknown method' });
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
      if (!pending.method) return res.status(400).json({ error: 'No method selected. Please choose a verification method.' });

      if (pending.method === 'totp') {
        const { rows: uRows } = await query('SELECT totp_secret FROM users WHERE id = $1', [pending.userId]);
        const secret = uRows[0]?.totp_secret;
        if (!secret || !speakeasy.totp.verify({ secret, encoding: 'base32', token: code.trim(), window: 1 })) {
          return res.status(400).json({ error: 'Incorrect authenticator code' });
        }
      } else {
        if (pending.code !== code.trim()) return res.status(400).json({ error: 'Incorrect code' });
      }
      pending2FA.delete(tempId);

      const { rows } = await query('SELECT * FROM users WHERE id = $1', [pending.userId]);
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      const user = mapUser(rows[0]);

      if (pending.deviceId && !user.trustedDevices.includes(pending.deviceId)) {
        const newDevices = [...user.trustedDevices, pending.deviceId];
        await query('UPDATE users SET trusted_devices = $1 WHERE id = $2', [JSON.stringify(newDevices), user.id]);
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
      const pwErr2 = validatePassword(password);
      if (pwErr2) return res.status(400).json({ error: pwErr2 });

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
      const pwErr3 = validatePassword(newPassword || '');
      if (pwErr3) return res.status(400).json({ error: pwErr3 });
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

  // ── GET /api/auth/2fa/status ────────────────────────────────────────
  router.get('/2fa/status', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT two_fa_method, totp_secret, phone FROM users WHERE id = $1', [req.user.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      res.json({
        method: rows[0].two_fa_method || 'email',
        totpConfigured: !!rows[0].totp_secret,
        phoneConfigured: !!rows[0].phone,
        smsAvailable: twilioConfigured(),
        maskedPhone: maskPhone(rows[0].phone),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/auth/2fa/setup-totp ───────────────────────────────────
  router.post('/2fa/setup-totp', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT username FROM users WHERE id = $1', [req.user.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      const secret = speakeasy.generateSecret({ length: 20 }).base32;
      const otpauth = speakeasy.otpauthURL({ secret, label: rows[0].username, issuer: 'CaiShen', encoding: 'base32' });
      const qrDataUrl = await QRCode.toDataURL(otpauth);
      await query('UPDATE users SET totp_secret = $1 WHERE id = $2', [secret, req.user.id]);
      res.json({ secret, qrDataUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/auth/2fa/confirm-totp ─────────────────────────────────
  router.post('/2fa/confirm-totp', verifyToken, async (req, res) => {
    try {
      const { code } = req.body;
      const { rows } = await query('SELECT totp_secret FROM users WHERE id = $1', [req.user.id]);
      const secret = rows[0]?.totp_secret;
      if (!secret) return res.status(400).json({ error: 'No TOTP secret found. Start setup again.' });
      if (!speakeasy.totp.verify({ secret, encoding: 'base32', token: code?.trim(), window: 1 })) {
        return res.status(400).json({ error: 'Incorrect code — make sure your authenticator app is synced' });
      }
      await query(`UPDATE users SET two_fa_method = 'totp' WHERE id = $1`, [req.user.id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/auth/2fa/setup-phone — save phone number ──────────────
  router.post('/2fa/setup-phone', verifyToken, async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ error: 'Phone number required' });
      const normalized = phone.trim();
      if (!/^\+[1-9]\d{6,14}$/.test(normalized)) return res.status(400).json({ error: 'Invalid phone number' });
      const { rows: existing } = await query('SELECT id FROM users WHERE phone = $1 AND id != $2', [normalized, req.user.id]);
      if (existing.length) return res.status(400).json({ error: 'Phone number already registered to another account' });
      await query('UPDATE users SET phone = $1 WHERE id = $2', [normalized, req.user.id]);
      res.json({ success: true, maskedPhone: maskPhone(normalized) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/auth/2fa/set-email ────────────────────────────────────
  router.post('/2fa/set-email', verifyToken, async (req, res) => {
    try {
      await query(`UPDATE users SET two_fa_method = 'email', totp_secret = NULL WHERE id = $1`, [req.user.id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { router, verifyToken, requireAdmin };
};

module.exports.ensureDefaultAdmin = ensureDefaultAdmin;
