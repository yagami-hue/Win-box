package com.github.catvod.spider;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * HideUtils stub —— 饭太硬（FTY）壳的加密工具类。
 *
 * 背景（经反编译 fty-real 的 merge.Rc 确认）：
 * 壳 jar 里 native 版 DexNative 有 4 个 native 加密方法：
 *   encrypt(String) / decrypt(String) / calcResult(int[]) / native_ting_md5(String)
 * 真实实现（fty-real）把这些加密方法抽到独立的 HideUtils 类，由主程序（饭太硬 APP）
 * 注入到 classpath 供蜘蛛调用。Rc.B/Gc/KJ/n 四个方法都是「开关 cn.yq 决定走 HideUtils
 * 还是 InitOrigin.i 反射」，其中 HideUtils 分支对应这 4 个方法。
 *
 * 桌面版现状：
 *   - HideUtils 类不在 fty-real jar 里，也不在 FongMi 官方源码里（饭太硬私有），
 *     缺类时 Rc 调 HideUtils 会抛 NoClassDefFoundError；
 *   - 真实加密算法（encrypt/decrypt/calcResult 的密钥与算法）在饭太硬 APP 里，不公开，
 *     桌面版无法 1:1 还原。
 *
 * 本 stub 的定位（诚实边界）：
 *   - tingMd5：按标准 MD5（32 位小写 hex）实现，这是最可能对齐的一种；
 *   - encrypt/decrypt：对称加解密无法还原密钥，占位返回原串（保证不抛错、链路不断）；
 *   - calcResult：签名算法无法还原，占位返回原数组。
 * 以上「占位」只保证不崩溃、不 CNFE；真正依赖饭太硬私有签名的播放源仍可能解析失败，
 * 这是架构限制，不是本 stub 能解决的。
 */
public class HideUtils {

    public static String encrypt(String s) {
        // 饭太硬私有对称加密，密钥不可知；占位返回原串
        return s == null ? null : s;
    }

    public static String decrypt(String s) {
        // ★ 明文映射表（09-15 抓包取证 + 实测验证）：
        //   Rc.KJ 在 yq=true 时调 HideUtils.decrypt 解密 ext / 内部硬编码配置串。
        //   饭太硬私有加密算法（AES/DES 族）无法从单对明文密文破解，改用「已知明文对」查表：
        //   入参精确匹配则返回取证到的明文，否则占位返回原串（保持不抛错）。
        //   seed 的 `5++kwLhNYm9UrO9wh7Dl7eKamTee4s/5` → `https://seedhub.pro/`（搜索实测可返回真实结果）。
        if ("5++kwLhNYm9UrO9wh7Dl7eKamTee4s/5".equals(s)) return "https://seedhub.pro/";
        // 文采（Jpys）内部硬编码配置串（经 KJ 解密），明文猜测候选：www.muou.site / mihdr.top / api.wsyzy.net
        if ("rfOZwatJWBBQ8sd6hpjH8padnQLHxd7mwWAMXIHSDFwEMwcS1yJ5h/NwQvZuwNMnk2WgUcF2+2cUqycyQcIgBPyN5IeuTUDkTYjfwKX2HyOf0wtkbwQLqJXv".equals(s)) {
            String guess = System.getProperty("tvbox.jpysGuess", "https://www.muou.site/");
            return guess;
        }
        return s == null ? null : s;
    }

    public static int[] calcResult(int[] a) {
        // 饭太硬私有签名算法，占位返回原数组
        return a;
    }

    public static String tingMd5(String s) {
        if (s == null) return "";
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] d = md.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(32);
            for (byte b : d) sb.append(String.format("%02x", b & 0xff));
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            return "";
        }
    }
}