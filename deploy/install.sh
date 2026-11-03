#!/usr/bin/env bash
# Twelve Yards — one-time VPS setup (Ubuntu).
# Clones the game from GitHub, runs it on its own port (8090 or the next free one), and checks GitHub every minute for updates.
set -e
REPO="https://github.com/samerzayer/twelve-yards.git"
DIR=/opt/twelve-yards

echo "==> Checking tools"
command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git >/dev/null)

# The game gets its OWN private Node.js inside /opt/twelve-yards/.node.
# The server's existing Node.js (used by your other sites) is never touched.
NODE_VER=v22.11.0
ARCH=$(uname -m); case "$ARCH" in x86_64) NA=x64;; aarch64) NA=arm64;; *) NA=x64;; esac
echo "==> Getting the game"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q; else rm -rf "$DIR"; git clone -q "$REPO" "$DIR"; fi
if [ ! -x "$DIR/.node/bin/node" ]; then
  mkdir -p "$DIR/.node"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-$NA.tar.xz" | tar xJ -C "$DIR/.node" --strip-components=1
fi
NODE="$DIR/.node/bin/node"; NPM="$DIR/.node/bin/npm"
cd "$DIR" && PATH="$DIR/.node/bin:$PATH" "$NPM" install --omit=dev --no-audit --no-fund >/dev/null

# Use the first free port from 8090 up, so nothing already running is disturbed.
PORT=8090

while ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$PORT$" && ! systemctl is-active --quiet twelve-yards; do PORT=$((PORT+1)); done

echo "==> Starting the game server"
cat >/etc/systemd/system/twelve-yards.service <<EOF
[Unit]
Description=Twelve Yards game server
After=network.target
[Service]
WorkingDirectory=$DIR
Environment=PORT=$PORT
ExecStart=$NODE server.mjs
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
  PATH=/opt/twelve-yards/.node/bin:$PATH npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1
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
