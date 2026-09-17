#!/usr/bin/env node
// capture.mjs — regenerate docs/screenshots/ from the real app with headless Chrome.
//
//   node tools/shots/capture.mjs                  # all scenes
//   node tools/shots/capture.mjs --only race,pause
//   node tools/shots/capture.mjs --probe          # only the DOM audit report
//   node tools/shots/capture.mjs --scale 1        # smaller files
//   CHROME_PATH=/path/to/chrome node tools/shots/capture.mjs
//
// Self-contained: it serves the repository over a throwaway HTTP server and drives
// Chrome over the DevTools Protocol using Node's built-in WebSocket — no python, no
// npm dependencies.
//
// It uses CDP rather than the --screenshot / --virtual-time-budget CLI shortcuts
// because those are unreliable for an app that animates:
//
//   * the capture happens only once the driver reports window.__shotDone, so the
//     timing never has to be guessed from a wall-clock budget;
//   * the viewport is pinned with Emulation.setDeviceMetricsOverride, so the PNG
//     size is exact rather than incidental;
//   * virtual time is not used at all. Under --virtual-time-budget the headless
//     compositor stops producing frames, requestAnimationFrame stalls after its
//     first tick, and the race loop in src/game.js can never advance.
//
// Two flags matter here and neither is optional:
//   --no-sandbox            without it the Chrome network service crashes on
//                           startup and the browser never becomes debuggable;
//   (no --disable-gpu)      with the GPU disabled the compositor produces no
//                           frames at all, which also wedges the run.
//
// Every capture is verified afterwards — the PNG must have exactly the expected
// pixel size and the driver must have reported success — so a silently wrong
// screenshot is impossible.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES, byId, expectSize, shotScenes } from './scenes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes('--' + name);
const OUT_DIR = path.resolve(ROOT, arg('out', 'docs/screenshots'));
const PORT = Number(arg('port', 8899));
const SCALE = arg('scale', null) ? Number(arg('scale')) : null;
const ONLY = arg('only', null) ? arg('only').split(',').map((s) => s.trim()) : null;
const PROBE_ONLY = has('probe') || has('report');
const SCENE_TIMEOUT = Number(arg('timeout', 150000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- chrome
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH, process.env.CHROME, process.env.BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* keep looking */ }
  }
  throw new Error('找不到 Chrome/Chromium/Edge，请用 CHROME_PATH=/path/to/chrome 指定。');
}

// ---------------------------------------------------------------- static server
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel || 'index.html');
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': buf.length,
        'cache-control': 'no-store',
      });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------- CDP client
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }

  static connect(url, ms = 20000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP connect timeout')); }, ms);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CDP(ws)); });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('CDP socket error: ' + (e.message || ''))); });
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('CDP timeout: ' + method));
      }, 60000);
    });
  }

  /** Evaluate an expression in the page and return its value. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: false,
    });
    if (r.exceptionDetails) throw new Error('page exception: ' + r.exceptionDetails.text);
    return r.result ? r.result.value : undefined;
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

/** The port Chrome picked, published in <profile>/DevToolsActivePort. */
async function waitForDebugPort(profile, ms = 30000) {  const file = path.join(profile, 'DevToolsActivePort');
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const first = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
      const port = Number(first);
      if (port > 0) return port;
    } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error('Chrome 未公布 DevToolsActivePort（启动失败？）');
}

async function pageSocket(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return t.webSocketDebuggerUrl;
    } catch { /* not yet */ }
    await sleep(150);
  }
  throw new Error('找不到可调试的页面目标');
}

/**
 * A freshly started target can refuse Runtime.evaluate until a real document has
 * committed — every poll then fails silently and the scene just times out. Probe
 * until evaluation actually works before trusting any timing.
 */
async function waitEvalReady(cdp, ms = 30000) {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    try {
      if (await cdp.eval('1 + 1') === 2) return;
    } catch (e) { last = e.message; }
    if (Date.now() - t0 > ms) throw new Error('Runtime.evaluate 始终不可用: ' + last);
    await sleep(150);
  }
}

// ---------------------------------------------------------------- png
/** width/height straight out of the PNG IHDR chunk. */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// ---------------------------------------------------------------- main
const fmt = (n) => String(n).padStart(8);
let failed = 0;

