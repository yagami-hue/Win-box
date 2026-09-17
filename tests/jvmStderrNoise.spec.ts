// tests/jvmStderrNoise.spec.ts — JVM 级噪声过滤。
// 背景：桌面 JVM 桥必须加 -noverify（见 jvmSpawnArgs.spec.ts），JDK13+ 会打印
// deprecation warning；混淆蜘蛛自身的反射探测也会抛 NoSuchMethodException 但被其
// try/catch 吞掉。这些都不代表失败，若不过滤会淹没真实错误、误导用户。
import { describe, it, expect } from 'vitest';
import { stripJvmNoise, extractSpiderReason } from '../src/engine/spider/JarSpiderBridge';

describe('stripJvmNoise — 过滤 JVM 级噪声', () => {
  it('过滤 -noverify 弃用警告', () => {
    const input =
      'OpenJDK 64-Bit Server VM warning: Options -Xverify:none and -noverify were deprecated in JDK 13 and will likely be removed in a future release.\n' +
      '[SpiderRunner.ERROR] real failure';
    const out = stripJvmNoise(input);
    expect(out).not.toContain('deprecated in JDK 13');
    expect(out).toContain('[SpiderRunner.ERROR] real failure');
  });

  it('过滤蜘蛛内部反射探测噪声（NoSuchMethodException + 栈帧）', () => {
    const input = [
      'java.lang.NoSuchMethodException: com.github.catvod.spider.Ali.getToken()',
      '\tat java.base/java.lang.Class.getMethod(Unknown Source)',
      '\tat com.github.catvod.spider.Ali.Ԩ(Unknown Source)',
      'java.lang.NullPointerException: 真实问题',
    ].join('\n');
    const out = stripJvmNoise(input);
    expect(out).not.toContain('NoSuchMethodException');
    expect(out).not.toContain('Class.getMethod');
    expect(out).toContain('NullPointerException: 真实问题');
  });

  it('保留 [SpiderRunner.ERROR] 真实失败信号', () => {
    const input = '[SpiderRunner.ERROR] java.lang.ClassNotFoundException: android.database.Cursor';
    expect(stripJvmNoise(input)).toBe(input);
  });

  it('空输入返回空串', () => {
    expect(stripJvmNoise('')).toBe('');
  });
});

describe('extractSpiderReason — 回归：仍能提取 SpiderLog', () => {
  it('取最后一条 SpiderLog 并压成一行', () => {
    const stderr =
      '[android.Log.D] SpiderLog: 自定义爬虫代码加载成功 :: \n' +
      '[android.Log.E] SpiderLog: Connect timed out :: java.net.SocketTimeoutException: connect timed out';
    expect(extractSpiderReason(stderr)).toBe('Connect timed out');
  });
});
