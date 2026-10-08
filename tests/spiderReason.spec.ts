// tests/spiderReason.spec.ts
// jar 蜘蛛"失败原因"提取的回归测试。
//
// 背景：蜘蛛在 catch 分支用 SpiderLog 打印真实原因（源站超时 / 非 JSON / 内部参数异常），
// 但默认只进 logger，用户只看到笼统的「蜘蛛返回空结果」。extractSpiderReason 把
// stderr 里的最后一条 SpiderLog 压成人可读短句，供 SourceViewModel 细化文案。
import { describe, it, expect } from 'vitest';
import { extractSpiderReason, extractSpiderReasonRaw, translateSpiderLog, isSpiderClassMissing } from '../src/engine/spider/JarSpiderBridge';

const LOADED = '[android.Log.D] SpiderLog: 自定义爬虫代码加载成功！';
const LOADED_TW = '[android.Log.D] SpiderLog: 自定義爬蟲代碼載入成功！';
const FETCHED = '[android.Log.D] SpiderLog: 获取到源码-->  ......';

describe('extractSpiderReason', () => {
  it('空输入返回空串', () => {
    expect(extractSpiderReason('')).toBe('');
    expect(extractSpiderReason('\n\n')).toBe('');
  });

  it('只有"加载成功"日志时返回空串（成功日志不算原因）', () => {
    expect(extractSpiderReason(LOADED)).toBe('');
    expect(extractSpiderReason(`${LOADED}\n${LOADED}`)).toBe('');
  });

  it('繁体"自定義爬蟲代碼載入成功"同样不算失败（09-14 曾漏过滤）', () => {
    expect(extractSpiderReason(LOADED_TW)).toBe('');
    expect(extractSpiderReason(`${LOADED}\n${LOADED_TW}`)).toBe('');
  });

  it('"获取到源码-->"日志不算失败（蜘蛛成功取到正文，随后才解析）', () => {
    expect(extractSpiderReason(FETCHED)).toBe('');
    expect(extractSpiderReason(`${FETCHED}\n${FETCHED}`)).toBe('');
  });

  it('繁体成功日志与真实失败并存时仍取失败原因', () => {
    const err = `${LOADED_TW}\n[android.Log.D] SpiderLog: Connect timed out :: java.net.SocketTimeoutException`;
    expect(extractSpiderReason(err)).toBe('Connect timed out');
  });

  it('提取连接超时原因', () => {
    const err = `${LOADED}\n[android.Log.D] SpiderLog: Connect timed out :: java.net.SocketTimeoutException: Connect timed out`;
    expect(extractSpiderReason(err)).toBe('Connect timed out');
  });

  it('提取 "bound must be positive"（蜘蛛内部参数异常）', () => {
    const err = `${LOADED}\n[android.Log.D] SpiderLog: bound must be positive :: java.lang.IllegalArgumentException: bound must be positive`;
    expect(extractSpiderReason(err)).toBe('bound must be positive');
  });

  it('取最后一条 SpiderLog（越靠后越接近真实出口）', () => {
    const err = [
      LOADED,
      '[android.Log.D] SpiderLog: 一些中间日志',
      '[android.Log.D] SpiderLog: Index 0 out of bounds :: java.lang.IndexOutOfBoundsException',
    ].join('\n');
    expect(extractSpiderReason(err)).toBe('Index 0 out of bounds');
  });

  it('无 " :: " 分隔时取整段并截断到 120 字符', () => {
    const long = 'x'.repeat(200);
    const err = `${LOADED}\n[android.Log.D] SpiderLog: ${long}`;
    const r = extractSpiderReason(err);
    expect(r.length).toBe(120);
    expect(r).toBe('x'.repeat(120));
  });

  it('忽略 SpiderRunner.ERROR 的堆栈行（只认 SpiderLog）', () => {
    const err = [
      '[SpiderRunner.ERROR] java.lang.ClassNotFoundException: android.app.AlertDialog',
      '\tat java.base/java.lang.ClassLoader.loadClass(Unknown Source)',
    ].join('\n');
    expect(extractSpiderReason(err)).toBe('');
  });
});

