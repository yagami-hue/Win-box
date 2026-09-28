// tests/driveBindSource.spec.ts
// ★ 2026-09-26：源主页「网盘绑定」入口的判定判据（isDriveBindSource）。
//
// 背景：用户报「摸鱼的部分源也需要配置网盘才行，软件最好能自动识别，和 fty 一样」。
//   实测两套配置的类名写法不同 —— fty/游魂是 `csp_XGuard`（壳），摸鱼是 `csp_X`（真实类）；
//   只按原文匹配会漏掉摸鱼那一半。另有一批源用 `ext.cookie` 显式声明凭据口子（123/光鸭/观影/厂长…）。
import { describe, expect, it } from 'vitest';
import {
  driveBindHintFromPlaySources,
  isDriveBindSource,
  looksLikeDriveBindFailure,
  needsDriveBind,
} from '../src/shared/driveProvider';

describe('isDriveBindSource — 网盘绑定入口判定', () => {
  it('★ 立播族（Libvio）：fty 写 LibvioGuard+Cloud-drive、摸鱼写 csp_Libvio+site 列表 → 两套都要认', () => {
    // fty/游魂的写法（靠 ext 的 Cloud-drive 命中）
    expect(isDriveBindSource('{"Cloud-drive":"tvfan/Cloud-drive.txt"}', 'csp_LibvioGuard')).toBe(true);
    // ★ 摸鱼的真实写法（用户实测配置原样：api=csp_Libvio，ext 只有 site 列表）
    const moYuExt = '{"site":["https://libviofabu.com","https://libvio.app","https://libfabu.com","https://libviogroup.github.io"]}';
    expect(isDriveBindSource(moYuExt, 'csp_Libvio')).toBe(true);
    expect(isDriveBindSource('', 'csp_LibvioGuard')).toBe(true);
  });

  it('ext 带 Cloud-drive（fty/游魂系）→ 需要绑定（Guard 与否都认）', () => {
    const ext = '{"Cloud-drive":"tvfan/Cloud-drive.txt"}';
    expect(isDriveBindSource(ext, 'csp_MyDriveGuard')).toBe(true);
    expect(isDriveBindSource(ext, 'csp_LibvioGuard')).toBe(true);
    expect(isDriveBindSource(ext, 'csp_KkSs')).toBe(true);
  });

  it('★ 摸鱼系（无 Guard 后缀的网盘家族类名）→ 需要绑定', () => {
    expect(isDriveBindSource('{"site":["https://www.muoua.top"]}', 'csp_FishCloud')).toBe(true);
    expect(isDriveBindSource('https://example.com/x.json', 'csp_FishDrive')).toBe(true);
    expect(isDriveBindSource('{"site":["https://123panfx.com"]}', 'csp_PanWebShare123')).toBe(true);
    expect(isDriveBindSource('{"site":["https://www.guangya.net"]}', 'csp_PanWebShareGuangYa')).toBe(true);
    expect(isDriveBindSource('{"site":["https://x"]}', 'csp_FishKF')).toBe(true);
    expect(isDriveBindSource('{}', 'csp_Wogg')).toBe(true);
    // fty 系盘搜家族（同一只蜘蛛在 fty 里带 Guard）
    expect(isDriveBindSource('{"Cloud-drive":"tvfan/Cloud-drive.txt"}', 'csp_YpanSoGuard')).toBe(true);
    expect(isDriveBindSource('', 'csp_UuSsGuard')).toBe(true);
  });

  it('★ ext 显式声明 cookie 字段（作者留的凭据口子）→ 需要绑定', () => {
    expect(isDriveBindSource('{"cookie":"","site":["https://www.4kcz.com"]}', 'csp_CZ')).toBe(true);
    expect(isDriveBindSource('{"cookie":"","site":["https://x"]}', 'csp_Gying')).toBe(true);
    expect(isDriveBindSource('{"cookie":"","site":["https://x"]}', 'csp_Bili')).toBe(true);
    // 非 JSON / 加密 ext 不得误判（宁窄勿宽）
    expect(isDriveBindSource('rfOIzPkSUkANv6AT2prC8en3+TzKx9TnlT8vaY37HhtYfAQe6C5xqrVuJPhQwYV6r3eRd', 'csp_T4Guard')).toBe(false);
  });

  it('普通 CMS / 非网盘蜘蛛不挂无用按钮', () => {
    expect(isDriveBindSource('{"site":["https://x"]}', 'csp_PianDan')).toBe(false);
    expect(isDriveBindSource('{"categories":[{"name":"a","url":"https://pan.quark.cn/s/x"}]}', 'csp_Market')).toBe(false);
    expect(isDriveBindSource('{"php":"https://x/n.php","site":"chaliao"}', 'csp_NiuLai')).toBe(false);
    expect(isDriveBindSource('{"host":"https://short.fishcloud.top"}', 'csp_HonHon')).toBe(false);
    expect(isDriveBindSource('', 'https://example.com/drpy2.min.js')).toBe(false);
    expect(isDriveBindSource(null, null)).toBe(false);
    expect(isDriveBindSource(undefined, '')).toBe(false);
  });
});

/**
 * ★ 2026-09-27（用户要求「确保每一个需要绑定网盘的都能有这段提示，不管换什么订阅什么源」）：
 *   `needsDriveBind` = 静态判据 ∪ 主进程**运行期学到的**源 key。
 *   学习点 = `SpiderHost.play()` 里 `matchDriveCookieProvider(url)` 命中（蜘蛛真实产出网盘直链）。
 *   这一条不依赖类名清单，因此任何订阅/任何新蜘蛛都覆盖得到。
 */
