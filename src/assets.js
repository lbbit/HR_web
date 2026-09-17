// assets.js — pixel-art asset manifest, preloading, and image cache.
//
// All art is the ORIGINAL hand-crafted pixel art from the Qt project, re-encoded
// to lossless WebP (≈1.5 MB total). Buttons and labels already contain their
// pixel text baked in, so the retro look needs no font for static UI text.
//
// IMPORTANT: `img(src)` returns the RESOLVED HTMLImageElement (or null) — never a
// Promise. (The previous version returned the Promise, which made canvas
// drawImage() throw and blank the whole race frame.)

const A = './assets/';

// ---------- path builders ----------
export const bg = (name) => `${A}bg/${name}.webp`;
export const ui = (name) => `${A}ui/${name}.webp`;
export const btn = (base, state = 'W') => `${A}ui/${base}_${state}.webp`;

// The original art only ships RUN1/RUN2 for horses 0..18 — HORSE19 (the legendary
// "高清无码" horse) has a STAND frame only. Requesting its run frames 404s (and in
// the Qt original it silently rendered an empty pixmap), so we degrade those to
// STAND instead of asking for files that do not exist.
export const RUN_FRAMES = new Set(Array.from({ length: 19 }, (_, i) => i));
export function hasRunFrames(i) { return RUN_FRAMES.has(i); }

export function horseFrame(i, frame = 'STAND') {
  const f = (frame === 'RUN1' || frame === 'RUN2') && !RUN_FRAMES.has(i) ? 'STAND' : frame;
  return `${A}horses/HORSE${i}_${f}.webp`;
}
export const portrait = (i) => `${A}portraits/PORTRAIT${i}.webp`;

const EASY_KEYS = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
/**
 * Key-tile art. The original files are `<key>.png`, `<key>_G.png`, `<key>_R.png`
 * (green = correct, red = wrong) — i.e. the state is separated by an UNDERSCORE.
 * Normalise the state here so callers may pass '', 'G', or '_G' interchangeably;
 * omitting the underscore silently 404s every correct/wrong indicator.
 */
export function keyImage(mode, value, state = '') {
  const ch = mode === 'easy' ? EASY_KEYS[value] : String.fromCharCode(97 + value);
  const s = String(state).replace(/^_/, '');
  return `${A}keys/${ch}${s ? '_' + s : ''}.webp`;
}

// screen -> background image
export const SCREEN_BG = {
  title: 'BG0', login: 'BG1', register: 'BG2', menu: 'BG3', select: 'BG4',
  rank: 'BG5', rule: 'BG6', usercenter: 'BG7', changename: 'BG9', changecode: 'BG10',
  admin: 'BG12', gameover: 'BG13', dialog: 'BG20',
};
export const RACE_BGS = ['BG9_0', 'BG9_1', 'BG9_2'];

export const HORSE_COUNT = 20;
export const RACE_BG_W = 1000, RACE_BG_H = 622;
export const PORTRAIT_W = 450, PORTRAIT_H = 600;

// ---------- image cache ----------
const cache = new Map();    // src -> HTMLImageElement | null
const pending = new Map();  // src -> Promise

function load(src) {
  if (pending.has(src)) return pending.get(src);
  const p = new Promise((resolve) => {
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => { cache.set(src, im); resolve(im); };
    im.onerror = () => { cache.set(src, null); resolve(null); };
    im.src = src;
  });
  pending.set(src, p);
  return p;
}

/** Resolved image for `src`, or null if missing/not yet loaded. */
export function img(src) {
  return cache.get(src) || null;
}

// ---------- manifest for preload ----------
const BTN_TRIPLES = [
  'BUTTON_A', 'BUTTON_B', 'BUTTON_UP', 'BUTTON_DOWN', 'BUTTON_LEFT', 'BUTTON_RIGHT',
  'START', 'QUIT', 'RETURN', 'RETURN_X', 'LOGIN', 'REGISTER', 'CHECK', 'CHECKCONFIRM',
  'CREATE', 'CONTINUE', 'CHANGEUSERNAME', 'CHANGECODE', 'CONFIRMCHANGE', 'SWITCHUSER',
  'SELECTDIFFICULTY', 'SELECTRIVAL', 'STARTGAME', 'GAME', 'PERSONALCENTER', 'RANK', 'RULE',
  'EASY', 'HARD', 'LASTINDEX_LEFT', 'LASTINDEX_UP', 'NEXTINDEX_RIGHT', 'NEXTINDEX_DOWN',
];
const UI_SINGLE = [
  'ABOUT_W_50_25', 'ABOUT_P_50_25', 'ABOUT_C_50_25', 'DELETE_100_30', 'SELECT_W_P_C',
  'ACCOUNT_W_45_25', 'CODE_W_45_25', 'USERNAME_W_55_25', 'CONFIRMCODE_W_60_25',
  'RIVAL_W_60_30', 'DIFFICULTY_W_60_30', 'HORSE_W_60_30',
  'TOPRANK_W_120_50', 'TOPSCORE_W_120_50', 'GAMETIME_W_60_25', 'HORSEHAVE_W_60_25',
  'HORSEDISTANCE_W_60_25', 'EASY_50_30', 'HARD_50_30', 'EASY_60_40', 'HARD_60_40',
  'EASY_90_40', 'HARD_90_40', 'PREPAREGAMELOGO_W_150_60', 'NAME_100_30',
  'CHOOSEUSER_100_30', 'CODE_100_30', 'NEWNAME_W_100_50', 'CONFIRMNAME_W_110_50',
  'NEWCODE_W_100_50', 'ORIGINALCODE_W_100_50', 'CONFIRMCODE_W_100_50',
  'horse_PITY', 'horse_all', 'RANK_NO1', 'RANK_NO2', 'RANK_NO3', 'RANK_NO4', 'RANK_NO5',
  'withmusic', 'withoutmusic',
];

export function manifest() {
  const list = [];
  // backgrounds
  for (const n of ['BG0', 'BG1', 'BG2', 'BG3', 'BG4', 'BG5', 'BG6', 'BG7', 'BG9', 'BG10', 'BG12', 'BG13', 'BG20']) list.push(bg(n));
  for (const n of RACE_BGS) list.push(bg(n));
  // ui buttons + labels
  for (const b of BTN_TRIPLES) for (const s of ['W', 'P', 'C']) list.push(btn(b, s));
  for (const n of UI_SINGLE) list.push(ui(n));
  // portraits
  for (let i = 0; i < 10; i++) list.push(portrait(i));
  // horses
  for (let i = 0; i < HORSE_COUNT; i++) {
    list.push(horseFrame(i, 'STAND'));
    if (hasRunFrames(i)) { list.push(horseFrame(i, 'RUN1')); list.push(horseFrame(i, 'RUN2')); }
  }
  // keys
  for (let v = 0; v < 4; v++) for (const s of ['', 'G', 'R']) list.push(keyImage('easy', v, s));
  for (let v = 0; v < 26; v++) for (const s of ['', 'G', 'R']) list.push(keyImage('hard', v, s));
  return list;
}

export async function preload(onProgress) {
  const list = manifest();
  const total = list.length;
  let done = 0;
  await Promise.all(list.map((src) => load(src).then(() => {
    done++;
    if (onProgress) onProgress(done / total);
  })));
  return cache;
}

export { load as loadImage };
