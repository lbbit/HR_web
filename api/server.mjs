// server.mjs — HR_web backend: shared accounts / rankings for multi-player.
//
// Zero npm dependencies (node:http + node:crypto + node:fs only), designed to sit
// behind the static nginx image (see deploy/nginx/default.conf, location /api/).
//
// Design doc: docs/backend-design.md. Key properties:
//   * server-authoritative settlement — POST /api/result re-implements
//     storage.recordResult() exactly (including the random horse unlock), so the
//     client cannot forge scores or unlocks;
//   * idempotent results — clients attach a monotonic seq, replays are deduped
//     (offline outbox / network retries are safe);
//   * atomic persistence — debounced write-to-temp + rename, state survives
//     crashes without ever leaving a torn file;
//   * stateless sessions — HMAC-SHA256 bearer tokens, no session store;
//   * strict input validation + per-IP rate limit + 16KB body cap.
//
// The users map is kept on a null prototype for the same reason as in
// src/storage.js: a player named "constructor" must be a legal username.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ constants
const SECONDS_PER_GAME = 40; // 20 groups x 2s — same as storage.js
const TOKEN_TTL_S = 7 * 24 * 3600;
const BODY_CAP = 16 * 1024;
const SAVE_DEBOUNCE_MS = 300;
const MAX_USERS = 10000; // hard cap; a parlor game does not need more

const MSG = {
  badName: '用户名至少 2 个字符',
  nameTooLong: '用户名过长',
  badCode: '密码至少 4 位',
  codeTooLong: '密码过长',
  taken: '该用户名已被占用',
  noUser: '账号不存在，请先注册',
  wrongCode: '密码错误',
  needAuth: '请先登录',
  badToken: '登录已过期，请重新登录',
  forbidden: '需要管理员权限',
  noTarget: '用户不存在',
  protectedAdmin: '不能删除管理员',
  sameName: '与新用户名相同',
  confirmMismatch: '两次输入不一致',
  oldCodeWrong: '原密码错误',
  confirmCodeMismatch: '两次新密码不一致',
  newCodeShort: '新密码至少 4 位',
  badBody: '请求格式错误',
  tooLarge: '请求体过大',
  rateLimited: '请求太频繁，请稍后再试',
  needLogin: '请先登录',
  badScore: '非法的战绩数据',
  serverError: '服务器内部错误',
};

// ---------------------------------------------------------------- state model
function newUser(name, code) {
  // Field-for-field identical to newUser() in src/storage.js (plus the
  // server-only id, which keeps tokens valid across renames).
  const hasHorse = new Array(20).fill(false);
  const horseKey = new Array(20).fill(0);
  hasHorse[0] = hasHorse[1] = hasHorse[2] = true; // original grants 3 horses
  horseKey[0] = 0; horseKey[1] = 1; horseKey[2] = 2;
  return {
    id: crypto.randomUUID(),
    name, code,
    games: 0, seconds: 0, distance: 0,
    topE: 0, topH: 0,
    rankTopE: 0, rankTopH: 0,
    hasHorse, horseKey, totalHorse: 3,
    Port: 0,
    TopHorseE: 0, TopHorseH: 0,
    isAdmin: false,
    appliedSeqs: [], // server-only: recently applied result seqs (idempotency window)
  };
}

function normalizeRank(arr) {
  const out = [null, null, null, null, null];
  if (Array.isArray(arr)) {
    arr.filter((r) => r && typeof r.score === 'number' && typeof r.name === 'string')
      .slice(0, 5)
      .forEach((r, i) => { out[i] = { name: r.name, score: r.score }; });
  }
  return out;
}

function defaultState() {
  return {
    version: 1,
    users: Object.create(null),
    rankE: [null, null, null, null, null],
    rankH: [null, null, null, null, null],
  };
}

