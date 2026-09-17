// api.mjs — integration tests for api/server.mjs (the shared-storage backend).
//
// Starts REAL server instances (in-process via startServer) on port 0 and drives
// them over HTTP with Node's built-in fetch: registration, login, tokens,
// authoritative settlement, ranking order, seq idempotency, rename/recode,
// admin, persistence across restart, rate limit, malformed input, concurrency.
//
// Run: node test/api.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../api/server.mjs';

const fails = [];
const passes = [];
function ok(cond, msg) { (cond ? passes : fails).push(msg); }
function section(n) { console.log('\n\x1b[36m== ' + n + ' ==\x1b[0m'); }
function info(m) { console.log('   ' + m); }
function dumpFails() {
  if (!fails.length) return;
  console.error('\nFailures:');
  for (const f of fails) console.error('  \u2717 ' + f);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hrweb-api-test-'));

/** start an instance and wait until its health endpoint answers */
async function launch({ dataPath = path.join(tmp, 'state.json'), rateLimit = 100000 } = {}) {
  const app = startServer({ port: 0, dataPath, rateLimit });
  const port = await new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      const addr = app.server.address();
      if (addr && addr.port) return resolve(addr.port);
      if (Date.now() - t0 > 5000) return reject(new Error('server never listened'));
      setTimeout(poll, 20);
    })();
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await (await fetch(base + '/api/health')).json()).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  return { app, port, base, dataPath };
}

async function post(base, p, body, token) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  let j = null;
  try { j = await res.json(); } catch { /* leave null */ }
  return { status: res.status, json: j };
}
async function get(base, p, token) {
  const res = await fetch(base + p, { headers: token ? { authorization: 'Bearer ' + token } : {} });
  let j = null;
  try { j = await res.json(); } catch { /* leave null */ }
  return { status: res.status, json: j };
}

