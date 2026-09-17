// storage.js — persistence for accounts, rankings, horse collection, stats.
// Faithful to the original data model (user.h): best easy/hard score + rank, 20-horse
// collection starting with 3 horses, total games/seconds/distance.
//
// DUAL MODE (docs/backend-design.md): when the backend (api/server.mjs) is
// reachable the store works in REMOTE mode — writes go to the server over sync
// XHR (the game code depends on synchronous returns), responses refresh a local
// mirror, and the SERVER is authoritative for settlement (scores, ranking,
// random horse unlock). When the backend is unreachable the store falls back to
// the original LOCAL mode byte-for-byte, so offline play is unchanged. Settings
// are device-local in both modes (they stay in localStorage).

const KEY = 'hrweb_save_v2';
const TOKEN_KEY = 'hrweb_token';
const SEQ_KEY = 'hrweb_outbox_seq';
const OUTBOX_KEY = 'hrweb_outbox';
const OUTBOX_MAX = 20;
const REMOTE_DOWN = '账号服务不可用';

function defaultState() {
  return {
    // 无原型映射：用户名可以叫 constructor / toString / __proto__ 而不被
    // Object.prototype 上的继承键误判成“该用户名已被占用”
    users: Object.create(null),         // name -> user (remote mode: mirror)
    currentUser: null,
    // the original declares `RankC rankE[5]` as a fixed 5-slot table
    // (default UserName="---", Score=0); null == an empty slot
    rankE: [null, null, null, null, null],   // top-5 easy  [{name, score}]
    rankH: [null, null, null, null, null],   // top-5 hard
    settings: { music: true, sfx: true, track: 0 },
  };
}

/** Always yield a well-formed 5-slot board (also repairs older sparse saves). */
function normalizeRank(arr) {
  const out = [null, null, null, null, null];
  if (Array.isArray(arr)) {
    arr.filter((r) => r && typeof r.score === 'number' && typeof r.name === 'string')
      .slice(0, 5)
      .forEach((r, i) => { out[i] = { name: r.name, score: r.score }; });
  }
  return out;
}

function newUser(name, code) {
  const hasHorse = new Array(20).fill(false);
  const horseKey = new Array(20).fill(0);
  // the original grants 3 horses on registration (indices 0,1,2)
  hasHorse[0] = hasHorse[1] = hasHorse[2] = true;
  horseKey[0] = 0; horseKey[1] = 1; horseKey[2] = 2;
  return {
    name, code,
    games: 0,          // 总局数
    seconds: 0,        // 游戏时长（累计秒）
    distance: 0,       // 总路程
    topE: 0, topH: 0,  // 最高积分
    rankTopE: 0, rankTopH: 0, // 最高排名（0 = 从未上榜）
    hasHorse, horseKey, totalHorse: 3,
    Port: 0,
    TopHorseE: 0, TopHorseH: 0,
    isAdmin: false,
  };
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    const d = defaultState();
    const merged = Object.assign(d, s);
    // 旧存档里的 users 是普通对象（带 Object.prototype），统一重建为无原型映射，
    // 否则 users['constructor'] 这类读取会命中继承键
    merged.users = Object.assign(Object.create(null),
      (s.users && typeof s.users === 'object' && !Array.isArray(s.users)) ? s.users : {});
    merged.settings = Object.assign(d.settings, s.settings || {});
    merged.rankE = normalizeRank(merged.rankE);
    merged.rankH = normalizeRank(merged.rankH);
    return merged;
  } catch {
    return defaultState();
  }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn('save failed', e); }
}

// =====================================================================
//  remote mode plumbing
// =====================================================================

let mode = 'undecided';            // 'undecided' | 'local' | 'remote' — fixed per page load
let remoteNames = [];              // all known usernames (mirror of server truth)

/**
 * Decide (once) whether the backend is reachable. Synchronous on purpose: the
 * game code depends on synchronous storage returns, and the probe is a same-
 * origin request answered in milliseconds. In environments without XHR (the
 * headless test harness) this resolves to LOCAL immediately.
 */
function detectModeSync() {
  if (mode !== 'undecided') return mode;
  try {
    if (typeof XMLHttpRequest === 'undefined') throw new Error('no XHR');
    const x = new XMLHttpRequest();
    x.open('GET', '/api/health', false); // sync; nginx caps /api proxy time (5s)
    x.send(null);
    if (x.status === 200) {
      const j = JSON.parse(x.responseText);
      if (j && j.api === 1) mode = 'remote';
    }
  } catch { /* offline or harness */ }
  if (mode === 'undecided') mode = 'local';
  return mode;
}

