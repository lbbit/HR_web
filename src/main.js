// main.js — app bootstrap, screen router, and wiring for every screen.

import * as assets from './assets.js';
import * as store from './storage.js';
import { audio, trackNames } from './audio.js';
import { RaceGame, makeRival } from './game.js';

const $ = (id) => document.getElementById(id);

let race = null;
let lastConfig = null;
const select = { diff: 'easy', tier: 0, horseSlot: 0, rival: null };
let audioReady = false;

const canvas = $('race-canvas');

// ---------- audio bootstrap (needs a user gesture) ----------
function ensureAudio() {
  if (audioReady) return;
  audioReady = true;
  audio.init();
  audio.resume();
  const s = store.getSettings();
  audio.setSfx(s.sfx);
  if (s.music) audio.playBGM(s.track);
  syncMusicUI();
}
document.addEventListener('pointerdown', ensureAudio);
document.addEventListener('keydown', ensureAudio);

function syncMusicUI() {
  const on = store.getSettings().music;
  const chip = $('title-music');
  if (chip) chip.textContent = on ? '♪ 音乐：开' : '♪ 音乐：关';
  const sw = $('set-music');
  if (sw) { sw.classList.toggle('on', on); sw.textContent = on ? '开' : '关'; }
}

// ---------- navigation ----------
function go(target) {
  if (race && target !== 'race' && target !== 'result') {
    race.destroy();
    race = null;
  }
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = $('screen-' + target);
  if (el) el.classList.add('active');
  const fn = onEnter[target];
  if (fn) fn();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-go]');
  if (t) {
    e.preventDefault();
    audio.click();
    go(t.getAttribute('data-go'));
  }
});

// ---------- result ----------
function onFinish(result) {
  const u = store.current();
  $('result-title').textContent = result.defeated ? '胜利！' : '惜败…';
  $('result-title').style.color = result.defeated ? 'var(--green)' : 'var(--red)';
  $('res-player-name').textContent = u ? u.name : '玩家';
  $('res-player-score').textContent = result.playerScore;
  $('res-rival-name').textContent = result.rivalName;
  $('res-rival-score').textContent = result.rivalScore;

  const tags = $('result-tags');
  tags.innerHTML = '';
  const add = (txt, cls) => {
    const d = document.createElement('div');
    d.className = 'tag ' + (cls || '');
    d.textContent = txt;
    tags.appendChild(d);
  };
  add(result.isHard ? '困难模式' : '简单模式');
  if (result.isNewRecord) add('🏅 新纪录', 'gold');
  if (result.inRank) add('🏆 进入排行榜', 'green');
  if (result.unlocked === 20) add('🐎 已集齐全部 20 匹！', 'gold');
  else if (result.unlocked >= 0) add('🎉 解锁新马 #' + result.unlocked, 'green');
  else add('差一点解锁新马', 'red');

  go('result');
}

function startRace(config) {
  if (race) { race.destroy(); race = null; }
  lastConfig = config;
  go('race'); // activate the screen so the canvas has a measurable size
  race = new RaceGame(canvas, onFinish);
  race.start(config);
}

// ---------- screen enter hooks ----------
const onEnter = {
  title: syncMusicUI,
  login() {
    $('login-name').value = '';
    $('login-code').value = '';
    $('login-msg').textContent = '';
  },
  register() {
    $('reg-name').value = '';
    $('reg-code').value = '';
    $('reg-code2').value = '';
    $('reg-msg').textContent = '';
  },
  menu() {
    const u = store.current();
    if (!u) { go('title'); return; }
    $('menu-user').textContent = u.name;
    $('menu-level').textContent = `等级 ${store.level(u)} · 经验 ${u.exp}`;
    $('menu-tope').textContent = u.topE;
    $('menu-toph').textContent = u.topH;
    $('menu-horses').textContent = `${u.totalHorse}/20`;
    $('menu-portrait').src = assets.portraitImage(u.Port);
  },
  select() {
    const u = store.current();
    if (!u) { go('title'); return; }
    if (select.horseSlot >= u.totalHorse) select.horseSlot = 0;
    if (!select.rival) select.rival = makeRival(select.tier);
    renderSelect();
  },
  ranking: renderRanking,
  collection: renderCollection,
  settings: renderSettings,
  about() {},
  rule() {},
  race() {},
};

