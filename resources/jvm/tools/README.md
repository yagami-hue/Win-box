# jvm/tools —— 诊断与修复工具

这些工具**不参与默认运行流程**，只在排查/修复特定 jar 时手工调用。

---

## JarRewriter —— 用 ASM 重算栈帧（修 `VerifyError`）

### 什么时候用
当某个 jar 的蜘蛛报如下错误时：

```
java.lang.VerifyError: Expecting a stackmap frame at branch target N
  或：Expecting a stackmap frame at branch target ... 
  或：Bad type on operand stack / Inconsistent stackmap frames
```

### 背景（为什么要"重算"而不是加 `-noverify`）

`dex2jar` 生成的 StackMapTable 帧可能不完整/不一致，HotSpot 在 Java7+ 会做类型校验并抛
`VerifyError`。运行器目前用 `-noverify` 兜底，但那是**关掉整个字节码校验**：

| | `-noverify` | JarRewriter |
|---|---|---|
| 原理 | 让 JVM 不做校验 | 用 ASM 按当前字节码**重新推导**栈映射帧，产物自洽 |
| 校验状态 | 全部关闭 | 正常开启 |
| 副作用 | JDK13+ 弃用警告（需 `stripJvmNoise` 过滤） | 无 |
| 能修的问题面 | 只覆盖"帧缺失" | 还覆盖操作数栈类型不一致等 |

> ★ 实测记录（第十六轮，2026-09-11）：
> 当前 dex2jar 版本**已不产坏帧** —— 对两批真实 jar（138 + 75 = **213 个类**）
> 用 `ProbeVerify`（逐类 `Class.forName(name, false, loader)`，**不加 `-noverify`**）
> 实测 **VerifyError = 0**。
> ⇒ 本工具目前属于**备用手段**：只有在真撞到校验错误时才需要它，而不是常规流程的一环。

### 怎么用

```bat
:: 参数：<输入 jar> <输出 jar> [额外解析用 classpath，分号分隔]
set JDK=<你的 JDK17>\bin\java.exe
set T=<本目录>
set CP=%T%\asm-9.7.jar;%T%\asm-tree-9.7.jar;%T%\asm-commons-9.7.jar

%JDK% -Xmx1024m -cp "%CP%;%T%" JarRewriter ^
      in.jar out.jar ^
      "..\stubs\stubs.jar;..\libs\gson-2.10.1.jar;..\libs\okhttp-3.14.9.jar;..\libs\okio-1.17.5.jar;..\libs\jsoup-1.17.2.jar;..\libs\json-20240303.jar"
```

输出示例：

```
rewrite done: classes=138 rewritten=138 fallback=0 ms=122 out=1039506
```

- `fallback=0` 表示全部重写成功；**非 0 是安全的** —— 那一部分类会**原样保留**，
  不会把本来能跑的 jar 弄坏。
- **非 class 资源（`assets/**`、`META-INF/MANIFEST.MF`）逐字节原样搬运**，
  加固壳依赖的 `assets/*.so`、`assets/*.guard` 不会丢。
  （第十二轮的教训：任何"重打包"都必须保留非 class 资源，否则壳连初始化都过不去。）
- 自动跳过 `META-INF/*.SF` / `.RSA` / `.DSA` / `SIG-*` —— 内容一变原签名即失效，留着只会告警。

### 关键实现点（改这个工具前先读）
1. **6 组合降级**：`{SKIP_FRAMES, 0, EXPAND_FRAMES} × {复用常量池, 不复用}` 逐个试，
   全失败才回退原始字节 —— 对齐 PlayHub `JarSpiderService.rewriteClassForJvm`。
2. **`SafeFrameClassWriter`**：`COMPUTE_FRAMES` 需要解析父类，而蜘蛛类大量引用
   `android.*` 等服务端不存在的类型；ASM 默认遇到解析失败会抛异常。
   这里覆写 `getCommonSuperClass`，解析不到就返回 `java/lang/Object`（保守但可用）。
3. 因此**务必**把 `stubs.jar` 与 `libs/*.jar` 放进"额外解析 classpath"：
   解析得到越多，帧计算越准。

---

## 重新编译 JarRewriter

```bat
set JDK=<你的 JDK17>
set T=<本目录>
%JDK%\bin\javac.exe -encoding UTF-8 -cp "%T%\asm-9.7.jar;%T%\asm-tree-9.7.jar;%T%\asm-commons-9.7.jar" -d "%T%" "%T%\JarRewriter.java"
```

> 注意：`javac` 在 zh-CN Windows 上默认 GBK，**必须带 `-encoding UTF-8`**（源码含中文注释）。

---

## ASM 版本

`asm-9.7.jar` / `asm-tree-9.7.jar` / `asm-commons-9.7.jar`，来自 Maven Central（`org.ow2.asm`，BSD-3-Clause）。
共约 250 KB。仅 `JarRewriter` 使用，主流程不依赖。
