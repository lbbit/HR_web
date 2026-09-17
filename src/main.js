// main.js — bootstrap, pixel-stage scaling, screen construction and all UI wiring.
//
// Layouts mirror the original Qt .ui geometry exactly (450x600 content, 1000x622
// race, 740x480 game-over). Screen chrome = original pixel background images;
// controls = original pixel button/label images.

import * as assets from './assets.js';
import * as store from './storage.js';
import { audio, trackNames } from './audio.js';
import { RaceGame, makeRival } from './game.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const modal = $('modal');
const toastEl = $('toast');

// ---------- stage scaling ----------
let stageW = assets.PORTRAIT_W, stageH = assets.PORTRAIT_H;
function fit() {
  stage.style.width = stageW + 'px';
  stage.style.height = stageH + 'px';
  const k = Math.min((innerWidth * 0.98) / stageW, (innerHeight * 0.98) / stageH);
  stage.style.transform = `translate(-50%,-50%) scale(${k})`;
}
function setStage(w, h) { stageW = w; stageH = h; fit(); }
addEventListener('resize', fit);

// ---------- tiny DOM helpers ----------
function mk(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

function pbtn(parent, o) {
  const b = mk('button', 'pbtn');
  b.type = 'button';
  const base = o.base;
  const src = o.src || assets.btn(base, 'W');
  b.style.cssText = `left:${o.x}px;top:${o.y}px;width:${o.w}px;height:${o.h}px;background-image:url("${src}")`;
  b.setAttribute('aria-label', o.label || '');
  if (o.title) b.title = o.title;
  if (base && o.states !== false) {
    const set = (s) => { b.style.backgroundImage = `url("${assets.btn(base, s)}")`; };
    b.addEventListener('pointerdown', () => set('P'));
    b.addEventListener('pointerup', () => set('W'));
    b.addEventListener('pointerleave', () => set(o.hold ? 'C' : 'W'));
    b._pxSet = (s) => set(s);
  }
  b.addEventListener('click', () => { audio.click(); if (o.onClick) o.onClick(b); });
  parent.appendChild(b);
  return b;
}

function plabel(parent, name, o) {
  const im = mk('img', 'plabel');
  im.src = assets.ui(name);
  im.style.cssText = `left:${o.x}px;top:${o.y}px;` + (o.w ? `width:${o.w}px;` : '') + (o.h ? `height:${o.h}px;` : '');
  if (!o.w) im.style.width = 'auto';
  if (!o.h) im.style.height = 'auto';
  im.alt = o.alt || '';
  parent.appendChild(im);
  return im;
}

function ptext(parent, o) {
  const d = mk('div', 'ptext ' + (o.cls || 'mid') + (o.align ? ' ' + o.align : ''));
  d.textContent = o.text || '';
  d.style.cssText = `left:${o.x}px;top:${o.y}px;` +
    (o.w ? `width:${o.w}px;` : '') + (o.h ? `height:${o.h}px;` : '') +
    (o.color ? `color:${o.color};` : '') + (o.size ? `font-size:${o.size}px;` : '');
  if (o.align === 'center') d.style.textAlign = 'center';
  parent.appendChild(d);
  return d;
}

function pimg(parent, src, o) {
  const im = mk('img', o.cls || 'plabel');
  im.src = src;
  im.style.cssText = `left:${o.x}px;top:${o.y}px;width:${o.w}px;height:${o.h}px`;
  if (o.alt !== undefined) im.alt = o.alt;
  parent.appendChild(im);
  return im;
}

function pinput(parent, o) {
  const i = mk('input', 'pxinput');
  i.type = o.password ? 'password' : (o.type || 'text');
  i.placeholder = o.placeholder || '';
  i.autocomplete = o.autocomplete || 'off';
  i.maxLength = o.maxLength || 20;
  i.style.cssText = `left:${o.x}px;top:${o.y}px;width:${o.w}px;height:${o.h || 25}px;`;
  parent.appendChild(i);
  return i;
}

let toastT = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('show'), 1700);
}

// ---------- modal dialog (BG20) ----------
function openDialog({ left, right }) {
  const box = modal.querySelector('.box');
  box.innerHTML = '';
  const bgim = mk('img', 'bgimg');
  bgim.src = assets.bg('BG20'); bgim.alt = '';
  box.appendChild(bgim);
  const mkBtn = (o) => pbtn(box, {
    base: o.base, x: o.x, y: o.y, w: o.w, h: o.h, label: o.label,
    onClick: () => { closeDialog(); o.onClick && o.onClick(); },
  });
  if (left) mkBtn({ base: left.base, x: 50, y: 70, w: 120, h: 50, label: left.label, onClick: left.onClick });
  if (right) mkBtn({ base: right.base, x: 230, y: 70, w: 120, h: 50, label: right.label, onClick: right.onClick });
  modal.classList.add('open');
  const first = box.querySelector('.pbtn');
  if (first) first.focus();
}
function closeDialog() { modal.classList.remove('open'); }
modal.addEventListener('click', (e) => { if (e.target === modal) closeDialog(); });

