# TVBox Win

安卓 TVBox（CatVod 引擎）的 Windows 桌面移植 —— Electron + React + TypeScript + Vite。

> 本项目是**个人学习/研究性质的复刻实现**，与安卓版及任何第三方站点无隶属关系。
> 仓库仅包含**核心源码**，不含任何第三方私有蜘蛛 jar、JVM 运行时、逆向壳或专有产物。

## 特性

- 导入 TVBox 站源 JSON + 直播 txt/m3u，解析规则与安卓原版逐字段对齐（含上游既定行为）
- 内置 JVM 宿主，支持 `jar` 蜘蛛调用（`JarSpider`）与 `.py` 蜘蛛（Jython 宿主，Python 2.7 子集）
- 独立播放器窗口 + Web 播放页双路径；自动下一集（播完 5 秒倒计时可取消）
- 分类/筛选面板、extend 转义与回话级排序记忆、播放器音量百分比/悬停调节

## 目录结构

```
tvbox-win/
├── src/            # 四层：shared / engine / main / renderer
├── tests/          # 引擎单测（Vitest，36 文件 440 用例）
├── scripts/        # 构建脚本（build-main.mjs 等，esbuild + vite）
├── resources/      # js-lib + jvm 宿主源码（*.java），运行时需自行准备
├── docs/           # 源健康判定 / ext 配置等内部文档
└── package.json
```

## 本地开发

```bash
npm ci                # 安装依赖（node_modules，不入库）
npm test              # Vitest 引擎单测
npm run typecheck     # 双 tsc 类型检查
npm run build:main    # esbuild 主进程
npm run build:renderer# vite 渲染层
```

运行时依赖（**不入库**，按需自行准备）：JDK/JRE、`stubs.jar` 桥、`jython-standalone`、shell-shim 等，详见 `docs/`。

## 许可

代码采用 MIT 许可证（见 [LICENSE](LICENSE)）。请遵守第三方软件（蜘蛛 jar、运行时、壳等）各自的版权与许可。