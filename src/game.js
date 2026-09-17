// game.js — the race engine: canvas rendering, keyboard input, scoring, rival AI.
// Faithful to the original (score formula, 20 rounds × 6 keys × 2s window) but
// rebuilt with smooth 60fps animation, particles and a procedural rival.

import { audio } from './audio.js';
import * as assets from './assets.js';
import * as store from './storage.js';

const ROUNDS = 20;
const GROUP_KEYS = 6;
const GROUP_TIME = 2.0;     // seconds per key-group
const FINISH_MX = 760;      // distance units mapped across the track

function fixIndexScore(cK, cT) {
  cT = Math.max(0, Math.min(2, cT));
  return Math.round((80 * cT * cT - 400 * cT + 680) * (cK / 6));
}

const RIVAL_NAMES = ['闪电', '疾风', '星尘', '烈焰', '霜羽', '雷光', '夜骐', '金鬃', '幻影', '赤兔'];
const TIER_NAMES = ['新秀', '职业', '传奇'];

export function makeRival(tier) {
  const skillRange = [[0.45, 0.62], [0.6, 0.75], [0.75, 0.9]][tier] || [0.5, 0.65];
  const skill = skillRange[0] + Math.random() * (skillRange[1] - skillRange[0]);
  const name = RIVAL_NAMES[Math.floor(Math.random() * RIVAL_NAMES.length)];
  const portrait = Math.floor(Math.random() * 10);
  return { name, portrait, skill, tier, horse: Math.floor(Math.random() * 20) };
}

