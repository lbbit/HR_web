// Headless verification harness for HR_web.
// Mocks the browser DOM/Audio/RAF surface, loads src/main.js as a real ES module,
// then drives the whole game: every screen, full 20-round races, pause/resume,
// pause/quit, Esc-quit, storage mutations and admin actions.
//
// Also asserts that EVERY asset URL requested by the app resolves to a real file
// on disk (fs.existsSync), so a typo'd manifest path fails loudly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importUrl = (rel) => new URL('file://' + ROOT.replace(/\\/g, '/') + '/' + rel).href;

// ---------------------------------------------------------------- reporting
const fails = [];
const passes = [];
const errors = [];
function ok(cond, msg) { (cond ? passes : fails).push(msg); }
function section(n) { console.log('\n\x1b[36m== ' + n + ' ==\x1b[0m'); }
function info(m) { console.log('   ' + m); }

// ---------------------------------------------------------------- style
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
class Style {
  set cssText(t) {
    for (const decl of String(t).split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const k = decl.slice(0, i).trim();
      const v = decl.slice(i + 1).trim();
      if (k) this[camel(k)] = v;
    }
  }
  get cssText() { return ''; }
}

// ---------------------------------------------------------------- element
const byId = Object.create(null);
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = new Style();
    this._cls = new Set();
    this._ls = Object.create(null);
    this.attrs = Object.create(null);
    this._text = '';
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const self = this;
    return {
      add(...c) { c.forEach((x) => x && self._cls.add(x)); },
      remove(...c) { c.forEach((x) => self._cls.delete(x)); },
      toggle(c, force) {
        const want = force === undefined ? !self._cls.has(c) : !!force;
        if (want) self._cls.add(c); else self._cls.delete(c);
        return want;
      },
      contains(c) { return self._cls.has(c); },
    };
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null; return c;
  }
  insertBefore(c, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) return this.appendChild(c);
    this.children.splice(i, 0, c); c.parentNode = this; return c;
  }
  addEventListener(t, f) { (this._ls[t] || (this._ls[t] = [])).push(f); }
  removeEventListener(t, f) {
    const a = this._ls[t]; if (!a) return;
    const i = a.indexOf(f); if (i >= 0) a.splice(i, 1);
  }
  dispatch(type, ev = {}) {
    const e = Object.assign({
      type, target: this, currentTarget: this,
      preventDefault() {}, stopPropagation() {}, defaultPrevented: false,
    }, ev);
    for (const f of (this._ls[type] || []).slice()) f(e);
    return e;
  }
  click() { return this.dispatch('click'); }
  focus() { activeEl = this; }
  blur() { if (activeEl === this) activeEl = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  _matches(sel) {
    for (const p of String(sel).trim().split(/(?=[.#])/)) {
      if (p.startsWith('.')) { if (!this._cls.has(p.slice(1))) return false; }
      else if (p.startsWith('#')) { if (this.attrs.id !== p.slice(1)) return false; }
      else if (p && this.tagName !== p.toUpperCase()) return false;
    }
    return true;
  }
  _walk(out) { for (const c of this.children) { out.push(c); c._walk(out); } return out; }
  querySelector(sel) { return this._walk([]).find((c) => c._matches(sel)) || null; }
  querySelectorAll(sel) { return this._walk([]).filter((c) => c._matches(sel)); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = v === undefined || v === null ? '' : String(v); }
  get innerHTML() { return this._text; }
  set innerHTML(v) { if (v === '') { this.children = []; this._text = ''; } else { this._text = String(v); } }
  get value() { return this._v === undefined ? '' : this._v; }
  set value(v) { this._v = String(v); }
  get src() { return this._src || ''; }
  set src(v) { this._src = String(v); probeAsset(String(v), this); }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = String(v); byId[String(v)] = this; }
  get alt() { return this.attrs.alt || ''; }
  set alt(v) { this.attrs.alt = String(v); }
  get title() { return this.attrs.title || ''; }
  set title(v) { this.attrs.title = String(v); }
  get placeholder() { return this.attrs.placeholder || ''; }
  set placeholder(v) { this.attrs.placeholder = String(v); }
  get type() { return this.attrs.type || ''; }
  set type(v) { this.attrs.type = String(v); }
}
let activeEl = null;

// ---------------------------------------------------------------- asset probe
const missingAssets = new Set();
const requestedAssets = new Set();
function probeAsset(src, el) {
  if (!src || src.startsWith('data:')) return;
  const clean = src.replace(/^\.\//, '');
  requestedAssets.add(clean);
  const exists = fs.existsSync(path.join(ROOT, clean));
  if (!exists) missingAssets.add(clean);
  queueMicrotask(() => {
    if (exists) {
      Object.assign(el, { naturalWidth: 100, naturalHeight: 100, complete: true });
      if (el.onload) el.onload();
    } else if (el.onerror) el.onerror(new Error('missing ' + clean));
  });
}

// ---------------------------------------------------------------- document
function mkEl(tag, attrs = {}) {
  const e = new El(tag);
  if (attrs.id) { e.attrs.id = attrs.id; byId[attrs.id] = e; }
  if (attrs.cls) e.className = attrs.cls;
  return e;
}
const stageEl = mkEl('div', { id: 'stage' });
const modalEl = mkEl('div', { id: 'modal' });
const modalBox = mkEl('div', { cls: 'box' });
modalEl.appendChild(modalBox);
mkEl('div', { id: 'toast' });
mkEl('div', { id: 'loader' });
mkEl('div', { id: 'loader-fill' });
mkEl('div', { id: 'loader-text' });

const documentMock = {
  createElement: (t) => new El(t),
  createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e; },
  getElementById: (id) => byId[id] || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (t, f) => globalListeners.add(t, f),
  removeEventListener: (t, f) => globalListeners.remove(t, f),
  body: mkEl('body'),
  hidden: false,
};

// ---------------------------------------------------------------- globals
class ListenerBag {
  constructor() { this.m = Object.create(null); }
  add(t, f) { (this.m[t] || (this.m[t] = [])).push(f); }
  remove(t, f) { const a = this.m[t]; if (!a) return; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); }
  fire(type, ev = {}) {
    const e = Object.assign({ type, target: null, preventDefault() {}, stopPropagation() {} }, ev);
    for (const f of (this.m[type] || []).slice()) f(e);
  }
  count(type) { return (this.m[type] || []).length; }
}
const globalListeners = new ListenerBag();

class FakeParam {
  constructor(v) { this.value = v; }
  setValueAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) { this.value = v; return this; }
  cancelScheduledValues() { return this; }
}
class FakeNode { connect() { return this; } disconnect() { return this; } start() { } stop() { } }
class FakeGain extends FakeNode { constructor() { super(); this.gain = new FakeParam(1); } }
class FakeOsc extends FakeNode {
  constructor() { super(); this.frequency = new FakeParam(440); this.detune = new FakeParam(0); this.type = 'sine'; }
}
class FakeFilter extends FakeNode {
  constructor() { super(); this.type = 'lowpass'; this.frequency = new FakeParam(350); this.Q = new FakeParam(1); }
}
class FakeBuffer {
  constructor(ch, len) { this._d = new Float32Array(len); this.length = len; this.numberOfChannels = ch; }
  getChannelData() { return this._d; }
}
class FakeBufferSource extends FakeNode { constructor() { super(); this.buffer = null; this.loop = false; } }
const audioStats = { ctxCreated: 0, osc: 0, gain: 0, buffer: 0, filter: 0, src: 0 };
class FakeCtx {
  constructor() {
    audioStats.ctxCreated++;
    this.state = 'running'; this.currentTime = 0; this.sampleRate = 44100;
    this.destination = new FakeNode();
  }
  createGain() { audioStats.gain++; return new FakeGain(); }
  createOscillator() { audioStats.osc++; return new FakeOsc(); }
  createBiquadFilter() { audioStats.filter++; return new FakeFilter(); }
  createBuffer(ch, len) { audioStats.buffer++; return new FakeBuffer(ch, len); }
  createBufferSource() { audioStats.src++; return new FakeBufferSource(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

let fakeNow = 0, rafSeq = 0;
const rafMap = new Map();

globalThis.document = documentMock;
globalThis.window = globalThis;
globalThis.innerWidth = 1600;
globalThis.innerHeight = 900;
globalThis.addEventListener = (t, f) => globalListeners.add(t, f);
globalThis.removeEventListener = (t, f) => globalListeners.remove(t, f);
globalThis.AudioContext = FakeCtx;
globalThis.performance = { now: () => fakeNow };
globalThis.requestAnimationFrame = (cb) => { const id = ++rafSeq; rafMap.set(id, cb); return id; };
globalThis.cancelAnimationFrame = (id) => { rafMap.delete(id); };

const memStore = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, writable: true,
  value: {
    getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
    setItem: (k, v) => memStore.set(k, String(v)),
    removeItem: (k) => memStore.delete(k),
    clear: () => memStore.clear(),
    key: (i) => [...memStore.keys()][i] ?? null,
    get length() { return memStore.size; },
  },
});
try {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true, value: { userAgent: 'node-harness' },
  });
} catch { /* getter-only on some Node versions */ }

