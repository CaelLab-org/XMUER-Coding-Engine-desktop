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

const {contextBridge, ipcRenderer} = require('electron');

// AI 设置的启动快照。xce:// 下没有 cookie 可用，设置改存主进程的文件；这份快照必须在页面
// 脚本之前同步取到 —— 编辑器侧的 settings.js 在 render 期间（loadSettings）就要用，等不了 IPC。
let settingsSnapshot = null;
try {
    settingsSnapshot = ipcRenderer.sendSync('xce:settings-read-sync') || null;
} catch (error) {
    settingsSnapshot = null;
}

/**
 * 给渲染端的最小桥：文件对话框 + 读写 + 取网页 + AI 设置的落盘。
 * 渲染端拿它实现 File System Access API 的子集（见 src/playground/desktop-integration.js）、
 * AI 工具 xce_read_online 的桌面通道（见 src/playground/ai/online.js），
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
    // AI 设置：快照是启动时的值，之后由渲染端自己记；写入交给主进程原子落盘（src-main/settings-store.js）
    settingsSnapshot,
    settingsWrite: raw => ipcRenderer.invoke('xce:settings-write', raw)
});
