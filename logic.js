/**
 * Twelve Yards — 1v1 penalty shootout. Server-authoritative rules.
 *
 * Each kick k: the shooter is players[k % 2]. Both players lock in secretly
 * (shooter: zone + strike error; keeper: dive zone). When both are in, the
 * kick resolves here with a seeded roll and the result is revealed to both.
 * Pending choices are never sent to the other player (see viewFor).
 */

export const meta = { game: "Twelve Yards", minPlayers: 2, maxPlayers: 2 };

function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function mix(a, b) {
  let h = (a ^ Math.imul(b >>> 0, 2654435761)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
function rand(seed, i) { return mix(seed, i + 1) / 4294967296; }

// Strike error allowed before the shot goes off target (per zone 0-5: top L,C,R, low L,C,R)
function thr(z) { const c = z % 3, r = (z / 3) | 0; return r === 0 ? (c === 1 ? 0.55 : 0.4) : (c === 1 ? 0.85 : 0.6); }

function saveChance(sz, kz, e) {
  const sc = sz % 3, sr = (sz / 3) | 0;
  let p = 0;
  if (kz < 0) p = sc === 1 ? (sr === 1 ? 0.75 : 0.5) : 0;
  else {
    const kc = kz % 3, kr = (kz / 3) | 0;
    if (kc === sc) {
      if (kr === sr) p = sc === 1 ? 0.96 : (sr === 0 ? 0.8 : 0.92);
      else p = sc === 1 ? (kr === 0 ? 0.5 : 0.45) : (sr === 0 ? 0.4 : 0.6);
    } else if (kc === 1) p = 0.1;
    else if (sc === 1) p = sr === 1 ? 0.3 : 0.15;
  }
  if (p > 0) { if (e < 0.12) p -= 0.15; else if (e > 0.3) p += 0.12; }
  return Math.max(0, Math.min(0.98, p));
}

export function setup(players) {
  const res = {};
  for (const p of players) res[p] = [];
  return {
    players: [...players],
    names: {},
    k: 0,
    res,
    pending: { shot: null, dive: null },
    last: null,
    seed: hash(players.join("|")),
  };
}

const shooterOf = (s) => s.players[s.k % 2];
const keeperOf = (s) => s.players[(s.k + 1) % 2];

export function validateAction(state, playerId, action) {
  if (!action || typeof action !== "object") return { ok: false, error: "bad action" };
  if (!state.players.includes(playerId)) return { ok: false, error: "not a player" };
  if (action.t === "name") {
    if (typeof action.name !== "string" || action.name.length > 40) return { ok: false, error: "bad name" };
    return { ok: true };
  }
  if (action.k !== state.k) return { ok: false, error: "stale kick" };
  if (!Number.isInteger(action.n)) return { ok: false, error: "bad nonce" };
  if (action.t === "shot") {
    if (playerId !== shooterOf(state)) return { ok: false, error: "not your kick" };
    if (state.pending.shot) return { ok: false, error: "already shot" };
    if (!Number.isInteger(action.z) || action.z < 0 || action.z > 5) return { ok: false, error: "bad zone" };
    if (typeof action.e !== "number" || !(action.e >= 0 && action.e <= 1)) return { ok: false, error: "bad strike" };
    return { ok: true };
  }
  if (action.t === "dive") {
    if (playerId !== keeperOf(state)) return { ok: false, error: "you are not in goal" };
    if (state.pending.dive) return { ok: false, error: "already dived" };
    if (!Number.isInteger(action.z) || action.z < -1 || action.z > 5) return { ok: false, error: "bad dive" };
    return { ok: true };
  }
  return { ok: false, error: "unknown action" };
}

export function applyAction(state, playerId, action) {
  if (action.t === "name") {
    const name = action.name.replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 12);
    return { ...state, names: { ...state.names, [playerId]: name } };
  }
  const pending = { ...state.pending };
  if (action.t === "shot") pending.shot = { z: action.z, e: Math.round(action.e * 1000) / 1000, n: action.n | 0 };
  else pending.dive = { z: action.z, n: action.n | 0 };
  if (!pending.shot || !pending.dive) return { ...state, pending };

  // Both locked in: resolve this kick.
  const shooter = shooterOf(state);
  const seed = mix(mix(mix(state.seed, pending.shot.n), pending.dive.n), state.k + 7);
  const z = pending.shot.z, e = pending.shot.e, kz = pending.dive.z;
  const corner = z % 3 !== 1, high = z < 3;
  let outcome = "goal", kind = "";
  if (e > thr(z)) {
    outcome = "miss";
    kind = high && (!corner || rand(seed, 0) < 0.55) ? "over" : (rand(seed, 1) < 0.3 ? "post" : "wide");
  } else if (rand(seed, 2) < saveChance(z, kz, e)) outcome = "save";

  const res = { ...state.res, [shooter]: [...state.res[shooter], outcome === "goal" ? "goal" : "miss"] };
  return {
    ...state,
    res,
    k: state.k + 1,
    pending: { shot: null, dive: null },
    seed,
    last: { k: state.k, shooter, zone: z, e, kz, outcome, kind, seed },
  };
}

export function isGameOver(state) {
  const [A, B] = state.players;
  const ra = state.res[A], rb = state.res[B];
  const a = ra.length, b = rb.length;
  const ga = ra.filter((x) => x === "goal").length, gb = rb.filter((x) => x === "goal").length;
  let over = false;
  if (a <= 5 && b <= 5 && (ga + (5 - a) < gb || gb + (5 - b) < ga)) over = true;
  if (a >= 5 && b >= 5 && a === b && ga !== gb) over = true;
  if (!over) return { over: false };
  return { over: true, winner: ga > gb ? A : B };
}

export function viewFor(state, playerId) {
  const idx = state.players.indexOf(playerId);
  const opp = state.players.find((p) => p !== playerId) ?? null;
  const mineDone = state.players[state.k % 2] === playerId ? !!state.pending.shot : !!state.pending.dive;
  const oppDone = state.players[state.k % 2] === playerId ? !!state.pending.dive : !!state.pending.shot;
  return {
    you: playerId,
    youIdx: idx,
    opp,
    names: state.names,
    k: state.k,
    res: { you: state.res[playerId] ?? [], opp: opp ? state.res[opp] ?? [] : [] },
    youShoot: state.players[state.k % 2] === playerId,
    mineDone: idx >= 0 ? mineDone : false,
    oppDone: idx >= 0 ? oppDone : false,
    last: state.last,
  };
}
