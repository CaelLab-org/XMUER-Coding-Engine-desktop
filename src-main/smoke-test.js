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
const {app, Menu} = require('electron');

/**
 * 冒烟自测：把窗口跑起来，探一下页面是不是真的渲染出来了、桥是不是真的挂上了，
 * 走一遍"写文件 → 落盘"的字节通路，最后截图存盘然后退出。
 * 只在 XCE_SMOKE_TEST 环境变量指向一个 PNG 路径时启用，给 CI 和本地验收用。
 */

const PROBE = `(() => {
    const gui = document.querySelector('[class*="gui_"]');
    return {
        title: document.title,
        origin: window.location.origin,
        url: window.location.href,
        elementCount: document.querySelectorAll('*').length,
        hasGui: !!gui,
        bridge: {
            editorPreload: typeof window.EditorPreload === 'object' && window.EditorPreload !== null,
            openPicker: typeof window.showOpenFilePicker === 'function',
            savePicker: typeof window.showSaveFilePicker === 'function'
        }
    };
})()`;

/**
 * 把窗口藏起来数 3 秒的动画/定时器回调 —— 这是选桌面版而不是网页版的核心理由，
 * 必须实测：浏览器隐藏标签会停 rAF、把定时器节流到秒级甚至分钟级。
 * backgroundThrottling: false 下应该照跑不误，且 document.hidden 保持 false。
 */
const measureBackgroundTicks = window => {
    window.hide();
    return window.webContents.executeJavaScript(`new Promise(resolve => {
        let rafTicks = 0;
        let timerTicks = 0;
        const tick = () => {
            rafTicks++;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        const interval = setInterval(() => {
            timerTicks++;
        }, 250);
        setTimeout(() => {
            clearInterval(interval);
            resolve({rafTicks, timerTicks, hidden: document.hidden});
        }, 3000);
    })`).then(result => {
        window.show();
        return result;
    });
};

const runSmokeTest = (window, {outputPath, fileId, fileTarget, openFile}) => {
    const wait = Number(process.env.XCE_SMOKE_WAIT || 15000);

    window.webContents.on('console-message', (...args) => {
        const event = args[0];
        const message = event && typeof event === 'object' && 'message' in event ? event.message : args[2];
        console.log(`[renderer] ${message}`);
    });
    window.webContents.on('did-fail-load', (event, code, description, url) => {
        console.log(`[load-failed] ${code} ${description} ${url}`);
    });
    window.webContents.on('preload-error', (event, preloadPath, error) => {
        console.log(`[preload-error] ${preloadPath} ${error}`);
    });

    window.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
            let failed = false;
            try {
                const probe = await window.webContents.executeJavaScript(PROBE);
                console.log(`[probe] ${JSON.stringify(probe)}`);
                if (!probe.hasGui || !probe.bridge.openPicker || !probe.bridge.savePicker) {
                    failed = true;
                }

                const menuRemoved = Menu.getApplicationMenu() === null;
                console.log(`[menu] ${menuRemoved ? 'removed' : 'still present'}`);
                if (!menuRemoved) {
                    failed = true;
                }

                // 命令行带了一个作品：确认真的载进 VM 了、标题换了、并且拿到了可写回的句柄
                if (openFile) {
                    const opened = await window.webContents.executeJavaScript(`(() => {
                        const state = window.ReduxStore && window.ReduxStore.getState();
                        const targets = window.vm && window.vm.runtime.targets;
                        return {
                            title: state && state.scratchGui.projectTitle,
                            hasHandle: !!(state && state.scratchGui.tw.fileHandle),
                            targets: targets ? targets.map(target => target.getName()) : []
                        };
                    })()`);
                    console.log(`[open-file] ${JSON.stringify(opened)}`);
                    const expectedTitle = path.basename(openFile)
                        .replace(/\.(?:sb3|sb2|sb|xce)$/i, '');
                    if (!opened.hasHandle || opened.title !== expectedTitle || opened.targets.length < 2) {
                        failed = true;
                    }
                }

                if (fileId) {
                    const payload = Array.from({length: 1024}, (v, i) => i % 251);
                    await window.webContents.executeJavaScript(`(async () => {
                        const bytes = new Uint8Array(${JSON.stringify(payload)});
                        await window.EditorPreload.writeFileChunk(${JSON.stringify(fileId)}, bytes);
                        await window.EditorPreload.closeFile(${JSON.stringify(fileId)});
                    })()`);
                    const written = fs.readFileSync(fileTarget);
                    const expected = Buffer.from(payload);
                    const ok = written.equals(expected);
                    console.log(`[file-roundtrip] ${ok ? 'OK' : '内容不一致'} ${written.length} 字节 → ${fileTarget}`);
                    if (!ok) {
                        failed = true;
                    }
                }

                const ticks = await measureBackgroundTicks(window);
                console.log(`[background-ticks] ${JSON.stringify(ticks)}`);
                // 被降频的话 rAF 会掉到 0、定时器掉到每秒一次左右；隐藏时 document.hidden 也会变 true
                if (ticks.rafTicks < 30 || ticks.hidden) {
                    failed = true;
                }

                const image = await window.webContents.capturePage();
                fs.writeFileSync(outputPath, image.toPNG());
                console.log(`[screenshot] ${outputPath}`);
            } catch (error) {
                console.log(`[smoke-error] ${error}`);
                failed = true;
            }

            app.exit(failed ? 1 : 0);
        }, wait);
    });
};

module.exports = {runSmokeTest};