function sanitizeUser(u) {
  // Rebuild from known fields so a hand-edited state file cannot smuggle junk in.
  const base = newUser(String(u.name), String(u.code));
  const num = (v, min, max, dflt) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : dflt);
  base.games = num(u.games, 0, 1e9, 0);
  base.seconds = num(u.seconds, 0, 1e12, 0);
  base.distance = num(u.distance, 0, 1e12, 0);
  base.topE = num(u.topE, 0, 99999, 0);
  base.topH = num(u.topH, 0, 99999, 0);
  base.rankTopE = num(u.rankTopE, 0, 5, 0);
  base.rankTopH = num(u.rankTopH, 0, 5, 0);
  base.Port = num(u.Port, 0, 9, 0);
  base.TopHorseE = num(u.TopHorseE, 0, 19, 0);
  base.TopHorseH = num(u.TopHorseH, 0, 19, 0);
  base.isAdmin = u.isAdmin === true;
  // stable identity survives renames (tokens reference the id, not the name)
  base.id = typeof u.id === 'string' && u.id.length <= 64 ? u.id : crypto.randomUUID();
  // keep the most recent applied seqs (bounded idempotency window)
  base.appliedSeqs = Array.isArray(u.appliedSeqs)
    ? [...new Set(u.appliedSeqs.filter((v) => intBetween(v, 1, Number.MAX_SAFE_INTEGER)))].slice(-64)
    : [];
  if (Array.isArray(u.hasHorse) && u.hasHorse.length === 20) {
    base.hasHorse = u.hasHorse.map((v) => v === true);
  }
  if (Array.isArray(u.horseKey) && u.horseKey.length === 20) {
    base.horseKey = u.horseKey.map((v) => num(v, 0, 19, 0));
  }
  base.totalHorse = base.hasHorse.filter(Boolean).length;
  // repair the horseKey slots against hasHorse (defensive; also fixes legacy files)
  const owned = [];
  base.hasHorse.forEach((v, i) => { if (v) owned.push(i); });
  base.horseKey = owned.concat(new Array(20 - owned.length).fill(0)).slice(0, 20);
  base.totalHorse = owned.length;
  return base;
}

function loadState(dataPath) {
  if (!fs.existsSync(dataPath)) return null;
  try {
    const raw = fs.readFileSync(dataPath, 'utf8');
    const s = JSON.parse(raw);
    const st = defaultState();
    if (s.users && typeof s.users === 'object' && !Array.isArray(s.users)) {
      for (const [name, u] of Object.entries(s.users)) {
        if (typeof name !== 'string' || !u || typeof u !== 'object') continue;
        if (!name || name.length > 20) continue;
        if (typeof u.code !== 'string' || u.code.length < 4) continue; // corrupt entry
        st.users[name] = sanitizeUser({ ...u, name });
      }
    }
    st.rankE = normalizeRank(s.rankE);
    st.rankH = normalizeRank(s.rankH);
    return st;
  } catch (e) {
    // Never start on a torn file: park it for manual recovery and start fresh.
    const parked = dataPath + '.corrupt-' + Date.now();
    try { fs.renameSync(dataPath, parked); } catch { /* best effort */ }
    console.warn('[api] state file unreadable, parked at ' + parked + ' (' + e.message + ')');
    return null;
  }
}

function seedIfNeeded(state) {
  // Mirrors the bootstrap seed in main.js build(); the client skips it in remote mode.
  if (Object.keys(state.users).length > 0) return false;
  const admin = newUser('admin', 'admin');
  admin.isAdmin = true;
  state.users['admin'] = admin;
  state.users['lbb'] = newUser('lbb', '1234');
  return true;
}

// ------------------------------------------------------- settlement (authoritative)
function updateRanking(arr, name, score) {
  // Same insertion logic as storage.js updateRanking.
  for (let i = 0; i < 5; i++) {
    if (score > (arr[i] ? arr[i].score : 0)) {
      for (let j = 4; j > i; j--) arr[j] = arr[j - 1];
      arr[i] = { name, score };
      return i + 1;
    }
  }
  return 0;
}

function attemptUnlock(u) {
  // Same rules as storage.js; the randomness lives HERE so the client cannot forge it.
  if (u.totalHorse >= 20) return 20;
  const newHorse = crypto.randomInt(19); // 0..18
  if (u.hasHorse[newHorse]) return -1;
  u.hasHorse[newHorse] = true;
  u.horseKey[u.totalHorse] = newHorse;
  u.totalHorse++;
  if (u.totalHorse === 19) { // first 19 collected -> legendary #19
    u.hasHorse[19] = true;
    u.horseKey[19] = 19;
    u.totalHorse = 20;
    return 19;
  }
  return newHorse;
}

