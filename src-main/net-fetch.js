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
 * `xce_read_online` 的桌面通道：在主进程里取网页。
 *
 * 渲染进程的 fetch 一样吃 Chromium 的跨域限制（窗口没关 webSecurity），所以「AI 读网页」在桌面版
 * 必须走主进程 —— `net.fetch` 用的是 Electron 的网络栈，没有页面 origin 那层 CORS 检查。
 *
 * 分工：**判断和上限由编辑器侧定**（见编辑器仓库的 src/playground/ai/online.js：5 秒超时、
 * 正文 20KB、head 2KB）。这里只负责把东西取回来，外加一条原始响应上限 —— 正文反正会砍到 20KB，
 * 没必要为了它把几十 MB 的页面整个读进内存。原始响应被这条上限截掉时要如实告诉渲染端。
 *
 * 失败一律**当返回值**回给渲染端，不从 IPC 抛：Electron 会把异常包成
 * `Error invoking remote method 'xce:fetch-online': Error: …`，那段前缀会直接进模型的上下文。
 */

const {ipcMain, net} = require('electron');

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 15000;

// 原始响应（含标签）最多留这么多
const RAW_CAP = 1024 * 1024;

// 明显不是文字的东西别当文本取回来：二进制解出来的垃圾会原样进模型的上下文
const BINARY = /^(?:image|video|audio|font)\/|^application\/(?:pdf|zip|octet-stream|x-7z-compressed|x-rar)/i;

// 下载图片的原始字节上限（xce:fetch-binary）：造型资产 10MB 已经是编辑器侧的天花板
const IMAGE_CAP = 10 * 1024 * 1024;

/** 服务器声明的字符集优先（中文站有 GBK 的），认不出就 UTF-8 */
const decoderFor = contentType => {
    const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
    try {
        return new TextDecoder(charset ? charset[1] : 'utf-8');
    } catch (e) {
        return new TextDecoder('utf-8');
    }
};

/** 边下边数，到 RAW_CAP 就停手 —— 页面再大也只花这么多内存 */
const readCapped = async (response, decoder) => {
    if (!response.body) {
        return {text: await response.text(), truncated: false};
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    let truncated = false;
    for (;;) {
        const {done, value} = await reader.read();
        if (done) {
            break;
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        size += value.byteLength;
        if (size >= RAW_CAP) {
            truncated = true;
            await reader.cancel();
            break;
        }
    }
    return {text: decoder.decode(Buffer.concat(chunks)), truncated};
};

const setupNetFetch = () => {
    ipcMain.handle('xce:fetch-online', async (event, url, timeoutMs) => {
        const target = String(url || '').trim();
        if (!/^https?:\/\/\S+$/i.test(target)) {
            return {ok: false, networkError: 'the URL must be a full http(s) address'};
        }

        const asked = Number(timeoutMs);
        const limit = Number.isFinite(asked) ?
            Math.min(Math.max(asked, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), limit);
        try {
            const response = await net.fetch(target, {signal: controller.signal, redirect: 'follow'});
            const contentType = response.headers.get('content-type') || '';
            if (BINARY.test(contentType)) {
                return {ok: false, status: response.status, binary: contentType};
            }
            const {text, truncated} = await readCapped(response, decoderFor(contentType));
            return {ok: response.ok, status: response.status, text, truncated};
        } catch (error) {
            return {
                ok: false,
                networkError: controller.signal.aborted ?
                    `no response within ${limit / 1000}s` : (error && error.message) || String(error)
            };
        } finally {
            clearTimeout(timer);
        }
    });

    // 下载图片（编辑器的「从网页加造型」）：跟 fetch-online 同一条网络栈，但不做文本转换 ——
    // 字节以 base64 回给渲染端，类型识别和 webp→png 转换都在那边做（见 online.js 的 fetchImage）。
    ipcMain.handle('xce:fetch-binary', async (event, url, timeoutMs) => {
        const target = String(url || '').trim();
        if (!/^https?:\/\/\S+$/i.test(target)) {
            return {ok: false, networkError: 'the URL must be a full http(s) address'};
        }

        const asked = Number(timeoutMs);
        const limit = Number.isFinite(asked) ?
            Math.min(Math.max(asked, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), limit);
        try {
            const response = await net.fetch(target, {signal: controller.signal, redirect: 'follow'});
            const contentType = response.headers.get('content-type') || '';
            if (/text\/html/i.test(contentType)) {
                // 拿到的是网页不是图片文件 —— 让编辑器侧给模型一句能懂的解释
                return {ok: false, status: response.status, notImage: contentType};
            }
            const reader = response.body && response.body.getReader ? response.body.getReader() : null;
            let bytes;
            if (reader) {
                const chunks = [];
                let size = 0;
                let tooLarge = false;
                for (;;) {
                    const {done, value} = await reader.read();
                    if (done) break;
                    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
                    size += value.byteLength;
                    if (size > IMAGE_CAP) {
                        tooLarge = true;
                        await reader.cancel();
                        break;
                    }
                }
                if (tooLarge) return {ok: false, status: response.status, tooLarge: true};
                bytes = Buffer.concat(chunks);
            } else {
                bytes = Buffer.from(await response.arrayBuffer());
                if (bytes.length > IMAGE_CAP) return {ok: false, status: response.status, tooLarge: true};
            }
            return {ok: response.ok, status: response.status, contentType, base64: bytes.toString('base64')};
        } catch (error) {
            return {
                ok: false,
                networkError: controller.signal.aborted ?
                    `no response within ${limit / 1000}s` : (error && error.message) || String(error)
            };
        } finally {
            clearTimeout(timer);
        }
    });
};

module.exports = {setupNetFetch, RAW_CAP, DEFAULT_TIMEOUT_MS};
