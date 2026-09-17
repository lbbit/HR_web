// audio.js — Web Audio engine.
// Replaces the original game's audio with freshly synthesized, modern-sounding
// chiptune/electronic BGM (3 selectable tracks) and dynamic sound effects.

function semi(root, n) {
  return root * Math.pow(2, n / 12);
}

// 3 procedurally generated tracks (no copyrighted samples).
const TRACKS = [
  {
    name: '霓虹疾驰',
    bpm: 128, wave: 'square', root: 330,
    lead: [0, null, 3, null, 5, null, 3, 7, null, 5, 3, null, 0, null, 7, 10],
    bass: [0, null, null, null, -5, null, null, null, 0, null, null, null, -7, null, -5, null],
  },
  {
    name: '合成德比',
    bpm: 140, wave: 'sawtooth', root: 294,
    lead: [0, 4, 2, 4, 7, 4, 2, 0, 9, 7, 4, 2, 0, 2, 4, 7],
    bass: [0, null, 0, null, -5, null, -7, null, 0, null, 0, null, -3, null, -5, null],
  },
  {
    name: '像素冲刺',
    bpm: 150, wave: 'triangle', root: 262,
    lead: [0, 7, 12, 7, 4, 9, 4, 0, 7, 12, 16, 12, 9, 4, 7, null],
    bass: [0, null, null, null, -12, null, null, null, 5, null, null, null, -7, null, null, null],
  },
];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.musicOn = true;
    this.sfxOn = true;
    this.track = 0;
    this._timer = null;
    this._nextTime = 0;
    this._step = 0;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.22;
    this.musicGain.connect(this.master);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this.sfxOn ? 0.55 : 0;
    this.sfxGain.connect(this.master);
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMusic(on) {
    this.musicOn = on;
    if (on) this.playBGM(this.track);
    else this.stopBGM();
  }
  setSfx(on) {
    this.sfxOn = on;
    if (this.sfxGain) this.sfxGain.gain.value = on ? 0.55 : 0;
  }
  setTrack(i) {
    this.track = i;
    if (this.musicOn) this.playBGM(i);
  }

  playBGM(i = this.track) {
    this.init();
    if (!this.ctx) return;
    this.resume();
    this.track = i;
    if (this._timer) return; // already running
    const t = TRACKS[i];
    this._step = 0;
    this._nextTime = this.ctx.currentTime + 0.06;
    const stepDur = 60 / t.bpm / 4; // 16th note
    this._timer = setInterval(() => {
      while (this._nextTime < this.ctx.currentTime + 0.12) {
        this._scheduleStep(t, this._step, this._nextTime, stepDur);
        this._nextTime += stepDur;
        this._step = (this._step + 1) % 16;
      }
    }, 25);
  }

  stopBGM() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _scheduleStep(t, step, time, stepDur) {
    // drums
    if (step % 4 === 0) this._kick(time);
    if (step % 8 === 4) this._snare(time);
    if (step % 2 === 0) this._hat(time);
    // lead
    const ld = t.lead[step];
    if (ld !== null && ld !== undefined) {
      this._tone(semi(t.root, ld), time, stepDur * 0.9, t.wave, 0.5, this.musicGain);
    }
    // bass
    const bs = t.bass[step];
    if (bs !== null && bs !== undefined) {
      this._tone(semi(t.root, bs), time, stepDur * 1.6, 'triangle', 0.7, this.musicGain);
    }
  }

  _tone(freq, time, dur, type, peak, dest) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(peak, time + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    o.connect(g);
    g.connect(dest || this.musicGain);
    o.start(time);
    o.stop(time + dur + 0.02);
  }

  _kick(time) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(150, time);
    o.frequency.exponentialRampToValueAtTime(45, time + 0.12);
    g.gain.setValueAtTime(0.9, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);
    o.connect(g); g.connect(this.musicGain);
    o.start(time); o.stop(time + 0.18);
  }
  _snare(time) {
    const buf = this._noiseBuf();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.35, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.14);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1200;
    src.connect(hp); hp.connect(g); g.connect(this.musicGain);
    src.start(time); src.stop(time + 0.15);
  }
  _hat(time) {
    const buf = this._noiseBuf();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.12, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7000;
    src.connect(hp); hp.connect(g); g.connect(this.musicGain);
    src.start(time); src.stop(time + 0.06);
  }
  _noiseBuf() {
    if (this._nb) return this._nb;
    const len = this.ctx.sampleRate * 0.3;
    const b = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._nb = b;
    return b;
  }

  // ---- SFX ----
  _sfxTone(freq, t0, dur, type, peak = 0.5, slideTo = null) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.sfxGain);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  click() { this.init(); if (!this.ctx) return; this._sfxTone(520, this.ctx.currentTime, 0.05, 'square', 0.4); }
  correct() {
    this.init(); if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._sfxTone(880, t, 0.07, 'square', 0.4);
    this._sfxTone(1320, t + 0.05, 0.09, 'square', 0.4);
  }
  wrong() {
    this.init(); if (!this.ctx) return;
    this._sfxTone(150, this.ctx.currentTime, 0.18, 'sawtooth', 0.4, 90);
  }
  countBeep(go = false) {
    this.init(); if (!this.ctx) return;
    this._sfxTone(go ? 880 : 440, this.ctx.currentTime, go ? 0.25 : 0.12, 'square', 0.5);
  }
  win() {
    this.init(); if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [0, 4, 7, 12].forEach((n, i) => this._sfxTone(semi(392, n), t + i * 0.12, 0.22, 'triangle', 0.5));
  }
  lose() {
    this.init(); if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [0, -2, -4, -7].forEach((n, i) => this._sfxTone(semi(392, n), t + i * 0.13, 0.24, 'sawtooth', 0.4));
  }
  unlock() {
    this.init(); if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [0, 4, 7, 12, 16, 19].forEach((n, i) => this._sfxTone(semi(523, n), t + i * 0.06, 0.18, 'triangle', 0.45));
  }
  hoof() {
    this.init(); if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(120, this.ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(60, this.ctx.currentTime + 0.08);
    g.gain.setValueAtTime(0.35, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.1);
    o.connect(g); g.connect(this.sfxGain);
    o.start(); o.stop(this.ctx.currentTime + 0.12);
  }
}

export const audio = new AudioEngine();
export const trackNames = TRACKS.map((t) => t.name);
