// storage.js — localStorage persistence: accounts, rankings, horse collection, settings.
// Faithful to the original data model (best easy/hard score, 20-horse collection, exp).

const KEY = 'hrweb_save_v1';

function defaultState() {
  return {
    users: {},          // name -> user
    currentUser: null,  // current account name
    rankE: [],          // top-5 easy  [{name, score}]
    rankH: [],          // top-5 hard  [{name, score}]
    settings: { music: true, sfx: true, track: 0 },
  };
}

function newUser(name, code) {
  const hasHorse = new Array(20).fill(false);
  hasHorse[0] = true;
  return {
    name,
    code,
    exp: 0,
    topE: 0,
    topH: 0,
    hasHorse,
    totalHorse: 1,
    horseKey: [0],
    Port: 0,
    TopHorseE: 0,
    TopHorseH: 0,
  };
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    return Object.assign(defaultState(), s);
  } catch {
    return defaultState();
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('save failed', e);
  }
}

export function getSettings() {
  return state.settings;
}
export function setSettings(patch) {
  state.settings = Object.assign({}, state.settings, patch);
  save();
}

export function current() {
  if (!state.currentUser) return null;
  return state.users[state.currentUser] || null;
}

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

export function login(name, code) {
  name = (name || '').trim();
  const u = state.users[name];
  if (!u) return { ok: false, msg: '账号不存在，请先注册' };
  if (u.code !== code) return { ok: false, msg: '密码错误' };
  state.currentUser = name;
  save();
  return { ok: true };
}

export function logout() {
  state.currentUser = null;
  save();
}

function updateRanking(arr, name, score) {
  for (let i = 0; i < 5; i++) {
    if (score > (arr[i] ? arr[i].score : 0)) {
      for (let j = 4; j > i; j--) arr[j] = arr[j - 1];
      arr[i] = { name, score };
      return true;
    }
  }
  return false;
}

// Replicates the original unlock logic: every game attempts to unlock a horse.
function attemptUnlock(u) {
  if (u.totalHorse >= 20) return 20; // already have all
  const newHorse = Math.floor(Math.random() * 19); // 0..18
  if (u.hasHorse[newHorse]) return -1; // rolled an owned one -> miss
  u.hasHorse[newHorse] = true;
  u.horseKey[u.totalHorse] = newHorse;
  u.totalHorse++;
  if (u.totalHorse === 19) {
    // auto-unlock the legendary #19 once 0..18 are collected
    u.hasHorse[19] = true;
    u.horseKey[19] = 19;
    u.totalHorse = 20;
    return 19;
  }
  return newHorse;
}

export function level(u) {
  return Math.floor(u.exp / 100) + 1;
}

// Record a finished race. Returns a summary for the result screen.
export function recordResult({ isHard, score, horse }) {
  const u = current();
  if (!u) return null;
  u.exp += 40;
  let isNewRecord = false;
  if (isHard) {
    if (score > u.topH) {
      isNewRecord = true;
      u.topH = score;
      u.TopHorseH = horse;
    }
  } else {
    if (score > u.topE) {
      isNewRecord = true;
      u.topE = score;
      u.TopHorseE = horse;
    }
  }
  const inRank = isHard ? updateRanking(state.rankH, u.name, score)
                        : updateRanking(state.rankE, u.name, score);
  const unlocked = attemptUnlock(u);
  save();
  return { isNewRecord, inRank, unlocked, score, topNow: isHard ? u.topH : u.topE };
}

export function getRanking() {
  return { easy: state.rankE.slice(), hard: state.rankH.slice() };
}

export function resetAll() {
  state = defaultState();
  save();
}
