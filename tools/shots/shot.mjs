// shot.mjs — screenshot driver, runs inside tools/shots/shot.html.
//
// The capture page embeds the real /index.html in a same-origin iframe, so every
// screenshot exercises the shipped page exactly as-is (no duplicated markup).
//
// Flow: seed localStorage -> size the iframe to an exact multiple of the stage ->
// load the app -> drive the UI with real DOM events -> pin the stage transform to
// that exact integer zoom -> hand over to Chrome's screenshot action.
//
// The stage is always pinned to an INTEGER scale so pixel art stays pixel-perfect
// (the app itself fits the stage with a 0.98 margin, which would resample).
//
// Usage: shot.html?scene=race[&scale=2]
// Add ?report=1 (or use the probe scene) to show the status text instead of the app.

import { byId, STAGE } from './scenes.mjs';

const q = new URLSearchParams(location.search);
const sceneId = q.get('scene') || 'title';
const scene = byId(sceneId);
const scale = Number(q.get('scale') || (scene ? scene.scale : 2));

const frame = document.getElementById('app-frame');
const out = document.getElementById('out');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Deliberately NOT requestAnimationFrame: see patchRaf() below — rAF is the one
// thing that does not tick under Chrome's virtual time clock.
const nextFrame = () => new Promise((r) => setTimeout(r, 0));
const doc = () => frame.contentDocument;
const win = () => frame.contentWindow;

/**
 * The race loop in src/game.js is requestAnimationFrame-driven, but under
 * --virtual-time-budget the headless compositor produces almost no frames, so a
 * rAF chain stalls after its first tick and the race can never progress. rAF is
 * therefore re-pointed at setTimeout — which *does* advance the virtual clock —
 * and fed performance.now(), the timestamp the game already expects.
 */
function patchRaf(w) {
  if (!w || w.__shotRafPatched) return;
  w.__shotRafPatched = true;
  let id = 0;
  const timers = new Map();
  w.requestAnimationFrame = (cb) => {
    const n = ++id;
    timers.set(n, setTimeout(() => { timers.delete(n); cb(w.performance.now()); }, 16));
    return n;
  };
  w.cancelAnimationFrame = (n) => {
    const t = timers.get(n);
    if (t !== undefined) { clearTimeout(t); timers.delete(n); }
  };
}

// ---------------------------------------------------------------- reporting
let STATUS = 'ok';

// Progress breadcrumbs. A capture that never reaches 'done' is otherwise a
// silent mystery (the PNG exists, the title is stale); recording each step and
// publishing the last one as the page title makes the stall point explicit.
const STEPS = [];
function step(name) {
  STEPS.push(name);
  out.textContent = STEPS.join('\n');
  document.title = 'SHOT-' + STATUS + ' ' + sceneId + ' @' + name;
}

/** Publish the outcome for the capture script (see capture.mjs). */
function finish() {
  window.__shotDone = true;
  window.__shotStatus = STATUS;
  window.__shotScene = sceneId;
  window.__shotReport = out.textContent;
}

function report(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
  out.textContent = text;
  document.body.classList.add('report');
  document.title = 'SHOT-' + STATUS + ' ' + sceneId;
  finish();
  return text;
}
/** Make a driver failure impossible to miss: the screenshot becomes magenta. */
function fail(err) {
  STATUS = 'error';
  const stack = (err && err.stack) || String(err);
  const body = document.body;
  body.classList.remove('report');
  body.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:99;background:#ff00ff;color:#000;' +
    'font:14px/1.5 ui-monospace,monospace;padding:24px;white-space:pre-wrap';
  box.textContent = 'SCREENSHOT DRIVER ERROR\n\nscene : ' + sceneId +
    '\nsteps : ' + STEPS.join(' > ') + '\n\n' + stack;
  body.appendChild(box);
  document.title = 'SHOT-error ' + sceneId + ' @' + (STEPS[STEPS.length - 1] || 'start');
  out.textContent = box.textContent;
  finish();
}

// ---------------------------------------------------------------- DOM helpers
const activeScreen = () => {
  const s = doc().querySelector('.screen.active');
  return s ? s.id.replace('screen-', '') : null;
};
const shown = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

