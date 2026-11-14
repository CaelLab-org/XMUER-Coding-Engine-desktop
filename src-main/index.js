/**
 * XMUER Coding Engine Desktop
 * Copyright (C) 2026 CaelLab <contact@caellab.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

const fs = require('fs');
const path = require('path');
const {app, dialog, Menu} = require('electron');
const {registerScheme, serveBuild} = require('./protocols');
const {resolveBuildRoot, resolveStartPath} = require('./build-root');
const {setupFileIO, abortAllWriters, registerHandle} = require('./file-io');
const {setupOpenFiles, openFiles, flushPending} = require('./open-files');
const {filesFromArgv} = require('./project-files');
const {setupNetFetch} = require('./net-fetch');
const {setupSettingsStore} = require('./settings-store');
const {setupAiBridge} = require('./ai-bridge');
const {setupNotifications} = require('./notifications');
const {createSplashWindow} = require('./splash');
const {shouldShowSplash, markLaunched} = require('./launch-history');
const {createEditorWindow} = require('./editor-window');
const {runSmokeTest} = require('./smoke-test');

// 本地应用不该有"先点一下才出声音"这种网页限制（AI 触发运行项目时没有用户手势）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setAppUserModelId('online.xmuer.engine');

// 编辑器不需要 File/Edit/View/Window 这排默认菜单：它占一行还带来 Ctrl+R 这类
// 会把没保存的项目整个刷掉的快捷键。文本框里的复制粘贴是 Chromium 原生的，不受影响。
Menu.setApplicationMenu(null);

// 自定义协议的权限必须在 ready 之前登记
registerScheme();

// 双击 .sb3 / .xce 时 Windows 把文件路径放在命令行里；开发态 electron . 也会带一份
const startupFiles = filesFromArgv(process.argv);

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    let mainWindow = null;
    let aiBridge = null;

    app.on('second-instance', (event, argv) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.focus();
        }
        // 已经开着的时候再双击一个作品：交给现有窗口打开
        openFiles(filesFromArgv(argv));
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('will-quit', () => {
        if (aiBridge) {
            aiBridge.stop();
        }
    });

    app.whenReady().then(async () => {
        let buildRoot;
        try {
            buildRoot = resolveBuildRoot();
        } catch (error) {
            dialog.showErrorBox('启动失败', `${error.message}`);
            app.exit(1);
            return;
        }

        serveBuild(buildRoot);
        setupFileIO({getWindow: () => mainWindow});
        // AI 的 xce_read_online 走这里：主进程发请求，没有页面的跨域限制
        setupNetFetch();
        // AI 设置的落盘通道：必须在建窗口之前注册 —— preload 一跑就会同步要那份启动快照
        setupSettingsStore();
        // 本机 AI 桥：外部 MCP 客户端经它驱动编辑器。端口和口令落在用户目录的 ai-bridge.json，
        // 只监听 127.0.0.1；preload 同样在建窗口前同步读一次。
        aiBridge = await setupAiBridge({
            dir: path.join(app.getPath('appData'), 'XMUER Coding Engine')
        });
        // 桌面通知：AI 干完活 / 要用户拿主意时把窗口叫回来（渲染端 ai/notify.js 发过来的）
        setupNotifications();

        // 启动画面只在**冷启动**演：当天第一次、或者刚更新完（判据见 launch-history.js）。
        // 同一天之内再开就直接出窗口 —— 每次都演一遍是「看着就慢」的来源（用户 2026-10-04 提的）。
        // 冒烟自测一律不演：那个流程要自己 hide/show 窗口并截图，多一个 alwaysOnTop 的窗口会挡画面。
        const version = app.getVersion();
        const smoking = !!process.env.XCE_SMOKE_TEST;
        const splash = !smoking && shouldShowSplash({version}) ? createSplashWindow({version}) : null;
        if (!smoking) markLaunched({version});

        const window = createEditorWindow({startPath: resolveStartPath(buildRoot), splash});
        mainWindow = window;
        setupOpenFiles({getWindow: () => mainWindow});
        window.on('closed', () => {
            abortAllWriters();
            mainWindow = null;
        });
        // 冷启动时带进来的文件：页面还在加载，openFiles 会等 did-finish-load 再送
        flushPending();
        openFiles(startupFiles);

        if (process.env.XCE_SMOKE_TEST) {
            const smokeFile = path.join(app.getPath('temp'), 'xce-smoke-roundtrip.bin');
            const {id: smokeFileId} = registerHandle(smokeFile);
            runSmokeTest(window, {
                outputPath: process.env.XCE_SMOKE_TEST,
                fileId: smokeFileId,
                fileTarget: smokeFile,
                openFile: startupFiles[0]
            });
        }
    });
}