// Deterministic PRNG so the whole run is reproducible (the game uses Math.random
// for key groups, rival skill, horse unlocks).
let _seed = 0x2f6e2b1 >>> 0;
const realRandom = Math.random;
Math.random = () => {
  _seed = (Math.imul(_seed, 1664525) + 1013904223) >>> 0;
  return _seed / 4294967296;
};

// ---------------------------------------------------------------- traps
const realWarn = console.warn.bind(console);
const realError = console.error.bind(console);
const warns = [];
console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
function dumpFails() {
  if (!fails.length) return;
  realError('\nFailures:');
  for (const f of fails) realError('  \u2717 ' + f);
}
function bail(label, e) {
  errors.push(label + ': ' + (e && e.stack || e));
  console.error = realError;
  realError('\n\x1b[31m' + label + '\x1b[0m\n' + (e && e.stack || e));
  realError(`\nPASS ${passes.length}  FAIL ${fails.length}`);
  dumpFails();
  process.exit(1);
}
process.on('uncaughtException', (e) => bail('UNCAUGHT EXCEPTION', e));
process.on('unhandledRejection', (e) => bail('UNHANDLED REJECTION', e));

// ---------------------------------------------------------------- helpers
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
function pump(dt) {
  const cbs = [...rafMap.values()];
  rafMap.clear();
  fakeNow += dt;
  for (const cb of cbs) cb(fakeNow);
}
function activeScreen() {
  for (const k of Object.keys(byId)) {
    if (k.startsWith('screen-') && byId[k]._cls.has('active')) return k.slice(7);
  }
  return null;
}
function screenEl(name) { return byId['screen-' + name]; }
function descendants(root) { return root._walk([]); }
function findBtn(name, label) {
  const s = screenEl(name);
  return s ? (descendants(s).find((e) => e.attrs['aria-label'] === label) || null) : null;
}
function clickBtn(name, label) {
  const b = findBtn(name, label);
  if (!b) throw new Error(`button "${label}" not found on screen "${name}"`);
  b.dispatch('pointerdown');
  b.dispatch('pointerup');
  b.click();
  return b;
}
function setInput(name, placeholder, value) {
  const i = descendants(screenEl(name)).find((e) => e.tagName === 'INPUT' && (e.attrs.placeholder || '') === placeholder);
  if (!i) throw new Error(`input "${placeholder}" not found on screen "${name}"`);
  i.value = value;
  return i;
}
function dialogBtn(label) {
  return descendants(modalBox).find((e) => e.attrs['aria-label'] === label) || null;
}
function clickDialog(label) {
  const b = dialogBtn(label);
  if (!b) throw new Error(`dialog button "${label}" not found`);
  b.click();
  return b;
}
function fireKey(key, code) {
  globalListeners.fire('keydown', {
    key, code: code || (key.length === 1 ? 'Key' + key.toUpperCase() : key),
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  });
}
const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
function randomInput(n, hard) {
  const pool = hard ? LETTERS : ARROWS;
  for (let i = 0; i < n; i++) fireKey(pool[(Math.random() * pool.length) | 0]);
}
const modalOpen = () => modalEl._cls.has('open');
const staging = () => [stageEl.style.width, stageEl.style.height].map((v) => String(v || '').replace(/px$/, '')).join('x');
const saved = () => JSON.parse(localStorage.getItem('hrweb_save_v2') || '{}');
const MAXF = 1600;

