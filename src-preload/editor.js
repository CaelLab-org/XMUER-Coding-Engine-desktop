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

const {contextBridge, ipcRenderer} = require('electron');

// AI 设置的启动快照。xce:// 下没有 cookie 可用，设置改存主进程的文件；这份快照必须在页面
// 脚本之前同步取到 —— 编辑器侧的 settings.js 在 render 期间（loadSettings）就要用，等不了 IPC。
let settingsSnapshot = null;
try {
    settingsSnapshot = ipcRenderer.sendSync('xce:settings-read-sync') || null;
} catch (error) {
    settingsSnapshot = null;
}

// 本机 AI 桥的端口和口令（主进程建窗口前就起好了）。没有这段的网页版，
// 编辑器侧的 ai/bridge.js 会直接跳过。
let aiBridgeSnapshot = null;
try {
    aiBridgeSnapshot = ipcRenderer.sendSync('xce:ai-bridge-info-sync') || null;
} catch (error) {
    aiBridgeSnapshot = null;
}

// 「用本程序打开」的文件可能在页面脚本挂好之前就到（冷启动时主进程在 did-finish-load 就发），
// 先排队，等编辑器侧注册 onOpenFile 时补发。
const openFileQueue = [];
const openFileListeners = new Set();
ipcRenderer.on('xce:open-file', (event, descriptor) => {
    if (!descriptor || !descriptor.id) {
        return;
    }
    if (openFileListeners.size === 0) {
        openFileQueue.push(descriptor);
        return;
    }
    openFileListeners.forEach(callback => callback(descriptor));
});

/**
 * 给渲染端的最小桥：文件对话框 + 读写 + 取网页 + AI 设置的落盘。
 * 渲染端拿它实现 File System Access API 的子集（见 src/playground/desktop-integration.js）、
 * AI 工具 xce_read_online / xce_add_costume_from_url 的桌面通道（见 src/playground/ai/online.js），
 * 以及 AI 设置的存储通道（见 src/playground/ai/settings.js）。
 */
contextBridge.exposeInMainWorld('EditorPreload', {
    pickOpenFile: () => ipcRenderer.invoke('xce:pick-open-file'),
    pickSaveFile: suggestedName => ipcRenderer.invoke('xce:pick-save-file', suggestedName),
    readFile: id => ipcRenderer.invoke('xce:read-file', id),
    writeFileChunk: (id, chunk) => ipcRenderer.invoke('xce:write-file-chunk', id, chunk),
    closeFile: id => ipcRenderer.invoke('xce:close-file', id),
    abortFile: id => ipcRenderer.invoke('xce:abort-file', id),
    // 取网页：主进程发请求（没有 CORS），返回值形状见 src-main/net-fetch.js
    fetchOnline: (url, timeoutMs) => ipcRenderer.invoke('xce:fetch-online', url, timeoutMs),
    // 下载图片（「从网页加造型」）：字节以 base64 回来，类型识别在编辑器侧做
    fetchBinary: (url, timeoutMs) => ipcRenderer.invoke('xce:fetch-binary', url, timeoutMs),
    // 桌面通知：AI 干完活 / 有事情要用户拿主意时把人叫回来。
    // 走主进程的原生 Notification（xce:// 下页面自己的通知权限不可靠，见 src-main/notifications.js）
    notify: payload => ipcRenderer.invoke('xce:notify', payload),
    // 「页面真的画好了」：启动画面据此收场（见 src-main/editor-window.js 的启动时序）。
    // 编辑器侧在 app-target.js 的 SplashEnd 之后发一次，所以主窗口露面时不会有残留的加载圈。
    pageReady: () => ipcRenderer.send('xce:page-ready'),
    // AI 设置：快照是启动时的值，之后由渲染端自己记；写入交给主进程原子落盘（src-main/settings-store.js）
    settingsSnapshot,
    settingsWrite: raw => ipcRenderer.invoke('xce:settings-write', raw),
    // 本机 AI 桥（MCP 客户端用）：渲染端拿它连 127.0.0.1 上的 hub
    aiBridge: aiBridgeSnapshot,
    // 关窗确认：主进程收到页面的 beforeunload 驳回时会问一声，用户确认后再让它真关
    // （见 src-main/editor-window.js 与 playground/close-guard.js）
    onCloseRequest: callback => {
        const listener = () => callback();
        ipcRenderer.on('xce:close-request', listener);
        return () => ipcRenderer.removeListener('xce:close-request', listener);
    },
    closeConfirmed: () => ipcRenderer.send('xce:close-confirm'),
    // 「用本程序打开」：双击 .sb3 / .xce（或命令行带文件）时主进程送来一个文件句柄
    onOpenFile: callback => {
        openFileListeners.add(callback);
        while (openFileQueue.length) {
            callback(openFileQueue.shift());
        }
        return () => openFileListeners.delete(callback);
    }
});