// ★ 2026-10-08（用户报「配置中心」源只见一句「接口缺失请反馈」、原始异常被吞）：
//   人话翻译会给用户看，但「具体缺哪个类/方法」在 ` :: 异常` 尾巴里 —— 须并行落原始串才能定位。
describe('extractSpiderReasonRaw（同一条 SpiderLog 的原文，★ 2026-10-08）', () => {
  it('保留 :: 异常尾巴（extractSpiderReason 会吞掉它）', () => {
    const err = `${LOADED}\n[android.Log.D] SpiderLog: 配置中心接口失败 :: java.lang.NoSuchMethodError: android.content.Context.getExternalFilesDir`;
    expect(extractSpiderReason(err)).toBe('配置中心接口失败');
    expect(extractSpiderReasonRaw(err)).toContain('java.lang.NoSuchMethodError');
    expect(extractSpiderReasonRaw(err)).toContain('android.content.Context.getExternalFilesDir');
  });
  it('只有成功日志 / 空输入 → 空串（与 extractSpiderReason 同过滤）', () => {
    expect(extractSpiderReasonRaw('')).toBe('');
    expect(extractSpiderReasonRaw(LOADED)).toBe('');
    expect(extractSpiderReasonRaw(FETCHED)).toBe('');
  });
  it('截断到 300 字符', () => {
    const err = `[android.Log.D] SpiderLog: boom :: ${'z'.repeat(500)}`;
    expect(extractSpiderReasonRaw(err).length).toBe(300);
  });
});

/**
 * 翻译层回归：把"行话"映射成用户能懂的中文。
 *
 * 重点是**架构性不兼容**这一类（第六轮新增）：加固壳蜘蛛依赖安卓原生库
 * （ARM/AArch64 .so）、dalvik DexClassLoader，桌面 JVM 架构上无法执行。
 * 这类必须与"依赖缺失请反馈"区分开，否则会把用户引向错误的解决方向。
 */