async function main() {
  const chrome = findChrome();
  const list = PROBE_ONLY
    ? SCENES.filter((s) => s.probe)
    : (ONLY ? ONLY.map((id) => byId(id) || (() => { throw new Error('unknown scene: ' + id); })()) : shotScenes());
  const scenes = SCALE ? list.map((s) => ({ ...s, scale: SCALE })) : list;

  const server = await startServer();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hrweb-shot-'));
  const base = `http://127.0.0.1:${PORT}`;

  const proc = spawn(chrome, [
    '--headless=new', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--disable-default-apps', '--mute-audio', '--no-proxy-server',
    '--no-sandbox', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--window-size=1200,1400',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  proc.stderr.on('data', (d) => { chromeErr += d; });

  console.log(`chrome   : ${chrome}`);
  console.log(`root     : ${ROOT}`);
  console.log(`server   : ${base}`);
  console.log(`out      : ${OUT_DIR}${SCALE ? `   scale override: ${SCALE}x` : ''}`);
  console.log('');

  let cdp = null;
  try {
    const dbgPort = await waitForDebugPort(profile);
    cdp = await CDP.connect(await pageSocket(dbgPort));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Warm-up navigation. The very first about:blank -> document transition can
    // leave Runtime.evaluate unable to resolve the default execution context, which
    // makes every subsequent poll fail and the first scene time out. Absorb that
    // transition once, here, and only start the scene loop from a live context.
    await cdp.send('Page.navigate', { url: base + '/index.html' });
    await waitEvalReady(cdp);

    for (const scene of scenes) {
      const [w, h] = expectSize(scene);
      const url = `${base}/tools/shots/shot.html?scene=${scene.id}&scale=${scene.scale}`;

      // pin the viewport BEFORE navigating: the driver derives its integer zoom
      // from window.innerWidth/innerHeight, so the frame must already be exact.
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: false,
      });
      await cdp.send('Page.navigate', { url });

      const t0 = Date.now();
      let done = false, lastErr = '';
      while (!done) {
        if (Date.now() - t0 > SCENE_TIMEOUT) break;
        await sleep(150);
        try { done = await cdp.eval('window.__shotDone === true'); } catch (e) { lastErr = e.message; }
      }

      let info;
      if (done) {
        info = await cdp.eval('({status: window.__shotStatus, report: window.__shotReport || ""})');
      } else {
        // no __shotDone: report where the driver got stuck instead of just "timeout"
        const st = await cdp.eval(
          '({title: document.title, steps: (document.getElementById("out")||{}).textContent || ""})',
        ).catch(() => ({}));
        info = {
          status: 'timeout',
          report: `driver never reported __shotDone within ${SCENE_TIMEOUT}ms\n` +
            `  title: ${st.title || '(unreadable)'}\n` +
            `  steps: ${(st.steps || '(none)').replace(/\n/g, ' > ')}` +
            (lastErr ? `\n  last eval error: ${lastErr}` : ''),
        };
      }
      const status = String(info.status || 'unknown');

      if (scene.probe) {
        console.log('==== probe report ====');
        console.log(info.report || '(no report)');
        if (status !== 'ok' || /FAILURES\s+[1-9]/.test(info.report || '')) failed++;
        continue;
      }

      // capture only now — the driver has already pinned the stage transform
      let png = null;
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const buf = Buffer.from(shot.data, 'base64');
        png = path.join(OUT_DIR, scene.file + (status === 'ok' ? '' : '.error') + '.png');
        fs.writeFileSync(png, buf);
      } catch (e) {
        console.log(`FAIL ${fmt(0)} B  ${'-'.padStart(9)}  ${scene.id.padEnd(11)} capture failed: ${e.message}`);
        failed++;
        continue;
      }

      const size = pngSize(png);
      const bytes = fs.statSync(png).size;
      const sizeOk = size && size[0] === w && size[1] === h;
      const ok = sizeOk && status === 'ok';
      if (!ok) failed++;
      // a previous failing run leaves <file>.error.png behind — clear it on success
      if (ok) {
        const stale = path.join(OUT_DIR, scene.file + '.error.png');
        try { fs.rmSync(stale, { force: true }); } catch { /* nothing to clean */ }
      }
      const note = ok ? '' : (status !== 'ok' ? `driver: ${status}` : `expected ${w}x${h}, got ${size ? size.join('x') : 'none'}`);
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${fmt(bytes)} B  ${String(size ? size.join('x') : '-').padStart(9)}  ${scene.id.padEnd(11)} ${note}`);
      if (!ok && info.report) console.log(info.report.split('\n').map((l) => '        ' + l).join('\n'));
    }
  } catch (e) {
    console.error('\n' + e.message);
    if (chromeErr) console.error(chromeErr.split('\n').filter((l) => !/device_event_log|usb_service/.test(l)).slice(0, 10).join('\n'));
    failed++;
  } finally {
    if (cdp) cdp.close();
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    server.close();
    // Chrome may still hold Crashpad files when it exits; a failed cleanup is harmless.
    if (!has('keep')) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ } }
  }

  console.log('');
  if (failed) {
    console.log(`\x1b[31m${failed} scene(s) failed\x1b[0m`);
    process.exitCode = 1;
  } else {
    console.log(`\x1b[32mall scenes captured and verified\x1b[0m`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
