// game.js — the race engine.
//
// Faithful to the original gamestart.cpp: 20 groups x 6 keys x 2s window, original
// score formula, LCD countdown, dual scores, per-group eval, and a procedural rival.
// Rendering is DOM-based (the original was QLabels too): horses move via CSS left,
// key tiles are <img>, and the race background is the original BG9_0 pixel art.

import { audio } from './audio.js';
import * as assets from './assets.js';
import * as store from './storage.js';

const ROUNDS = 20;
const GROUP_KEYS = 6;
const GROUP_TIME = 2.0;          // seconds per key-group
const TOTAL_TIME = ROUNDS * GROUP_TIME; // 40s
const DIST_MX = 1400;            // total mx that maps to the whole track
// A 20-group race appends 41 log lines; the cap is a guard, not a design limit.
// QTextBrowser keeps everything and scrolls, so this stays well above the real count.
const LOG_LINES = 60;

// QSlider geometry from gamestart.ui: 462 wide with the groove inset 12px each side.
const SLIDER_W = 462, SLIDER_INSET = 12;
const SLIDER_SPAN = SLIDER_W - SLIDER_INSET * 2;

/** QString::number() style: shortest form, so 2 -> "2", 1.8 -> "1.8", 1.24 -> "1.24". */
function qnum(n) { return String(Number(n.toFixed(2))); }

export function fixIndexScore(cK, cT) {
  cT = Math.max(0, Math.min(2, cT));
  return Math.round((80 * cT * cT - 400 * cT + 680) * (cK / 6));
}

const RIVAL_NAMES = ['闪电', '疾风', '星尘', '烈焰', '霜羽', '雷光', '夜骐', '金鬃', '幻影', '赤兔'];
export function makeRival(tier) {
  const range = [[0.45, 0.62], [0.6, 0.75], [0.75, 0.9]][tier] || [0.5, 0.65];
  const skill = range[0] + Math.random() * (range[1] - range[0]);
  return {
    name: RIVAL_NAMES[Math.floor(Math.random() * RIVAL_NAMES.length)],
    portrait: Math.floor(Math.random() * 10),
    skill, tier, horse: Math.floor(Math.random() * 20),
  };
}

const START_X_ME = 80, START_X_RIVAL = 90;
const MAX_X = 810;
const mxToX = (mx) => Math.min(mx / DIST_MX, 1) * (MAX_X - START_X_ME);

export class RaceGame {
  constructor(refs, cb = {}) {
    this.r = refs;
    this.cb = cb;
    this._onKey = this._onKey.bind(this);
    this._loop = this._loop.bind(this);
    this._raf = null;
    this.destroyed = false;
  }

  // ---------- lifecycle ----------
  start({ isHard, playerHorse, rival }) {
    this.cfg = { isHard, playerHorse, rival };
    this.rival = rival;
    this.mode = isHard ? 'hard' : 'easy';

    this.phase = 'countdown';
    this.countdown = 3.0;
    this.lastWhole = 4;
    this.groupIndex = 0;
    this.keyIndex = 0;
    this.correctKeys = 0;
    this.completeTime = GROUP_TIME;
    this.groupElapsed = 0;
    this.elapsedTotal = 0;
    this.playerScore = 0;
    this.rivalScore = 0;
    this.playerMx = 0; this.rivalMx = 0;
    this.playerMxTarget = 0; this.rivalMxTarget = 0;
    this.playerX = START_X_ME; this.rivalX = START_X_RIVAL;
    this.paused = false;
    this.finished = false;
    this.logLines = ['开始游戏...'];
    this._lastTs = 0;

    const r = this.r;
    r.horseMe.src = this._frame(playerHorse, 'STAND');
    r.horseRival.src = this._frame(this.rival.horse, 'STAND');
    r.horseMe.style.top = '220px'; r.horseMe.style.left = START_X_ME + 'px';
    r.horseRival.style.top = '160px'; r.horseRival.style.left = START_X_RIVAL + 'px';
    r.isHardTxt.textContent = isHard ? '困难' : '简单';
    r.score1.textContent = '0';
    r.score2.textContent = '0';
    r.sliderFill.style.width = '0px';
    r.sliderHandle.style.left = SLIDER_INSET + 'px';
    r.progressFill.style.width = '0%';
    r.sliderLabel.textContent = GROUP_TIME.toFixed(2) + 's';
    // QLCDNumber colours are phase-driven (gamestart.cpp:323 red -> :341 green)
    r.lcd.style.color = '#ff0000';
    r.lcd.textContent = '3';
    this._setPauseLabel(false);
    this._renderLog();

    this._prepareGroup();
    window.addEventListener('keydown', this._onKey);
    if (audio.musicOn) audio.playBGM(audio.track);
    this._raf = requestAnimationFrame(this._loop);
  }