// Chrome serialises inline colours back as rgb(...), so `style.color === '#008000'`
// never matches. Normalise both sides through a scratch element instead.
const _colorProbe = document.createElement('span');
function normColor(v) {
  if (!v) return '';
  _colorProbe.style.color = '';
  _colorProbe.style.color = v;
  return _colorProbe.style.color || v;
}
const buttons = () => [...doc().querySelectorAll('button')].filter(shown);
function btn(label) {
  return buttons().find((b) => b.getAttribute('aria-label') === label) || null;
}
async function click(label) {
  const b = btn(label);
  if (!b) {
    throw new Error(`button not found: "${label}" (screen=${activeScreen()})\n` +
      'visible buttons: ' + buttons().map((x) => x.getAttribute('aria-label') || x.textContent).join(' | '));
  }
  b.click();
  await sleep(0);
  await nextFrame();
  return b;
}
function fill(placeholder, value) {
  const el = [...doc().querySelectorAll('input')].find((i) => i.placeholder === placeholder && shown(i));
  if (!el) throw new Error('input not found: ' + placeholder);
  el.value = value;
  el.dispatchEvent(new (win().Event)('input', { bubbles: true }));
  el.dispatchEvent(new (win().Event)('change', { bubbles: true }));
  return el;
}
function key(k) {
  const code = /^Arrow/.test(k) ? k : 'Key' + k.toUpperCase();
  win().dispatchEvent(new (win().KeyboardEvent)('keydown', {
    key: k, code, bubbles: true, cancelable: true,
  }));
}

// Anything the app throws inside the iframe (a blocked AudioContext, a missing
// asset, ...) would otherwise be invisible: it just makes a driver wait time out.
const PAGE_ERRORS = [];
function watchErrors(w) {
  if (!w || w.__shotWatched) return;
  w.__shotWatched = true;
  w.addEventListener('error', (e) => PAGE_ERRORS.push('error: ' + (e.message || e.error)));
  w.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    PAGE_ERRORS.push('rejection: ' + ((r && (r.stack || r.message)) || r));
  });
}
const errTail = () => (PAGE_ERRORS.length ? '\n  page errors:\n    ' + PAGE_ERRORS.slice(-6).join('\n    ') : '');

/** Wait for a predicate. Returns whatever the predicate returned, so element
 *  lookups can be written as `const el = await waitFor(() => querySelector(...))`. */
async function waitFor(fn, label, ms = 15000, diagnose) {
  const t0 = Date.now();
  step('wait:' + label);
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) {
      throw new Error('timeout waiting for ' + label +
        (diagnose ? '\n  state: ' + diagnose() : '') + errTail());
    }
    await sleep(25);
  }
}

// ---------------------------------------------------------------- fixtures
// Seed through the app's own storage module (same origin, same localStorage), so
// the fixture can never drift from the real data model.
const RIVAL_EASY = [['星尘', 12750], ['闪电', 11980], ['疾风', 10460], ['霜羽', 9780]];
const RIVAL_HARD = [['赤兔', 9240], ['夜骐', 8460], ['金鬃', 7140], ['幻影', 6580]];
const LBB_TOP_E = 11240;
const LBB_TOP_H = 7820;

async function seed(kind) {
  localStorage.clear();
  if (kind === 'fresh') return '空存档：应用自建 admin/lbb，停在标题页';

  const S = await import('/src/storage.js');
  const users = [];
  const addUser = (name, code, isAdmin) => {
    const r = S.register(name, code);
    if (!r.ok) throw new Error(`seed: register(${name}) -> ${r.msg}`);
    if (isAdmin) { S.current().isAdmin = true; S.persist(); }
    users.push(name);
    return S.current();
  };
  const play = (score, isHard, horse = 0) =>
    S.recordResult({ isHard, score, horse, distance: Math.round(score / 8) });

  addUser('admin', 'admin', true);
  S.logout();
  if (kind === 'accounts') return `仅账号（admin/lbb），未登录 → 标题页`;

  for (const [n, s] of RIVAL_EASY) { addUser(n, '1234'); play(s, false); S.logout(); }
  for (const [n, s] of RIVAL_HARD) { addUser(n, '1234'); play(s, true); S.logout(); }

  const lbb = addUser('lbb', '1234', false);
  // Stay logged in: every runner starts from the main menu, so a seed that ends
  // logged out would strand the driver on the title screen.
  if (kind === 'rivals') return '对手榜已填满 · 以 lbb（新号，3 匹马）登录 → 主菜单';

  play(LBB_TOP_E, false);                       // -> #3 on the easy board
  play(LBB_TOP_H, true, 1);                     // -> #3 on the hard board
  let guard = 0;
  while (lbb.totalHorse < 11 && guard++ < 80) play(4800 + guard * 60, false, 2);
  lbb.Port = 3;
  S.persist();

  const info = `lbb: ${lbb.games} 局 / ${lbb.totalHorse} 匹马 / topE ${lbb.topE} (rank ${lbb.rankTopE})`;
  if (kind === 'admin') { S.login('admin', 'admin'); return `以 admin 登录 · ${info}`; }
  return `以 lbb 登录 · ${info}`;
}