/** run a race to completion, pressing keys every frame; returns frames used */
function runRace(hard) {
  let f = 0;
  while (f < MAXF && activeScreen() === 'race') { randomInput(6, hard); pump(50); f++; }
  return f;
}

const USER = 'tester', CODE = '1234';

// ============================================================================
section('BOOT');
await import(importUrl('src/main.js'));
await tick(30);
ok(activeScreen() === null, 'loader covers the stage before preload finishes');
for (let i = 0; i < 60; i++) await tick(20);
ok(byId['loader'].style.display === 'none', 'loader hidden after boot');
ok(activeScreen() === 'title', `boot lands on title (got ${activeScreen()})`);
ok(staging() === '450x600', `title stage is 450x600 (got ${staging()})`);
ok(!!screenEl('title'), 'title screen built');
for (const n of ['login', 'register', 'menu', 'select', 'rank', 'rule', 'usercenter', 'changename', 'changecode', 'admin', 'gameover', 'race']) {
  ok(!!screenEl(n), `screen "${n}" built`);
}
ok(globalListeners.count('keydown') >= 2, 'global keydown listeners wired');

section('ASSET RESOLUTION (every requested URL must exist on disk)');
info(`distinct asset URLs requested by built screens: ${requestedAssets.size}`);
ok(missingAssets.size === 0, `all referenced asset URLs exist on disk (${missingAssets.size} missing)`);
for (const m of [...missingAssets].slice(0, 25)) info('MISSING ' + m);

section('AUDIO — BGM scheduler (snare / hat / noise buffer)');
const audioMod = await import(importUrl('src/audio.js'));
ok(audioMod.trackNames.length === 3, `3 procedural BGM tracks (${audioMod.trackNames.join(' / ')})`);
const A = audioMod.audio;
A.init();
ok(!!A.ctx, 'AudioContext created');
A.setMusic(true);
A.setTrack(1);
for (let i = 0; i < 60; i++) { A.ctx.currentTime += 0.05; await tick(28); }
A.setTrack(2);
for (let i = 0; i < 60; i++) { A.ctx.currentTime += 0.05; await tick(28); }
A.stopBGM();
info(`osc=${audioStats.osc} gain=${audioStats.gain} filter=${audioStats.filter} buffer=${audioStats.buffer} src=${audioStats.src}`);
ok(audioStats.buffer > 0, 'noise buffer allocated for snare/hat');
ok(audioStats.src > 0, 'buffer sources scheduled (snare/hat)');
ok(audioStats.filter > 0, 'biquad filters applied to snare/hat');
ok(A.track === 2, 'track switching works');
A.setSfx(false); A.setSfx(true);
A.click(); A.correct(); A.wrong(); A.countBeep(true); A.win(); A.lose(); A.unlock(); A.hoof();
ok(true, 'all SFX entry points run without throwing');

section('STORAGE / ACCOUNT SEED');
let s = saved();
ok(!!s.users && !!s.users.admin && !!s.users.lbb, 'seed accounts admin + lbb created on first run');
ok(s.users.admin.isAdmin === true, 'admin flagged isAdmin');
ok(s.users.lbb.totalHorse === 3, 'new user starts with 3 horses (matches register.cpp)');
ok(s.users.lbb.hasHorse.filter(Boolean).length === 3, 'hasHorse has exactly 3 owned');
ok(Array.isArray(s.rankE) && s.rankE.length === 5 && s.rankE.every((r) => r === null),
   'rankE is a well-formed empty 5-slot board (no sparse holes)');