export class RaceGame {
  constructor(canvas, onFinish) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onFinish = onFinish;
    this.W = 0; this.H = 0; this.dpr = 1;
    this.tiles = [];
    this._onKey = this._onKey.bind(this);
    this._onResize = this.resize.bind(this);
    this._raf = null;
    this.finished = false;
  }

  start({ isHard, playerHorse, rival }) {
    this.cfg = { isHard, playerHorse, rival };
    this.rivalHorse = rival.horse;
    this.bg = assets.img(assets.bgImage(Math.floor(Math.random() * 5)));
    this.phase = 'countdown';
    this.countdown = 3.0;
    this.lastWhole = 4;
    this.groupIndex = 0;
    this.keyIndex = 0;
    this.correctKeys = 0;
    this.completeTime = GROUP_TIME;
    this.elapsedInGroup = 0;
    this.playerScore = 0; this.rivalScore = 0;
    this.playerMx = 0; this.rivalMx = 0;
    this.playerMxTarget = 0; this.rivalMxTarget = 0;
    this.animTime = 0; this.bgScroll = 0;
    this.dust = []; this.confetti = [];
    this.paused = false;
    this.finished = false;
    this._lastTs = 0;

    this._cacheHud();
    this.hud.playerName.textContent = store.current() ? store.current().name : '玩家';
    this.hud.rivalName.textContent = rival.name;
    this.hud.playerScore.textContent = '0';
    this.hud.rivalScore.textContent = '0';
    this.hud.round.textContent = `第 1 / ${ROUNDS} 组`;
    this.hud.timer.textContent = '3';
    this.hud.timer.classList.remove('low');
    this.hud.progressBar.style.width = '0%';
    this.hud.eval.textContent = '';
    this.hud.pauseOverlay.classList.add('hidden');
    this.hud.countdown.classList.remove('go');

    this.prepareGroup(); // show first sequence during countdown
    this.resize();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('keydown', this._onKey);
    if (audio.musicOn) audio.playBGM(audio.track);
    this._loop(performance.now());
  }

  _cacheHud() {
    const $ = (id) => document.getElementById(id);
    this.hud = {
      playerName: $('r-player-name'), playerScore: $('r-player-score'),
      rivalName: $('r-rival-name'), rivalScore: $('r-rival-score'),
      round: $('r-round'), timer: $('r-timer'), progressBar: $('r-progress-bar'),
      eval: $('r-eval'), countdown: $('r-countdown'), pauseOverlay: $('r-pause-overlay'),
    };
    this.tiles = [$('key0'), $('key1'), $('key2'), $('key3'), $('key4'), $('key5')];
  }

  prepareGroup() {
    const mode = this.cfg.isHard ? 'hard' : 'easy';
    this.keys = [];
    for (let i = 0; i < GROUP_KEYS; i++) {
      this.keys.push(mode === 'easy' ? Math.floor(Math.random() * 4) : Math.floor(Math.random() * 26));
    }
    this.keyIndex = 0;
    this.correctKeys = 0;
    this.completeTime = GROUP_TIME;
    this.elapsedInGroup = 0;
    for (let i = 0; i < GROUP_KEYS; i++) {
      this.tiles[i].src = assets.keyImage(mode, this.keys[i], '');
      this.tiles[i].classList.toggle('current', i === 0);
    }
    this.hud.round.textContent = `第 ${this.groupIndex + 1} / ${ROUNDS} 组`;
    this.hud.eval.textContent = '';
    // procedural rival plays this group
    const s = this.cfg.rival.skill;
    let ck = 0;
    for (let i = 0; i < GROUP_KEYS; i++) if (Math.random() < 0.55 + 0.4 * s) ck++;
    const t = Math.min(2, 0.5 + (1 - s) * 1.1 + Math.random() * 0.5);
    this.rivalPlan = { score: fixIndexScore(ck, t), mx: fixIndexScore(ck, t) / 8 };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.W = rect.width; this.H = rect.height;
  }

  _onKey(e) {
    if (e.code === 'Space') {
      e.preventDefault();
      this.togglePause();
      return;
    }
    if (this.phase !== 'racing' || this.paused || this.keyIndex >= GROUP_KEYS) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
      return;
    }
    const mode = this.cfg.isHard ? 'hard' : 'easy';
    let value = -1;
    if (mode === 'easy') {
      if (e.key === 'ArrowUp') value = 0;
      else if (e.key === 'ArrowDown') value = 1;
      else if (e.key === 'ArrowLeft') value = 2;
      else if (e.key === 'ArrowRight') value = 3;
    } else if (/^[a-zA-Z]$/.test(e.key)) {
      value = e.key.toLowerCase().charCodeAt(0) - 97;
    }
    if (value < 0) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
      return;
    }
    e.preventDefault();
    const expected = this.keys[this.keyIndex];
    if (value === expected) {
      this.tiles[this.keyIndex].src = assets.keyImage(mode, expected, 'G');
      this.correctKeys++;
      audio.correct();
    } else {
      this.tiles[this.keyIndex].src = assets.keyImage(mode, expected, 'R');
      audio.wrong();
    }
    if (this.keyIndex === GROUP_KEYS - 1) this.completeTime = Math.min(GROUP_TIME, this.elapsedInGroup);
    this.keyIndex++;
    for (let i = 0; i < GROUP_KEYS; i++) this.tiles[i].classList.toggle('current', i === this.keyIndex);
  }

  togglePause() {
    if (this.phase !== 'racing') return;
    this.paused = !this.paused;
    if (this.paused) {
      audio.stopBGM();
      this.hud.pauseOverlay.classList.remove('hidden');
    } else {
      this.hud.pauseOverlay.classList.add('hidden');
      if (audio.musicOn) audio.playBGM(audio.track);
    }
  }

  _loop(ts) {
    this._raf = requestAnimationFrame((t) => this._loop(t));
    const dt = this._lastTs ? Math.min(0.05, (ts - this._lastTs) / 1000) : 0;
    this._lastTs = ts;
    if (this.paused) { this._draw(); return; }

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      const whole = Math.ceil(this.countdown);
      this.hud.timer.textContent = String(Math.max(0, whole));
      if (whole < this.lastWhole && whole > 0) { this.lastWhole = whole; audio.countBeep(false); }
      if (this.countdown <= 0) {
        this.phase = 'racing';
        this.elapsedInGroup = 0;
        this.hud.timer.textContent = 'GO';
        this.hud.countdown.classList.add('go');
        audio.countBeep(true);
        setTimeout(() => this.hud.countdown.classList.remove('go'), 500);
      }
    } else if (this.phase === 'racing') {
      this.elapsedInGroup += dt;
      const remain = Math.max(0, GROUP_TIME - this.elapsedInGroup);
      this.hud.timer.textContent = remain.toFixed(1);
      this.hud.timer.classList.toggle('low', remain <= 0.6);
      this.hud.progressBar.style.width = Math.min(100, (this.elapsedInGroup / GROUP_TIME) * 100) + '%';
      if (this.elapsedInGroup >= GROUP_TIME) this._endGroup();
    }

    if (this.phase === 'racing' || this.phase === 'countdown') {
      this.animTime += dt;
      this.bgScroll = (this.bgScroll + dt * 120) % 80;
      // smooth horse movement toward target
      this.playerMx += (this.playerMxTarget - this.playerMx) * Math.min(1, dt * 6);
      this.rivalMx += (this.rivalMxTarget - this.rivalMx) * Math.min(1, dt * 6);
      if (this.phase === 'racing') this._spawnDust(dt);
    }
    this._updateParticles(dt);
    this._draw();
  }

  _endGroup() {
    const cK = this.correctKeys;
    const cT = this.completeTime;
    const score = fixIndexScore(cK, cT);
    this.playerScore += score;
    this.playerMxTarget += score / 8;
    this.rivalScore += this.rivalPlan.score;
    this.rivalMxTarget += this.rivalPlan.mx;
    this.hud.playerScore.textContent = String(this.playerScore);
    this.hud.rivalScore.textContent = String(this.rivalScore);

    let ev = 'bad!';
    if (cK === 6) ev = 'perfect!';
    else if (cK === 5) ev = 'great!';
    else if (cK === 4) ev = 'good!';
    else if (cK === 0) ev = 'miss!';
    this.hud.eval.textContent = `${ev}  +${score}`;
    this.hud.eval.style.color = cK >= 5 ? 'var(--green)' : cK >= 3 ? 'var(--gold)' : 'var(--red)';

    this.groupIndex++;
    if (this.groupIndex >= ROUNDS) this._finish();
    else this.prepareGroup();
  }

  _finish() {
    this.phase = 'finished';
    this.finished = true;
    const defeated = this.playerScore > this.rivalScore;
    if (defeated) audio.win(); else audio.lose();
    if (defeated) this._spawnConfetti();
    const summary = store.recordResult({
      isHard: this.cfg.isHard,
      score: this.playerScore,
      horse: this.cfg.playerHorse,
    });
    if (this.onFinish) {
      this.onFinish(Object.assign({
        playerScore: this.playerScore,
        rivalScore: this.rivalScore,
        defeated,
        isHard: this.cfg.isHard,
        horse: this.cfg.playerHorse,
        rivalName: this.cfg.rival.name,
        rivalHorse: this.rivalHorse,
      }, summary));
    }
  }

  _spawnDust(dt) {
    this._dustAcc = (this._dustAcc || 0) + dt;
    if (this._dustAcc > 0.06) {
      this._dustAcc = 0;
      const px = this._horseX(this.playerMx, false);
      const py = this._horseY(false) + this._horseH() * 0.35;
      this.dust.push({ x: px, y: py, vx: -40 - Math.random() * 40, vy: -10 + Math.random() * 10, life: 0.5, r: 3 + Math.random() * 3 });
    }
  }
  _spawnConfetti() {
    for (let i = 0; i < 90; i++) {
      this.confetti.push({
        x: Math.random() * this.W, y: -20 - Math.random() * 200,
        vx: -30 + Math.random() * 60, vy: 80 + Math.random() * 120,
        life: 2.5, rot: Math.random() * 6, vr: -4 + Math.random() * 8,
        c: ['#7c5cff', '#22d3ee', '#ffd166', '#3ddc84', '#ff5d7a'][i % 5],
        s: 5 + Math.random() * 6,
      });
    }
  }
  _updateParticles(dt) {
    for (const d of this.dust) { d.x += d.vx * dt; d.y += d.vy * dt; d.life -= dt; }
    this.dust = this.dust.filter((d) => d.life > 0);
    for (const c of this.confetti) { c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt; c.life -= dt; }
    this.confetti = this.confetti.filter((c) => c.life > 0 && c.y < this.H + 40);
  }

  _horseH() { return Math.max(54, this.H * 0.16); }
  _horseY(isPlayer) { return isPlayer ? this.H * 0.66 : this.H * 0.36; }
  _horseX(mx, isPlayer) {
    const startX = this.W * 0.1, finishX = this.W * 0.9;
    const pxPerMx = (finishX - startX) / FINISH_MX;
    return startX + Math.min(mx, FINISH_MX) * pxPerMx;
  }

  _draw() {
    const ctx = this.ctx, W = this.W, H = this.H;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    // background
    if (this.bg) {
      const ir = this.bg.width / this.bg.height, r = W / H;
      let dw, dh, dx, dy;
      if (ir > r) { dh = H; dw = H * ir; dx = (W - dw) / 2; dy = 0; }
      else { dw = W; dh = W / ir; dx = 0; dy = (H - dh) / 2; }
      ctx.drawImage(this.bg, dx, dy, dw, dh);
    } else { ctx.fillStyle = '#1a1340'; ctx.fillRect(0, 0, W, H); }

    // lane ground bands
    const lanes = [this._horseY(true), this._horseY(false)];
    for (const ly of lanes) {
      const gh = this._horseH() * 1.1;
      ctx.fillStyle = 'rgba(0,0,0,.28)';
      ctx.fillRect(0, ly - gh / 2, W, gh);
      // moving speed stripes
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.lineWidth = 2;
      for (let x = -this.bgScroll; x < W; x += 80) {
        ctx.beginPath(); ctx.moveTo(x, ly + gh / 2 - 6); ctx.lineTo(x + 40, ly + gh / 2 - 6); ctx.stroke();
      }
    }

    // finish line
    const fx = this._horseX(FINISH_MX, true);
    const fTop = this.H * 0.28, fBot = this.H * 0.78;
    const fw = 14;
    for (let y = fTop, i = 0; y < fBot; y += 14, i++) {
      ctx.fillStyle = i % 2 ? '#fff' : '#111';
      ctx.fillRect(fx, y, fw, 14);
    }

    // dust
    for (const d of this.dust) {
      ctx.globalAlpha = Math.max(0, d.life);
      ctx.fillStyle = 'rgba(220,210,255,.6)';
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // horses
    this._drawHorse(this.rivalHorse, this.rivalMx, false);
    this._drawHorse(this.cfg.playerHorse, this.playerMx, true);

    // confetti
    for (const c of this.confetti) {
      ctx.globalAlpha = Math.max(0, Math.min(1, c.life));
      ctx.save();
      ctx.translate(c.x, c.y); ctx.rotate(c.rot);
      ctx.fillStyle = c.c; ctx.fillRect(-c.s / 2, -c.s / 2, c.s, c.s * 0.6);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  _drawHorse(index, mx, isPlayer) {
    const ctx = this.ctx;
    const moving = this.phase === 'racing';
    let frame = 'stand';
    if (moving) frame = Math.floor(this.animTime / 0.12) % 2 ? 'run2' : 'run1';
    const img = assets.img(assets.horseFrame(index, frame)) || assets.img(assets.horseFrame(index, 'stand'));
    const hH = this._horseH();
    const hW = hH * (120 / 90);
    const x = this._horseX(mx, isPlayer);
    const y = this._horseY(isPlayer) + (moving ? Math.sin(this.animTime * 14) * 3 : 0);
    if (img && img.width) {
      ctx.drawImage(img, x - hW / 2, y - hH / 2, hW, hH);
    } else {
      ctx.fillStyle = isPlayer ? '#7c5cff' : '#ff5d7a';
      ctx.fillRect(x - hW / 2, y - hH / 2, hW, hH);
    }
    // name plate
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    const label = isPlayer ? '你' : this.cfg.rival.name;
    ctx.font = '600 13px system-ui';
    const tw = ctx.measureText(label).width + 12;
    ctx.fillRect(x - tw / 2, y - hH / 2 - 20, tw, 16);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y - hH / 2 - 8);
    ctx.textAlign = 'left';
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onKey);
  }
}
