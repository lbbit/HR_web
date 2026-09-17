// 不用 docker，在本地复现镜像的「构建闸门」。
//
// 为什么需要它：gate 阶段（Dockerfile 阶段 2）只在 docker build 里跑，而它挂掉的
// 典型原因不是代码错，而是**布局错** —— 比如测试要读 README.md 里的截图引用，
// 而 gate 没把 docs/ 一起 COPY 进来，于是构建在 CI 上失败，本地却一无所知。
// 这个脚本把阶段 1、2 的 COPY 原样铺进一个临时目录，再在里头跑同样的两个测试，
// 一秒出结果，不用等一整轮 CI。
//
// 文件清单是**从 Dockerfile 解析出来的**，不在这里抄一份，所以不会和镜像脱节。
//
//   node tools/gate-sim.mjs          # 跑完即删临时目录
//   node tools/gate-sim.mjs --keep   # 保留临时目录，便于手翻
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE = path.join(ROOT, 'Dockerfile');
const SIM = path.join(os.tmpdir(), 'hr-gate-sim-' + process.pid);

// ---- 1. 从 Dockerfile 里取出「喂给 gate 的」那些 COPY --------------------------
// 阶段 1 (bundle) 与阶段 2 (gate) 是串联的，后者以前者为底，所以两段的 COPY
// 都落进同一个目录。阶段 3 (runtime) 不参与：它的 COPY 要么带 --from，要么
// 目标写的是容器内绝对路径。
const stages = [];
let cur = null;
for (const raw of fs.readFileSync(DOCKERFILE, 'utf8').split('\n')) {
  const line = raw.trim();
  const from = line.match(/^FROM\s+\S+\s+AS\s+(\S+)/i);
  if (from) { cur = { name: from[1], copies: [] }; stages.push(cur); continue; }
  if (!cur || line.startsWith('#')) continue;
  const copy = line.match(/^COPY\s+(?!.*--from)(\S.*)$/i);
  if (!copy) continue;
  const parts = copy[1].trim().split(/\s+/);
  if (parts.length < 2) continue;
  cur.copies.push({ sources: parts.slice(0, -1), dest: parts[parts.length - 1] });
}

const feed = stages.slice(0, 2);
const gate = feed[feed.length - 1];
console.log(`Dockerfile 阶段 : ${stages.map((s) => s.name).join(' → ')}`);
console.log(`喂给 ${gate.name} : ${feed.map((s) => s.name).join(' + ')} 共 ` +
            `${feed.reduce((n, s) => n + s.copies.length, 0)} 条 COPY`);

// ---- 2. 照 COPY 铺出那个临时目录 ----------------------------------------------
fs.rmSync(SIM, { recursive: true, force: true });
fs.mkdirSync(SIM, { recursive: true });
let n = 0;
for (const stage of feed) {
  for (const { sources, dest } of stage.copies) {
    const toDir = dest.endsWith('/') || sources.length > 1;
    for (const src of sources) {
      const from = path.join(ROOT, src);
      if (!fs.existsSync(from)) { console.log(`  FATAL COPY 源不存在: ${src}`); process.exit(1); }
      // 与 docker 一致：目录是「把内容铺进目标」，不是把目录塞进去
      const to = toDir ? path.join(SIM, dest, path.basename(src.replace(/\/+$/, ''))) : path.join(SIM, dest);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
      n++;
    }
  }
}
console.log(`临时目录       : ${SIM}  (${n} 条 COPY 已应用)`);

// ---- 3. 跑 gate 阶段那两条测试 -------------------------------------------------
let failed = 0;
for (const t of ['test/assets.mjs', 'test/harness.mjs']) {
  const r = spawnSync(process.execPath, [t], { cwd: SIM, encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).split('\n');
  const hot = out.filter((l) => /BROKEN|MISSING|ORPHAN|CASE MISMATCH|ASSETS|PASS|FAIL|TOO FEW/.test(l));
  console.log(`\n── ${t} → ${r.status === 0 ? '通过' : '失败 (exit ' + r.status + ')'}`);
  console.log((hot.length ? hot : out.slice(-6)).slice(0, 14).join('\n'));
  if (r.status !== 0) failed++;
}

if (failed) {
  console.log(`\n构建闸门会失败（${failed} 个测试不过）。临时目录保留在: ${SIM}`);
  console.log('对照 Dockerfile 的 COPY 与测试期望的路径即可定位。');
  process.exit(1);
}
if (!process.argv.includes('--keep')) fs.rmSync(SIM, { recursive: true, force: true });
console.log('\n构建闸门: 通过（镜像里的 gate 阶段会同样的通过）');