  /** pushButton_StartandStop toggles between 暂停游戏 (running) and 开始游戏 (paused). */
  _setPauseLabel(paused) {
    const b = this.r.pauseBtn;
    if (!b) return;
    b.textContent = paused ? '开始游戏' : '暂停游戏';
    b.setAttribute('aria-label', b.textContent);
  }

  _frame(horse, frame) {
    return assets.horseFrame(horse, frame);
  }

  pause() {
    if (this.phase !== 'racing' || this.paused) return;
    this.paused = true;
    this._setPauseLabel(true);
    audio.stopBGM();
    if (this.cb.onPauseRequest) this.cb.onPauseRequest();
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this._setPauseLabel(false);
    this._lastTs = 0; // avoid a huge dt after the pause
    if (audio.musicOn) audio.playBGM(audio.track);
  }
  quit() {
    this.destroy();
    if (this.cb.onQuit) this.cb.onQuit();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    window.removeEventListener('keydown', this._onKey);
    audio.stopBGM();
  }

  // ---------- input ----------
  _onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); this.quit(); return; }
    if (e.code === 'Space') { e.preventDefault(); if (this.paused) { this.resume(); if (this.cb.onResumeClose) this.cb.onResumeClose(); } else this.pause(); return; }
    if (this.phase !== 'racing' || this.paused || this.keyIndex >= GROUP_KEYS) {
      if (e.key.startsWith('Arrow')) e.preventDefault();
      return;
    }
    let value = -1;
    if (this.mode === 'easy') {
      value = { ArrowUp: 0, ArrowDown: 1, ArrowLeft: 2, ArrowRight: 3 }[e.key] ?? -1;
    } else if (/^[a-zA-Z]$/.test(e.key)) {
      value = e.key.toLowerCase().charCodeAt(0) - 97;
    }
    if (value < 0) { if (e.key.startsWith('Arrow')) e.preventDefault(); return; }
    e.preventDefault();

    const expected = this.keys[this.keyIndex];
    const box = this.r.boxes[this.keyIndex];
    if (value === expected) {
      this.r.keys[this.keyIndex].src = assets.keyImage(this.mode, expected, 'G');
      box.classList.add('done');
      this.correctKeys++;
      audio.correct();
    } else {
      this.r.keys[this.keyIndex].src = assets.keyImage(this.mode, expected, 'R');
      box.classList.add('miss');
      audio.wrong();
    }
    if (this.keyIndex === GROUP_KEYS - 1) this.completeTime = Math.min(GROUP_TIME, this.groupElapsed);
    this.keyIndex++;
    this.r.boxes.forEach((b, i) => b.classList.toggle('cur', i === this.keyIndex));
  }

  // ---------- groups ----------
  _prepareGroup() {
    this.keys = [];
    for (let i = 0; i < GROUP_KEYS; i++) {
      this.keys.push(this.mode === 'easy' ? Math.floor(Math.random() * 4) : Math.floor(Math.random() * 26));
    }
    this.keyIndex = 0;
    this.correctKeys = 0;
    this.completeTime = GROUP_TIME;
    this.groupElapsed = 0;
    const r = this.r;
    for (let i = 0; i < GROUP_KEYS; i++) {
      r.keys[i].src = assets.keyImage(this.mode, this.keys[i], '');
      r.boxes[i].className = 'keytile' + (i === 0 ? ' cur' : '');
    }
    r.sliderFill.style.width = '0px';
    r.sliderHandle.style.left = SLIDER_INSET + 'px';
    // rival plays this group
    const s = this.rival.skill;
    let ck = 0;
    for (let i = 0; i < GROUP_KEYS; i++) if (Math.random() < 0.55 + 0.4 * s) ck++;
    const t = Math.min(2, 0.5 + (1 - s) * 1.1 + Math.random() * 0.5);
    this.rivalPlan = { score: fixIndexScore(ck, t), mx: fixIndexScore(ck, t) / 8 };
  }

  _endGroup() {
    const cK = this.correctKeys;
    const score = fixIndexScore(cK, this.completeTime);
    this.playerScore += score;
    this.playerMxTarget += score / 8;
    this.rivalScore += this.rivalPlan.score;
    this.rivalMxTarget += this.rivalPlan.mx;

    let ev = 'bad!';
    if (cK === 6) ev = 'perfect!';
    else if (cK === 5) ev = 'great!';
    else if (cK === 4) ev = 'good!';
    else if (cK === 0) ev = 'miss!';
    // textBrowser_log line, verbatim from gamestart.cpp:596 —
    //   append(keyGroup + ": " + evaluation + " " + CompleteTime + "s按完!\n 积分+：" + indexScore)
    // One append() carrying both lines, so the group line comes first and its score
    // follows it, and each new entry lands BELOW the previous one.
    this.logLines.push(`${this.groupIndex}: ${ev} ${qnum(this.completeTime)}s按完!`);
    this.logLines.push(` 积分+：${score}`);
    // QTextBrowser keeps the whole log; we only bound it defensively. Because new
    // entries go on the end, the oldest line is the one that ages out.
    while (this.logLines.length > LOG_LINES) this.logLines.shift();
    this._renderLog();

    this.r.score1.textContent = String(this.playerScore);
    this.r.score2.textContent = String(this.rivalScore);
    this.r.progressFill.style.width = Math.round(((this.groupIndex + 1) / ROUNDS) * 100) + '%';

    this.groupIndex++;
    if (this.groupIndex >= ROUNDS) this._finish();
    else this._prepareGroup();
  }

  _finish() {
    this.phase = 'finished';
    this.finished = true;
    const defeated = this.playerScore > this.rivalScore;
    audio.stopBGM();
    if (defeated) audio.win(); else audio.lose();
    const summary = store.recordResult({
      isHard: this.cfg.isHard,
      score: this.playerScore,
      horse: this.cfg.playerHorse,
      distance: Math.round(this.playerMx),
    });
    this.destroy();
    if (this.cb.onFinish) {
      this.cb.onFinish(Object.assign({
        playerScore: this.playerScore,
        rivalScore: this.rivalScore,
        defeated,
        isHard: this.cfg.isHard,
        horse: this.cfg.playerHorse,
        rivalName: this.rival.name,
        rivalHorse: this.rival.horse,
      }, summary || {}));
    }
  }

  _renderLog() {
    const box = this.r.logBox;
    box.innerHTML = '';
    this.logLines.forEach((t) => {
      const d = document.createElement('div');
      d.className = 'ln'; d.textContent = t;
      box.appendChild(d);
    });
    // QTextBrowser.append() scrolls to the tail, so the newest line stays visible.
    box.scrollTop = box.scrollHeight || 0;
  }

  // ---------- main loop ----------
  _loop(ts) {
    if (this.destroyed) return;
    this._raf = requestAnimationFrame(this._loop);
    const dt = this._lastTs ? Math.min(0.05, (ts - this._lastTs) / 1000) : 0;
    this._lastTs = ts;
    if (this.paused) return;

    const r = this.r;
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      const whole = Math.max(0, Math.ceil(this.countdown));
      r.lcd.textContent = whole > 0 ? String(whole) : 'GO';
      if (whole < this.lastWhole && whole > 0) { this.lastWhole = whole; audio.countBeep(false); }
      if (this.countdown <= 0) {
        this.phase = 'racing';
        this.elapsedTotal = 0;
        this.lastWhole = 0;
        r.lcd.style.color = '#008000';   // QLCDNumber turns green once racing
        audio.countBeep(true);
      }
    } else if (this.phase === 'racing') {
      this.groupElapsed += dt;
      this.elapsedTotal += dt;
      const remain = Math.max(0, TOTAL_TIME - this.elapsedTotal);
      const pct = Math.min(1, this.groupElapsed / GROUP_TIME);
      r.lcd.textContent = String(Math.ceil(remain));
      // #FF0088 for the final group (gamestart.cpp:416), green otherwise
      r.lcd.style.color = this.groupIndex >= ROUNDS - 1 ? '#FF0088' : '#008000';
      r.sliderFill.style.width = (pct * SLIDER_SPAN).toFixed(1) + 'px';
      r.sliderHandle.style.left = (SLIDER_INSET + pct * SLIDER_SPAN).toFixed(1) + 'px';
      // label_lefttime shows the REMAINING seconds of the group, not the elapsed ones
      r.sliderLabel.textContent = qnum(GROUP_TIME - this.groupElapsed) + 's';
      if (this.groupElapsed >= GROUP_TIME) this._endGroup();
    }

    // smooth horse movement
    if (this.phase === 'countdown' || this.phase === 'racing') {
      const k = Math.min(1, dt * 6);
      this.playerMx += (this.playerMxTarget - this.playerMx) * k;
      this.rivalMx += (this.rivalMxTarget - this.rivalMx) * k;
      this.playerX += (mxToX(this.playerMx) + START_X_ME - this.playerX) * k;
      this.rivalX += (mxToX(this.rivalMx) + START_X_RIVAL - this.rivalX) * k;
      r.horseMe.style.left = this.playerX.toFixed(1) + 'px';
      r.horseRival.style.left = this.rivalX.toFixed(1) + 'px';
      const moving = this.phase === 'racing';
      r.horseMe.src = this._frame(this.cfg.playerHorse, moving ? (Math.floor(this.elapsedTotal / 0.12) % 2 ? 'RUN2' : 'RUN1') : 'STAND');
      r.horseRival.src = this._frame(this.rival.horse, moving ? (Math.floor(this.elapsedTotal / 0.12) % 2 ? 'RUN2' : 'RUN1') : 'STAND');
      if (moving) {
        this._hoofAcc = (this._hoofAcc || 0) + dt;
        if (this._hoofAcc > 0.34) { this._hoofAcc = 0; audio.hoof(); }
      }
    }
  }
}
