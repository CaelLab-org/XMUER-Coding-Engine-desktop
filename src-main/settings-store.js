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

/**
 * AI 设置的落盘（userData/settings.json）。
 *
 * 为什么不是 cookie：xce:// 是自定义协议，Chromium 不给它写 cookie —— 渲染端的
 * document.cookie 静默失败，这里的 session.cookies.set 也会报 invalid domain（都实测过）。
 * 编辑器侧的 ai/settings.js 探测到本模块的桥就走文件，探测不到就还走 cookie（网页版）。
 *
 * 读有两条通道，因为时机不同：
 *   - **同步（sendSync）**：preload 在页面脚本之前要一份快照，settings.js 的 loadSettings
 *     是同步函数（面板在 render 里就调），等不了真正从这里 invoke 回来。
 *   - **异步（invoke）**：写。原子写，写一半崩了不会留下半个 json。
 *
 * 文件就一个 —— 用户想备份 / 换机直接把 settings.json 拷走就行。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {app, ipcMain} = require('electron');

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

const setupSettingsStore = () => {
    // preload 的启动快照走这里：读不到（还没存过）就是 null
    ipcMain.on('xce:settings-read-sync', event => {
        try {
            event.returnValue = fs.readFileSync(settingsFile(), 'utf8');
        } catch (error) {
            event.returnValue = null;
        }
    });

    ipcMain.handle('xce:settings-write', async (event, raw) => {
        const target = settingsFile();
        if (typeof raw !== 'string' || raw === '') {
            // 清空设置 = 删文件，等于回到出厂值
            try {
                await fsp.unlink(target);
            } catch (error) {
                // 本来就没有这个文件
            }
            return null;
        }

        const tempPath = `${target}.xce-tmp-${crypto.randomBytes(4).toString('hex')}`;
        await fsp.writeFile(tempPath, raw);
        await fsp.rename(tempPath, target);
        return null;
    });
};

module.exports = {setupSettingsStore};