let exitCode = 0;
try {
  // ===========================================================================
  section('BOOT / HEALTH / SEED');
  const { app, base, dataPath } = await launch();

  const h = await (await fetch(base + '/api/health')).json();
  ok(h.ok === true && h.api === 1, `health answers {ok,api:1} (users=${h.users})`);

  // the server seeds the demo accounts itself (client skips seeding in remote mode)
  const admin = await post(base, '/api/login', { name: 'admin', code: 'admin' });
  ok(admin.json && admin.json.ok === true, 'seeded admin/admin logs in');
  ok(admin.json.user && admin.json.user.isAdmin === true, 'seeded admin carries isAdmin');
  const lbb = await post(base, '/api/login', { name: 'lbb', code: '1234' });
  ok(lbb.json && lbb.json.ok === true, 'seeded lbb/1234 logs in');
  ok(admin.json.names.includes('admin') && admin.json.names.includes('lbb'), 'session payload carries the user list');

  // ===========================================================================
  section('REGISTER — validation, duplicates, prototype-key names');
  const reg = await post(base, '/api/register', { name: 'alice', code: '1234' });
  ok(reg.json.ok === true && typeof reg.json.token === 'string', 'register alice -> ok + token');
  ok(reg.json.user.totalHorse === 3, 'new user starts with 3 horses (matches register.cpp)');
  const dup = await post(base, '/api/register', { name: 'alice', code: '9999' });
  ok(dup.json.ok === false && dup.json.msg === '该用户名已被占用', 'duplicate register rejected');
  ok((await post(base, '/api/register', { name: 'a', code: '1234' })).json.msg === '用户名至少 2 个字符', 'short name rejected');
  ok((await post(base, '/api/register', { name: 'bob', code: '12' })).json.msg === '密码至少 4 位', 'short code rejected');
  ok((await post(base, '/api/register', { name: 'x'.repeat(21), code: '1234' })).json.ok === false, 'overlong name rejected');
  const ctor = await post(base, '/api/register', { name: 'constructor', code: '1234' });
  ok(ctor.json.ok === true, 'register "constructor" succeeds (null-prototype users map)');
  ok((await get(base, '/api/namecheck?name=constructor')).json.taken === true, 'namecheck sees "constructor" as taken');
  ok((await get(base, '/api/namecheck?name=toString')).json.taken === false, 'namecheck: free name reports free');
  ok((await get(base, '/api/namecheck?name=%20ab%20')).json.taken === false, 'namecheck trims before lookup');

  // ===========================================================================
  section('LOGIN — success / wrong code / unknown');
  ok((await post(base, '/api/login', { name: 'alice', code: 'wrong' })).json.msg === '密码错误', 'wrong code rejected');
  ok((await post(base, '/api/login', { name: 'ghost', code: '1234' })).json.msg === '账号不存在，请先注册', 'unknown account rejected');

  // ===========================================================================
  section('AUTH — bearer tokens');
  ok((await post(base, '/api/result', { isHard: false, score: 100, horse: 0, distance: 10, seq: 1 })).status === 401,
    'result without a token -> 401');
  ok((await post(base, '/api/result', { isHard: false, score: 100, horse: 0, distance: 10, seq: 1 },
    'garbage.sig')).status === 401, 'forged token -> 401');
  const tampered = reg.json.token.split('.')[0] + '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  ok((await post(base, '/api/result', { isHard: false, score: 100, horse: 0, distance: 10, seq: 1 }, tampered)).status === 401,
    'HMAC-tampered token -> 401');
  const sess = await get(base, '/api/session', reg.json.token);
  ok(sess.json.ok === true && sess.json.user.name === 'alice', 'valid token restores the session');

  // ===========================================================================
  section('RESULT — authoritative settlement, ranking order, seq idempotency');
  const r1 = await post(base, '/api/result', { isHard: false, score: 1000, horse: 1, distance: 500, seq: 1 }, reg.json.token);
  ok(r1.json.ok === true && r1.json.summary.isNewRecord === true && r1.json.summary.rankPos === 1,
    'first result lands on rank #1');
  ok(r1.json.user.games === 1 && r1.json.user.topE === 1000 && r1.json.user.seconds === 40,
    'games/seconds/topE updated like storage.recordResult');
  ok(r1.json.rankE[0].name === 'alice' && r1.json.rankE[0].score === 1000, 'rankE slot 1 = alice 1000');

  const replay = await post(base, '/api/result', { isHard: false, score: 1000, horse: 1, distance: 500, seq: 1 }, reg.json.token);
  ok(replay.json.ok === true && replay.json.deduped === true, 'seq replay is deduped');
  ok(replay.status === 200, 'dedupe answers 200');
  const afterReplay = await get(base, '/api/session', reg.json.token);
  ok(afterReplay.json.user.games === 1, 'replay did not double-count games');

  // a second player joins the board; ordering must stay descending
  const bob = (await post(base, '/api/register', { name: 'bobby', code: '1234' })).json;
  const r2 = await post(base, '/api/result', { isHard: false, score: 2000, horse: 2, distance: 600, seq: 1 }, bob.token);
  ok(r2.json.summary.rankPos === 1 && r2.json.rankE[0].name === 'bobby', 'higher score takes rank #1');
  ok(r2.json.rankE[1].name === 'alice' && r2.json.rankE[1].score === 1000, 'previous #1 pushed to #2');

  // lower score still enters the board while empty slots (treated as 0) remain —
  // same rule as storage.updateRanking; a ZERO score never enters
  const r3 = await post(base, '/api/result', { isHard: false, score: 5, horse: 0, distance: 10, seq: 2 }, reg.json.token);
  ok(r3.json.summary.isNewRecord === false, 'low score: no record');
  ok(r3.json.summary.inRank === true && r3.json.summary.rankPos === 3, 'low score fills the first empty slot (#3)');
  ok(r3.json.user.games === 2, 'games still counted');
  const r3b = await post(base, '/api/result', { isHard: false, score: 0, horse: 0, distance: 10, seq: 100 }, reg.json.token);
  ok(r3b.json.summary.inRank === false, 'zero score never enters the board');

  // hard mode fills rankH independently
  const r4 = await post(base, '/api/result', { isHard: true, score: 3000, horse: 3, distance: 700, seq: 3 }, reg.json.token);
  ok(r4.json.summary.rankPos === 1 && r4.json.rankH[0].name === 'alice', 'hard board tracked separately');

  // unlock roll: over many games the collection must grow within legal bounds
  let lastUser = r4.json.user;
  for (let s = 4; s <= 30; s++) {
    const r = await post(base, '/api/result', { isHard: false, score: 10, horse: 0, distance: 10, seq: s }, reg.json.token);
    lastUser = r.json.user;
  }
  ok(lastUser.totalHorse >= 3 && lastUser.totalHorse <= 20, `unlock rolls stay in range (totalHorse=${lastUser.totalHorse})`);
  ok(lastUser.hasHorse.length === 20 && lastUser.horseKey.length === 20, 'horse tables keep their fixed 20 slots');
  const ownedIds = lastUser.hasHorse.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  const slots = lastUser.horseKey.slice(0, lastUser.totalHorse);
  ok(slots.length === ownedIds.length && ownedIds.every((h) => slots.includes(h)),
    'horseKey slots and hasHorse flags describe the same set');
  ok(new Set(slots).size === slots.length, 'no duplicate ids in horseKey');

  ok((await post(base, '/api/result', { isHard: false, score: -5, horse: 0, distance: 0, seq: 31 }, reg.json.token)).json.ok === false,
    'negative score rejected');
  ok((await post(base, '/api/result', { isHard: false, score: 100, horse: 42, distance: 0, seq: 32 }, reg.json.token)).json.ok === false,
    'out-of-range horse rejected');

  // ===========================================================================
  section('PROFILE / CHANGE NAME / CHANGE CODE');
  ok((await post(base, '/api/profile', { port: 4 }, reg.json.token)).json.user.Port === 4, 'avatar port stored');
  ok((await post(base, '/api/profile', { port: 99 }, reg.json.token)).json.ok === false, 'out-of-range avatar rejected');

  const badConfirm = await post(base, '/api/changename', { newName: 'alice2', confirm: 'alice3' }, reg.json.token);
  ok(badConfirm.json.ok === false && badConfirm.json.msg === '两次输入不一致', 'rename confirm mismatch rejected');
  const rename = await post(base, '/api/changename', { newName: 'alice2', confirm: 'alice2' }, reg.json.token);
  ok(rename.json.ok === true && rename.json.user.name === 'alice2', 'rename ok');
  ok(rename.json.names.includes('alice2') && !rename.json.names.includes('alice'), 'name list updated');
  ok(rename.json.rankE.some((r) => r && r.name === 'alice2'), 'ranking entries renamed too');
  ok((await post(base, '/api/login', { name: 'alice', code: '1234' })).json.ok === false, 'old name no longer logs in');
  ok((await post(base, '/api/changename', { newName: 'bobby', confirm: 'bobby' }, reg.json.token)).json.msg === '该用户名已被占用',
    'rename onto an existing name rejected');

  ok((await post(base, '/api/changecode', { oldCode: 'nope', newCode: '5678', confirmCode: '5678' }, reg.json.token)).json.msg === '原密码错误',
    'wrong old code rejected');
  ok((await post(base, '/api/changecode', { oldCode: '1234', newCode: '5678', confirmCode: '5678' }, reg.json.token)).json.ok === true,
    'code change ok');
  ok((await post(base, '/api/login', { name: 'alice2', code: '5678' })).json.ok === true, 'login with the new code works');

  // ===========================================================================
  section('ADMIN — scope and delete protection');
  const asUser = await get(base, '/api/admin/users', bob.token);
  ok(asUser.json.ok === false && asUser.json.msg === '需要管理员权限', 'non-admin blocked from the user list');
  const asAdmin = await get(base, '/api/admin/users', admin.json.token);
  ok(asAdmin.json.ok === true && asAdmin.json.users.some((u) => u.name === 'alice2' && u.code === '5678'),
    'admin sees the full user list (original admin screen shows codes)');
  ok((await post(base, '/api/admin/delete', { name: 'admin' }, admin.json.token)).json.msg === '不能删除管理员',
    'deleting an admin is blocked');
  ok((await post(base, '/api/admin/delete', { name: 'ghost' }, admin.json.token)).json.ok === false, 'deleting a missing user fails');
  const del = await post(base, '/api/admin/delete', { name: 'constructor' }, admin.json.token);
  ok(del.json.ok === true, 'admin deletes a user');
  ok((await post(base, '/api/login', { name: 'constructor', code: '1234' })).json.ok === false, 'deleted user cannot log in');

  // ===========================================================================
  section('CONCURRENCY — parallel results stay atomic');
  const carl = (await post(base, '/api/register', { name: 'carl', code: '1234' })).json;
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      post(base, '/api/result', { isHard: false, score: 100 + i, horse: 0, distance: 10, seq: i + 1 }, carl.token)));
  ok(results.every((r) => r.json.ok === true), '20 parallel results all applied');
  const carlNow = await get(base, '/api/session', carl.token);
  ok(carlNow.json.user.games === 20, `games counter exact under concurrency (${carlNow.json.user.games})`);
  const board = carlNow.json.rankE.filter(Boolean);
  ok(board.every((r, i) => i === 0 || board[i - 1].score >= r.score), 'board still strictly ordered');

  // ===========================================================================
  section('BAD INPUT — malformed JSON / oversized body');
  const raw = await fetch(base + '/api/register', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  ok(raw.status === 400, `malformed JSON -> 400 (got ${raw.status})`);
  const big = await fetch(base + '/api/register', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'a'.repeat(20000), code: '1234' }),
  });
  ok(big.status === 413, `oversized body -> 413 (got ${big.status})`);

  // ===========================================================================
  section('PERSISTENCE — restart replays the state file; tokens survive');
  // register one more user, flush, then boot a fresh instance on the SAME data dir
  const dave = (await post(base, '/api/register', { name: 'dave', code: '1234' })).json;
  app.flush();
  await app.close();

  const app2 = await launch({ dataPath });
  const relogin = await post(app2.base, '/api/login', { name: 'alice2', code: '5678' });
  ok(relogin.json.ok === true, 'renamed + recoded user survives the restart');
  ok(relogin.json.user.games === 31, `play stats survive the restart (games=${relogin.json.user.games})`);
  ok(relogin.json.rankE.some((r) => r && r.name === 'alice2'), 'rankings survive the restart');
  const oldToken = await get(app2.base, '/api/session', dave.token);
  ok(oldToken.json.ok === true, 'token issued before the restart still validates (shared secret)');
  const ctorAfter = await get(app2.base, '/api/namecheck?name=alice');
  ok(ctorAfter.json.taken === false, 'deleted/renamed-away name is free again');
  await app2.app.close();

  // ===========================================================================
  section('RATE LIMIT — per-IP fixed window');
  const rl = await launch({ dataPath: path.join(tmp, 'rl.json'), rateLimit: 3 });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await post(rl.base, '/api/health', {})).status);
  ok(codes.filter((c) => c === 429).length >= 1, `429 after the window is exhausted (${codes.join(',')})`);
  await rl.app.close();

  // ===========================================================================
  section('RESULT');
  ok(passes.length >= 40, `assertion volume sane (${passes.length})`);
  console.log(`\n\x1b[${fails.length ? 31 : 32}mPASS ${passes.length}   FAIL ${fails.length}\x1b[0m`);
  if (fails.length) { console.log('\nFailures:'); for (const f of fails) console.log('  \x1b[31m\u2717\x1b[0m ' + f); }
  exitCode = fails.length ? 1 : 0;
} catch (e) {
  console.error('\n\x1b[31mAPI TEST BAIL\x1b[0m\n' + (e && e.stack || e));
  dumpFails();
  exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);