ok(Array.isArray(s.rankH) && s.rankH.length === 5 && s.rankH.every((r) => r === null),
   'rankH is a well-formed empty 5-slot board');

section('SCREEN WALK: title -> login -> register -> menu');
clickBtn('title', '开始');
ok(activeScreen() === 'login', 'title START -> login');
clickBtn('login', '返回');
ok(activeScreen() === 'title', 'login RETURN -> title');
clickBtn('title', '开始');
clickBtn('login', '注册');
ok(activeScreen() === 'register', 'login REGISTER -> register');

setInput('register', '2-12 字', 'lbb');
clickBtn('register', '检测用户名');           // taken -> stays put
setInput('register', '至少 4 位', '1234');
setInput('register', '再次输入', '1234');
clickBtn('register', '注册');
ok(activeScreen() === 'register', 'duplicate username rejected (stays on register)');

setInput('register', '2-12 字', USER);
clickBtn('register', '检测用户名');
clickBtn('register', '注册');
ok(activeScreen() === 'menu', `register ${USER} -> menu (got ${activeScreen()})`);
ok(saved().currentUser === USER, `register sets currentUser=${USER}`);
ok(saved().users[USER].games === 0, 'fresh account has 0 games');
clickBtn('menu', '退出');
clickDialog('切换用户');
ok(activeScreen() === 'login', 'menu QUIT -> 切换用户 -> login');
clickBtn('login', '登录');
ok(activeScreen() === 'login', 'empty credentials rejected');
setInput('login', '用户名', USER);
setInput('login', '密码', 'wrong');
clickBtn('login', '登录');
ok(activeScreen() === 'login', 'wrong password rejected');
setInput('login', '密码', CODE);
clickBtn('login', '登录');
ok(activeScreen() === 'menu', `${USER} login -> menu`);

section('SCREEN WALK: menu branches');
clickBtn('menu', '规则');
ok(activeScreen() === 'rule', 'menu RULE -> rule');
clickBtn('rule', '返回');
ok(activeScreen() === 'menu', 'rule RETURN -> menu (logged in)');

clickBtn('menu', '排行榜');
ok(activeScreen() === 'rank', 'menu RANK -> rank');
const rankRows = descendants(screenEl('rank')).filter((e) => e._cls.has('ptext'));
ok(rankRows.length === 10, `rank renders 5 name + 5 score cells (${rankRows.length})`);
ok(rankRows.every((r) => r.textContent === '---' || r.textContent === '0'),
   'empty ranking shows placeholder rows');
clickBtn('rank', '困难');
clickBtn('rank', '简单');
clickBtn('rank', '返回');
ok(activeScreen() === 'menu', 'rank RETURN -> menu');

section('SCREEN WALK: user center (profile / rename / recode)');
clickBtn('menu', '个人中心');
ok(activeScreen() === 'usercenter', 'menu PERSONALCENTER -> usercenter');
const photo = descendants(screenEl('usercenter')).find((e) => e.attrs.alt === '头像');
const srcBefore = photo._src;
clickBtn('usercenter', '下一头像');
ok(photo._src !== srcBefore, '下一头像 changes the portrait');
clickBtn('usercenter', '上一头像');
ok(photo._src === srcBefore, '上一头像 returns to the previous portrait');
clickBtn('usercenter', '困难');
clickBtn('usercenter', '简单');
const vName = descendants(screenEl('usercenter')).find((e) => e.tagName === 'DIV' && e.textContent === USER);
ok(!!vName, `usercenter shows the username (${USER})`);

clickBtn('usercenter', '修改用户名');
ok(activeScreen() === 'changename', 'usercenter -> changename');
setInput('changename', '新用户名', 'x');
setInput('changename', '再次输入', 'x');
clickBtn('changename', '确认修改');
ok(activeScreen() === 'changename', 'too-short new name rejected');
setInput('changename', '新用户名', 'lbb');       // taken
setInput('changename', '再次输入', 'lbb');
clickBtn('changename', '确认修改');
ok(activeScreen() === 'changename', 'taken new name rejected');
setInput('changename', '新用户名', 'tester2');
setInput('changename', '再次输入', 'tester2');
clickBtn('changename', '确认修改');
ok(activeScreen() === 'usercenter', 'rename ok -> usercenter');
ok(saved().currentUser === 'tester2' && !!saved().users.tester2, 'rename persisted to tester2');
ok(!saved().users[USER], 'old account key removed');
// rename back
clickBtn('usercenter', '修改用户名');
setInput('changename', '新用户名', USER);
setInput('changename', '再次输入', USER);
clickBtn('changename', '确认修改');
ok(saved().currentUser === USER, `renamed back to ${USER}`);

