#!/usr/bin/env bash
# Twelve Yards — one-time VPS setup (Ubuntu).
# Clones the game from GitHub, runs it on port 8090, and checks GitHub every minute for updates.
set -e
REPO="https://github.com/samerzayer/twelve-yards.git"
DIR=/opt/twelve-yards
PORT=8090

echo "==> Installing git and Node.js"
command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git >/dev/null)
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "==> Getting the game"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q; else rm -rf "$DIR"; git clone -q "$REPO" "$DIR"; fi
cd "$DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null

echo "==> Starting the game server"
cat >/etc/systemd/system/twelve-yards.service <<EOF
[Unit]
Description=Twelve Yards game server
After=network.target
[Service]
WorkingDirectory=$DIR
Environment=PORT=$PORT
ExecStart=$(command -v node) server.mjs
Restart=always
[Install]
WantedBy=multi-user.target
EOF

# Auto-update: every minute, pull from GitHub; restart only when something changed.
cat >/usr/local/bin/twelve-yards-update <<'EOF'
#!/usr/bin/env bash
cd /opt/twelve-yards || exit 0
git fetch -q origin || exit 0
if [ "$(git rev-parse HEAD)" != "$(git rev-parse @{u})" ]; then
  git reset -q --hard @{u}
  npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1
  systemctl restart twelve-yards
  echo "updated to $(git rev-parse --short HEAD)"
fi
EOF
chmod +x /usr/local/bin/twelve-yards-update
cat >/etc/systemd/system/twelve-yards-update.service <<EOF
[Unit]
Description=Twelve Yards auto-update
[Service]
Type=oneshot
ExecStart=/usr/local/bin/twelve-yards-update
EOF
cat >/etc/systemd/system/twelve-yards-update.timer <<EOF
[Unit]
Description=Check GitHub for Twelve Yards updates every minute
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now twelve-yards twelve-yards-update.timer >/dev/null 2>&1
systemctl restart twelve-yards
command -v ufw >/dev/null && ufw status | grep -q active && ufw allow $PORT/tcp >/dev/null || true
sleep 2
if curl -fs "http://127.0.0.1:$PORT/" >/dev/null; then
  IP=$(curl -fs4 https://api.ipify.org || hostname -I | awk '{print $1}')
  echo ""; echo "✅ Twelve Yards is live: http://$IP:$PORT  (auto-updates from GitHub every minute)"
else
  echo "❌ Server did not start. Logs:"; journalctl -u twelve-yards -n 30 --no-pager
fi
