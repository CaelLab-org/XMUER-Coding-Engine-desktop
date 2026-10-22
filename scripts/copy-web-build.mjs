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

// 把编辑器仓库（默认是兄弟目录 "XMUER Coding Engine"）的构建产物拷进 web-build，
// 供 electron-builder 打进安装包。开发时跑 npm start 不用拷 —— 主进程会自己回退过去。
import fs from 'fs';
import path from 'path';
import {execFileSync} from 'child_process';
import {fileURLToPath} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = process.env.XCE_ENGINE_DIR || path.resolve(here, '..', '..', 'XMUER Coding Engine');
const source = path.join(engineDir, 'build');
const target = path.resolve(here, '..', 'web-build');

if (!fs.existsSync(path.join(source, 'index.html'))) {
    console.error(
        `找不到编辑器构建产物：${source}\n` +
        '先在编辑器仓库跑一次 npm run build；它在别处的话用 XCE_ENGINE_DIR 指定'
    );
    process.exit(1);
}

fs.rmSync(target, {recursive: true, force: true});
fs.cpSync(source, target, {recursive: true});

// AGPL-3.0：发出去的二进制要说清编辑器源码出自哪个 commit（CI 里同样写这个文件）。
// 它随 extraResources 进安装目录（resources/web/SOURCE.txt），用户找源码时看得到。
const ENGINE_REPOSITORY = 'CaelLab-org/scratch-gui';
let commit = 'unknown';
let dirty = '';
try {
    commit = execFileSync('git', ['-C', engineDir, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    if (execFileSync('git', ['-C', engineDir, 'status', '--porcelain'], {encoding: 'utf8'}).trim()) {
        // 本地打包时工作区常常是脏的：那个 commit 不等于编出这份产物的源码，如实写出来
        dirty = ' (the editor working tree had uncommitted changes when this build was made)';
    }
} catch (e) {
    // 编辑器目录不是 git 检出（比如拿的是压缩包）也不该拦住打包，如实写 unknown
}
fs.writeFileSync(path.join(target, 'SOURCE.txt'),
    `Editor source: https://github.com/${ENGINE_REPOSITORY}\nCommit: ${commit}${dirty}\n`);

console.log(`已拷贝 ${source} → ${target}`);