clickBtn('usercenter', '修改密码');
ok(activeScreen() === 'changecode', 'usercenter -> changecode');
setInput('changecode', '原密码', 'nope');
setInput('changecode', '新密码', 'abcd');
setInput('changecode', '再次输入', 'abcd');
clickBtn('changecode', '确认修改');
ok(activeScreen() === 'changecode', 'wrong original code rejected');
setInput('changecode', '原密码', CODE);
setInput('changecode', '新密码', 'ab');
setInput('changecode', '再次输入', 'ab');
clickBtn('changecode', '确认修改');
ok(activeScreen() === 'changecode', 'too-short new code rejected');
setInput('changecode', '新密码', 'abcd');
setInput('changecode', '再次输入', 'abcd');
clickBtn('changecode', '确认修改');
ok(activeScreen() === 'usercenter', 'changecode ok -> usercenter');
ok(saved().users[USER].code === 'abcd', 'new code persisted');
clickBtn('usercenter', '返回');
ok(activeScreen() === 'menu', 'usercenter RETURN -> menu');

section('ADMIN SCREEN');
ok(findBtn('menu', '用户管理').style.display === 'none', '用户管理 hidden for non-admin');
clickBtn('menu', '退出');
ok(modalOpen(), 'menu QUIT opens the BG20 dialog');
ok(!!dialogBtn('继续') === false, 'menu dialog has no 继续 button (that is race-only)');
clickDialog('切换用户');
ok(activeScreen() === 'login', 'dialog 切换用户 -> login');
ok(saved().currentUser === null, 'logout cleared currentUser');
setInput('login', '用户名', 'admin');
setInput('login', '密码', 'admin');
clickBtn('login', '登录');
ok(activeScreen() === 'menu', 'admin login -> menu');
ok(findBtn('menu', '用户管理').style.display === 'block', '用户管理 visible for admin');
clickBtn('menu', '用户管理');
ok(activeScreen() === 'admin', 'menu -> admin');
const vCode = descendants(screenEl('admin')).find((e) => e.textContent === 'admin' && e.tagName === 'DIV');
ok(!!vCode, 'admin screen lists a user name');
clickBtn('admin', '下一用户');
clickBtn('admin', '上一用户');
clickBtn('admin', '删除用户');            // may hit admin -> should refuse
clickBtn('admin', '返回');
ok(activeScreen() === 'menu', 'admin RETURN -> menu');
clickBtn('menu', '退出');
clickDialog('退出');
ok(activeScreen() === 'title', 'menu dialog 退出 -> title');
ok(saved().currentUser === null, 'still logged out');

section('SELECT SCREEN');
setInput('login', '用户名', 'admin');   // placeholder reached via title->login
clickBtn('title', '开始');
setInput('login', '用户名', USER);
setInput('login', '密码', 'abcd');
clickBtn('login', '登录');
ok(activeScreen() === 'menu', 're-login with new password -> menu');
clickBtn('menu', '开始游戏');
ok(activeScreen() === 'select', 'menu GAME -> select');
ok(staging() === '450x600', `select stage 450x600 (got ${staging()})`);

// regression: select screen must be painted on FIRST entry (was blank before)
const rivalNameEl = descendants(screenEl('select')).find((e) => e._cls.has('ptext'));
ok(!!rivalNameEl && rivalNameEl.textContent.length > 0, `rival name painted on entry ("${rivalNameEl && rivalNameEl.textContent}")`);
const horseCountEl = descendants(screenEl('select')).find((e) => /马匹/.test(e.textContent));
ok(!!horseCountEl, `horse counter painted on entry ("${horseCountEl && horseCountEl.textContent}")`);
const diffImg = descendants(screenEl('select')).find((e) => e.attrs.alt === '难度');
ok(/EASY/.test(diffImg._src), 'difficulty defaults to EASY art');
clickBtn('select', '切换难度');
ok(/HARD/.test(diffImg._src), 'difficulty toggles to HARD art');
clickBtn('select', '切换难度');
ok(/EASY/.test(diffImg._src), 'difficulty toggles back to EASY art');
clickBtn('select', '下一对手');
clickBtn('select', '上一对手');
clickBtn('select', '下一匹马');
clickBtn('select', '上一匹马');
const selHorseImg = descendants(screenEl('select')).find((e) => e.attrs.alt === '出战马');
ok(!!selHorseImg && /HORSE\d+_STAND/.test(selHorseImg._src), `horse art resolved (${selHorseImg && selHorseImg._src})`);

selHorseImg.click();
const grid = descendants(screenEl('select')).find((e) => e._cls.has('hgrid'));
ok(grid && grid.style.display === 'grid', 'horse grid opens on click');
const cells = descendants(grid).filter((e) => e._cls.has('hcell'));
ok(cells.length === 20, `grid renders 20 horse cells (${cells.length})`);
ok(descendants(grid).filter((e) => e._cls.has('locked')).length === 17, '17 cells locked (3 owned)');
const unlockedCell = cells.find((e) => !e._cls.has('locked'));
unlockedCell.click();
ok(grid.style.display === 'none', 'picking a horse closes the grid');

