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

/**
 * 桌面通知：AI 干完一轮、或者有事要用户拿主意时，把人叫回来。
 *
 * 为什么走**主进程的原生 Notification**、不用渲染端的 Web Notification：xce:// 是自定义协议，
 * Chromium 对它的通知权限判定不可靠（跟 cookie 是同一个原因，那边实测过），而主进程的
 * Notification 是操作系统级的，跟页面协议无关。渲染端的 ai/notify.js 先探测本模块的桥，
 * 探不到（网页版）才退回 Web Notification 并申请权限。
 *
 * 三条规矩照 ZCode 的 desktopNotifications：
 *   - **有窗口聚焦就不弹**（人就在看着，弹出来只是烦）；
 *   - 同一个 tag 3 秒内只弹一次；
 *   - 点通知把主窗口叫到前面来。
 */

const {BrowserWindow, Notification, ipcMain} = require('electron');

const DEDUPE_MS = 3000;
const recent = new Map();

const liveWindows = () => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());

const focusEditorWindow = () => {
    const target = liveWindows()[0];
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
};

const setupNotifications = () => {
    ipcMain.handle('xce:notify', (event, payload) => {
        const title = String((payload && payload.title) || '').trim();
        if (!title || !Notification.isSupported()) return false;
        if (liveWindows().some(window => window.isFocused())) return false;

        const tag = String((payload && payload.tag) || 'xce');
        const now = Date.now();
        if (now - (recent.get(tag) || 0) < DEDUPE_MS) return false;
        recent.set(tag, now);

        const notification = new Notification({
            title,
            body: String((payload && payload.body) || ''),
            silent: false
        });
        notification.on('click', focusEditorWindow);
        notification.show();
        return true;
    });
};

module.exports = {setupNotifications};