describe('needsDriveBind — 静态判据 ∪ 运行期学到的', () => {
  it('静态判据命中 → true（与 learned 无关）', () => {
    expect(needsDriveBind({ key: 'Libvio', api: 'csp_Libvio', ext: '{}' }, [])).toBe(true);
    expect(needsDriveBind({ key: 'X', api: 'csp_FishCloud', ext: '' })).toBe(true);
  });

  it('★ 类名清单漏网的新源：只要学过一次（播放时产出网盘直链）→ 就显示绑定入口', () => {
    const unknown = { key: '某新盘源', api: 'csp_BrandNewPan2026', ext: '{"site":["https://x"]}' };
    expect(needsDriveBind(unknown, [])).toBe(false); // 还没学到 → 不误挂
    expect(needsDriveBind(unknown, ['某新盘源'])).toBe(true); // 学到之后 → 永久显示
    // 其它源不受影响（按 key 精确匹配，不做模糊）
    expect(needsDriveBind(unknown, ['别的源'])).toBe(false);
  });

  it('空/缺失入参安全（不得抛错、不得误判）', () => {
    expect(needsDriveBind(null, ['a'])).toBe(false);
    expect(needsDriveBind(undefined)).toBe(false);
    expect(needsDriveBind({}, ['a'])).toBe(false);
    expect(needsDriveBind({ key: '' }, [''])).toBe(false);
  });
});

/**
 * ★ 2026-09-27（缺口 B）：**播放前就能判定「这源要网盘 Cookie」** —— 详情里的播放源名带网盘字样。
 *   实测原样（wex 玩偶 detailContent）：`vod_play_from = 夸克原画$$$夸克最高急速$$$…`，
 *   而剧集 id 是上游私有串（认不出网盘）⇒ 只能按源名判。
 *   为什么必须有：原先只在「播放**成功**产出网盘直链」时才学习 —— 未绑定 Cookie 时播放必失败，
 *   于是「学不到 → 不显示绑定入口 → 永远绑不上」的死循环。
 */
describe('driveBindHintFromPlaySources — 详情播放源名的网盘判定', () => {
  it('★ wex 玩偶实测形态：夸克原画/最高急速 → 命中', () => {
    expect(driveBindHintFromPlaySources(['夸克原画', '夸克最高急速', '夸克自动急速'])).toBe('夸克');
    expect(driveBindHintFromPlaySources(['夸克原画 #02'])).toBe('夸克');
  });

  it('其它网盘源名同样命中（115/阿里/迅雷/百度/123/天翼/光鸭）', () => {
    expect(driveBindHintFromPlaySources(['115网盘'])).toBe('115');
    expect(driveBindHintFromPlaySources(['阿里云盘'])).toBe('阿里云盘');
    expect(driveBindHintFromPlaySources(['迅雷网盘'])).toBe('迅雷');
    expect(driveBindHintFromPlaySources(['百度盘'])).toBe('百度盘');
    expect(driveBindHintFromPlaySources(['123盘'])).toBe('123盘');
    expect(driveBindHintFromPlaySources(['天翼云盘'])).toBe('天翼');
    expect(driveBindHintFromPlaySources(['光鸭'])).toBe('光鸭');
  });

  it('普通 CMS 源名不得误判（宁窄勿宽）', () => {
    expect(driveBindHintFromPlaySources(['HD线路', '流畅', '原画'])).toBe(null);
    expect(driveBindHintFromPlaySources(['m3u8', '粵語'])).toBe(null);
    expect(driveBindHintFromPlaySources([])).toBe(null);
    expect(driveBindHintFromPlaySources(null, null)).toBe(null);
    expect(driveBindHintFromPlaySources(undefined)).toBe(null);
  });

  it('剧集地址是网盘域名时也能命中（extra 判据）', () => {
    expect(driveBindHintFromPlaySources(['HD'], ['https://pan.quark.cn/s/abc'])).toBe('quark');
    expect(driveBindHintFromPlaySources(['HD'], ['https://115.com/s/xyz'])).toBe('115');
  });
});

/**
 * ★ 2026-09-27（缺口 B）：未绑定网盘 Cookie 时的**失败翻译**。
 *   实测：wex 玩偶未绑定夸克时蜘蛛抛 `org.json.JSONException: JSONObject["data"] not found.`
 *   （上游网盘接口无 Cookie 时回错误 JSON，蜘蛛没兜底）→ 必须提示「去绑定」而不是甩 JSONException。
 */
describe('looksLikeDriveBindFailure — 网盘未绑定的失败识别', () => {
  it('★ 实测形态（缺 data 字段）→ 命中', () => {
    expect(looksLikeDriveBindFailure('org.json.JSONException: JSONObject["data"] not found.')).toBe(true);
    expect(looksLikeDriveBindFailure('JSONObject[data] not found')).toBe(true);
  });

  it('授权类关键词 + 网盘语境 → 命中', () => {
    expect(looksLikeDriveBindFailure('网盘接口返回：未登录')).toBe(true);
    expect(looksLikeDriveBindFailure('quark drive: invalid token')).toBe(true);
  });

  it('普通解析/网络错误不得误判', () => {
    expect(looksLikeDriveBindFailure('java.net.UnknownHostException: wogg.333232.xyz')).toBe(false);
    expect(looksLikeDriveBindFailure('timed out')).toBe(false);
    expect(looksLikeDriveBindFailure('')).toBe(false);
    expect(looksLikeDriveBindFailure(null)).toBe(false);
    expect(looksLikeDriveBindFailure(undefined)).toBe(false);
  });
});
