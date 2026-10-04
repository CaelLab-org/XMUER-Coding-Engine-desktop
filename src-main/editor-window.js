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

const path = require('path');
const {BrowserWindow, shell} = require('electron');
const {SCHEME} = require('./protocols');
const {runSmokeTest} = require('./smoke-test');

const isInternalURL = url => url.startsWith(`${SCHEME}://`);

/**
 * 站外链接一律丢给系统浏览器，别让主窗口被导航走 —— 页脚那些外链在网页版是正常跳转，
 * 在桌面版里跳走就等于把编辑器顶掉了。
 */
const openExternalInstead = webContents => {
    webContents.setWindowOpenHandler(({url}) => {
        if (isInternalURL(url)) {
            return {action: 'allow'};
        }
        shell.openExternal(url);
        return {action: 'deny'};
    });

    webContents.on('will-navigate', (event, url) => {
        if (!isInternalURL(url)) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });
};

const createEditorWindow = ({startPath}) => {
    const window = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 640,
        backgroundColor: '#f5f6f8',
        show: false,
        title: 'XMUER Coding Engine',
        webPreferences: {
            preload: path.join(__dirname, '..', 'src-preload', 'editor.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // 编辑器是工作环境，不是标签页：窗口切到后台也别停 rAF、别把定时器节流到一分钟一次
            backgroundThrottling: false,
            spellcheck: false
        }
    });

    window.once('ready-to-show', () => window.show());
    window.on('closed', () => {});

    openExternalInstead(window.webContents);

    window.loadURL(`${SCHEME}://.${startPath}`);

    return window;
};

module.exports = {createEditorWindow, isInternalURL};