function applyResult(state, u, { isHard, score, horse, distance }) {
  u.games++;
  u.seconds += SECONDS_PER_GAME;
  u.distance += distance;
  let isNewRecord = false;
  if (isHard) { if (score > u.topH) { isNewRecord = true; u.topH = score; u.TopHorseH = horse; } }
  else { if (score > u.topE) { isNewRecord = true; u.topE = score; u.TopHorseE = horse; } }
  const pos = isHard ? updateRanking(state.rankH, u.name, score) : updateRanking(state.rankE, u.name, score);
  const inRank = pos > 0;
  if (inRank) {
    const cur = isHard ? u.rankTopH : u.rankTopE;
    const best = cur === 0 ? pos : Math.min(cur, pos);
    if (isHard) u.rankTopH = best; else u.rankTopE = best;
  }
  const unlocked = attemptUnlock(u);
  return { isNewRecord, inRank, rankPos: pos, unlocked, score, topNow: isHard ? u.topH : u.topE };
}

// ---------------------------------------------------------------- persistence
function makePersistence(dataPath) {
  let timer = null;
  const writeNow = () => {
    timer = null;
    const dir = path.dirname(dataPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = dataPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, dataPath); // atomic on the same filesystem
  };
  let state = null;
  const api = {
    attach(s) { state = s; },
    schedule() {
      if (timer) return;
      timer = setTimeout(writeNow, SAVE_DEBOUNCE_MS);
      // do not keep the process alive just for a pending save
      if (timer.unref) timer.unref();
    },
    flush() { if (timer) writeNow(); },
  };
  return api;
}

// ------------------------------------------------------------------ tokens
function makeTokens(dataPath) {
  const secretPath = path.join(path.dirname(dataPath), 'secret.key');
  let secret;
  try {
    secret = fs.readFileSync(secretPath);
    if (secret.length < 32) throw new Error('too short');
  } catch {
    secret = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  }
  const b64u = (buf) => Buffer.from(buf).toString('base64url');
  return {
    issue(id) {
      const payload = b64u(JSON.stringify({ i: id, e: Math.floor(Date.now() / 1000) + TOKEN_TTL_S }));
      const sig = b64u(crypto.createHmac('sha256', secret).update(payload).digest());
      return payload + '.' + sig;
    },
    verify(token) {
      if (typeof token !== 'string') return null;
      const dot = token.indexOf('.');
      if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null;
      const payload = token.slice(0, dot);
      const sig = Buffer.from(token.slice(dot + 1), 'base64url');
      const expect = crypto.createHmac('sha256', secret).update(payload).digest();
      if (sig.length !== expect.length || !crypto.timingSafeEqual(sig, expect)) return null;
      let p;
      try { p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
      if (!p || typeof p.i !== 'string' || !Number.isFinite(p.e)) return null;
      if (p.e * 1000 < Date.now()) return null;
      return p.i;
    },
  };
}

// -------------------------------------------------------------------- helpers
const intBetween = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function validName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (!n || n.length < 2) return { error: MSG.badName };
  if (n.length > 20) return { error: MSG.nameTooLong };
  return { value: n };
}

function validCode(code) {
  if (typeof code !== 'string') return { error: MSG.badCode };
  if (code.length < 4) return { error: MSG.badCode };
  if (code.length > 20) return { error: MSG.codeTooLong };
  return { value: code };
}

function publicUser(u) {
  // The mirror the client keeps; fields match storage.js exactly (incl. code —
  // the original admin screen displays it; see docs/backend-design.md §3).
  // id / appliedSeqs are server-internal and never leave the process.
  const { id, appliedSeqs, ...rest } = u;
  return rest;
}