// ---------- login / register ----------
$('login-btn').addEventListener('click', () => {
  const r = store.login($('login-name').value, $('login-code').value);
  if (!r.ok) { $('login-msg').textContent = r.msg; audio.wrong(); return; }
  audio.click();
  go('menu');
});
$('reg-btn').addEventListener('click', () => {
  const n = $('reg-name').value, c = $('reg-code').value, c2 = $('reg-code2').value;
  if (c !== c2) { $('reg-msg').textContent = '两次密码不一致'; audio.wrong(); return; }
  const r = store.register(n, c);
  if (!r.ok) { $('reg-msg').textContent = r.msg; audio.wrong(); return; }
  audio.click();
  go('menu');
});
$('menu-logout').addEventListener('click', () => { store.logout(); audio.click(); go('title'); });

// ---------- select screen ----------
function renderSelect() {
  const u = store.current();
  const r = select.rival;
  $('rival-name').textContent = r.name;
  $('rival-tier').textContent = ['新秀', '职业', '传奇'][r.tier];
  $('rival-portrait').src = assets.portraitImage(r.portrait);
  const horseId = u.horseKey[select.horseSlot];
  $('horse-pick-img').src = assets.horseFrame(horseId, 'STAND');
  $('horse-pick-name').textContent = `骏马 #${horseId}`;
  $('horse-pick-tag').textContent = '已解锁';
  // diff seg
  document.querySelectorAll('#seg-diff .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.diff === select.diff));
  // tier seg
  document.querySelectorAll('#seg-tier .seg-btn').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.tier) === select.tier));
}

document.querySelectorAll('#seg-diff .seg-btn').forEach((b) =>
  b.addEventListener('click', () => { select.diff = b.dataset.diff; audio.click(); renderSelect(); }));
document.querySelectorAll('#seg-tier .seg-btn').forEach((b) =>
  b.addEventListener('click', () => {
    select.tier = Number(b.dataset.tier);
    select.rival = makeRival(select.tier);
    audio.click(); renderSelect();
  }));
$('rival-prev').addEventListener('click', () => { select.rival = makeRival(select.tier); audio.click(); renderSelect(); });
$('rival-next').addEventListener('click', () => { select.rival = makeRival(select.tier); audio.click(); renderSelect(); });
$('horse-prev').addEventListener('click', () => {
  const u = store.current();
  select.horseSlot = (select.horseSlot - 1 + u.totalHorse) % u.totalHorse;
  audio.click(); renderSelect();
});
$('horse-next').addEventListener('click', () => {
  const u = store.current();
  select.horseSlot = (select.horseSlot + 1) % u.totalHorse;
  audio.click(); renderSelect();
});
$('select-start').addEventListener('click', () => {
  const u = store.current();
  const config = {
    isHard: select.diff === 'hard',
    playerHorse: u.horseKey[select.horseSlot],
    rival: select.rival,
  };
  audio.click();
  startRace(config);
});
$('result-again').addEventListener('click', () => {
  const u = store.current();
  const config = {
    isHard: select.diff === 'hard',
    playerHorse: u.horseKey[select.horseSlot],
    rival: makeRival(select.tier),
  };
  audio.click();
  startRace(config);
});

