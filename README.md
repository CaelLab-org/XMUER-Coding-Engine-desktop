# XMUER Coding Engine Desktop

[XMUER Coding Engine](https://engine.xmuer.online/) 的 Windows 桌面版。把编辑器整个装到本地，不再受浏览器标签页的影响：切到后台不会被停掉动画循环、不会被把定时器节流到分钟级、不会被回收标签页、本地数据也不会被浏览器清掉。

## 下载和发布在哪

**本仓库只放 Electron 壳的源码，不提供安装包。** 桌面版和网页版共用同一套编辑器，正式发布、安装包和每版更新日志都发在主仓库 [CaelLab-org/scratch-gui](https://github.com/CaelLab-org/scratch-gui)：

- 下载页面：<https://engine.xmuer.online/desktop/>
- 最新 Release：<https://github.com/CaelLab-org/scratch-gui/releases>
- 编辑器源码：<https://github.com/CaelLab-org/scratch-gui>

本仓库的 Release 只是指路（不附安装包），免得两处版本对不上。

## 与网页版的关系

编辑器本体来自另一个仓库 [CaelLab-org/scratch-gui](https://github.com/CaelLab-org/scratch-gui)（也就是 engine.xmuer.online 的那套构建产物）。本仓库只放 Electron 壳：

- `src-main/` 主进程：自定义 `xce://` 协议加载本地构建产物、原生文件对话框与原子写盘、窗口参数（关掉后台降频）、外部链接交给系统浏览器、AI 的取网页请求（`net.fetch`，没有页面的跨域限制）、AI 设置的落盘（`settings-store.js` 写 `userData/settings.json`）
- `src-preload/` 只做最小暴露（IPC）
- 渲染端需要用到的桥在编辑器仓库里：文件读写是 `src/playground/desktop-integration.js`，取网页是 `src/playground/ai/online.js`，AI 设置的存取是 `src/playground/ai/settings.js`（都只看 `window.EditorPreload`，网页版整段跳过）

## AI 设置存在哪

网页版把 AI 设置（供应商 / base_url / 模型 / api_key）放在 cookie 里，**桌面版没有 cookie 可用**：`xce://` 是自定义协议，Chromium 不给它写 —— 渲染端的 `document.cookie` 静默失败，主进程的 `session.cookies.set` 直接报 `invalid domain`（两条路都实测过）。

所以桌面版的设置走主进程的文件：`%APPDATA%/XMUER Coding Engine/settings.json`。preload 在页面脚本之前同步取一份快照（`loadSettings` 在 render 里就调，等不了 IPC），写入经 IPC 原子落盘。编辑器侧是同一份 `ai/settings.js`，启动时探测 `window.EditorPreload` 决定走哪条路，网页版行为不变。

想备份或换机，直接拷这个 json 就行（api_key 也在里面，别外传）。

## 构建

```bash
# 1. 先构建编辑器（默认找同级目录 "XMUER Coding Engine"）
cd "../XMUER Coding Engine" && npm run build && cd -

# 2. 本仓库
npm install
npm run copy-web   # web-build 存在时开发态优先读它；改完编辑器这一步不能省
npm start          # 开发态直接跑
npm run dist       # 出 Windows 安装包到 dist/
```

编辑器仓库不在同级目录时，用环境变量 `XCE_ENGINE_DIR=<编辑器仓库路径>` 指定。

`npm run dist` 出安装包要本机装了 [Inno Setup](https://jrsoftware.org/isdl.php) 6.5+（`ISCC.exe` 认路径或 `ISCC` 环境变量）。
只想出免安装的目录（`dist/win-unpacked`）跑 `npm run pack`；还要旧那套 NSIS 安装包跑 `npm run dist:nsis`。

## 冒烟自测

```bash
XCE_SMOKE_TEST=smoke.png npm start     # 或对已打包的 exe 设置同样的环境变量
```

会把窗口跑起来检查：编辑器渲染出来没、文件桥挂上没、走一遍 IPC 写盘校验内容、数一遍隐藏窗口里的帧数（验证后台没被降频），最后截图存盘退出。退出码非 0 表示有问题。CI 把它当门禁。

## 用文件打开

装好之后 `.sb3` 和 `.xce` 会与本程序关联（安装时那一步可以取消）：双击作品直接在编辑器里打开，Ctrl+S 存回原文件。`.xce` 和 `.sb3` 内容相同（都是 Scratch 3 项目包），只是 XCE 自己的后缀。

`.chat.xce`（AI 对话记录）和 `.output.xce`（AI 设置备份）虽然也是 `.xce` 结尾，但不会被当成作品：双击它们会提示去 AI 面板导入，不会载入编辑器。

## 许可证

**AGPL-3.0-only**，全文见 [LICENSE](LICENSE)，第三方来源与出处说明见 [NOTICE.txt](NOTICE.txt)。

需要注意：本项目打包进安装包的编辑器是 [TurboWarp scratch-gui](https://github.com/TurboWarp/scratch-gui)（GPL-3.0）的修改版分支衍生作品，桌面壳的架构也参考了 [TurboWarp Desktop](https://github.com/TurboWarp/desktop)（GPL-3.0）。GPL-3.0 与 AGPL-3.0 兼容，所以整个程序以 AGPL-3.0 分发；发布二进制时需保证对应源码可公开获取（两个仓库都是公开的即可）。