// ------------------------------------------------------------------ server
export function startServer(opts = {}) {
  const port = Number(opts.port ?? process.env.HR_PORT ?? 8081);
  const host = opts.host ?? process.env.HR_HOST ?? '0.0.0.0';
  const dataPath = opts.dataPath ?? process.env.HR_DATA_PATH ?? path.join(HERE, 'data', 'state.json');
  const rateLimit = Number(opts.rateLimit ?? process.env.HR_RATE_LIMIT ?? 120); // per IP per minute

  const persist = makePersistence(dataPath);
  const tokens = makeTokens(dataPath);

  let state = loadState(dataPath);
  if (!state) {
    state = defaultState();
    if (seedIfNeeded(state)) persist.schedule();
  } else {
    seedIfNeeded(state);
  }
  persist.attach(state);

  // per-IP fixed-window rate limiter (lazy sweep, no timers)
  const buckets = new Map();
  function allow(ip) {
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now - b.t0 >= 60000) { b = { t0: now, n: 0 }; buckets.set(ip, b); }
    b.n++;
    if (buckets.size > 10000) for (const [k, v] of buckets) if (now - v.t0 >= 60000) buckets.delete(k);
    return b.n <= rateLimit;
  }

  // id -> name index (tokens carry the id, so renames never invalidate sessions)
  const ids = new Map();
  const indexIds = () => {
    ids.clear();
    for (const [name, u] of Object.entries(state.users)) ids.set(u.id, name);
  };
  indexIds();

  function authUser(req) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const id = tokens.verify(m[1]);
    if (!id) return null;
    const name = ids.get(id);
    return name ? (state.users[name] || null) : null;
  }

  function names() { return Object.keys(state.users); }

  const sessionPayload = (u) => ({
    ok: true, token: tokens.issue(u.id), user: publicUser(u),
    rankE: state.rankE, rankH: state.rankH, names: names(),
  });

  async function handle(req, res, url) {
    const route = url.pathname.replace(/\/+$/, '') || '/';
    const json = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };

    // ---------------- public reads ----------------
    if (req.method === 'GET' && (route === '/api/health' || route === '/healthz')) {
      return json(200, { ok: true, api: 1, users: names().length });
    }
    if (req.method === 'GET' && route === '/api/rank') {
      return json(200, { ok: true, rankE: state.rankE, rankH: state.rankH });
    }
    if (req.method === 'GET' && route === '/api/namecheck') {
      const n = validName(url.searchParams.get('name'));
      if (n.error) return json(200, { ok: true, taken: true }); // an invalid name is never usable
      return json(200, { ok: true, taken: !!state.users[n.value] });
    }

    // ---------------- everything below is auth + JSON ----------------
    // Authenticated GETs (session restore, admin user list); everything else
    // must be a POST under /api/.
    if (req.method !== 'POST') {
      if (route === '/api/session' || route === '/api/admin/users') {
        const u = authUser(req);
        if (!u) {
          const had = /^Bearer\s+/i.test(req.headers['authorization'] || '');
          return json(401, { ok: false, msg: had ? MSG.badToken : MSG.needAuth });
        }
        if (route === '/api/session') return json(200, sessionPayload(u));
        if (!u.isAdmin) return json(200, { ok: false, msg: MSG.forbidden });
        return json(200, { ok: true, users: names().map((n) => publicUser(state.users[n])) });
      }
      return json(404, { ok: false, msg: 'not found' });
    }
    if (!route.startsWith('/api/')) return json(404, { ok: false, msg: 'not found' });

    let body;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
    } catch (e) {
      return json(e.code === 413 ? 413 : 400, { ok: false, msg: e.code === 413 ? MSG.tooLarge : MSG.badBody });
    }

    if (route === '/api/register') {
      const n = validName(body.name); if (n.error) return json(200, { ok: false, msg: n.error });
      const c = validCode(body.code); if (c.error) return json(200, { ok: false, msg: c.error });
      if (state.users[n.value]) return json(200, { ok: false, msg: MSG.taken });
      if (names().length >= MAX_USERS) return json(200, { ok: false, msg: '用户数已达上限' });
      const u = newUser(n.value, c.value);
      state.users[n.value] = u;
      ids.set(u.id, n.value);
      persist.schedule();
      return json(200, sessionPayload(u));
    }

    if (route === '/api/login') {
      const n = validName(body.name); if (n.error) return json(200, { ok: false, msg: n.error });
      const u = state.users[n.value];
      if (!u) return json(200, { ok: false, msg: MSG.noUser });
      if (typeof body.code !== 'string' || u.code !== body.code) return json(200, { ok: false, msg: MSG.wrongCode });
      return json(200, sessionPayload(u));
    }

    // ---------------- authenticated ----------------
    const u = authUser(req);
    if (!u) {
      const had = /^Bearer\s+/i.test(req.headers['authorization'] || '');
      return json(401, { ok: false, msg: had ? MSG.badToken : MSG.needAuth });
    }

    if (route === '/api/session') {
      return json(200, sessionPayload(u));
    }

    if (route === '/api/result') {
      const { isHard, score, horse, distance, seq } = body;
      if (typeof isHard !== 'boolean' || !intBetween(score, 0, 99999)
        || !intBetween(horse, 0, 19) || !intBetween(distance, 0, 1e9)) {
        return json(200, { ok: false, msg: MSG.badScore });
      }
      if (!intBetween(seq, 1, Number.MAX_SAFE_INTEGER)) return json(200, { ok: false, msg: MSG.badScore });
      // Idempotency: a seq already applied (network retry / outbox replay) is a
      // no-op. A bounded per-user set — not a watermark — so results from a
      // SECOND device of the same account (own seq counter) are never mistaken
      // for replays, and out-of-order arrival cannot drop legitimate deltas.
      if (!Array.isArray(u.appliedSeqs)) u.appliedSeqs = [];
      if (u.appliedSeqs.includes(seq)) return json(200, { ok: true, deduped: true });
      u.appliedSeqs.push(seq);
      if (u.appliedSeqs.length > 64) u.appliedSeqs.splice(0, u.appliedSeqs.length - 64);
      const summary = applyResult(state, u, { isHard, score, horse, distance });
      persist.schedule();
      return json(200, { ok: true, summary, user: publicUser(u), rankE: state.rankE, rankH: state.rankH });
    }

    if (route === '/api/profile') {
      if (!intBetween(body.port, 0, 9)) return json(200, { ok: false, msg: MSG.badBody });
      u.Port = body.port;
      persist.schedule();
      return json(200, { ok: true, user: publicUser(u) });
    }

    if (route === '/api/changename') {
      const n = validName(body.newName); if (n.error) return json(200, { ok: false, msg: n.error });
      const confirm = typeof body.confirm === 'string' ? body.confirm.trim() : '';
      if (n.value !== confirm) return json(200, { ok: false, msg: MSG.confirmMismatch });
      if (n.value === u.name) return json(200, { ok: false, msg: MSG.sameName });
      if (state.users[n.value]) return json(200, { ok: false, msg: MSG.taken });
      const old = u.name;
      delete state.users[old];
      ids.delete(u.id);           // the index still points at the old name
      u.name = n.value;
      state.users[n.value] = u;
      ids.set(u.id, n.value);
      // keep ranking entries consistent (same as storage.js changeName)
      for (const arr of [state.rankE, state.rankH]) for (const r of arr) if (r && r.name === old) r.name = n.value;
      persist.schedule();
      return json(200, { ok: true, user: publicUser(u), names: names(), rankE: state.rankE, rankH: state.rankH });
    }

    if (route === '/api/changecode') {
      if (typeof body.oldCode !== 'string' || u.code !== body.oldCode) return json(200, { ok: false, msg: MSG.oldCodeWrong });
      const c = validCode(body.newCode); if (c.error) return json(200, { ok: false, msg: c.error });
      if (body.newCode !== body.confirmCode) return json(200, { ok: false, msg: MSG.confirmCodeMismatch });
      u.code = body.newCode;
      persist.schedule();
      return json(200, { ok: true, user: publicUser(u) });
    }

    // ---------------- admin ----------------
    if (route === '/api/admin/delete') {
      if (!u.isAdmin) return json(200, { ok: false, msg: MSG.forbidden });
      const target = typeof body.name === 'string' ? state.users[body.name] : null;
      if (!target) return json(200, { ok: false, msg: MSG.noTarget });
      if (target.isAdmin) return json(200, { ok: false, msg: MSG.protectedAdmin });
      delete state.users[body.name];
      ids.delete(target.id);      // its tokens stop resolving immediately
      persist.schedule();
      return json(200, { ok: true, names: names() });
    }

    return json(404, { ok: false, msg: 'not found' });
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let rejected = false;
      req.on('data', (c) => {
        if (rejected) return;               // drain (do not buffer) after the cap
        size += c.length;
        if (size > BODY_CAP) {
          rejected = true;
          const e = new Error(MSG.tooLarge); e.code = 413;
          reject(e);
          req.resume();                     // let the 413 response reach the client
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', () => { /* socket torn down after the early response */ });
    });
  }

  const server = http.createServer((req, res) => {
    let ip = req.socket.remoteAddress || 'unknown';
    if (!allow(ip)) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, msg: MSG.rateLimited }));
      return;
    }
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch {
      res.writeHead(400).end(); return;
    }
    Promise.resolve(handle(req, res, url)).catch((e) => {
      console.error('[api] handler error:', e && e.stack || e);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, msg: MSG.serverError }));
      } else {
        try { res.end(); } catch { /* socket gone */ }
      }
    });
  });

  server.listen(port, host, () => {
    const addr = server.address();
    console.log(`[api] listening on ${typeof addr === 'object' ? addr.port : port}, data: ${dataPath}`);
  });

  return {
    server,
    get state() { return state; },
    flush: () => persist.flush(),
    close: () => new Promise((resolve) => {
      persist.flush();
      server.close(() => resolve());
    }),
  };
}

// ------------------------------------------------------------------ entry
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const app = startServer();
  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.flush();
    app.close().then(() => { console.log('[api] ' + sig + ': flushed and closed'); process.exit(0); });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
