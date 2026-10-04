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

const fs = require('fs');
const path = require('path');
const {app} = require('electron');

// 编辑器是另一个仓库（caellab-com/scratch-gui），默认放在本仓库的兄弟目录下。
// 位置不一样就用 XCE_ENGINE_DIR 指过去。
const ENGINE_DIR = process.env.XCE_ENGINE_DIR || path.join(__dirname, '..', '..', 'XMUER Coding Engine');

/**
 * 编辑器构建产物在哪：打包后由 extraResources 放到 resources/web；
 * 开发时优先用 web-build，没有再回退到编辑器仓库的 build/，这样改完前端不用重新拷一遍。
 * @returns {string}
 */
const resolveBuildRoot = () => {
    const candidates = app.isPackaged ?
        [path.join(process.resourcesPath, 'web')] :
        [
            path.join(__dirname, '..', 'web-build'),
            path.join(ENGINE_DIR, 'build')
        ];

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'index.html'))) {
            return candidate;
        }
    }

    throw new Error(
        `找不到编辑器构建产物，找过这些位置：\n${candidates.join('\n')}\n` +
        '先在编辑器仓库（XMUER Coding Engine）跑 npm run build；它在别处的话用 XCE_ENGINE_DIR 指定'
    );
};

/**
 * 启动进入哪个语言版本的编辑器（按系统语言挑，挑不到就回退）。
 * @param {string} buildRoot
 * @returns {string}
 */
const resolveStartPath = buildRoot => {
    const locale = app.getLocale();
    const candidates = [
        locale,
        locale.replace(/-([a-z]+)$/, (match, region) => `-${region.toUpperCase()}`),
        'zh-CN',
        'en-US'
    ];

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(path.join(buildRoot, candidate, 'editor.html'))) {
            return `/${candidate}/editor.html`;
        }
    }

    return '/index.html';
};

module.exports = {resolveBuildRoot, resolveStartPath, ENGINE_DIR};
