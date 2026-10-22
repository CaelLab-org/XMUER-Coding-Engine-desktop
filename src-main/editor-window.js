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

const path = require('path');
const {BrowserWindow, ipcMain, shell} = require('electron');
const {SCHEME} = require('./protocols');
const {closeSplash, setSplashStage} = require('./splash');
const {runSmokeTest} = require('./smoke-test');

const isInternalURL = url => url.startsWith(`${SCHEME}://`);

/**
 * 页面已经画出来了（ready-to-show）之后，最多再等这么久就要显示主窗口。
 *
 * **这个数字是上一版 15 秒兜底的修正**：那会儿只要渲染端没发 `xce:page-ready`
 * （引擎侧的产物没跟着更新就会这样），启动画面就卡满 15 秒 —— 用户 2026-10-04 报的
 * 「启动怎么那么久」就是这个。现在最多多等 1.2 秒：够接上常见情况（页面就在这一两秒内就绪），
 * 接不上也只是把网页自己那张加载页露出来一下，不会让人干等。
 */
const REVEAL_GRACE_MS = 1200;

// 用户已经在我们自己的对话框里确认过「退出」的窗口（见 createEditorWindow 里的 will-prevent-unload）
const closeAllowed = new Set();

// 渲染端点完确认框回的那一句。只登记名单，关闭动作还是走正常的 close() —— 这样
// pagehide 那些收尾（把防抖里的自动存档写掉）照样会跑。
ipcMain.on('xce:close-confirm', event => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target || target.isDestroyed()) {
        return;
    }
    closeAllowed.add(target.id);
    target.close();
});

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

const createEditorWindow = ({startPath, splash}) => {
    const hasSplash = !!splash;
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

    /**
     * 启动时序（用户 2026-10-04：「启动别那么久，只有首次久」）：
     *
     * **没有启动画面**（当天已经开过了、冒烟自测）：ready-to-show 立刻显示主窗口，最快。
     * 此时窗口里是网页自己那张品牌加载页，跟启动画面同一套视觉，所以接得上。
     *
     * **有启动画面**（当天第一次 / 刚更新完）:等页面就绪再收，但**只多等 REVEAL_GRACE_MS**，
     * 不再有那个会卡 15 秒的长兜底。只等 ready-to-show 的话，主窗口会先露出网页那张加载页，
     * 跟淡出的启动画面接不上；只等 page-ready 又可能白等 —— 两头都留个上限最稳。
     */
    let painted = false;
    let pageReady = false;
    let revealed = false;
    let grace = null;
    const reveal = () => {
        if (revealed || window.isDestroyed()) return;
        revealed = true;
        clearTimeout(grace);
        window.show();
        window.focus();
        if (hasSplash) closeSplash(splash);
    };
    const maybeReveal = () => {
        if (!painted) return;
        if (!hasSplash || pageReady) reveal();
    };

    window.once('ready-to-show', () => {
        painted = true;
        // 页面已经出来了，但编辑器还在装配（React 挂载 + 项目恢复）
        setSplashStage(splash, '正在准备编辑器…');
        if (hasSplash && !revealed) grace = setTimeout(reveal, REVEAL_GRACE_MS);
        maybeReveal();
    });
    ipcMain.on('xce:page-ready', event => {
        if (BrowserWindow.fromWebContents(event.sender) !== window) return;
        pageReady = true;
        maybeReveal();
    });

    window.on('closed', () => {
        closeAllowed.delete(window.id);
    });

    /**
     * scratch-gui 的存档守卫在「有未保存改动」时会用它自己的 beforeunload 驳回卸载。
     * 浏览器会给「离开此网站？」提示让人选，**Electron 默认静默驳回** —— 点叉没有任何反应、
     * 也没有提示，窗口就是关不掉（用户 2026-10-04 报的）。
     *
     * 所以这里改成：收到这次驳回就把它**拦下**（窗口继续开着），同时叫渲染端弹自家确认框；
     * 用户点「退出」后渲染端发 `xce:close-confirm`，那时才放行这一次关闭。
     * 项目没有未保存改动时页面不会驳回，这个事件根本不发 —— 关窗还是一次到位。
     */
    window.webContents.on('will-prevent-unload', event => {
        if (closeAllowed.delete(window.id)) {
            // 用户已经确认过：忽略页面的 beforeunload，让这次卸载真的走完
            event.preventDefault();
            return;
        }
        window.webContents.send('xce:close-request');
    });

    openExternalInstead(window.webContents);

    window.loadURL(`${SCHEME}://.${startPath}`);

    return window;
};

module.exports = {createEditorWindow, isInternalURL};
