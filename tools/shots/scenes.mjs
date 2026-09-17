// scenes.mjs — the screenshot manifest for docs/screenshots/.
//
// Shared by the browser driver (shot.mjs, running inside headless Chrome) and the
// capture script (capture.mjs, running in Node) so the Chrome window size, the
// iframe size and the expected PNG size can never drift apart.
//
// Every capture is taken at an exact INTEGER scale of the app's fixed stage
// resolution, which is why the results are pixel-perfect rather than resampled:
// the app scales its stage with a CSS transform, and at an integer factor every
// source pixel becomes an exact NxN block (image-rendering: pixelated).

export const STAGE = {
  portrait: [450, 600],   // every menu-ish screen (BG0..BG12)
  race:     [1000, 622],  // BG9_0
  gameover: [740, 480],   // BG13
};

/**
 * id       scene id passed to the driver as ?scene=<id>
 * stage    which fixed stage resolution the scene ends on
 * scale    integer zoom factor of the capture (2 = 2x native pixels)
 * seed     localStorage fixture, see shot.mjs:seed()
 * budget   Chrome --virtual-time-budget in ms (generous: virtual time is instant
 *          in wall-clock terms, it only has to outlast the simulated session)
 * file     output basename under docs/screenshots/
 * caption  Chinese caption used by the README
 */
export const SCENES = [
  { id: 'title',      stage: 'portrait', scale: 2, seed: 'fresh',   budget: 9000,  file: '01-title',      caption: '标题页 —— 原作 BG0 像素画 + 原作按钮素材' },
  { id: 'login',      stage: 'portrait', scale: 2, seed: 'accounts', budget: 9000, file: '02-login',      caption: '登录' },
  { id: 'register',   stage: 'portrait', scale: 2, seed: 'accounts', budget: 9000, file: '03-register',   caption: '注册（含用户名查重）' },
  { id: 'menu',       stage: 'portrait', scale: 2, seed: 'veteran', budget: 9000,  file: '04-menu',       caption: '主菜单' },
  { id: 'select',     stage: 'portrait', scale: 2, seed: 'veteran', budget: 9000,  file: '05-select',     caption: '选关 —— 对手 / 难度 / 出战马' },
  { id: 'stable',     stage: 'portrait', scale: 2, seed: 'veteran', budget: 9000,  file: '06-stable',     caption: '马厩 —— 20 匹收集进度' },
  { id: 'race',       stage: 'race',     scale: 2, seed: 'veteran', budget: 16000, file: '07-race',       caption: '比赛中 —— 20 组 × 6 键、LCD 倒计时、双积分、战况日志' },
  { id: 'pause',      stage: 'race',     scale: 2, seed: 'veteran', budget: 14000, file: '08-pause',      caption: '暂停菜单（继续 / 退到选关）' },
  { id: 'gameover',   stage: 'gameover', scale: 2, seed: 'rivals',  budget: 70000, file: '09-gameover',   caption: '结算 —— 名次、新纪录、新马解锁' },
  { id: 'rank',       stage: 'portrait', scale: 2, seed: 'veteran', budget: 9000,  file: '10-rank',       caption: '排行榜 —— 简单 / 困难 双榜' },
  { id: 'usercenter', stage: 'portrait', scale: 2, seed: 'veteran', budget: 9000,  file: '11-usercenter', caption: '个人中心 —— 头像、战绩、最高排名与积分' },
  { id: 'rule',       stage: 'portrait', scale: 2, seed: 'veteran', budget: 9000,  file: '12-rule',       caption: '规则说明' },
  { id: 'admin',      stage: 'portrait', scale: 2, seed: 'admin',   budget: 9000,  file: '13-admin',      caption: '用户管理（仅管理员）' },

  // Not a screenshot: a DOM audit that walks every screen and reports broken
  // images plus any element that falls outside the stage. Run with --dump-dom.
  { id: 'probe', stage: 'portrait', scale: 1, seed: 'veteran', budget: 14000, probe: true },
];

export const byId = (id) => SCENES.find((s) => s.id === id) || null;

/** PNG size a scene is expected to produce. */
export function expectSize(scene) {
  const [w, h] = STAGE[scene.stage];
  return [w * scene.scale, h * scene.scale];
}

/** Scenes that produce a committed screenshot (i.e. everything but the probe). */
export const shotScenes = () => SCENES.filter((s) => !s.probe);
