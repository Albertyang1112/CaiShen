#!/bin/bash
# CaiShen — one-command server setup for mycaishen.ai
# Run as root on a fresh Ubuntu 24.04 droplet:
#   bash <(curl -fsSL https://raw.githubusercontent.com/Albertyang1112/CaiShen/main/deploy.sh)
set -e

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  CaiShen Deployment — mycaishen.ai"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. System packages ──────────────────────────────────────────────────
echo "▶ Installing system packages..."
apt-get update -qq
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - > /dev/null 2>&1
apt-get install -y nodejs nginx certbot python3-certbot-nginx git > /dev/null 2>&1
npm install -g pm2 > /dev/null 2>&1
echo "  ✓ Node $(node -v), nginx, certbot, pm2 installed"

# ── 2. Clone repo ───────────────────────────────────────────────────────
echo "▶ Cloning repository..."
if [ -d "/var/www/caishen" ]; then
  cd /var/www/caishen && git pull
else
  git clone https://github.com/Albertyang1112/CaiShen.git /var/www/caishen
  cd /var/www/caishen
fi
echo "  ✓ Code cloned to /var/www/caishen"

# ── 3. Write .env ───────────────────────────────────────────────────────
echo "▶ Writing .env..."
cat > /var/www/caishen/.env << 'ENVEOF'
# Plaid
PLAID_CLIENT_ID=your_plaid_client_id
PLAID_SECRET=your_plaid_secret
PLAID_ENV=production

# QuickBooks
QB_CLIENT_ID=your_qb_client_id
QB_CLIENT_SECRET=your_qb_client_secret
QB_REDIRECT_URI=https://mycaishen.ai/auth/quickbooks/callback

# Anthropic (AI Advisor)
ANTHROPIC_API_KEY=your_anthropic_key

# Security
MASTER_PASSWORD=change_me

# Database
DATABASE_URL=your_neon_database_url

# Email (2FA)
EMAIL_FROM=your_email@gmail.com
EMAIL_PASS=your_gmail_app_password

# App
PORT=3001
AUTO_SYNC_INTERVAL=5
NODE_ENV=production

# Plaid webhooks — set to https://mycaishen.ai/api/plaid/webhook once live
PLAID_WEBHOOK_URL=
ENVEOF
chmod 600 /var/www/caishen/.env
echo "  ✓ .env written"

# ── 4. Install dependencies & build frontend ────────────────────────────
echo "▶ Installing dependencies..."
cd /var/www/caishen
npm install > /dev/null 2>&1
echo "  ✓ Server dependencies installed"

echo "▶ Building React frontend (this takes ~60s)..."
cd /var/www/caishen/client
npm install > /dev/null 2>&1
npm run build 2>&1
echo "  ✓ Frontend built to client-dist/"

# ── 5. Start server with PM2 ────────────────────────────────────────────
echo "▶ Starting CaiShen server..."
cd /var/www/caishen
pm2 stop caishen 2>/dev/null || true
pm2 delete caishen 2>/dev/null || true
pm2 start server/index.js --name caishen
pm2 save
env PATH=$PATH:/usr/bin $(which pm2) startup systemd -u root --hp /root | tail -1 | bash
echo "  ✓ Server running on port 3001 (auto-restarts on reboot)"

# ── 6. Nginx config ─────────────────────────────────────────────────────
echo "▶ Configuring nginx..."
cat > /etc/nginx/sites-available/caishen << 'NGINXEOF'
server {
    listen 80;
    server_name mycaishen.ai www.mycaishen.ai;
    client_max_body_size 100M;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_buffering off;
        proxy_read_timeout 86400;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/caishen /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "  ✓ Nginx configured"

# ── 7. SSL certificate ──────────────────────────────────────────────────
echo "▶ Getting SSL certificate (requires DNS to be pointing here)..."
certbot --nginx -d mycaishen.ai -d www.mycaishen.ai \
  --non-interactive --agree-tos --email albertyang203@gmail.com \
  --redirect 2>&1
echo "  ✓ SSL certificate installed"

# ── 8. Final check ──────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ CaiShen is live at https://mycaishen.ai"
echo ""
echo "  Login: admin / hello123"
echo "  API:   https://mycaishen.ai/api/status"
echo ""
echo "  Next steps:"
echo "  - Add ANTHROPIC_API_KEY to /var/www/caishen/.env"
echo "    then: pm2 restart caishen"
echo "  - Set PLAID_WEBHOOK_URL=https://mycaishen.ai/api/plaid/webhook"
echo "    in your Plaid dashboard"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