// ---------------------------------------------------------------- race driving
// Read the expected key straight off the current key tile (the tile art IS the
// prompt — there is no hidden queue), then press it. Every 7th press is
// deliberately wrong so the red state shows up in the capture.
function expectedKey() {
  const box = doc().querySelector('#screen-race .keytile.cur');
  if (!box) return null;
  const im = box.querySelector('img');
  const src = (im && im.getAttribute('src')) || '';
  const m = /keys\/([A-Za-z]+?)(?:_[GR])?\.webp$/.exec(src);
  if (!m) return null;
  const t = m[1].toUpperCase();
  return { UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight' }[t] || t.toLowerCase();
}
function otherKey(k) {
  const arrows = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  const i = arrows.indexOf(k);
  if (i >= 0) return arrows[(i + 1) % 4];
  return k === 'a' ? 'b' : 'a';
}

async function enterRace() {
  await click('开始游戏');
  await waitFor(() => activeScreen() === 'select', 'select screen');
  await click('开始比赛');
  await waitFor(() => activeScreen() === 'race', 'race screen');
  // wait out the 3s countdown so the HUD is in its racing state
  const lcdState = () => {
    const l = doc().querySelector('#screen-race .lcd');
    return l ? `lcd=${JSON.stringify(l.textContent)} color=${l.style.color}` : 'lcd=absent';
  };
  await waitFor(() => {
    const l = doc().querySelector('#screen-race .lcd');
    return l && normColor(l.style.color) === normColor('#008000');
  }, 'countdown to finish', 20000, lcdState);
}

/**
 * Play the race with real DOM events.
 *   untilGameover  keep playing until the result screen appears
 *   pauseAfterMs   play this long, then hit 暂停游戏 and settle on the pause dialog
 *   forMs          otherwise play for this long (default: enough groups for the
 *                  score, slider and battle log to be visibly populated)
 */
async function driveRace({ mistakes, untilGameover, pauseAfterMs, forMs = 5000 }) {
  await enterRace();
  let n = 0;
  const t0 = Date.now();
  const tick = () => {
    if (untilGameover && activeScreen() !== 'race') return;
    if (pauseAfterMs && !tick.paused && Date.now() - t0 > pauseAfterMs) {
      tick.paused = true;
      const b = btn('暂停游戏');
      if (b) b.click();
      return;
    }
    if (tick.paused) return;
    const t = expectedKey();
    if (t) { n++; key(mistakes && n % 7 === 0 ? otherKey(t) : t); }
  };
  const timer = setInterval(tick, 110);
  try {
    if (untilGameover) {
      await waitFor(() => activeScreen() === 'gameover', 'gameover screen', 90000);
    } else if (pauseAfterMs) {
      await waitFor(() => tick.paused, 'pause to be requested', pauseAfterMs + 8000);
      // the pause dialog must actually be up (继续 / 退到选关), not just requested
      await waitFor(() => btn('继续') && btn('退到选关'), 'pause dialog');
      await sleep(250);
    } else {
      await sleep(forMs);
    }
  } finally {
    clearInterval(timer);
  }
  return `${n} 次按键 · 阶段 ${activeScreen()} · 组 ${doc().querySelector('#screen-race .lcd')?.textContent}`;
}
/** Perfect play (never miss) — used for the result screen so it shows a top score. */
const perfect = (o) => driveRace(Object.assign({ mistakes: false }, o));

// ---------------------------------------------------------------- scenes
const RUNNERS = {
  title: async () => {},
  login: async () => {
    await click('开始');
    await waitFor(() => activeScreen() === 'login', 'login screen');
    fill('用户名', 'admin');
    fill('密码', 'admin');
  },
  register: async () => {
    await click('开始');
    await click('注册');
    await waitFor(() => activeScreen() === 'register', 'register screen');
    fill('2-12 字', 'lbb');
    fill('至少 4 位', '1234');
    fill('再次输入', '1234');
    await click('检测用户名');
    await sleep(80);
  },
  menu: async () => {},
  select: async () => {
    await click('开始游戏');
    await waitFor(() => activeScreen() === 'select', 'select screen');
  },
  stable: async () => {
    await click('开始游戏');
    await waitFor(() => activeScreen() === 'select', 'select screen');
    const im = await waitFor(() => doc().querySelector('#screen-select img[title]'), 'horse preview');
    im.click();
    await sleep(120);
  },
  race: async () => driveRace({ mistakes: true }),
  pause: async () => driveRace({ mistakes: true, pauseAfterMs: 2400 }),
  gameover: async () => perfect({ untilGameover: true }),
  rank: async () => {
    await click('排行榜');
    await waitFor(() => activeScreen() === 'rank', 'rank screen');
  },
  usercenter: async () => {
    await click('个人中心');
    await waitFor(() => activeScreen() === 'usercenter', 'usercenter screen');
  },
  rule: async () => {
    await click('规则');
    await waitFor(() => activeScreen() === 'rule', 'rule screen');
  },
  admin: async () => {
    await click('用户管理');
    await waitFor(() => activeScreen() === 'admin', 'admin screen');
  },
  probe: async () => probeReport(),
};

// ---------------------------------------------------------------- audit mode
// Walks every screen and reports anything broken: 404'd images, elements that
// fall outside the stage, and the pixel-fidelity invariants that were violated
// before the redesign (a fabricated key tile, an invented badge, Zpix-vs-original
// colours, and so on).
async function probeReport() {
  const d = doc();
  const w = win();
  const cs = (el) => w.getComputedStyle(el);
  const lines = [];
  const ok = (cond, msg) => lines.push(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  let failures = 0;
  const check = (cond, msg) => { if (!cond) failures++; ok(cond, msg); };

  // ---- 1. every requested image actually loaded
  const imgs = [...d.querySelectorAll('img')];
  const broken = [...new Set(imgs.filter((i) => i.getAttribute('src') && i.naturalWidth === 0).map((i) => i.getAttribute('src')))];
  check(broken.length === 0, `images loaded (${imgs.length} in DOM, ${broken.length} broken)`);
  for (const b of broken) lines.push('        BROKEN ' + b);

  // ---- 2. HTTP-level failures (a 404'd font/asset never becomes an <img>)
  const res = w.performance.getEntriesByType('resource');
  const bad = res.filter((r) => r.responseStatus >= 400);
  check(bad.length === 0, `resource requests (${res.length}, ${bad.length} >=400)`);
  for (const b of bad.slice(0, 10)) lines.push(`        HTTP ${b.responseStatus} ${b.name}`);

  // ---- 3. nothing may fall outside the stage, on any screen
  // Each screen has its OWN stage size, which the app derives from that screen's
  // original background art (450x600 menus, 1000x622 race, 740x480 game-over).
  // Measuring every screen against whichever stage happened to be on screen produced
  // 21 bogus hits, so resize the stage to each screen's own art before measuring.
  const stage = d.getElementById('stage');
  const prevW = stage.style.width, prevH = stage.style.height;
  const oob = [];
  for (const sec of [...d.querySelectorAll('.screen')]) {
    const name = sec.id.replace('screen-', '');
    for (const s of d.querySelectorAll('.screen')) s.classList.toggle('active', s === sec);
    const bg = sec.querySelector('.bgimg');
    const lw = bg && bg.naturalWidth ? bg.naturalWidth : 450;
    const lh = bg && bg.naturalHeight ? bg.naturalHeight : 600;
    stage.style.width = lw + 'px'; stage.style.height = lh + 'px';
    const sr = stage.getBoundingClientRect();
    const k = sr.width / lw;
    for (const el of sec.querySelectorAll('*')) {
      const st = cs(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const L = (r.left - sr.left) / k, T = (r.top - sr.top) / k;
      const W = r.width / k, H = r.height / k;
      if (L < -1 || T < -1 || L + W > lw + 1 || T + H > lh + 1) {
        oob.push(`${name}: ${el.className || el.tagName} @${L.toFixed(0)},${T.toFixed(0)} ${W.toFixed(0)}x${H.toFixed(0)} (stage ${lw}x${lh})`);
      }
    }
  }
  stage.style.width = prevW; stage.style.height = prevH;
  check(oob.length === 0, `all elements inside the stage (${oob.length} outside)`);
  for (const o of oob.slice(0, 15)) lines.push('        OOB ' + o);

  // ---- 4. pixel-fidelity invariants (regressions we actually shipped before)
  const race = d.getElementById('screen-race');
  const tiles = [...race.querySelectorAll('.keytile')];
  check(tiles.length === 6, `6 key tiles`);
  check(tiles.every((t) => cs(t).backgroundColor === 'rgba(0, 0, 0, 0)'),
    'key tiles are transparent (the original art is a bare glyph, no tile)');
  check(tiles.every((t) => cs(t.querySelector('img')).width === '64px'),
    'key glyphs render at their native 64x64');
  check(!d.querySelector('.badge'), 'no invented round badge on the race HUD');
  check(!d.querySelector('#screen-title .chip'), 'no invented music chip on the title screen');
  const lcd = race.querySelector('.lcd');
  check(lcd && cs(lcd).backgroundColor === 'rgb(255, 255, 0)', `LCD background is yellow (${lcd && cs(lcd).backgroundColor})`);
  const at = (x, y) => [...race.querySelectorAll('*')].find((e) => e.style.left === x + 'px' && e.style.top === y + 'px');
  const want = [
    ['pause 暂停游戏 button', at(40, 30), '100x50'],
    ['slider', at(180, 440), '462x22'],
    ['label_lefttime', at(640, 440), null],
    ['label_isHard', at(20, 440), null],
    ['LCD', at(20, 490), '101x51'],
    ['label_S', at(130, 490), null],
    ['score1', at(850, 400), null],
    ['score2', at(850, 433), null],
    ['log box', at(830, 480), '131x111'],
    ['progress bar', at(23, 581), '789x20'],
    ['music button', at(904, 20), '30x30'],
  ];
  const missing = want.filter(([, el]) => !el).map(([n]) => n);
  check(missing.length === 0, `race HUD widgets at the original .ui coordinates (${want.length - missing.length}/${want.length})`);
  for (const m of missing) lines.push('        MISSING ' + m);

  lines.push('');
  lines.push(`SCENE              ${sceneId}`);
  lines.push(`SEED               ${LAST_SEED_NOTE}`);
  lines.push(`FAILURES           ${failures}`);
  STATUS = failures ? 'error' : 'ok';
  return lines.join('\n');
}

// ---------------------------------------------------------------- main
let LAST_SEED_NOTE = '';

async function main() {
  if (!scene) throw new Error('unknown scene: ' + sceneId);
  const [lw, lh] = STAGE[scene.stage];

  step('seed');
  LAST_SEED_NOTE = await seed(scene.seed);

  // size the frame BEFORE loading so the app's viewport is already correct
  frame.style.width = (lw * scale) + 'px';
  frame.style.height = (lh * scale) + 'px';
  localStorage.setItem('hrweb-shot-scene', sceneId);
  step('frame-sized');

  await new Promise((resolve) => { frame.onload = resolve; frame.src = '/index.html'; });
  patchRaf(win());          // must land before the app schedules its first frame
  watchErrors(win());
  step('iframe-loaded');

  // wait for the app to build + preload + leave its loading screen
  await waitFor(() => {
    const l = doc().getElementById('loader');
    return l && l.style.display === 'none';
  }, 'app boot', 30000);
  step('booted');

  step('runner:' + sceneId);
  const runnerNote = await RUNNERS[sceneId]();
  if (typeof runnerNote === 'string') out.textContent = runnerNote;
  await nextFrame();
  step('runner-done');

  // pin the stage to an exact integer zoom (the app keeps a 0.98 fit margin)
  const stage = doc().getElementById('stage');
  const sw = parseFloat(stage.style.width), sh = parseFloat(stage.style.height);
  const k = Math.min(win().innerWidth / sw, win().innerHeight / sh);
  stage.style.transform = `translate(-50%,-50%) scale(${k})`;
  await nextFrame();
  await nextFrame();
  step('pinned');

  const rect = stage.getBoundingClientRect();
  const isProbe = sceneId === 'probe';
  const text = isProbe ? out.textContent : '';
  const summary = [
    `SCENE   ${sceneId}`,
    `SEED    ${LAST_SEED_NOTE}`,
    `STAGE   ${sw}x${sh} @ ${k}x -> ${rect.width}x${rect.height}px`,
    `VIEWPORT ${win().innerWidth}x${win().innerHeight}`,
    `SCREEN  ${activeScreen()}`,
    runnerNote ? `NOTE    ${runnerNote}` : '',
    PAGE_ERRORS.length ? `PAGE ERRORS ${PAGE_ERRORS.length}\n  ${PAGE_ERRORS.slice(-6).join('\n  ')}` : '',
    isProbe ? text : '',
  ].filter(Boolean).join('\n');

  if (isProbe || q.get('report')) { report(summary); return; }

  // Expose the status where capture.mjs can read it even for a normal shot.
  step('done');
  out.textContent = summary;
  document.title = 'SHOT-' + STATUS + ' ' + sceneId + ' src=' + Math.round(rect.width) + 'x' + Math.round(rect.height);
  finish();
}

main().catch(fail);