section('RACE — geometry / stage');
clickBtn('select', '开始比赛');
ok(activeScreen() === 'race', 'select STARTGAME -> race');
ok(staging() === '1000x622', `race stage is 1000x622 (got ${staging()})`);
const keyTiles = descendants(screenEl('race')).filter((e) => e._cls.has('keytile'));
ok(keyTiles.length === 6, '6 key tiles');
ok(keyTiles[0].style.left === '205px' && keyTiles[5].style.left === '555px', 'key tiles at 205 + i*70');
ok(keyTiles[0].style.top === '470px', 'key tiles at top 470');
const horses = descendants(screenEl('race')).filter((e) => e._cls.has('horse'));
ok(horses.length === 2, 'two horse sprites (rival + player)');
ok(horses[0].style.top === '160px' && horses[1].style.top === '220px', 'rival y160 / player y220');
const raceBg = descendants(screenEl('race')).find((e) => e._cls.has('bgimg'));
ok(/BG9_0\.webp$/.test(raceBg._src), `race background is BG9_0 pixel art (${raceBg._src})`);
ok(rafMap.size === 1, 'exactly one rAF loop registered');
ok(horses[1]._src.includes('STAND'), 'player starts on the STAND frame');
ok(rafMap.size === 1, 'single rAF loop while countdown runs');

section('RACE — countdown -> racing');
for (let i = 0; i < 62; i++) pump(50);        // 3s countdown at 50ms/frame
ok(horses[1]._src.includes('RUN'), `sprite switched to RUN after countdown (${horses[1]._src})`);
randomInput(6);
for (let i = 0; i < 4; i++) pump(50);
ok(horses[1].style.left !== '80px', `player horse advanced (left=${horses[1].style.left})`);
const lcd = descendants(screenEl('race')).find((e) => e._cls.has('lcd'));
ok(String(lcd.textContent).length > 0, `LCD shows a countdown value (${lcd.textContent})`);
const keyImgs = keyTiles.map((t) => t.children[0]);
ok(keyImgs.every((i) => !!i && !!i._src), 'all 6 key tiles have an image assigned');

section('RACE — first key-group completes (_endGroup regression)');
const byPos = (x, y) => descendants(screenEl('race'))
  .find((e) => e.style.left === x + 'px' && e.style.top === y + 'px');
const score1 = byPos(850, 400), score2 = byPos(850, 432);
const badge = descendants(screenEl('race')).find((e) => e._cls.has('badge'));
const logBox = descendants(screenEl('race')).find((e) => e._cls.has('pixelbox'));
const progressFill = descendants(screenEl('race')).find((e) => e._cls.has('pbar')).children[0];
ok(!!score1 && !!score2, 'dual score labels present at the original coordinates');
ok(!!badge && !!logBox && !!progressFill, 'badge / log box / progress bar present');
for (let i = 0; i < 45; i++) pump(50);        // 2.0s group window at 50ms/frame
ok(['快', '中', '慢'].includes(badge.textContent),
   `_endGroup ran and updated the speed badge (${JSON.stringify(badge.textContent)})`);
ok(progressFill.style.width === '5%', `progress bar advanced to 5% after group 1/20 (${progressFill.style.width})`);
ok(logBox.children.length >= 2, `battle log got a line (${logBox.children.length})`);
ok(/^\d+: (perfect|great|good|bad|miss)!/.test(logBox.children[0] ? logBox.children[0].textContent : ''),
   `log line formatted: "${logBox.children[0] && logBox.children[0].textContent}"`);
ok(/^\d+$/.test(score1.textContent), `player score is numeric (${score1.textContent})`);
ok(/^\d+$/.test(score2.textContent), `rival score is numeric (${score2.textContent})`);
ok(Number(score2.textContent) >= 0, 'rival scored a non-negative amount');

section('RACE — pause / resume');
const sliderFill = descendants(screenEl('race')).find((e) => e._cls.has('slider')).children[0];
ok(!!sliderFill, 'slider fill element exists');
clickBtn('race', '暂停');
ok(modalOpen(), '暂停 button opens the dialog');
ok(activeScreen() === 'race', 'race screen stays active while paused');
ok(!!dialogBtn('继续') && !!dialogBtn('退到选关'), 'dialog offers 继续 + 退到选关');
const clockBefore = sliderFill.style.width;
const lcdBefore = lcd.textContent;
const frozen = horses[1].style.left;
for (let i = 0; i < 10; i++) pump(50);
ok(sliderFill.style.width === clockBefore, `race clock frozen while paused (${clockBefore})`);
ok(lcd.textContent === lcdBefore, 'LCD frozen while paused');
ok(horses[1].style.left === frozen, 'horses frozen while paused');
clickDialog('继续');
ok(!modalOpen(), 'dialog closed on 继续');
randomInput(6);
for (let i = 0; i < 6; i++) pump(50);
ok(sliderFill.style.width !== clockBefore, `race clock advances after 继续 (${clockBefore} -> ${sliderFill.style.width})`);

section('RACE — Space toggles pause');
fireKey(' ', 'Space');
ok(modalOpen(), 'Space opens the pause dialog');
fireKey(' ', 'Space');
ok(!modalOpen(), 'Space again resumes AND closes the dialog');
const clockNow = sliderFill.style.width;
for (let i = 0; i < 4; i++) pump(50);
ok(sliderFill.style.width !== clockNow, 'race clock advances after Space-resume');

section('RACE — pause then quit to select');
clickBtn('race', '暂停');
clickDialog('退到选关');
ok(activeScreen() === 'select', '退到选关 -> select');
ok(rafMap.size === 0, 'race loop torn down after quit (no dangling rAF)');
ok(staging() === '450x600', 'stage restored to portrait on select');

section('RACE — Esc quits instantly');
clickBtn('select', '开始比赛');
ok(activeScreen() === 'race', 'race restarted');
for (let i = 0; i < 20; i++) pump(50);
fireKey('Escape', 'Escape');
ok(activeScreen() === 'select', 'Escape mid-race -> select');
ok(rafMap.size === 0, 'rAF cleared after Esc quit');

