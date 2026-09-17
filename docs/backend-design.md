# HR_web 后端存储设计 —— 多人共享数据

> 状态：已实现（本文档与代码同步维护）。
> 关联：`api/server.mjs`（服务端）、`src/storage.js`（双模式适配器）、`docker-compose.yml`、`deploy/nginx/default.conf`、`test/api.mjs`。

## 1. 目标与非目标

| 目标 | 说明 |
| --- | --- |
| 多人共享 | 账号、马匹收集、战绩、双难度 Top5 排行榜全局一份，所有玩家可见 |
| 前端玩法不变 | `storage.js` 的同步 API 签名不变，`game.js` / `main.js` 玩法逻辑零改动 |
| 后端压力小 | 每局只有 1 次写请求（~1KB JSON）；无数据库进程；写盘按防抖合并；单进程内存热数据 |
| 严谨正确 | 服务端权威结算、请求幂等去重、原子落盘、令牌鉴权、严格输入校验 |
| 可离线 | 后端不可达时自动回退为现有 localStorage 单机模式（功能与今天完全一致） |

非目标：不做实时对战（对战仍是人机）；不做跨设备实时推送（排行在进入界面时刷新）；不做 HTTPS（由部署侧反代负责，见 §8）。

## 2. 总体架构

```
浏览器 (前端玩法不变)
   │  同步 XHR（登录/注册/结算/改名/改密/头像/管理，均为小 JSON，低频）
   │  异步 fetch（开机探测 / 会话恢复 / 排行刷新 / 离线队列重放）
   ▼
nginx (静态镜像) ── location /api/ ──▶ api 服务 (Node 22, 零 npm 依赖)
                                        ├─ 内存热数据（全量状态，<1MB 量级）
                                        ├─ HMAC-SHA256 无状态会话令牌
                                        └─ JSON 原子持久化（防抖 300ms，tmp+rename）
                                             ▼
                                        /data/state.json (compose 卷)
```

为什么是「同步 XHR」而不是把 storage 改成异步：`game.js._finish()` 依赖
`store.recordResult()` **同步**返回 `{isNewRecord, inRank, rankPos, unlocked, ...}`
渲染结算画面；`main.js` 的登录/注册/改密处理器同样依赖同步返回值决定跳转。
把整条链路改异步会波及全部玩法代码，违背「前端玩法不变」。
这些请求低频（登录一次、每局一次）、载荷 <1KB、走局域网回环，同步阻塞几毫秒
可接受；代价与收益在 §9 记录。

## 3. 数据模型（服务端，与 storage.js 完全对齐）

`/data/state.json`：

```jsonc
{
  "version": 1,
  "users": { "<name>": { /* 与 storage.js newUser() 字段一致：
        name, code, games, seconds, distance, topE, topH,
        rankTopE, rankTopH, hasHorse[20], horseKey[20], totalHorse,
        Port, TopHorseE, TopHorseH, isAdmin, lastSeq */ } },
  "rankE": [null|{name,score} ×5],   // 简单难度 Top5
  "rankH": [null|{name,score} ×5]    // 困难难度 Top5
}
```

不存的东西：`settings`（音乐/音效/赛道是设备偏好，留在浏览器 localStorage）；
`currentUser`（会话由令牌表达，服务端无会话状态）。

**密码明文说明**：原作（Qt 单机）把密码存在本地且管理员界面直接显示任意用户
密码（`buildAdmin` 的 `vCode`）。为保持复刻保真，服务端同样存明文。
已知风险与缓解：仅限内网/信任环境部署；API 层有速率限制与体积上限；生产
公网部署必须在反代终止 TLS（§8）。此为有意权衡，不是疏漏。

## 4. API 契约

约定：全部 `Content-Type: application/json`；响应统一 `{ok:true, ...}` 或
`{ok:false, msg}`；鉴权用 `Authorization: Bearer <token>`；除 health/rank/namecheck
外都要求令牌。请求体上限 16KB；非 JSON 或坏 JSON → 400。