// ---------- screens ----------
const screens = {};
const onEnter = {};
const SPECS = {
  title: [assets.PORTRAIT_W, assets.PORTRAIT_H, 'BG0'],
  login: [assets.PORTRAIT_W, assets.PORTRAIT_H, 'BG1'],
  register: [assets.PORTRAIT_W, assets.PORTRAIT_H, 'BG2'],
  menu: [assets.PORTRAIT_W, assets.PORTRAIT_H, 'BG3'],
  select: [assets.PORTRAIT_W, assets.PORTRAIT_H, 'BG4'],
  rank: [assets.PORTRAIT_W, assets.PORTRAIT_H, 'BG5'],
  rule: [assets.PORTRAIT_W, assets.PORTRAIT_H, 'BG6'],
  usercenter: [assets.PORTRAIT_W, assets.PORTRAIT_H, 'BG7'],
  changename: [assets.PORTRAIT_W, assets.PORTRAIT_H, 'BG9'],
  changecode: [assets.PORTRAIT_W, assets.PORTRAIT_H, 'BG10'],
  admin: [assets.PORTRAIT_W, assets.PORTRAIT_H, 'BG12'],
  gameover: [740, 480, 'BG13'],
  race: [assets.RACE_BG_W, assets.RACE_BG_H, null],
};

function makeScreen(name) {
  const [, , bgName] = SPECS[name];
  const sec = mk('section', 'screen');
  sec.id = 'screen-' + name;
  if (bgName) { const b = mk('img', 'bgimg'); b.src = assets.bg(bgName); b.alt = ''; sec.appendChild(b); }
  stage.appendChild(sec);
  screens[name] = sec;
  return sec;
}

// ---------- router ----------
let race = null;
const ui = {};

function go(name) {
  if (race && name !== 'race' && name !== 'gameover') { race.destroy(); race = null; }
  for (const k in screens) screens[k].classList.remove('active');
  const [w, h] = SPECS[name];
  setStage(w, h);
  screens[name].classList.add('active');
  closeDialog();
  if (onEnter[name]) onEnter[name]();
}

// =====================================================================
//  Screen builders
// =====================================================================