/** True when the app is wired to the shared backend. Decides the mode for good. */
export function remoteActive() { return detectModeSync() === 'remote'; }

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

/** Small JSON request, fire-and-forget (avatar writes, outbox replay). */
async function apiAsync(pathname, body, method = 'POST') {
  const headers = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) headers['Authorization'] = 'Bearer ' + t;
  const res = await fetch(pathname, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    signal: AbortSignal.timeout(4000),
  });
  const r = await res.json();
  if (res.status === 401) setToken(null);
  if (!res.ok) throw new Error('http ' + res.status);
  return r;
}

/** Small JSON request that BLOCKS until answered (login/register/result/...). */
function apiSync(method, pathname, body) {
  const x = new XMLHttpRequest();
  x.open(method, pathname, false);
  x.setRequestHeader('Content-Type', 'application/json');
  const t = getToken();
  if (t) x.setRequestHeader('Authorization', 'Bearer ' + t);
  x.send(body === undefined ? null : JSON.stringify(body));
  let r = null;
  try { r = JSON.parse(x.responseText); } catch { throw new Error('bad response'); }
  if (x.status === 401) setToken(null);   // expired/invalid token — caller surfaces the message
  if (x.status !== 200) throw new Error('http ' + x.status);
  return r;
}

/** Take a session/user payload from the server into the local mirror. */
function adoptSession(r) {
  if (r.token) setToken(r.token);
  state.rankE = normalizeRank(r.rankE);
  state.rankH = normalizeRank(r.rankH);
  remoteNames = Array.isArray(r.names) ? r.names.filter((n) => typeof n === 'string') : remoteNames;
  if (r.user && r.user.name) {
    state.users[r.user.name] = r.user;
    state.currentUser = r.user.name;
  }
  save();
}

function adoptUser(user) {
  if (user && user.name) {
    state.users[user.name] = user;
    if (state.currentUser === user.name || !state.currentUser) state.currentUser = user.name;
  }
}

// ---- offline outbox: race results settled locally while the backend was down,
// ---- replayed (with their original seq; the server dedupes) once it is back.
function nextSeq() {
  let prev = 0;
  try { prev = parseInt(localStorage.getItem(SEQ_KEY) || '0', 10) || 0; } catch { /* fresh */ }
  // max(prev+1, Date.now())：单调（本设备防回退），且跨设备同账号也不会撞号
  // （两台设备各自的 seq 计数互不知晓，时间戳保证全局唯一性）
  const seq = Math.max(prev + 1, Date.now());
  try { localStorage.setItem(SEQ_KEY, String(seq)); } catch { /* private mode */ }
  return seq;
}

function queueOutbox(entry) {
  try {
    const box = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
    box.push(entry);
    while (box.length > OUTBOX_MAX) box.shift(); // bound the backlog
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(box));
  } catch { /* private mode */ }
}

async function flushOutbox() {
  let box = [];
  try { box = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { box = []; }
  if (!Array.isArray(box) || !box.length) return;
  const pending = [];
  for (const entry of box) {
    try {
      const r = await apiAsync('/api/result', entry);
      if (r && r.ok && !r.deduped) {
        adoptUser(r.user);
        if (r.rankE) state.rankE = normalizeRank(r.rankE);
        if (r.rankH) state.rankH = normalizeRank(r.rankH);
      }
      // ok:false (rejected data) and deduped:true both drop the entry
    } catch {
      pending.push(entry); // still unreachable — try again next boot
    }
  }
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(pending)); } catch { /* private mode */ }
  save();
}

/**
 * Boot-time reconnection: replay offline results, then (if we hold a token)
 * re-validate the session and refresh the mirror. Never throws.
 */
export async function restoreSession() {
  if (detectModeSync() !== 'remote') return null;
  await flushOutbox();
  if (!getToken()) return null;
  try {
    const r = await apiAsync('/api/session', null, 'GET');
    if (r && r.ok) { adoptSession(r); return r.user; }
    setToken(null);
  } catch { /* server blips — the mirror from localStorage keeps the UI alive */ }
  return null;
}

/** Public-read rankings refresh (rank screen re-paints after this resolves). */
export async function refreshRanking() {
  if (detectModeSync() !== 'remote') return;
  try {
    const r = await apiAsync('/api/rank', null, 'GET');
    if (r && r.ok) {
      state.rankE = normalizeRank(r.rankE);
      state.rankH = normalizeRank(r.rankH);
      save();
    }
  } catch { /* keep the stale mirror */ }
}

