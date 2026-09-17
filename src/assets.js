// assets.js — asset manifest, preloading, and image helpers.
// Reuses sprites/backgrounds/key tiles from the original Qt project.

const ASSET = './assets/';

// Horse sprite indices that exist (0..18 have full frames; 19 only STAND).
export const HORSE_COUNT = 20;

const cache = new Map();

function loadImage(src) {
  if (cache.has(src)) return cache.get(src);
  const img = new Image();
  img.decoding = 'async';
  const p = new Promise((resolve) => {
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // never block on a missing asset
    img.src = src;
  });
  cache.set(src, p);
  return p;
}

export function horseFrame(i, frame) {
  return `${ASSET}horses/HORSE${i}_${frame}_120_90.png`;
}
export function getHorseFrames(i) {
  return {
    stand: horseFrame(i, 'STAND'),
    run1: horseFrame(i, 'RUN1'),
    run2: horseFrame(i, 'RUN2'),
  };
}

const EASY_KEYS = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

// mode: 'easy' | 'hard'; value: 0..3 (easy) or 0..25 (hard); state: '' | 'G' | 'R'
export function keyImage(mode, value, state = '') {
  if (mode === 'easy') {
    return `${ASSET}keys/${EASY_KEYS[value]}${state}.png`;
  }
  const ch = String.fromCharCode(97 + value);
  return `${ASSET}keys/${ch}${state}.png`;
}

export function bgImage(i) {
  return `${ASSET}bg/track${i}.jpg`;
}
export function sceneImage(name) {
  return `${ASSET}bg/scene_${name}.jpg`;
}
export function portraitImage(i) {
  return `${ASSET}portraits/PORTRAIT${i}.png`;
}

// Preload everything so the first race frame is instant.
export async function preload(onProgress) {
  const list = [];
  for (let i = 0; i < HORSE_COUNT; i++) {
    const f = getHorseFrames(i);
    list.push(f.stand, f.run1, f.run2);
  }
  for (let v = 0; v < 4; v++) {
    for (const s of ['', '_G', '_R']) list.push(keyImage('easy', v, s));
  }
  for (let v = 0; v < 26; v++) {
    for (const s of ['', '_G', '_R']) list.push(keyImage('hard', v, s));
  }
  for (let i = 0; i < 10; i++) list.push(portraitImage(i));
  for (let i = 0; i < 5; i++) list.push(bgImage(i));
  list.push(sceneImage('menu'), sceneImage('result'));

  let done = 0;
  const total = list.length;
  await Promise.all(
    list.map((src) =>
      loadImage(src).then(() => {
        done++;
        if (onProgress) onProgress(done / total);
      })
    )
  );
  return cache;
}

export function img(src) {
  return cache.get(src);
}