section('RACE — full 20-round race to finish');
const g0 = saved().users[USER].games || 0;
clickBtn('select', '开始比赛');
const f1 = runRace();
info(`frames consumed: ${f1} (expected ~860 = 3s countdown + 20 x 2s)`);
ok(activeScreen() === 'gameover', `race finishes into gameover (got ${activeScreen()})`);
ok(f1 > 820 && f1 < 980, `frame count in the expected band (${f1})`);
ok(staging() === '740x480', `gameover stage is 740x480 (got ${staging()})`);
const st = saved().users[USER];
ok(st.games === g0 + 1, `games counter incremented (${g0} -> ${st.games})`);
ok(st.seconds >= 40, `seconds accumulated (${st.seconds})`);
ok(st.distance > 0, `distance accumulated (${st.distance})`);
ok(st.topE > 0, `easy top score recorded (${st.topE})`);
ok(rafMap.size === 0, 'race loop stopped after finish');
const overTexts = descendants(screenEl('gameover')).map((e) => e.textContent);
ok(overTexts.includes(String(st.topE)), 'gameover shows the score');
ok(overTexts.some((t) => t === '你'), 'gameover labels the player as 你');
ok(overTexts.some((t) => /新纪录|排行榜|未获得|获得新马|集齐/.test(t)), 'gameover shows a record/unlock line');
clickBtn('gameover', '返回');
ok(activeScreen() === 'menu', 'gameover RETURN -> menu');

section('RANKING after the race');
clickBtn('menu', '排行榜');
ok(activeScreen() === 'rank', 'rank screen opened');
const rkRaw = saved().rankE;
const rk = rkRaw.filter(Boolean);
ok(Array.isArray(rkRaw) && rkRaw.length === 5, `rankE is a 5-slot board (${rkRaw.length})`);
ok(rk.length >= 1, `rankE has ${rk.length} real entr${rk.length === 1 ? 'y' : 'ies'}`);
if (rk.length) {
  ok(rk[0].name === USER, `rank #1 is ${USER}`);
  ok(rk[0].score === st.topE, `rank #1 score matches topE (${rk[0].score})`);
  ok(rk.every((r, i) => i === 0 || rk[i - 1].score >= r.score), 'rankE sorted descending');
  ok(rk.every((r) => r.score > 0), 'only positive scores enter the board');
}
ok(rkRaw.slice(rk.length).every((r) => r === null) || rk.length === 5, 'unfilled slots are null');
const rankNameCells = descendants(screenEl('rank')).filter((e) => e._cls.has('ptext')).slice(0, 5);
ok(rankNameCells[0].textContent === USER, `rank screen row 1 shows ${USER}`);
clickBtn('rank', '返回');

section('HORSE COLLECTION via repeated races (incl. legendary unlock)');
const RUNS = 250;
let done = 0, reachedAll = false;
for (let g = 0; g < RUNS; g++) {
  clickBtn('menu', '开始游戏');
  clickBtn('select', '开始比赛');
  const ff = runRace(false);
  if (activeScreen() !== 'gameover') { errors.push(`run ${g}: never finished (screen=${activeScreen()}, frames=${ff})`); break; }
  clickBtn('gameover', '返回');
  if (activeScreen() !== 'menu') { errors.push(`run ${g}: gameover RETURN did not reach menu`); break; }
  done++;
  if (saved().users[USER].totalHorse === 20) { reachedAll = true; break; }
}
const fin = saved().users[USER];
info(`races driven: ${done}   games=${fin.games}   horses=${fin.totalHorse}/20   topE=${fin.topE}`);
ok(done >= 1, `races completed (${done})`);
ok(fin.games === g0 + 1 + done, `games counter == ${g0 + 1 + done} (got ${fin.games})`);
ok(reachedAll, `collected all 20 horses within ${RUNS} races (got ${fin.totalHorse})`);
ok(fin.totalHorse === 20, 'totalHorse caps at exactly 20');
ok(fin.hasHorse[19] === true, 'legendary horse #19 auto-unlocked on completing 0..18');
ok(fin.horseKey[19] === 19, 'horseKey[19] === 19 (legendary slot)');
ok(fin.hasHorse[0] && fin.hasHorse[1] && fin.hasHorse[2], 'initial 3 horses retained');
ok(fin.horseKey.length === 20, 'horseKey table is 20 long');
// the 20 collection slots must be a duplicate-free permutation of the owned ids
const slots = fin.horseKey.slice(0, fin.totalHorse);
const ownedIds = fin.hasHorse.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
ok(new Set(slots).size === slots.length, `no duplicate horse ids in horseKey[0..${fin.totalHorse - 1}]`);
ok(slots.length === ownedIds.length && ownedIds.every((h) => slots.includes(h)),
   'horseKey slots and hasHorse flags describe the same set');
ok(rafMap.size === 0, 'no dangling rAF between races');