// ---------- settings ----------
export function getSettings() { return state.settings; }
export function setSettings(patch) { state.settings = Object.assign({}, state.settings, patch); save(); }

/** Persist ad-hoc mutations made directly on the current user object. */
export function persist() { save(); }

// ---------- accounts ----------
export function current() { return state.currentUser ? (state.users[state.currentUser] || null) : null; }

export function register(name, code) {
  name = (name || '').trim();
  if (!name || name.length < 2) return { ok: false, msg: '用户名至少 2 个字符' };
  if ((code || '').length < 4) return { ok: false, msg: '密码至少 4 位' };
  if (detectModeSync() === 'remote') {
    let r;
    try { r = apiSync('POST', '/api/register', { name, code }); }
    catch { return { ok: false, msg: REMOTE_DOWN }; }
    if (!r.ok) return r;
    adoptSession(r);
    return { ok: true };
  }
  if (state.users[name]) return { ok: false, msg: '该用户名已被占用' };
  state.users[name] = newUser(name, code);
  state.currentUser = name;
  save();
  return { ok: true };
}

export function nameTaken(name) {
  name = (name || '').trim();
  if (detectModeSync() === 'remote') {
    // the server is the only truth; a missing session just means "not taken by me"
    try {
      const r = apiSync('GET', '/api/namecheck?name=' + encodeURIComponent(name));
      return !!(r && r.ok && r.taken);
    } catch {
      return remoteNames.includes(name) || !!state.users[name];
    }
  }
  return !!state.users[name];
}

export function login(name, code) {
  name = (name || '').trim();
  if (detectModeSync() === 'remote') {
    let r;
    try { r = apiSync('POST', '/api/login', { name, code }); }
    catch { return { ok: false, msg: REMOTE_DOWN }; }
    if (!r.ok) return r;
    adoptSession(r);
    return { ok: true };
  }
  const u = state.users[name];
  if (!u) return { ok: false, msg: '账号不存在，请先注册' };
  if (u.code !== code) return { ok: false, msg: '密码错误' };
  state.currentUser = name;
  save();
  return { ok: true };
}

export function logout() {
  state.currentUser = null;
  setToken(null);
  save();
}

export function changeName(newName, confirmName) {
  const u = current();
  if (!u) return { ok: false, msg: '请先登录' };
  newName = (newName || '').trim();
  if (newName.length < 2) return { ok: false, msg: '用户名至少 2 个字符' };
  if (newName !== (confirmName || '').trim()) return { ok: false, msg: '两次输入不一致' };
  if (newName === u.name) return { ok: false, msg: '与新用户名相同' };
  if (detectModeSync() === 'remote') {
    let r;
    try { r = apiSync('POST', '/api/changename', { newName, confirm: confirmName }); }
    catch { return { ok: false, msg: REMOTE_DOWN }; }
    if (!r.ok) return r;
    delete state.users[u.name];
    adoptUser(r.user);
    remoteNames = Array.isArray(r.names) ? r.names : remoteNames;
    if (r.rankE) state.rankE = normalizeRank(r.rankE); // 榜上的名字也被服务端改了
    if (r.rankH) state.rankH = normalizeRank(r.rankH);
    save();
    return { ok: true };
  }
  if (state.users[newName]) return { ok: false, msg: '该用户名已被占用' };
  const old = u.name;
  delete state.users[old];
  u.name = newName;
  state.users[newName] = u;
  state.currentUser = newName;
  // keep ranking entries consistent
  for (const arr of [state.rankE, state.rankH]) for (const r of arr) if (r && r.name === old) r.name = newName;
  save();
  return { ok: true };
}

export function changeCode(oldCode, newCode, confirmCode) {
  const u = current();
  if (!u) return { ok: false, msg: '请先登录' };
  if (detectModeSync() === 'remote') {
    let r;
    try { r = apiSync('POST', '/api/changecode', { oldCode, newCode, confirmCode }); }
    catch { return { ok: false, msg: REMOTE_DOWN }; }
    if (!r.ok) return r;
    adoptUser(r.user);
    save();
    return { ok: true };
  }
  if (u.code !== oldCode) return { ok: false, msg: '原密码错误' };
  if ((newCode || '').length < 4) return { ok: false, msg: '新密码至少 4 位' };
  if (newCode !== confirmCode) return { ok: false, msg: '两次新密码不一致' };
  u.code = newCode;
  save();
  return { ok: true };
}

