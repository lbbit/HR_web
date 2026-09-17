// storage.js — localStorage persistence: accounts, rankings, horse collection, stats.
// Faithful to the original data model (user.h): best easy/hard score + rank, 20-horse
// collection starting with 3 horses, total games/seconds/distance.

const KEY = 'hrweb_save_v2';

function defaultState() {
  return {
    users: {},          // name -> user
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
  if (state.users[name]) return { ok: false, msg: '该用户名已被占用' };
  state.users[name] = newUser(name, code);
  state.currentUser = name;
  save();
  return { ok: true };
}

export function nameTaken(name) {
  return !!state.users[(name || '').trim()];
}

export function login(name, code) {
  name = (name || '').trim();
  const u = state.users[name];
  if (!u) return { ok: false, msg: '账号不存在，请先注册' };
  if (u.code !== code) return { ok: false, msg: '密码错误' };
  state.currentUser = name;
  save();
  return { ok: true };
}

export function logout() { state.currentUser = null; save(); }

export function changeName(newName, confirmName) {
  const u = current();
  if (!u) return { ok: false, msg: '请先登录' };
  newName = (newName || '').trim();
  if (newName.length < 2) return { ok: false, msg: '用户名至少 2 个字符' };
  if (newName !== (confirmName || '').trim()) return { ok: false, msg: '两次输入不一致' };
  if (newName === u.name) return { ok: false, msg: '与新用户名相同' };
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
  if (u.code !== oldCode) return { ok: false, msg: '原密码错误' };
  if ((newCode || '').length < 4) return { ok: false, msg: '新密码至少 4 位' };
  if (newCode !== confirmCode) return { ok: false, msg: '两次新密码不一致' };
  u.code = newCode;
  save();
  return { ok: true };
}

// ---------- admin (用户管理) ----------
export function allUsers() { return Object.values(state.users); }
export function deleteUser(name) {
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
// of 0..18 (19 horses) auto-unlocks the legendary #19.
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
export function recordResult({ isHard, score, horse, distance }) {
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

export function resetAll() { state = defaultState(); save(); }
