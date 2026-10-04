# XMUER Coding Engine Desktop

[XMUER Coding Engine](https://engine.xmuer.online/) 的 Windows 桌面版。把编辑器整个装到本地，不再受浏览器标签页的影响：切到后台不会被停掉动画循环、不会被把定时器节流到分钟级、不会被回收标签页、本地数据也不会被浏览器清掉。

## 与网页版的关系

编辑器本体来自另一个仓库 [caellab-com/scratch-gui](https://github.com/caellab-com/scratch-gui)（也就是 engine.xmuer.online 的那套构建产物）。本仓库只放 Electron 壳：

- `src-main/` 主进程：自定义 `xce://` 协议加载本地构建产物、原生文件对话框与原子写盘、窗口参数（关掉后台降频）、外部链接交给系统浏览器、AI 的取网页请求（`net.fetch`，没有页面的跨域限制）
- `src-preload/` 只做最小暴露（IPC）
- 渲染端需要用到的桥在编辑器仓库里：文件读写是 `src/playground/desktop-integration.js`，取网页是 `src/playground/ai/online.js`（都只看 `window.EditorPreload`，网页版整段跳过）

## 构建

```bash
# 1. 先构建编辑器（默认找同级目录 "XMUER Coding Engine"）
cd "../XMUER Coding Engine" && npm run build && cd -

# 2. 本仓库
npm install
npm start        # 开发态直接跑，自动用 ../XMUER Coding Engine/build
npm run dist     # 出 Windows 安装包到 dist/
```

编辑器仓库不在同级目录时，用环境变量 `XCE_ENGINE_DIR=<编辑器仓库路径>` 指定。

## 冒烟自测

```bash
XCE_SMOKE_TEST=smoke.png npm start     # 或对已打包的 exe 设置同样的环境变量
```

会把窗口跑起来检查：编辑器渲染出来没、文件桥挂上没、走一遍 IPC 写盘校验内容、数一遍隐藏窗口里的帧数（验证后台没被降频），最后截图存盘退出。退出码非 0 表示有问题。CI 把它当门禁。

## 许可证

**GPL-3.0-only**，全文见 [LICENSE](LICENSE)，第三方来源与出处说明见 [NOTICE.txt](NOTICE.txt)。

需要注意：本项目打包进安装包的编辑器是 [TurboWarp scratch-gui](https://github.com/TurboWarp/scratch-gui)（GPL-3.0）的修改版分支衍生作品，桌面壳的架构也参考了 [TurboWarp Desktop](https://github.com/TurboWarp/desktop)（GPL-3.0）。**因此整个程序必须以 GPL-3.0 分发，不能改成 MIT / Unlicense / 公有领域**；发布二进制时需保证对应源码可公开获取（两个仓库都是公开的即可）。