// ---------- avatar (was persist() of a mutated u.Port; now an explicit write) ----------
export function setPortrait(d) {
  const u = current();
  if (!u) return;
  u.Port = (u.Port + 10 + d) % 10;
  save(); // instant UI + offline durability
  if (detectModeSync() === 'remote') {
    apiAsync('/api/profile', { port: u.Port })
      .then((r) => { if (r && r.ok && r.user) { adoptUser(r.user); save(); } })
      .catch(() => { /* converge on the next avatar change / session restore */ });
  }
}

// ---------- admin (用户管理) ----------
export function allUsers() {
  if (detectModeSync() === 'remote') {
    try {
      const r = apiSync('GET', '/api/admin/users');
      if (r && r.ok && Array.isArray(r.users)) {
        state.users = Object.create(null);
        for (const u of r.users) state.users[u.name] = u;
        remoteNames = r.users.map((u) => u.name);
        save();
        return Object.values(state.users);
      }
    } catch { /* fall through to the stale mirror */ }
  }
  return Object.values(state.users);
}

export function deleteUser(name) {
  if (detectModeSync() === 'remote') {
    let r;
    try { r = apiSync('POST', '/api/admin/delete', { name }); }
    catch { return { ok: false, msg: REMOTE_DOWN }; }
    if (!r.ok) return r;
    delete state.users[name];
    if (state.currentUser === name) state.currentUser = null;
    remoteNames = Array.isArray(r.names) ? r.names : remoteNames;
    save();
    return { ok: true };
  }
  if (!state.users[name]) return { ok: false };
  delete state.users[name];
  if (state.currentUser === name) state.currentUser = null;
  save();
  return { ok: true };
}

// ---------- ranking ----------
function updateRanking(arr, name, score) {
  for (let i = 0; i < 5; i++) {
    if (score > (arr[i] ? arr[i].score : 0)) {
      for (let j = 4; j > i; j--) arr[j] = arr[j - 1];
      arr[i] = { name, score };
      return i + 1; // 1-based rank position
    }
  }
  return 0;
}
export function getRanking() { return { easy: normalizeRank(state.rankE), hard: normalizeRank(state.rankH) }; }

// ---------- horses ----------
// The original unlocks a random horse among 0..18 after each race; collecting all
// of 0..18 (19 horses) auto-unlocks the legendary #19. In remote mode the unlock
// roll happens SERVER-side (api/server.mjs applyResult); this local copy is used
// for offline play only.
function attemptUnlock(u) {
  if (u.totalHorse >= 20) return 20;
  const newHorse = Math.floor(Math.random() * 19); // 0..18
  if (u.hasHorse[newHorse]) return -1;             // rolled an owned one -> no unlock
  u.hasHorse[newHorse] = true;
  u.horseKey[u.totalHorse] = newHorse;
  u.totalHorse++;
  if (u.totalHorse === 19) {                        // first 19 collected -> legendary
    u.hasHorse[19] = true;
    u.horseKey[19] = 19;
    u.totalHorse = 20;
    return 19;
  }
  return newHorse;
}

// ---------- results ----------
const SECONDS_PER_GAME = 40; // 20 groups x 2s

/** Local settlement — the original behavior, also the offline fallback. */
function localRecordResult({ isHard, score, horse, distance }) {
  const u = current();
  if (!u) return null;
  u.games++;
  u.seconds += SECONDS_PER_GAME;
  u.distance += distance || 0;

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
  save();
  return { isNewRecord, inRank, rankPos: pos, unlocked, score, topNow: isHard ? u.topH : u.topE };
}

/**
 * Settle one finished race. Remote mode: the server computes everything
 * (authoritative) and answers with the same shape the game-over screen has
 * always consumed. If the network fails mid-race the race still settles locally
 * (the player keeps their immediate feedback) and the delta is queued for
 * replay with its original seq — see docs/backend-design.md §7.
 */
export function recordResult(req) {
  if (detectModeSync() === 'remote') {
    const seq = nextSeq();
    try {
      const r = apiSync('POST', '/api/result', { ...req, seq });
      if (r.ok && !r.deduped) {
        adoptUser(r.user);
        state.rankE = normalizeRank(r.rankE);
        state.rankH = normalizeRank(r.rankH);
        save();
        return r.summary;
      }
      // deduped / rejected: the server already has (or refuses) this delta —
      // keep the game flowing with a local settlement of the same race
      return localRecordResult(req);
    } catch {
      queueOutbox({ ...req, seq });
      return localRecordResult(req);
    }
  }
  return localRecordResult(req);
}

export function resetAll() { state = defaultState(); save(); }