// ---------- ranking ----------
function renderRanking() {
  const { easy, hard } = store.getRanking();
  fillBoard($('rank-easy'), easy);
  fillBoard($('rank-hard'), hard);
}
function fillBoard(ol, arr) {
  ol.innerHTML = '';
  if (!arr.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '暂无记录，快去比赛吧！';
    ol.appendChild(li);
    return;
  }
  arr.forEach((r, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="rank-no">${i + 1}</span><span class="rn-name">${r.name}</span><span class="rn-score">${r.score}</span>`;
    ol.appendChild(li);
  });
}

// ---------- collection ----------
function renderCollection() {
  const u = store.current();
  $('coll-count').textContent = `${u.totalHorse} / 20`;
  const grid = $('coll-grid');
  grid.innerHTML = '';
  const selectedHorse = u.horseKey[select.horseSlot];
  for (let i = 0; i < 20; i++) {
    const unlocked = u.hasHorse[i];
    const cell = document.createElement('div');
    cell.className = 'coll-cell ' + (unlocked ? 'unlocked' : 'locked') +
      (unlocked && i === selectedHorse ? ' selected' : '');
    const img = document.createElement('img');
    img.src = assets.horseFrame(i, 'STAND');
    cell.appendChild(img);
    const name = document.createElement('div');
    name.className = 'cc-name';
    name.textContent = `骏马 #${i}`;
    cell.appendChild(name);
    if (!unlocked) {
      const lock = document.createElement('div');
      lock.className = 'cc-lock';
      lock.textContent = '🔒';
      cell.appendChild(lock);
    }
    if (unlocked) {
      cell.addEventListener('click', () => {
        const slot = u.horseKey.indexOf(i);
        if (slot >= 0) { select.horseSlot = slot; audio.click(); renderCollection(); }
      });
    }
    grid.appendChild(cell);
  }
}

// ---------- settings ----------
function renderSettings() {
  const s = store.getSettings();
  const sm = $('set-music');
  sm.classList.toggle('on', s.music); sm.textContent = s.music ? '开' : '关';
  const sx = $('set-sfx');
  sx.classList.toggle('on', s.sfx); sx.textContent = s.sfx ? '开' : '关';
  const seg = $('seg-track');
  seg.innerHTML = '';
  trackNames.forEach((nm, i) => {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (i === s.track ? ' active' : '');
    b.textContent = nm;
    b.addEventListener('click', () => {
      store.setSettings({ track: i });
      audio.setTrack(i);
      audio.click();
      renderSettings();
    });
    seg.appendChild(b);
  });
}
$('set-music').addEventListener('click', () => {
  const on = !store.getSettings().music;
  store.setSettings({ music: on });
  audio.setMusic(on);
  renderSettings();
});
$('set-sfx').addEventListener('click', () => {
  const on = !store.getSettings().sfx;
  store.setSettings({ sfx: on });
  audio.setSfx(on);
  if (on) audio.click();
  renderSettings();
});
$('set-reset').addEventListener('click', () => {
  if (confirm('确定清空本机全部存档（账号、成绩、马厩）？此操作不可恢复。')) {
    store.resetAll();
    select.rival = null; select.horseSlot = 0;
    go('title');
  }
});

// ---------- title music chip ----------
$('title-music').addEventListener('click', () => {
  const on = !store.getSettings().music;
  store.setSettings({ music: on });
  audio.setMusic(on);
  syncMusicUI();
});

// ---------- race controls ----------
$('r-pause').addEventListener('click', () => { if (race) race.togglePause(); });
$('r-music').addEventListener('click', () => {
  const on = !store.getSettings().music;
  store.setSettings({ music: on });
  audio.setMusic(on);
  syncMusicUI();
});

// ---------- boot ----------
async function boot() {
  const fill = $('loader-fill');
  const txt = $('loader-text');
  try {
    await assets.preload((p) => { fill.style.width = Math.round(p * 100) + '%'; });
  } catch (e) {
    console.warn('preload error', e);
  }
  txt.textContent = '就绪';
  fill.style.width = '100%';
  setTimeout(() => {
    $('loader').style.display = 'none';
    // resume where the user left off
    if (store.current()) go('menu');
    else go('title');
  }, 350);
}
boot();
