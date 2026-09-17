#!/usr/bin/env bash
# 真实蜘蛛冒烟测试 —— 用桌面 JVM 桥跑指定的 jar 蜘蛛方法。
#
# 用法：bash run-spider.sh <jar路径> <类名> <方法> [参数...]
#   例：bash run-spider.sh <converted.jar> com.github.catvod.spider.KungFu404 homeContent <ext>
#
# 目的：在**不改动应用**的前提下，用与 JarSpiderBridge 完全一致的 classpath/参数
# 复现蜘蛛调用，快速定位 NoSuchMethodError / NoSuchFieldError / ClassNotFoundException。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
JAVA="$HERE/jre/bin/java.exe"
STUBS="$(cygpath -w "$HERE/stubs/stubs.jar")"
LIBS=$(for f in "$HERE"/libs/*.jar; do cygpath -w "$f"; done | paste -sd ';')
JAR="$(cygpath -w "$1")"; CLASS="$2"; METHOD="$3"; shift 3
ARGS=("$@")
CP="$STUBS;$LIBS;$JAR"
# -noverify 必须与 JarSpiderBridge.ts 保持一致：
# dex2jar 产物的 StackMapTable 帧不完整，HotSpot(Java7+) 默认校验会抛
# VerifyError: Expecting a stackmap frame at branch target N（ART 不校验这些帧）。
"$JAVA" -noverify \
    -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8 \
    -cp "$CP" SpiderRunner "$JAR" "$CLASS" "$METHOD" "${ARGS[@]}" 2>&1