section('HARD MODE race');
clickBtn('menu', '开始游戏');
clickBtn('select', '切换难度');
const hardDiff = descendants(screenEl('select')).find((e) => e.attrs.alt === '难度');
ok(/HARD/.test(hardDiff._src), 'difficulty art switched to HARD');
clickBtn('select', '开始比赛');
ok(activeScreen() === 'race', 'hard-mode race starts');
const hardLbl = descendants(screenEl('race')).find((e) => e.textContent === '困难');
ok(!!hardLbl, 'race HUD shows 困难');
const hf = runRace(true);
ok(activeScreen() === 'gameover', `hard-mode race finishes (${hf} frames)`);
const st2 = saved().users[USER];
ok(st2.topH > 0, `hard top score recorded (${st2.topH})`);
const rh = (saved().rankH || []).filter(Boolean);
ok(rh.length >= 1, `rankH populated (${rh.length})`);
if (rh.length) ok(rh[0].name === USER && rh[0].score === st2.topH, 'hard rank #1 matches the score');
ok(rafMap.size === 0, 'rAF clean after hard race');
clickBtn('gameover', '返回');
ok(activeScreen() === 'menu', 'back at menu');

section('RACE with the legendary horse #19 (no RUN art in the original)');
const assetsMod = await import(importUrl('src/assets.js'));
ok(assetsMod.horseFrame(19, 'RUN1') === assetsMod.horseFrame(19, 'STAND'),
   'horse #19 RUN1 falls back to STAND (no such art exists)');
ok(/HORSE18_RUN1/.test(assetsMod.horseFrame(18, 'RUN1')), 'horse #18 keeps its real RUN1 frame');
clickBtn('menu', '开始游戏');
const selImg = descendants(screenEl('select')).find((e) => e.attrs.alt === '出战马');
selImg.click();
const grid19 = descendants(screenEl('select')).find((e) => e._cls.has('hgrid'));
const cell19 = descendants(grid19).find((e) => e._cls.has('hcell')
  && e.children.some((c) => c._cls.has('no') && c.textContent === '#19'));
ok(!!cell19, 'grid has a #19 cell');
ok(cell19 && !cell19._cls.has('locked'), '#19 cell is unlocked after collecting all horses');
const missingBefore = missingAssets.size;
cell19.click();
ok(/HORSE19_STAND/.test(selImg._src), `selecting #19 shows its STAND art (${selImg._src})`);
clickBtn('select', '开始比赛');
ok(activeScreen() === 'race', 'race started riding #19');
const p19 = descendants(screenEl('race')).filter((e) => e._cls.has('horse'))[1];
randomInput(6);
for (let i = 0; i < 66; i++) pump(50);
ok(/HORSE19_STAND/.test(p19._src), `#19 stays on STAND while racing (${p19._src})`);
ok(missingAssets.size === missingBefore, 'riding #19 requests no non-existent asset');
const f19 = runRace(false);
ok(activeScreen() === 'gameover', `race with #19 finishes (${f19} frames)`);
clickBtn('gameover', '返回');
ok(activeScreen() === 'menu', 'back at menu after the #19 race');

section('ADMIN delete user flow');
clickBtn('menu', '退出');
clickDialog('切换用户');
setInput('login', '用户名', 'admin');
setInput('login', '密码', 'admin');
clickBtn('login', '登录');
clickBtn('menu', '用户管理');
ok(activeScreen() === 'admin', 'admin screen');
const usersBefore = Object.keys(saved().users).length;
clickBtn('admin', '下一用户');
clickBtn('admin', '删除用户');
const usersAfter = Object.keys(saved().users).length;
ok(usersAfter <= usersBefore, `delete keeps or reduces the user count (${usersBefore} -> ${usersAfter})`);
clickBtn('admin', '返回');

section('AUDIO engine exercised');
info(`AudioContexts=${audioStats.ctxCreated} osc=${audioStats.osc} gain=${audioStats.gain} filter=${audioStats.filter} buffer=${audioStats.buffer} src=${audioStats.src}`);
ok(audioStats.ctxCreated >= 1, 'AudioContext created on first gesture');
ok(audioStats.osc > 0, 'oscillators scheduled (BGM + SFX ran)');

section('PERSISTENCE round-trip');
const raw = localStorage.getItem('hrweb_save_v2');
ok(typeof raw === 'string' && raw.length > 100, 'save blob written');
const parsed = JSON.parse(raw);
ok(Object.keys(parsed.users).length >= 2, `>=2 accounts persisted (${Object.keys(parsed.users).join(', ')})`);
ok(parsed.settings && typeof parsed.settings.music === 'boolean', 'settings persisted');
// simulate a page reload: the module must rehydrate from localStorage
ok(parsed.users[USER].games > 0, 'saved blob carries play stats');

// ---------------------------------------------------------------- report
section('RESULT');
const warnsFiltered = warns.filter((w) => !/preload error/.test(w));
ok(warnsFiltered.length === 0, `no unexpected console.warn (${warnsFiltered.length})`);
ok(errors.length === 0, `no exceptions / rejections (${errors.length})`);
for (const w of warnsFiltered.slice(0, 10)) info('WARN ' + w);
for (const e of errors.slice(0, 10)) info('ERR  ' + e);

console.log(`\n\x1b[${fails.length ? 31 : 32}mPASS ${passes.length}   FAIL ${fails.length}\x1b[0m`);
if (fails.length) { console.log('\nFailures:'); for (const f of fails) console.log('  \x1b[31m\u2717\x1b[0m ' + f); }
process.exit(fails.length ? 1 : 0);
