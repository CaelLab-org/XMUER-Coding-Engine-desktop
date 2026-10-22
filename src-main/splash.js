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
 * 启动画面（用户 2026-10-04：「启动别那么久，只有首次久 / 好久没启动过了才算」）。
 *
 * 三条原则，都是被上一版踩出来的：
 *   1. **只在冷启动演**（当天第一次 / 刚更新过，判据见 launch-history.js）。同一天之内再开直接出窗口 ——
 *      每次都演一遍是「看着就慢」的来源，而动画本身并不花时间（它跟页面加载并行）。
 *   2. **不设长兜底**。上一版兜底 15 秒：桌面壳里那份网页产物要是还没接 `xce:page-ready`
 *      （比如引擎侧没跟着更新），启动画面就会**卡满 15 秒**。现在这个上限由 editor-window.js 管，
 *      而且是 1.2 秒级的宽限，不是 15 秒。
 *   3. **动画短、有上限**。视觉抄 ZCode 桌面端（logo 0.72s 的弹入）与 GPCL（圆角 logo 块 + 呼吸光晕 +
 *      粒子 + 淡出），整套下来 1 秒内进场，剩下的时间它在说真话（阶段文案见 setStage）。
 *
 * 窗口是**不透明**的无边框窗（透明窗在部分显卡/远程桌面上会整块发黑），圆角交给系统。
 */

const path = require('path');
const {BrowserWindow} = require('electron');

// 一块横向的品牌卡；比这个再大就像个正经窗口了
const SPLASH_SIZE = {width: 420, height: 300};

// 退场淡出：GPCL 是 0.5s，ZCode 是 0.16s。取中间偏快 —— 用户此刻已经能看到主窗口了。
const FADE_OUT_MS = 200;
const FADE_STEP_MS = 16;

const fadeOut = splash => new Promise(resolve => {
    if (!splash || splash.isDestroyed()) {
        resolve();
        return;
    }
    const steps = Math.max(1, Math.round(FADE_OUT_MS / FADE_STEP_MS));
    let step = 0;
    const timer = setInterval(() => {
        step += 1;
        if (splash.isDestroyed()) {
            clearInterval(timer);
            resolve();
            return;
        }
        splash.setOpacity(Math.max(0, 1 - step / steps));
        if (step >= steps) {
            clearInterval(timer);
            resolve();
        }
    }, FADE_STEP_MS);
});

/**
 * 建启动画面。自己是藏着的，等 ready-to-show 再显示。
 * @param {object} opts
 *   version 应用版本，写进画面右下角那行（省得版本号散在多处）
 * @returns {BrowserWindow}
 */
const createSplashWindow = ({version} = {}) => {
    const splash = new BrowserWindow({
        width: SPLASH_SIZE.width,
        height: SPLASH_SIZE.height,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        // 不进任务栏、永远在最上面：它就是盖在主窗口前面那一层，收尾时淡掉
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        backgroundColor: '#08122a',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false
        }
    });

    splash.loadFile(path.join(__dirname, 'splash.html'), {query: version ? {v: version} : {}});
    splash.once('ready-to-show', () => {
        if (!splash.isDestroyed()) splash.show();
    });
    return splash;
};

/**
 * 换一句阶段文案。画面里的 `window.__stage` 就是给这个用的 ——
 * 与其演一段假动画，不如说清此刻在等什么（学 ZCode 的「正在启动 / 正在初始化本地数据 / 正在完成启动」）。
 * @param {?BrowserWindow} splash
 * @param {string} text
 */
const setSplashStage = (splash, text) => {
    if (!splash || splash.isDestroyed() || !splash.webContents || splash.webContents.isDestroyed()) return;
    splash.webContents.executeJavaScript(`window.__stage && window.__stage(${JSON.stringify(String(text))})`)
        .catch(() => {
            // 画面还没跑起来 / 已经关了：阶段文案本来就是锦上添花，吞掉
        });
};

/**
 * 淡出并销毁启动画面。传 null（这一轮不演启动动画）就直接返回。
 * @param {?BrowserWindow} splash
 * @returns {Promise<void>}
 */
const closeSplash = async splash => {
    if (!splash || splash.isDestroyed()) return;
    await fadeOut(splash);
    if (!splash.isDestroyed()) splash.destroy();
};

module.exports = {createSplashWindow, setSplashStage, closeSplash};
