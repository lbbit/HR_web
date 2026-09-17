# 魔幻赛马 · Horse Racing Web

**魔幻赛马** 的现代 Web 复刻版 —— 用最新的 Web 技术重写经典 Qt 单机赛马游戏，
保留原作玩法精髓，并做得更流畅、更现代。

> 原作仓库：[github.com/lbbit/HR](https://github.com/lbbit/HR)（基于 Qt Widgets 的桌面单机游戏）
> 复刻仓库：[github.com/lbbit/HR_web](https://github.com/lbbit/HR_web)

---

## 玩法

键盘节奏竞速。每局共 **20 组** 按键，每组限时 **2 秒**，开局 3 秒倒计时。
屏幕会依次给出按键提示，你在限定时间内按出对应键即可前进：

- **简单模式**：按提示依次敲出 `↑ ↓ ← →` 方向键。
- **困难模式**：按提示依次敲出 `A–Z` 字母键，组合更丰富。

按键越准、越快，得分越高。单组得分公式与原作一致：

```
单组得分 = (80 · t² − 400 · t + 680) × 正确数 / 6
（t 为该组用时，单位秒）
```

得分转化为赛马前进距离，**总分高于对手即获胜**。每局结算后有机会解锁新马，
集齐 20 匹达成传说成就。

`空格` 键可随时暂停 / 继续。

## 特性

- **原生 ES Module + Canvas 2D**：无框架、无构建步骤，直接打开即可运行。
- **60fps 流畅动画**：平滑的马匹插值、视差赛道背景、尘土与彩带粒子特效。
- **程序化现代音频**（Web Audio API）：3 首可切换的电子/芯片风 BGM + 动态音效，
  取代原作的 5 段 WAV 音频。
- **完整进度系统**：注册/登录、简单/困难双榜（Top 5）、20 匹马收集、等级与经验。
- **复用原作素材**：原工程的马匹精灵、赛道背景（重编码为 JPEG 体积更小）、按键图块。
- **本地存档**：基于 `localStorage`，无需后端。

## 运行

纯静态站点，任意静态服务器即可：

```bash
# 方式一：Python
python -m http.server 8080
# 然后浏览器打开 http://localhost:8080

# 方式二：Node
npx serve .
```

> 通过 `file://` 直接打开 `index.html` 可能因 ES Module 的 CORS 限制失败，
> 建议用上面的本地服务器方式访问。

## 目录结构

```
HR_web/
├── index.html          # 所有界面（标题/登录/菜单/比赛/结算/排行/马厩/设置…）
├── styles.css          # 暗色霓虹「魔法」主题
├── src/
│   ├── main.js         # 启动、界面路由与各界面交互
│   ├── game.js         # 比赛引擎：渲染、输入、计分、对手 AI
│   ├── audio.js        # Web Audio 音频引擎（BGM + 音效）
│   ├── storage.js      # localStorage 持久化（账号/排行/马厩/设置）
│   └── assets.js       # 资源清单与预加载
└── assets/
    ├── horses/         # 20 匹马精灵（STAND/RUN1/RUN2）
    ├── keys/           # 方向键与 A–Z 按键图块（含正确/错误态）
    ├── bg/             # 赛道背景与场景图（JPEG）
    ├── portraits/      # 头像
    └── ui/             # logo、favicon
```

## 与原作的差异

| 维度 | 原作 (Qt) | 复刻 (Web) |
| --- | --- | --- |
| 技术栈 | Qt Widgets (C++) | HTML5 Canvas + Web Audio + 原生 ES Module |
| 音频 | 5 段约 1.1MB WAV | 程序化合成 3 首 BGM + 音效（零音频文件） |
| 动画 | 原图帧切换 | 60fps 插值 + 粒子特效 |
| 对手 | 复刻玩家历史最佳（幽灵） | 程序化三档难度 AI（忠实还原幽灵精神） |
| 存档 | 本地文件 | localStorage |
| 分发 | 安装包 (Inno Setup) | 静态站点 / 任意托管 |

## License

复刻用于学习与原作致敬。素材与玩法逻辑源自原作 [lbbit/HR](https://github.com/lbbit/HR)。