| 方法/路径 | 鉴权 | 请求 | 响应（成功时） |
| --- | --- | --- | --- |
| GET `/api/health` | 无 | — | `{ok, api:1, users}`（探测用） |
| GET `/api/rank` | 无 | — | `{ok, rankE, rankH}` |
| GET `/api/namecheck?name=x` | 无 | — | `{ok, taken}` |
| POST `/api/register` | 无 | `{name, code}` | `{ok, token, user, rankE, rankH, names}` |
| POST `/api/login` | 无 | `{name, code}` | 同上 |
| GET `/api/session` | 令牌 | — | 同上（刷新页面恢复会话） |
| POST `/api/result` | 令牌 | `{isHard, score, horse, distance, seq}` | `{ok, summary, user, rankE, rankH}`；重复 seq → `{ok, deduped:true}` |
| POST `/api/profile` | 令牌 | `{port: 0-9}` | `{ok, user}`（头像） |
| POST `/api/changename` | 令牌 | `{newName, confirm}` | `{ok, user, names}` |
| POST `/api/changecode` | 令牌 | `{oldCode, newCode, confirmCode}` | `{ok, user}` |
| GET `/api/admin/users` | 管理员 | — | `{ok, users:[全量用户]}`（admin 屏显示密码，原作行为） |
| POST `/api/admin/delete` | 管理员 | `{name}` | `{ok, names}`；不能删除管理员 |

`summary` 与本地 `recordResult` 返回完全同形：
`{isNewRecord, inRank, rankPos, unlocked, score, topNow}`。

### 校验规则（与前端 storage.js 一致并封顶）

- `name`：trim 后长度 2–20（前端输入框 maxlength=20）；任意字符合法
  （含 `constructor`/`__proto__` 等，服务端 users 同样用无原型映射）。
- `code`：长度 4–20。
- `score`：0–99999 非负整数；`distance`：0–1e9；`horse`：0–19；
  `isHard`：布尔；`seq`：≥1 整数；`port`：0–9。
- 校验失败 → `{ok:false, msg}`（与前端文案一致）。

## 5. 会话令牌（无状态，服务端零会话存储）

- `token = base64url(payload) + '.' + base64url(HMAC_SHA256(payload))`，
  `payload = {i: 用户稳定 ID, e: 过期秒}`，有效期 7 天。令牌引用 **ID 而非用户名**，
  改名不会吊销已发放的会话；每个用户注册时分配 `id`（UUID），服务端维护
  id→name 索引。
- HMAC 密钥首次启动随机生成，持久化到 `/data/secret.key`（0600），
  重启不失效、多副本不共用（单副本部署）。
- 校验：重算 HMAC（`timingSafeEqual`）+ 未过期 + id 仍能解析到现存用户。
- 登出是纯客户端行为（删令牌），服务端无需吊销列表；令牌泄漏窗口 = 7 天，
  可改密码后……（不改令牌——文档化限制：改密不吊销旧令牌，属可接受弱化）。

## 6. 结算权威性与并发正确性

1. **服务端权威**：`POST /api/result` 在服务端复刻 `storage.recordResult`
   的全部规则（games/seconds/distance/topE/topH/rankTop 更新、Top5 插入排序、
   随机解锁马及其传说马兜底）。随机数由服务端 `crypto.randomInt` 产生，
   防客户端伪造战绩/解锁。
2. **原子性**：Node 单线程，处理器内同步完成「校验→变更→入榜」，天然免锁。
3. **幂等去重**：请求携带 seq（客户端取 `max(上次seq+1, 当前毫秒)` —— 单调
   防回退，且两台设备同账号也不会撞号）；服务端按用户维护**最近已应用 seq
   集合**（有界 64 个，随状态持久化），命中即返回 `deduped` 不二次计分。
   不用「水位线」是因为它会把乱序到达的合法增量、以及另一台设备的低号 seq
   误判成重放。窗口 64 ≫ 离线队列上限 20，实际重放永远落在窗口内。
4. **改名一致性**：改名在单个请求内完成「查重→改 users 键→同步改 rankE/rankH
   中的名字」，无中间态。
5. **多端同账号**：结算按 seq 集合逐条应用（不丢、不重），其余整用户字段
   （头像等）按请求覆盖（last-write-wins）。两个标签页同时玩同一账号会产生
   交错计分顺序——文档化为已知限制（原作单机语义）。
