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
const {Readable} = require('stream');
const {protocol} = require('electron');

const SCHEME = 'xce';

const MIME_TYPES = new Map(Object.entries({
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.map': 'application/json',
    '.css': 'text/css',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.cur': 'image/x-icon',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.hex': 'application/octet-stream',
    '.xml': 'text/xml',
    '.zip': 'application/zip',
    '.wasm': 'application/wasm'
}));

/**
 * 必须在 app ready 之前调用。standard/secure 让这个 scheme 拿到正常 origin 待遇
 * （Web Worker、WebGL、音频、localStorage 都依赖它），supportFetchAPI 给 fetch 用。
 */
const registerScheme = () => {
    protocol.registerSchemesAsPrivileged([{
        scheme: SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            stream: true,
            corsEnabled: true
        }
    }]);
};

const mimeTypeFor = filePath => MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';

/**
 * 把 xce://./<路径> 映射到构建产物目录里的文件。
 * @param {string} buildRoot
 */
const serveBuild = buildRoot => {
    const root = path.resolve(buildRoot);

    protocol.handle(SCHEME, async request => {
        let pathname;
        try {
            // 地址形如 xce://./zh-CN/editor.html，host 部分（.）忽略掉
            pathname = decodeURIComponent(new URL(request.url).pathname);
        } catch (e) {
            return new Response('Bad request', {status: 400});
        }

        if (pathname.endsWith('/')) {
            pathname += 'index.html';
        }

        const filePath = path.resolve(root, `.${pathname}`);
        if (filePath !== root && !filePath.startsWith(root + path.sep)) {
            return new Response('Forbidden', {status: 403});
        }

        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.isDirectory()) {
                return new Response('Not found', {status: 404});
            }
            return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
                headers: {
                    'content-type': mimeTypeFor(filePath)
                }
            });
        } catch (e) {
            return new Response('Not found', {status: 404});
        }
    });
};

module.exports = {SCHEME, registerScheme, serveBuild};
