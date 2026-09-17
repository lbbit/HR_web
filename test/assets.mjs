// Asset integrity check for HR_web.
//   1. every URL in the assets.js manifest must exist on disk
//   2. if a base URL is passed (argv[2]), every URL must also serve HTTP 200
//      with an image/expected content-type
//
// usage: node assets.mjs [http://127.0.0.1:PORT]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || null;

const { manifest, RACE_BGS, HORSE_COUNT } = await import(
  new URL('file://' + ROOT.replace(/\\/g, '/') + '/src/assets.js').href
);
const list = manifest();

let bad = 0, bytes = 0;
const byDir = {};
for (const src of list) {
  const rel = src.replace(/^\.\//, '');
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { console.log('MISSING FILE  ' + rel); bad++; continue; }
  const size = fs.statSync(abs).size;
  bytes += size;
  const d = rel.split('/')[1] || rel;
  byDir[d] = byDir[d] || { n: 0, b: 0 };
  byDir[d].n++; byDir[d].b += size;
}
console.log(`manifest entries : ${list.length}`);
console.log(`unique entries   : ${new Set(list).size}`);
for (const [d, v] of Object.entries(byDir)) {
  console.log(`  ${d.padEnd(10)} ${String(v.n).padStart(4)} files  ${(v.b / 1024).toFixed(1)} KB`);
}
console.log(`total on-disk    : ${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`missing files    : ${bad}`);

// extra files present on disk but not in the manifest (informational)
const allFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) walk(rel); else allFiles.push(rel);
  }
})('assets');
const inManifest = new Set(list.map((s) => s.replace(/^\.\//, '')));
// referenced from index.html / CSS / the nginx 404 page, not preloaded by JS
const ALLOWED_EXTRA = new Set(['assets/ui/favicon.ico', 'assets/fonts/zpix-subset.woff2']);
const orphans = allFiles.filter((f) => !inManifest.has(f) && !ALLOWED_EXTRA.has(f));
console.log(`assets on disk   : ${allFiles.length}   orphans (not preloaded): ${orphans.length}`);
if (orphans.length) for (const o of orphans.slice(0, 20)) console.log('  ORPHAN ' + o);

// Windows/macOS filesystems are case-INSENSITIVE, so a wrong-cased path still
// "exists" locally but 404s on a Linux host (GitHub Pages, most CI). Compare
// against the real directory entries, which preserve exact case.
const exact = new Set(allFiles);
let caseBad = 0;
for (const src of list) {
  const rel = src.replace(/^\.\//, '');
  if (!exact.has(rel)) { console.log('CASE MISMATCH  ' + rel); caseBad++; }
}
console.log(`case mismatches  : ${caseBad}`);
bad += caseBad;

// ---- core page files
const core = ['index.html', 'styles.css', 'src/main.js', 'src/game.js', 'src/audio.js', 'src/storage.js', 'src/assets.js', 'assets/ui/favicon.ico', 'assets/fonts/zpix-subset.woff2', 'README.md'];
for (const c of core) {
  if (!fs.existsSync(path.join(ROOT, c))) { console.log('MISSING CORE ' + c); bad++; }
}

// ---- references written in markup, which the JS manifest cannot see --------
// The pixel font is loaded from CSS and preloaded from <head>, so a typo there
// is invisible to manifest() and would silently burn a request (plus a console
// warning) instead of failing. Anything the browser is told to fetch must exist.
const MARKUP = ['index.html', 'styles.css', 'deploy/nginx/404.html'];
const refs = new Set();
for (const f of MARKUP) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) { console.log('MISSING MARKUP FILE ' + f); bad++; continue; }
  const text = fs.readFileSync(abs, 'utf8');
  for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) refs.add(m[1]);
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) refs.add(m[1]);
}
const localRefs = [...refs].filter(
  (u) => !/^(?:https?:)?\/\//.test(u) && !u.startsWith('data:') && !u.startsWith('#')
);
console.log(`markup refs       : ${refs.size} total, ${localRefs.length} local (in ${MARKUP.length} files)`);
let refBad = 0;
for (const u of localRefs) {
  // a leading '/' means "relative to the served web root", which is the repo root
  const rel = u.replace(/^\.\//, '').replace(/^\//, '').split(/[?#]/)[0];
  if (!rel) continue;
  if (!fs.existsSync(path.join(ROOT, rel))) { console.log('BROKEN REF  ' + u + '  -> ' + rel); refBad++; continue; }
  if (rel.startsWith('assets/') && !exact.has(rel)) { console.log('REF CASE MISMATCH  ' + u); refBad++; }
}
console.log(`broken markup refs: ${refBad}`);
bad += refBad;
// anti-vacuity: the scan must actually have found the preload + @font-face
if (localRefs.length < 3) { console.log(`TOO FEW MARKUP REFS (${localRefs.length}) — scanner is broken`); bad++; }

// ---- HTTP check
if (BASE) {
  console.log(`\nHTTP check against ${BASE}`);
  const targets = [...new Set([...core.filter((c) => c !== 'README.md'), ...list.map((s) => s.replace(/^\.\//, ''))])];
  const failures = [];
  let httpOk = 0, httpBytes = 0;
  const CONC = 24;
  for (let i = 0; i < targets.length; i += CONC) {
    const batch = targets.slice(i, i + CONC);
    await Promise.all(batch.map(async (t) => {
      try {
        const r = await fetch(BASE + '/' + t.split('/').map(encodeURIComponent).join('/'));
        if (!r.ok) { failures.push(`${r.status} ${t}`); return; }
        const ct = r.headers.get('content-type') || '';
        const buf = await r.arrayBuffer();
        httpBytes += buf.byteLength;
        if (/\.webp$/.test(t) && !/image\/webp/.test(ct)) { failures.push(`content-type "${ct}" for ${t}`); return; }
        if (/\.png$/.test(t) && !/image\/png/.test(ct)) { failures.push(`content-type "${ct}" for ${t}`); return; }
        httpOk++;
      } catch (e) { failures.push(`ERR ${t} :: ${e.message}`); }
    }));
  }
  console.log(`  requested : ${targets.length}`);
  console.log(`  ok        : ${httpOk}`);
  console.log(`  bytes     : ${(httpBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  failures  : ${failures.length}`);
  for (const f of failures.slice(0, 25)) console.log('  FAIL ' + f);
  bad += failures.length;
}

console.log(bad === 0 ? '\n\x1b[32mASSETS OK\x1b[0m' : `\n\x1b[31mASSETS BAD (${bad})\x1b[0m`);
process.exit(bad === 0 ? 0 : 1);