6. **持久化原子性**：`state.json` 写临时文件后 `rename`（同目录原子），
   崩溃最多丢最近 300ms 的合并写，不会写坏文件；进程退出（SIGTERM/SIGINT）
   强制 flush。

## 7. 前端双模式（离线保底）

- 开机与首次需要时**同步探测** `GET /api/health`（超时 800ms）：
  成功 → 远程模式；任何失败（含无网/无 XHR 的测试环境）→ 本地模式，
  行为与今天逐字节一致（harness 全部回归走这条路径）。
- 远程模式下 `storage.js` 维护一份**镜像**（users 缓存 + 当前用户 + rankE/H
  + 全量用户名），同步读全部命中镜像；写走同步 XHR，响应回填镜像并落
  localStorage（刷新页面恢复 UI 不出空窗）。
- **离线队列（outbox）**：远程模式下结算请求网络失败时，该局按旧本地逻辑
  结算（UI 照常显示），delta 带递增 seq 存入 localStorage（上限 20 条）；
  之后任一次健康探测成功即异步按序重放，服务端按 seq 去重。
  已知折衷：离线局展示的解锁马可能与服务端重放结果不同（随机数在服务端），
  以服务端为准——仅离线窗口内可能出现，联机时不存在。
- 演示账号种子：本地模式仍由前端种子 admin/lbb；远程模式由服务端在空库时
  自行种子，前端跳过（避免双写竞争）。
- 管理员界面：远程模式下走 `/api/admin/users`；本地模式不变。

## 8. 部署

- `api/Dockerfile`：`node:22-alpine`，以内置 `node` 用户运行，
  `HR_DATA_PATH=/data/state.json`，数据卷 `hr_api_data`，HEALTHCHECK 打
  `/healthz`，资源上限 compose 控制（0.5 CPU / 256M，绰绰有余）。
- nginx 静态镜像追加：
  `location /api/ { resolver 127.0.0.11 valid=10s ipv6=off; set $api api; proxy_pass http://$api:8081; }`
  —— 用 Docker 内置 DNS + 变量，**api 容器不存在时 nginx 仍能启动**，
  请求时才解析、失败即 502，前端探测后进入离线模式。静态站本身零影响。
- `docker-compose.yml`：新增 `api` 服务（`build: ./api`，镜像
  `ghcr.io/lbbit/hr_web-api`），web 健康通过后才启动 api 无强依赖（api 自身
  有 healthcheck）。CI（`.github/workflows/docker.yml`）追加 api 镜像 job，
  同 push/tag 规则发布。
- TLS：反代层责任（公网部署时在前置代理终止），容器间为内网明文。

## 9. 性能预算与已知限制

| 项 | 预算 |
| --- | --- |
| 每局新增负载 | 1 次 POST ~1KB + 1 次合并写盘（300ms 窗口内多局合并为 1 次写） |
| 服务端常驻 | 单进程内存 <10MB（千级用户），无数据库进程 |
| 读路径 | 排行/会话/查重均为内存命中；仅管理界面拉全量（管理员专属） |
| 限流 | 每 IP 120 req/min，超出 429；body 16KB 上限 |

已知限制（均有意为之并记录）：密码明文（原作保真）；改密不吊销旧令牌；
同账号多端 LWW；离线局解锁马以服务端重放为准；同步 XHR 阻塞主线程数毫秒。

## 10. 验证策略

1. `test/api.mjs`（Node 内置 fetch，起真实服务进程）：health/种子/注册/重名/
   登录/错密/token 伪造/结算与排行有序性/seq 幂等/改名改名冲突/改密校验/
   admin 权限与删除保护/持久化重启回放/限流/坏请求/并发结算原子性。
2. `test/harness.mjs`（离线路径回归）：现有 235 断言必须全绿，证明前端
   玩法与离线行为零回归；补双模式相关断言。
3. `tools/` CDP 双页面 E2E（真实 Chrome）：两个浏览器页面各自注册账号，
   互相在排行榜看到对方；前端镜像与排行刷新钩子按服务端数据渲染。