describe('translateSpiderLog', () => {
  it('空输入返回空串', () => {
    expect(translateSpiderLog('')).toBe('');
    expect(translateSpiderLog('   ')).toBe('');
  });

  it('安卓原生库缺失 → 明确说明是架构限制', () => {
    const r = translateSpiderLog('java.lang.UnsatisfiedLinkError: no wexguard_v7 in java.library.path');
    expect(r).toContain('安卓原生库');
    expect(r).toContain('架构限制');
  });

  // ★ 第十二轮实测的**真实**报错形态：资源已经补对了，卡在 CPU 架构上。
  //   这一条必须与"找不到原生库"区分开（前者是移植缺陷已修，后者是资源缺失）。
  it('原生库 ABI 不匹配（实测 Can\'t load this .dll）→ 告知与 x64 不兼容', () => {
    const r = translateSpiderLog(
      "java.lang.UnsatisfiedLinkError: C:\\Temp\\.wexfnwabc: Can't load this .dll (machine code=0x34) on a AMD 64-bit platform",
    );
    expect(r).toContain('ARM 原生库');
    expect(r).toContain('x64');
    expect(r).toContain('请更换其他配置源');
  });

  it('dalvik DexClassLoader → 识别为加固/壳，而不是普通依赖缺失', () => {
    const r = translateSpiderLog('java.lang.NoClassDefFoundError: dalvik/system/DexClassLoader');
    expect(r).toContain('加固');
    expect(r).toContain('架构限制');
    // 关键：不能被通用的 ClassNotFoundException 规则吞掉
    expect(r).not.toContain('依赖的接口在桌面版缺失');
  });

  it('异常初始化错误 → 给出静态初始化失败的解释', () => {
    const r = translateSpiderLog('java.lang.ExceptionInInitializerError: Exception java.lang.NullPointerException');
    expect(r).toContain('静态初始化');
  });

  it('桌面版缺桩类 → 保留"兼容性问题请反馈"（不误判为架构限制）', () => {
    const r = translateSpiderLog('java.lang.NoSuchFieldError: android.view.View.mResizeMode');
    expect(r).toContain('桌面版缺失');
    expect(r).not.toContain('架构限制');
  });

  // ★ 2026-10-08（用户报「配置中心」源）：符号名必须上屏 —— 只说「接口缺失请反馈」等于没有可行动信息。
  it('NoSuchMethodError 带上缺失方法名', () => {
    const r = translateSpiderLog('java.lang.NoSuchMethodError: android.app.Activity.getWindow()Landroid/view/Window;');
    expect(r).toContain('桌面版缺失方法');
    expect(r).toContain('android.app.Activity.getWindow');
  });

  it('NoSuchFieldError / ClassNotFoundException 带上缺失符号名', () => {
    expect(translateSpiderLog('java.lang.NoSuchFieldError: android.view.View.mResizeMode')).toContain('android.view.View.mResizeMode');
    expect(translateSpiderLog('java.lang.ClassNotFoundException: android.content.ContentResolver')).toContain('android.content.ContentResolver');
  });

  // ★ 区分「蜘蛛自己的类找不到」与「桌面版缺接口」——两者成因与处置完全不同：
  //   前者 = 这只 jar 压根没加载成功（缓存丢了 / 配置与 jar 不匹配），
  //   后者才是兼容性问题。混为一谈会让用户反复反馈一个根本不用修的问题。
  it('蜘蛛自身类找不到 → 归因为"jar 未加载"，不是"桌面版缺接口"', () => {
    const r = translateSpiderLog('java.lang.ClassNotFoundException: com.github.catvod.spider.PanConfigGuard');
    expect(r).toContain('jar');
    expect(r).toContain('没有加载成功');
    expect(r).not.toContain('桌面版缺失');
    expect(r).not.toContain('请反馈');
  });

  it('平台接口类找不到（android.*）→ 仍归因为桌面版缺失', () => {
    const r = translateSpiderLog('java.lang.ClassNotFoundException: android.webkit.WebView');
    expect(r).toContain('桌面版缺失');
    expect(r).not.toContain('没有加载成功');
  });

  it('源站类原因仍按原规则翻译', () => {
    expect(translateSpiderLog('Connect timed out')).toContain('连接源站超时');
    expect(translateSpiderLog('java.net.UnknownHostException: a.b.c')).toContain('域名无法解析');
  });

  it('未命中规则时原样截断（不臆造）', () => {
    const raw = 'some unknown spider failure ' + 'z'.repeat(200);
    const r = translateSpiderLog(raw);
    expect(r.length).toBe(120);
    expect(r.startsWith('some unknown spider failure')).toBe(true);
  });
});

describe('isSpiderClassMissing（类缺失兜底重试的触发判定）', () => {
  // ★ 2026-09-28：池信封 ok=false 的错误串会先过 translateSpiderLog 再落 lastSpiderReason，
  //   因此翻译后的中文形态必须仍能被判定识别，否则「缓存 jar 并集兜底」在池路径失效。
  it('翻译后的中文原因仍能触发重试（池路径：先 translate 再判定）', () => {
    const translated = translateSpiderLog('java.lang.ClassNotFoundException: com.github.catvod.spider.Symx');
    expect(isSpiderClassMissing(translated)).toBe(true);
  });

  it('原始英文形态也能触发（一次性路径直接用原始 runnerErr 判定）', () => {
    expect(isSpiderClassMissing('java.lang.ClassNotFoundException: com.github.catvod.spider.Symx')).toBe(true);
  });

  it('空原因 / 普通源站原因不触发', () => {
    expect(isSpiderClassMissing('')).toBe(false);
    expect(isSpiderClassMissing('Connect timed out')).toBe(false);
  });
});
