/**
 * XMUER Coding Engine Desktop
 * Copyright (C) 2026 CaelLab <contact@caellab.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

const fs = require('fs');
const path = require('path');
const {app, dialog, Menu} = require('electron');
const {registerScheme, serveBuild} = require('./protocols');
const {resolveBuildRoot, resolveStartPath} = require('./build-root');
const {setupFileIO, abortAllWriters, registerHandle} = require('./file-io');
const {setupNetFetch} = require('./net-fetch');
const {setupSettingsStore} = require('./settings-store');
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

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    let mainWindow = null;

    app.on('second-instance', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.focus();
        }
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.whenReady().then(() => {
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

        const window = createEditorWindow({startPath: resolveStartPath(buildRoot)});
        mainWindow = window;
        window.on('closed', () => {
            abortAllWriters();
            mainWindow = null;
        });

        if (process.env.XCE_SMOKE_TEST) {
            const smokeFile = path.join(app.getPath('temp'), 'xce-smoke-roundtrip.bin');
            const {id: smokeFileId} = registerHandle(smokeFile);
            runSmokeTest(window, {
                outputPath: process.env.XCE_SMOKE_TEST,
                fileId: smokeFileId,
                fileTarget: smokeFile
            });
        }
    });
}
