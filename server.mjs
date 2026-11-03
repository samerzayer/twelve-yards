// Twelve Yards game server: serves the static game and runs 1v1 rooms over WebSockets at /ws/<room>.
// Same wire protocol as before: in {type:join|action|reset}, out {type:state|error}.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import * as logic from './logic.js';

const PORT = +process.env.PORT || 8080;
const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.json': 'application/json' };
const META = logic.meta;
const GZ = new Map(); // gzipped copies of static files, built on first request
const rooms = new Map(); // name -> {game:{status,seats,state,result}, conns: Map<ws, playerId>, touched}

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' || !extname(p)) p = '/index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    let body = await readFile(file);
    // WhatsApp link previews need a full image URL, so fill in this server's address
    const host = String(req.headers.host || '');
    if (p === '/index.html' && /^[\w.:-]+$/.test(host)) body = Buffer.from(body.toString().replace(/content="\/game\//g, `content="http://${host}/game/`));
    const type = TYPES[extname(file)] || 'application/octet-stream', headers = { 'content-type': type, 'cache-control': p.endsWith('.html') ? 'no-cache' : 'public, max-age=86400', vary: 'accept-encoding' };
    // gzip text files (the game page and the PixiJS library shrink to about a quarter)
    if (/text|javascript|json/.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      let z = p === '/index.html' ? null : GZ.get(file);
      if (!z) { z = gzipSync(body, { level: 9 }); if (p !== '/index.html') GZ.set(file, z); }
      headers['content-encoding'] = 'gzip'; body = z;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const m = /^\/ws\/([A-Za-z0-9_-]{1,64})$/.exec(new URL(req.url, 'http://x').pathname);
  if (!m) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, m[1]));
});

function roomOf(name) {
  let r = rooms.get(name);
  if (!r) { r = { game: { status: 'waiting', seats: [], state: null, result: null }, conns: new Map(), touched: Date.now() }; rooms.set(name, r); }
  return r;
}
function broadcast(r) {
  const connected = r.conns.size;
  for (const [ws, pid] of r.conns) {
    if (ws.readyState !== 1) continue;
    ws.send(JSON.stringify({ type: 'state', status: r.game.status, seats: r.game.seats, you: pid, connected,
      view: r.game.state ? logic.viewFor(r.game.state, pid) : null, result: r.game.result, meta: META }));
  }
}
function attach(ws, name) {
  const r = roomOf(name);
  const err = (e) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'error', error: e }));
  ws.on('message', (raw) => {
    const s = raw.toString();
    if (s === '__ping') { ws.send('__pong'); return; }
    let msg; try { msg = JSON.parse(s); } catch { return err('bad json'); }
    r.touched = Date.now();
    const g = r.game;
    try {
      if (msg.type === 'join') {
        const pid = String(msg.playerId || '').slice(0, 64); if (!pid) return err('bad player');
        r.conns.set(ws, pid);
        if (!g.seats.includes(pid) && g.seats.length < META.maxPlayers) g.seats.push(pid);
        if (g.status === 'waiting' && g.seats.length >= META.minPlayers) { g.state = logic.setup(g.seats); g.status = 'playing'; }
        return broadcast(r);
      }
      const pid = r.conns.get(ws); if (!pid) return err('join first');
      if (msg.type === 'action') {
        if (g.status !== 'playing') return err('game is not in progress');
        if (!g.seats.includes(pid)) return err('spectators cannot act');
        const v = logic.validateAction(g.state, pid, msg.action);
        if (!v.ok) return err(v.error || 'invalid action');
        g.state = logic.applyAction(g.state, pid, msg.action);
        const end = logic.isGameOver(g.state);
        if (end.over) { g.status = 'over'; g.result = end; }
        return broadcast(r);
      }
      if (msg.type === 'reset') {
        if (!g.seats.includes(pid)) return err('spectators cannot reset');
        const names = g.state ? g.state.names : {}, teams = g.state ? g.state.teams : {};
        const enough = g.seats.length >= META.minPlayers;
        g.state = enough ? { ...logic.setup(g.seats), names, teams } : null;
        g.status = enough ? 'playing' : 'waiting'; g.result = null;
        return broadcast(r);
      }
    } catch (e) { console.error(e); err('server error'); }
  });
  ws.on('close', () => { r.conns.delete(ws); broadcast(r); });
}
// forget rooms idle for 6 hours
setInterval(() => { const cut = Date.now() - 6 * 3600e3; for (const [k, r] of rooms) if (r.conns.size === 0 && r.touched < cut) rooms.delete(k); }, 600e3);
server.listen(PORT, () => console.log('Twelve Yards on :' + PORT));
