// Twelve Yards game server: serves the static game and runs 1v1 rooms over WebSockets at /ws/<room>.
// In: {type: join|hello|ready|leave|action|reset|rtc}. Out: {type: state|rtc|error}.
// A room: waiting (1 player) -> lobby (2 players, waiting for both to be ready) -> playing -> over (rematch -> playing).
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
const rooms = new Map(); // name -> {game, conns: Map<ws, playerId>, touched}

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

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }); // room for voice-chat setup messages
server.on('upgrade', (req, socket, head) => {
  const m = /^\/ws\/([A-Za-z0-9_-]{1,64})$/.exec(new URL(req.url, 'http://x').pathname);
  if (!m) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, m[1]));
});

const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 12);
const cleanTeam = (t) => (/^[A-Z]{3}$/.test(t || '') ? t : '');
function roomOf(name) {
  let r = rooms.get(name);
  if (!r) { r = { game: { status: 'waiting', seats: [], ready: new Set(), info: {}, gone: {}, left: null, state: null, result: null }, conns: new Map(), touched: Date.now() }; rooms.set(name, r); }
  return r;
}
const online = (r) => new Set(r.conns.values());
function lobbyStatus(g) { if (g.status === 'playing' || g.status === 'over') return; g.status = g.seats.length >= META.minPlayers ? 'lobby' : 'waiting'; if (g.status === 'waiting') g.ready.clear(); }
function startMatch(g) {
  const names = {}, teams = {};
  for (const id of g.seats) { names[id] = g.info[id]?.name || 'Player'; if (g.info[id]?.team) teams[id] = g.info[id].team; }
  g.state = { ...logic.setup(g.seats), names, teams }; g.status = 'playing'; g.result = null; g.left = null;
}
function broadcast(r) {
  const g = r.game, on = online(r);
  const players = g.seats.map((id) => ({ id, name: g.info[id]?.name || '', team: g.info[id]?.team || '', ready: g.ready.has(id), online: on.has(id) }));
  for (const [ws, pid] of r.conns) {
    if (ws.readyState !== 1) continue;
    ws.send(JSON.stringify({ type: 'state', status: g.status, seats: g.seats, you: pid, connected: on.size, players, left: g.left,
      view: g.state ? logic.viewFor(g.state, pid) : null, result: g.result, meta: META }));
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
        for (const [w, p] of r.conns) if (p === pid && w !== ws) { r.conns.delete(w); try { w.terminate(); } catch {} } // same player came back on a new connection
        r.conns.set(ws, pid); delete g.gone[pid];
        if (!g.seats.includes(pid) && g.seats.length < META.maxPlayers) g.seats.push(pid);
        if (g.seats.includes(pid)) {
          const nm = cleanName(msg.name), tm = cleanTeam(msg.team);
          g.info[pid] = { name: nm || g.info[pid]?.name || 'Player', team: tm || g.info[pid]?.team || '' };
          if (g.state) { g.state.names = { ...g.state.names, [pid]: g.info[pid].name }; if (tm) g.state.teams = { ...(g.state.teams || {}), [pid]: tm }; }
        }
        lobbyStatus(g);
        return broadcast(r);
      }
      const pid = r.conns.get(ws); if (!pid) return err('join first');
      const seated = g.seats.includes(pid);
      if (msg.type === 'hello') { // name or team changed in the lobby
        if (!seated) return;
        const nm = cleanName(msg.name), tm = cleanTeam(msg.team);
        g.info[pid] = { name: nm || g.info[pid]?.name || 'Player', team: tm || g.info[pid]?.team || '' };
        if (g.state) g.state.names = { ...g.state.names, [pid]: g.info[pid].name };
        return broadcast(r);
      }
      if (msg.type === 'ready') { // both players present and looking at the game -> kick off together
        if (!seated || g.status !== 'lobby') return;
        g.ready.add(pid);
        if (g.seats.every((id) => g.ready.has(id))) startMatch(g);
        return broadcast(r);
      }
      if (msg.type === 'leave') {
        if (!seated) return;
        if (g.status === 'waiting' || g.status === 'lobby') { g.seats = g.seats.filter((x) => x !== pid); g.ready.delete(pid); delete g.info[pid]; lobbyStatus(g); }
        else g.left = pid;
        r.conns.delete(ws);
        return broadcast(r);
      }
      if (msg.type === 'rtc') { // voice chat setup: pass straight to the other player
        if (!seated) return;
        const out = JSON.stringify({ type: 'rtc', from: pid, data: msg.data });
        for (const [w, p] of r.conns) if (p !== pid && w.readyState === 1) w.send(out);
        return;
      }
      if (msg.type === 'action') {
        if (g.status !== 'playing') return err('game is not in progress');
        if (!seated) return err('spectators cannot act');
        const v = logic.validateAction(g.state, pid, msg.action);
        if (!v.ok) return err(v.error || 'invalid action');
        g.state = logic.applyAction(g.state, pid, msg.action);
        const end = logic.isGameOver(g.state);
        if (end.over) { g.status = 'over'; g.result = end; }
        return broadcast(r);
      }
      if (msg.type === 'reset') { // rematch: both are already here, start straight away
        if (!seated) return err('spectators cannot reset');
        if (g.seats.length >= META.minPlayers) startMatch(g); else { g.state = null; g.result = null; g.status = 'waiting'; }
        return broadcast(r);
      }
    } catch (e) { console.error(e); err('server error'); }
  });
  ws.on('close', () => { const pid = r.conns.get(ws); r.conns.delete(ws); if (pid && !online(r).has(pid)) r.game.gone[pid] = Date.now(); broadcast(r); });
}
// free a lobby seat when its player has been gone for 3 minutes; forget rooms idle for 6 hours
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of rooms) {
    const g = r.game;
    if (g.status === 'waiting' || g.status === 'lobby') {
      let changed = false;
      for (const [pid, t] of Object.entries(g.gone)) if (now - t > 180e3) { g.seats = g.seats.filter((x) => x !== pid); g.ready.delete(pid); delete g.info[pid]; delete g.gone[pid]; changed = true; }
      if (changed) { lobbyStatus(g); broadcast(r); }
    }
    if (r.conns.size === 0 && r.touched < now - 6 * 3600e3) rooms.delete(k);
  }
}, 30e3);
server.listen(PORT, () => console.log('Twelve Yards on :' + PORT));