// ---- TITLE (BG0) ----
function buildTitle() {
  const s = makeScreen('title');
  const art = [
    ['BUTTON_UP', 102, 410, 30, 50], ['BUTTON_DOWN', 102, 490, 30, 50],
    ['BUTTON_LEFT', 52, 460, 50, 30], ['BUTTON_RIGHT', 132, 460, 50, 30],
    ['BUTTON_B', 320, 450, 40, 40], ['BUTTON_A', 360, 410, 40, 40],
  ];
  for (const [base, x, y, w, h] of art) plabel(s, base + '_W', { x, y, w, h });
  for (const [, x, y, w, h] of art) {
    const b = mk('button', 'pbtn');
    b.type = 'button'; b.tabIndex = -1;
    b.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:transparent;`;
    b.setAttribute('aria-hidden', 'true');
    b.addEventListener('click', () => audio.click());
    s.appendChild(b);
  }
  pbtn(s, { base: 'START', x: 205, y: 410, w: 100, h: 50, label: '开始', onClick: () => go('login') });
  pbtn(s, { src: assets.ui('ABOUT_W_50_25'), x: 230, y: 470, w: 50, h: 25, label: '关于', onClick: () => go('rule') });
  pbtn(s, { base: 'QUIT', x: 210, y: 510, w: 80, h: 40, label: '退出', onClick: () => openDialog({
    left: { base: 'SWITCHUSER', label: '切换用户', onClick: () => { store.logout(); go('login'); } },
    right: { base: 'QUIT', label: '退出', onClick: () => toast('感谢游玩！可以关闭本页面了。') },
  }) });
  // NOTE: the original has no music button on the title screen — its only music
  // toggle lives on the race screen (pushButton_music, 904,20). Nothing plays
  // here either (BGM starts with the race), so adding one would be pure invention.
}
/**
 * Mirror the persisted music setting onto the race screen's original music art.
 * (Kept as a function because both the audio bootstrap and the race screen call it.)
 */
function syncMusic() {
  const btn = ui.race && ui.race.musicBtn;
  if (!btn) return;
  btn.style.backgroundImage = `url("${assets.ui(store.getSettings().music ? 'withmusic' : 'withoutmusic')}")`;
}

// ---- LOGIN (BG1) ----
function buildLogin() {
  const s = makeScreen('login');
  plabel(s, 'ACCOUNT_W_45_25', { x: 110, y: 260, w: 45, h: 25 });
  plabel(s, 'CODE_W_45_25', { x: 110, y: 330, w: 45, h: 25 });
  const acc = pinput(s, { x: 190, y: 260, w: 150, h: 25, placeholder: '用户名', autocomplete: 'username' });
  const code = pinput(s, { x: 190, y: 330, w: 150, h: 25, placeholder: '密码', password: true, autocomplete: 'current-password' });
  const msg = ptext(s, { x: 120, y: 372, w: 300, h: 22, cls: 'sm', align: 'center', color: '#b00' });
  const doLogin = () => {
    const r = store.login(acc.value, code.value);
    if (!r.ok) { msg.textContent = r.msg; msg.style.color = '#b00'; audio.wrong(); return; }
    msg.textContent = ''; go('menu');
  };
  pbtn(s, { base: 'LOGIN', x: 150, y: 400, w: 150, h: 80, label: '登录', onClick: doLogin });
  pbtn(s, { base: 'REGISTER', x: 340, y: 530, w: 80, h: 40, label: '注册', onClick: () => go('register') });
  pbtn(s, { base: 'RETURN', x: 30, y: 530, w: 80, h: 40, label: '返回', onClick: () => go('title') });
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  onEnter.login = () => { acc.value = ''; code.value = ''; msg.textContent = ''; acc.focus(); };
}

// ---- REGISTER (BG2) ----
function buildRegister() {
  const s = makeScreen('register');
  plabel(s, 'USERNAME_W_55_25', { x: 94, y: 290, w: 55, h: 25 });
  plabel(s, 'CODE_W_45_25', { x: 100, y: 340, w: 45, h: 25 });
  plabel(s, 'CONFIRMCODE_W_60_25', { x: 90, y: 390, w: 60, h: 25 });
  const name = pinput(s, { x: 160, y: 290, w: 150, h: 25, placeholder: '2-12 字' });
  const code = pinput(s, { x: 160, y: 340, w: 150, h: 25, placeholder: '至少 4 位', password: true });
  const code2 = pinput(s, { x: 160, y: 390, w: 150, h: 25, placeholder: '再次输入', password: true });
  const msg = ptext(s, { x: 90, y: 262, w: 330, h: 22, cls: 'sm', align: 'center', color: '#b00' });
  // 注册成功的瞬间会 go('menu')；若同一次交互里再迟到一次 click 事件（合成点击 /
  // 转发的激活事件等），绝不能让它把“该用户名已被占用”重新刷到界面上——
  // 那会让用户看到“报错已注册，实际却注册成功了”的自相矛盾
  let submitted = false;
  pbtn(s, { base: 'CHECK', x: 330, y: 290, w: 45, h: 24, label: '检测用户名', onClick: () => {
    if (!name.value.trim()) { msg.textContent = '请输入用户名'; msg.style.color = '#b00'; return; }
    if (store.nameTaken(name.value)) { msg.textContent = '该用户名已被占用'; msg.style.color = '#b00'; audio.wrong(); }
    else { msg.textContent = '用户名可用'; msg.style.color = '#070'; audio.correct(); }
  } });
  pbtn(s, { base: 'CHECKCONFIRM', x: 135, y: 440, w: 180, h: 70, label: '注册', onClick: () => {
    if (submitted) return;
    if (code.value !== code2.value) { msg.textContent = '两次密码不一致'; msg.style.color = '#b00'; audio.wrong(); return; }
    const r = store.register(name.value, code.value);
    if (!r.ok) { msg.textContent = r.msg; msg.style.color = '#b00'; audio.wrong(); return; }
    submitted = true;
    go('menu');
  } });
  pbtn(s, { base: 'RETURN', x: 30, y: 530, w: 80, h: 40, label: '返回', onClick: () => go('login') });
  onEnter.register = () => { submitted = false; name.value = ''; code.value = ''; code2.value = ''; msg.textContent = ''; name.focus(); };
}

// ---- MENU (BG3) ----
function buildMenu() {
  const s = makeScreen('menu');
  pbtn(s, { base: 'GAME', x: 165, y: 90, w: 120, h: 60, label: '开始游戏', onClick: () => go('select') });
  pbtn(s, { base: 'PERSONALCENTER', x: 150, y: 160, w: 150, h: 60, label: '个人中心', onClick: () => go('usercenter') });
  pbtn(s, { base: 'RANK', x: 165, y: 230, w: 120, h: 60, label: '排行榜', onClick: () => go('rank') });
  pbtn(s, { base: 'RULE', x: 175, y: 290, w: 100, h: 50, label: '规则', onClick: () => go('rule') });
  pbtn(s, { base: 'QUIT', x: 175, y: 350, w: 100, h: 50, label: '退出', onClick: () => openDialog({
    left: { base: 'SWITCHUSER', label: '切换用户', onClick: () => { store.logout(); go('login'); } },
    right: { base: 'QUIT', label: '退出', onClick: () => { store.logout(); go('title'); } },
  }) });
  ui.adminBtn = pbtn(s, { src: assets.ui('SELECT_W_P_C'), x: 215, y: 545, w: 80, h: 25, label: '用户管理', onClick: () => go('admin') });
  onEnter.menu = () => {
    const u = store.current();
    if (!u) { go('title'); return; }
    ui.adminBtn.style.display = u.isAdmin ? 'block' : 'none';
  };
}

// ---- SELECT (BG4) ----
const sel = { diff: 'easy', horse: 0, rival: null };
function rivalTier() { return sel.diff === 'hard' ? 2 : 1; }
function buildSelect() {
  const s = makeScreen('select');
  plabel(s, 'PREPAREGAMELOGO_W_150_60', { x: 150, y: 70, w: 150, h: 60 });
  plabel(s, 'RIVAL_W_60_30', { x: 70, y: 150, w: 60, h: 30 });
  const rivalName = ptext(s, { x: 190, y: 152, w: 160, h: 34, cls: 'sm', align: 'center' });
  pbtn(s, { src: assets.ui('LASTINDEX_LEFT_W'), x: 155, y: 150, w: 30, h: 30, label: '上一对手', onClick: () => { sel.rival = makeRival(rivalTier()); paintRival(); } });
  pbtn(s, { src: assets.ui('NEXTINDEX_RIGHT_W'), x: 355, y: 150, w: 30, h: 30, label: '下一对手', onClick: () => { sel.rival = makeRival(rivalTier()); paintRival(); } });

  plabel(s, 'DIFFICULTY_W_60_30', { x: 70, y: 240, w: 60, h: 30 });
  const diffImg = pimg(s, assets.ui('EASY_90_40'), { x: 225, y: 235, w: 90, h: 40, alt: '难度' });
  const toggleDiff = () => {
    sel.diff = sel.diff === 'easy' ? 'hard' : 'easy';
    diffImg.src = assets.ui(sel.diff === 'easy' ? 'EASY_90_40' : 'HARD_90_40');
    sel.rival = makeRival(rivalTier()); paintRival(); audio.click();
  };
  pbtn(s, { src: assets.ui('LASTINDEX_LEFT_W'), x: 155, y: 240, w: 30, h: 30, label: '切换难度', onClick: toggleDiff });
  pbtn(s, { src: assets.ui('NEXTINDEX_RIGHT_W'), x: 355, y: 240, w: 30, h: 30, label: '切换难度', onClick: toggleDiff });

  plabel(s, 'HORSE_W_60_30', { x: 70, y: 360, w: 60, h: 30 });
  const horseImg = pimg(s, assets.horseFrame(0, 'STAND'), { x: 210, y: 330, w: 120, h: 90, alt: '出战马' });
  const horseCount = ptext(s, { x: 175, y: 425, w: 190, h: 20, cls: 'xs', align: 'center' });
  pbtn(s, { src: assets.ui('LASTINDEX_LEFT_W'), x: 155, y: 360, w: 30, h: 30, label: '上一匹马', onClick: () => cycleHorse(-1) });
  pbtn(s, { src: assets.ui('NEXTINDEX_RIGHT_W'), x: 355, y: 360, w: 30, h: 30, label: '下一匹马', onClick: () => cycleHorse(1) });
  horseImg.style.cursor = 'pointer';
  horseImg.style.pointerEvents = 'auto';
  horseImg.title = '点击查看全部马匹';
  horseImg.addEventListener('click', () => { audio.click(); openGrid(paintHorse); });

  pbtn(s, { base: 'STARTGAME', x: 165, y: 450, w: 120, h: 50, label: '开始比赛', onClick: startRaceFromSelect });
  pbtn(s, { base: 'RETURN', x: 45, y: 515, w: 80, h: 40, label: '返回', onClick: () => go('menu') });

  const grid = mk('div', 'hgrid');
  grid.style.cssText = 'left:52px;top:148px;width:346px;height:334px;padding:10px;background:#fdf8cf;border:3px solid #101010;z-index:6;display:none;grid-template-columns:repeat(5,1fr);gap:5px';
  s.appendChild(grid);
  ui.horseGrid = grid;

  function paintRival() {
    if (!sel.rival) sel.rival = makeRival(rivalTier());
    rivalName.textContent = sel.rival.name;
  }
  function cycleHorse(d) {
    const u = store.current();
    if (!u) { go('title'); return; }
    sel.horse = (sel.horse + d + u.totalHorse) % u.totalHorse;
    paintHorse(); audio.click();
  }
  function paintHorse() {
    const u = store.current();
    if (!u) { go('title'); return; }
    if (sel.horse >= u.totalHorse) sel.horse = 0;
    horseImg.src = assets.horseFrame(u.horseKey[sel.horse], 'STAND');
    horseCount.textContent = `马匹 ${sel.horse + 1}/${u.totalHorse} · 收集 ${u.totalHorse}/20`;
  }
  ui.selectPaint = () => {
    diffImg.src = assets.ui(sel.diff === 'easy' ? 'EASY_90_40' : 'HARD_90_40');
    paintRival(); paintHorse();
  };
  ui.closeGrid = () => { ui.horseGrid.style.display = 'none'; };
  // paint on first entry too, otherwise the rival name / horse counter start blank
  onEnter.select = () => {
    if (!store.current()) { go('title'); return; }
    ui.closeGrid();
    ui.selectPaint();
  };
}
function openGrid(afterPick) {
  const grid = ui.horseGrid;
  const u = store.current();
  if (!u) { go('title'); return; }
  grid.innerHTML = '';
  for (let i = 0; i < 20; i++) {
    const owned = u.hasHorse[i];
    const cell = mk('div', 'hcell' + (owned ? '' : ' locked'));
    const im = mk('img'); im.src = assets.horseFrame(i, 'STAND'); im.alt = '';
    cell.appendChild(im);
    const no = mk('div', 'no'); no.textContent = '#' + i; cell.appendChild(no);
    if (!owned) { const lk = mk('div', 'lk'); lk.textContent = '🔒'; cell.appendChild(lk); }
    else {
      cell.style.cursor = 'pointer';
      cell.addEventListener('click', () => {
        const slot = u.horseKey.indexOf(i);
        if (slot >= 0) { sel.horse = slot; afterPick && afterPick(); ui.closeGrid(); audio.click(); }
      });
    }
    grid.appendChild(cell);
  }
  const hint = mk('div');
  hint.textContent = `已收集 ${u.totalHorse}/20 · 点击选择`;
  hint.style.cssText = 'grid-column:1/-1;font-size:12px;color:#333;text-align:center';
  grid.appendChild(hint);
  grid.style.display = 'grid';
}

function startRaceFromSelect() {
  const u = store.current();
  if (!u) { go('title'); return; }
  startRace({
    isHard: sel.diff === 'hard',
    playerHorse: u.horseKey[sel.horse],
    rival: sel.rival || makeRival(rivalTier()),
  });
}

// ---- RANK (BG5) ----
const rankSt = { diff: 'easy' };
function buildRank() {
  const s = makeScreen('rank');
  pbtn(s, { base: 'RETURN', x: 30, y: 530, w: 100, h: 50, label: '返回', onClick: () => go('menu') });
  const diffImg = pimg(s, assets.ui('EASY_60_40'), { x: 30, y: 350, w: 60, h: 40, alt: '难度' });
  const setDiff = (d) => { rankSt.diff = d; diffImg.src = assets.ui(d === 'easy' ? 'EASY_60_40' : 'HARD_60_40'); paint(); };
  pbtn(s, { src: assets.ui('LASTINDEX_UP_W'), x: 45, y: 300, w: 30, h: 30, label: '简单', onClick: () => { setDiff('easy'); audio.click(); } });
  pbtn(s, { src: assets.ui('NEXTINDEX_DOWN_W'), x: 45, y: 410, w: 30, h: 30, label: '困难', onClick: () => { setDiff('hard'); audio.click(); } });
  const rows = [];
  ['RANK_NO1', 'RANK_NO2', 'RANK_NO3', 'RANK_NO4', 'RANK_NO5'].forEach((c, i) => {
    const y = 250 + i * 50;
    pimg(s, assets.ui(c), { x: 110, y, w: 40, h: 40, alt: 'NO' + (i + 1) });
    const nm = ptext(s, { x: 165, y: y + 10, w: 130, h: 22, cls: 'sm', align: 'center' });
    const sc = ptext(s, { x: 298, y: y + 10, w: 122, h: 22, cls: 'sm', align: 'center' });
    rows.push([nm, sc]);
  });
  function paint() {
    const data = store.getRanking()[rankSt.diff] || [];
    rows.forEach(([nm, sc], i) => {
      const r = data[i];
      nm.textContent = r ? r.name : '---';
      sc.textContent = r ? r.score : '0';
    });
  }
  // 远程模式：进入排行页时先画镜像，再拉服务端权威数据重画（多人共享的关键视图）
  onEnter.rank = () => { paint(); store.refreshRanking().then(paint).catch(() => {}); };
}

// ---- RULE (BG6) ----
function buildRule() {
  const s = makeScreen('rule');
  pbtn(s, { base: 'RETURN', x: 50, y: 520, w: 80, h: 40, label: '返回', onClick: () => go(store.current() ? 'menu' : 'title') });
}

// ---- USERCENTER (BG7) ----
const ucSt = { diff: 'easy' };
function buildUserCenter() {
  const s = makeScreen('usercenter');
  const photo = pimg(s, assets.portrait(0), { x: 60, y: 80, w: 100, h: 100, alt: '头像' });
  plabel(s, 'USERNAME_W_55_25', { x: 198, y: 80, w: 55, h: 25 });
  plabel(s, 'GAMETIME_W_60_25', { x: 198, y: 128, w: 60, h: 25 });
  plabel(s, 'HORSEHAVE_W_60_25', { x: 198, y: 176, w: 60, h: 25 });
  const vName = ptext(s, { x: 268, y: 82, w: 140, h: 25, cls: 'sm' });
  const vTime = ptext(s, { x: 268, y: 130, w: 140, h: 25, cls: 'sm' });
  const vHorse = ptext(s, { x: 268, y: 178, w: 140, h: 25, cls: 'sm' });
  plabel(s, 'TOPRANK_W_120_50', { x: 50, y: 240, w: 120, h: 50 });
  plabel(s, 'TOPSCORE_W_120_50', { x: 50, y: 330, w: 120, h: 50 });
  const vRank = ptext(s, { x: 195, y: 256, w: 160, h: 24, cls: 'sm' });
  const vScore = ptext(s, { x: 195, y: 346, w: 160, h: 24, cls: 'sm' });
  const diffImg = pimg(s, assets.ui('EASY_50_30'), { x: 350, y: 300, w: 50, h: 30, alt: '难度' });
  const paintPortrait = (d) => {
    const u = store.current();
    if (!u) { go('title'); return; }
    store.setPortrait(d); // 本地即时生效 + 远程模式异步写服务端
    photo.src = assets.portrait(u.Port);
    audio.click();
  };
  pbtn(s, { src: assets.ui('LASTINDEX_LEFT_W'), x: 70, y: 190, w: 30, h: 30, label: '上一头像', onClick: () => paintPortrait(-1) });
  pbtn(s, { src: assets.ui('NEXTINDEX_RIGHT_W'), x: 120, y: 190, w: 30, h: 30, label: '下一头像', onClick: () => paintPortrait(1) });
  pbtn(s, { src: assets.ui('LASTINDEX_UP_W'), x: 360, y: 260, w: 30, h: 30, label: '简单', onClick: () => { ucSt.diff = 'easy'; paint(); audio.click(); } });
  pbtn(s, { src: assets.ui('NEXTINDEX_DOWN_W'), x: 360, y: 340, w: 30, h: 30, label: '困难', onClick: () => { ucSt.diff = 'hard'; paint(); audio.click(); } });
  pbtn(s, { base: 'CHANGEUSERNAME', x: 320, y: 470, w: 100, h: 40, label: '修改用户名', onClick: () => go('changename') });
  pbtn(s, { base: 'CHANGECODE', x: 320, y: 530, w: 100, h: 40, label: '修改密码', onClick: () => go('changecode') });
  pbtn(s, { base: 'RETURN', x: 30, y: 530, w: 80, h: 40, label: '返回', onClick: () => go('menu') });
  function paint() {
    const u = store.current();
    if (!u) { go('title'); return; }
    photo.src = assets.portrait(u.Port || 0);
    vName.textContent = u.name;
    vTime.textContent = u.seconds + '秒';
    vHorse.textContent = String(u.totalHorse);
    const isE = ucSt.diff === 'easy';
    const rt = isE ? u.rankTopE : u.rankTopH;
    vRank.textContent = rt === 0 ? '从未上榜' : '第 ' + rt + ' 名';
    vScore.textContent = String(isE ? u.topE : u.topH);
    diffImg.src = assets.ui(isE ? 'EASY_50_30' : 'HARD_50_30');
  }
  onEnter.usercenter = paint;
}

// ---- CHANGE NAME (BG9) ----
function buildChangeName() {
  const s = makeScreen('changename');
  plabel(s, 'NEWNAME_W_100_50', { x: 90, y: 215, w: 100, h: 50 });
  plabel(s, 'CONFIRMNAME_W_110_50', { x: 90, y: 355, w: 110, h: 50 });
  const n1 = pinput(s, { x: 210, y: 232, w: 150, h: 25, placeholder: '新用户名' });
  const n2 = pinput(s, { x: 210, y: 373, w: 150, h: 25, placeholder: '再次输入' });
  const msg = ptext(s, { x: 80, y: 185, w: 300, h: 22, cls: 'sm', align: 'center', color: '#b00' });
  pbtn(s, { base: 'CHECK', x: 175, y: 280, w: 100, h: 50, label: '检测', onClick: () => {
    if (!n1.value.trim()) { msg.textContent = '请输入新用户名'; msg.style.color = '#b00'; return; }
    if (store.nameTaken(n1.value)) { msg.textContent = '该用户名已被占用'; msg.style.color = '#b00'; audio.wrong(); }
    else { msg.textContent = '用户名可用'; msg.style.color = '#070'; audio.correct(); }
  } });
  pbtn(s, { base: 'CONFIRMCHANGE', x: 165, y: 420, w: 120, h: 60, label: '确认修改', onClick: () => {
    const r = store.changeName(n1.value, n2.value);
    if (!r.ok) { msg.textContent = r.msg; msg.style.color = '#b00'; audio.wrong(); return; }
    toast('用户名已修改'); go('usercenter');
  } });
  pbtn(s, { base: 'RETURN', x: 60, y: 520, w: 80, h: 40, label: '返回', onClick: () => go('usercenter') });
  onEnter.changename = () => { n1.value = ''; n2.value = ''; msg.textContent = ''; n1.focus(); };
}

// ---- CHANGE CODE (BG10) ----
function buildChangeCode() {
  const s = makeScreen('changecode');
  plabel(s, 'ORIGINALCODE_W_100_50', { x: 90, y: 190, w: 100, h: 50 });
  plabel(s, 'NEWCODE_W_100_50', { x: 90, y: 260, w: 100, h: 50 });
  plabel(s, 'CONFIRMCODE_W_100_50', { x: 90, y: 330, w: 100, h: 50 });
  const c0 = pinput(s, { x: 210, y: 212, w: 150, h: 25, password: true, placeholder: '原密码' });
  const c1 = pinput(s, { x: 210, y: 282, w: 150, h: 25, password: true, placeholder: '新密码' });
  const c2 = pinput(s, { x: 210, y: 352, w: 150, h: 25, password: true, placeholder: '再次输入' });
  const msg = ptext(s, { x: 80, y: 162, w: 300, h: 22, cls: 'sm', align: 'center', color: '#b00' });
  pbtn(s, { base: 'CONFIRMCHANGE', x: 150, y: 410, w: 150, h: 80, label: '确认修改', onClick: () => {
    const r = store.changeCode(c0.value, c1.value, c2.value);
    if (!r.ok) { msg.textContent = r.msg; msg.style.color = '#b00'; audio.wrong(); return; }
    toast('密码已修改'); go('usercenter');
  } });
  pbtn(s, { base: 'RETURN', x: 60, y: 520, w: 80, h: 40, label: '返回', onClick: () => go('usercenter') });
  onEnter.changecode = () => { c0.value = ''; c1.value = ''; c2.value = ''; msg.textContent = ''; c0.focus(); };
}

// ---- ADMIN (BG12) ----
const admSt = { idx: 0 };
function buildAdmin() {
  const s = makeScreen('admin');
  plabel(s, 'CHOOSEUSER_100_30', { x: 60, y: 70, w: 100, h: 30 });
  plabel(s, 'NAME_100_30', { x: 60, y: 120, w: 100, h: 30 });
  plabel(s, 'CODE_100_30', { x: 60, y: 200, w: 100, h: 30 });
  const vName = ptext(s, { x: 60, y: 158, w: 300, h: 30, cls: 'mid' });
  const vCode = ptext(s, { x: 60, y: 238, w: 300, h: 30, cls: 'mid' });
  const msg = ptext(s, { x: 60, y: 300, w: 330, h: 22, cls: 'sm', color: '#b00' });
  const users = () => store.allUsers();
  const paint = () => {
    const arr = users();
    if (!arr.length) { vName.textContent = '(无用户)'; vCode.textContent = ''; return; }
    if (admSt.idx >= arr.length) admSt.idx = 0;
    vName.textContent = arr[admSt.idx].name;
    vCode.textContent = arr[admSt.idx].code;
  };
  pbtn(s, { src: assets.ui('LASTINDEX_LEFT_W'), x: 330, y: 70, w: 30, h: 30, label: '上一用户', onClick: () => { const n = users().length || 1; admSt.idx = (admSt.idx + n - 1) % n; paint(); } });
  pbtn(s, { src: assets.ui('NEXTINDEX_RIGHT_W'), x: 370, y: 70, w: 30, h: 30, label: '下一用户', onClick: () => { const n = users().length || 1; admSt.idx = (admSt.idx + 1) % n; paint(); } });
  pbtn(s, { src: assets.ui('DELETE_100_30'), x: 60, y: 340, w: 120, h: 50, label: '删除用户', onClick: () => {
    const arr = users();
    if (!arr.length) return;
    const target = arr[admSt.idx];
    if (target.isAdmin) { msg.textContent = '不能删除管理员'; audio.wrong(); return; }
    store.deleteUser(target.name);
    msg.textContent = '已删除 ' + target.name;
    admSt.idx = 0; paint();
  } });
  pbtn(s, { src: assets.ui('RETURN_X_W'), x: 395, y: 22, w: 30, h: 30, label: '返回', onClick: () => go('menu') });
  onEnter.admin = () => {
    const u = store.current();
    if (!u || !u.isAdmin) { go('menu'); return; }
    admSt.idx = 0; msg.textContent = ''; paint();
  };
}

// ---- GAME OVER (BG13) ----
// Geometry mirrors gameover.ui exactly:
//   label_firstH 195,170  label_secondH 105,215  label_1name 230,140  label_2name 140,195
//   label_myscore 490,90  label_rivalscore 490,160
//   label_isnew 590,100 (新纪录)   label_inrank 320,100 (进入排行榜第 N 名)
//   label_isnew_2 480,250 ((新马)) label_newhorsepic 480,290
function buildGameOver() {
  const s = makeScreen('gameover');
  const first = pimg(s, assets.horseFrame(0, 'STAND'), { x: 195, y: 170, w: 120, h: 90, alt: '冠军马' });
  const second = pimg(s, assets.horseFrame(1, 'STAND'), { x: 105, y: 215, w: 120, h: 90, alt: '亚军马' });
  const n1 = ptext(s, { x: 230, y: 140, w: 54, h: 20, cls: 'sm', align: 'center' });
  const n2 = ptext(s, { x: 140, y: 195, w: 54, h: 16, cls: 'sm', align: 'center' });
  const myScore = ptext(s, { x: 490, y: 90, w: 100, h: 50, cls: 'big', align: 'center' });
  const rivalScore = ptext(s, { x: 490, y: 160, w: 100, h: 50, cls: 'big', align: 'center' });
  const isNew = ptext(s, { x: 590, y: 100, w: 80, h: 40, cls: 'sm', align: 'center', color: '#b00' });
  const inrank = ptext(s, { x: 320, y: 100, w: 161, h: 31, cls: 'sm', align: 'center', color: '#b00' });
  const newHorseLbl = ptext(s, { x: 480, y: 250, w: 121, h: 41, cls: 'sm', align: 'center' });
  const newHorse = pimg(s, assets.horseFrame(0, 'STAND'), { x: 480, y: 290, w: 120, h: 90, alt: '新马' });
  pbtn(s, { base: 'RETURN', x: 270, y: 370, w: 150, h: 80, label: '返回', onClick: () => go('menu') });
  ui.gameoverPaint = (res) => {
    if (!res) return;
    const myWon = res.playerScore >= res.rivalScore;
    first.src = assets.horseFrame(myWon ? res.horse : res.rivalHorse, 'STAND');
    second.src = assets.horseFrame(myWon ? res.rivalHorse : res.horse, 'STAND');
    n1.textContent = myWon ? '你' : res.rivalName;
    n2.textContent = myWon ? res.rivalName : '你';
    myScore.textContent = String(res.playerScore);
    rivalScore.textContent = String(res.rivalScore);
    isNew.textContent = res.isNewRecord ? '新纪录' : '';
    inrank.textContent = res.inRank ? '进入排行榜第 ' + res.rankPos + ' 名' : '';
    if (res.unlocked === 20) { newHorseLbl.textContent = '集齐全部 20 匹！'; newHorse.src = assets.horseFrame(19, 'STAND'); }
    else if (res.unlocked >= 0) { newHorseLbl.textContent = '获得新马 #' + res.unlocked; newHorse.src = assets.horseFrame(res.unlocked, 'STAND'); }
    else { newHorseLbl.textContent = '本局未获得新马'; newHorse.src = assets.horseFrame(res.horse, 'STAND'); }
  };
}

// ---- RACE (BG9_0, 1000x622) ----
function buildRace() {
  const s = makeScreen('race');
  const inner = mk('div', 'race-inner');
  s.appendChild(inner);
  const bgim = mk('img', 'bgimg'); bgim.src = assets.bg('BG9_0'); bgim.alt = ''; inner.appendChild(bgim);

  const horseRival = mk('img', 'horse'); horseRival.alt = ''; inner.appendChild(horseRival);
  const horseMe = mk('img', 'horse'); horseMe.alt = ''; inner.appendChild(horseMe);

  const keys = [], boxes = [];
  for (let i = 0; i < 6; i++) {
    const box = mk('div', 'keytile');
    box.style.left = (205 + i * 70) + 'px'; box.style.top = '470px';
    const im = mk('img'); im.alt = ''; box.appendChild(im);
    inner.appendChild(box); keys.push(im); boxes.push(box);
  }

  // QSlider 180,440 462x22 — the groove line is already painted in BG9_0, so the
  // element stays transparent and only carries the gradient sub-page + the handle.
  const slider = mk('div', 'slider'); slider.style.cssText = 'left:180px;top:440px;width:462px;height:22px;';
  const sliderFill = mk('i'); slider.appendChild(sliderFill);
  const sliderHandle = mk('b'); slider.appendChild(sliderHandle);
  inner.appendChild(slider);
  // label_lefttime 640,440 54x21 — remaining seconds of the current group ("1.86s")
  const sliderLabel = ptext(inner, { x: 640, y: 440, w: 54, h: 21, cls: 'sm', align: 'center' });

  const lcd = mk('div', 'lcd'); lcd.style.cssText = 'left:20px;top:490px;width:101px;height:51px;'; inner.appendChild(lcd);
  ptext(inner, { x: 130, y: 490, w: 31, h: 51, cls: 'big', align: 'center', text: 'S', size: 40 });
  const isHardTxt = ptext(inner, { x: 20, y: 440, w: 111, h: 41, cls: 'sm', align: 'center' });

  const score1 = ptext(inner, { x: 850, y: 400, w: 54, h: 21, cls: 'sm' });
  const score2 = ptext(inner, { x: 850, y: 433, w: 54, h: 20, cls: 'sm' });

  const logBox = mk('div', 'pixelbox');
  logBox.style.cssText = 'left:830px;top:480px;width:131px;height:111px;';
  logBox.setAttribute('aria-hidden', 'true'); inner.appendChild(logBox);

  const pbar = mk('div', 'pbar'); pbar.style.cssText = 'left:23px;top:581px;width:789px;height:20px;';
  const progressFill = mk('i'); pbar.appendChild(progressFill); inner.appendChild(pbar);

  // pushButton_StartandStop 40,30 100x50 — the original's label toggles between
  // 暂停游戏 and 开始游戏 as you pause/resume (gamestart.cpp on_..._clicked).
  const pauseBtn = mk('button', 'chip');
  pauseBtn.type = 'button';
  pauseBtn.style.cssText = 'left:40px;top:30px;width:100px;height:50px;font-size:18px';
  pauseBtn.textContent = '暂停游戏';
  pauseBtn.setAttribute('aria-label', '暂停游戏');
  pauseBtn.addEventListener('click', () => { audio.click(); if (race) race.pause(); });
  inner.appendChild(pauseBtn);

  const musicBtn = pbtn(inner, {
    src: assets.ui('withmusic'), x: 904, y: 20, w: 30, h: 30, label: '音乐开关',
    onClick: () => {
      const on = !store.getSettings().music;
      store.setSettings({ music: on });
      audio.setMusic(on);
      musicBtn.style.backgroundImage = `url("${assets.ui(on ? 'withmusic' : 'withoutmusic')}")`;
    },
  });
  musicBtn.style.backgroundSize = 'contain';
  musicBtn.style.backgroundRepeat = 'no-repeat';

  ui.race = { inner, bgim, horseRival, horseMe, keys, boxes, slider, sliderFill, sliderHandle, sliderLabel, lcd, isHardTxt, score1, score2, logBox, pbar, progressFill, pauseBtn, musicBtn };
}

// ---------- race lifecycle ----------
function startRace(config) {
  if (race) { race.destroy(); race = null; }
  const R = ui.race;
  for (const k in screens) screens[k].classList.remove('active');
  setStage(assets.RACE_BG_W, assets.RACE_BG_H);
  screens.race.classList.add('active');
  closeDialog();
  syncMusic();
  race = new RaceGame(R, {
    onFinish: (res) => {
      if (ui.gameoverPaint) ui.gameoverPaint(res);
      if (race) { race.destroy(); race = null; }
      go('gameover');
    },
    onQuit: () => { if (race) { race.destroy(); race = null; } go('select'); },
    onResumeClose: () => closeDialog(),
    onPauseRequest: () => openDialog({
      left: { base: 'CONTINUE', label: '继续', onClick: () => { if (race) race.resume(); } },
      right: { base: 'QUIT', label: '退到选关', onClick: () => { if (race) race.quit(); } },
    }),
  });
  race.start(config);
}

// ---------- audio bootstrap (needs a user gesture) ----------
let audioReady = false;
function ensureAudio() {
  if (audioReady) return;
  audioReady = true;
  audio.init(); audio.resume();
  audio.setSfx(store.getSettings().sfx);
  syncMusic();
}
addEventListener('pointerdown', ensureAudio);
addEventListener('keydown', ensureAudio);

// ---------- global keyboard ----------
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (modal.classList.contains('open')) return;   // dialog manages its own Esc
  if (screens.select && screens.select.classList.contains('active')) {
    if (ui.horseGrid && ui.horseGrid.style.display === 'grid') ui.closeGrid();
  }
});

// ---------- bootstrap ----------
function build() {
  buildTitle(); buildLogin(); buildRegister(); buildMenu(); buildSelect();
  buildRank(); buildRule(); buildUserCenter(); buildChangeName(); buildChangeCode();
  buildAdmin(); buildGameOver(); buildRace();
  // 演示账号种子只属于本地（离线）模式；远程模式下由服务端在空库时自行种子，
  // 避免双写竞争（见 docs/backend-design.md §7）
  if (!store.remoteActive() && !store.allUsers().length) {
    store.register('admin', 'admin');
    store.current().isAdmin = true;
    store.register('lbb', '1234');
    store.logout();
  }
  fit();
}

async function boot() {
  const fill = $('loader-fill');
  const txt = $('loader-text');
  build();
  // 远程模式：重放离线战果 + 恢复会话（带内部超时，后端不可达也不阻塞开机）
  await store.restoreSession().catch(() => {});
  try { await assets.preload((p) => { fill.style.width = Math.round(p * 100) + '%'; }); }
  catch (e) { console.warn('preload error', e); }
  txt.textContent = '就绪';
  fill.style.width = '100%';
  setTimeout(() => { $('loader').style.display = 'none'; go(store.current() ? 'menu' : 'title'); }, 300);
}
boot();
