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

// 用 Inno Setup 把 dist/win-unpacked 打成安装包（需要 Inno Setup 6.5+）。
// 版本号取自 package.json；ISCC 路径可以用环境变量 ISCC 指定。
import fs from 'fs';
import path from 'path';
import {execFileSync} from 'child_process';
import {fileURLToPath} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const payload = path.join(root, 'dist', 'win-unpacked');

if (!fs.existsSync(path.join(payload, `${pkg.productName}.exe`))) {
    console.error(`找不到应用产物：${payload}\n先跑 npx electron-builder --win --dir`);
    process.exit(1);
}

const iscc = [
    process.env.ISCC,
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe')
].find(p => p && fs.existsSync(p));

if (!iscc) {
    console.error('找不到 ISCC.exe：装 Inno Setup 6.5+（https://jrsoftware.org/isdl.php），或用 ISCC 环境变量给出路径');
    process.exit(1);
}

// exe 的文件版本号必须是四段纯数字
const versionInfo = pkg.version.replace(/-.*$/, '').split('.')
    .map(part => (/^\d+$/.test(part) ? part : '0'))
    .concat(['0', '0', '0'])
    .slice(0, 4)
    .join('.');

console.log(`ISCC: ${iscc}`);
execFileSync(iscc, [
    `/DAppVersion=${pkg.version}`,
    `/DVersionInfoVersion=${versionInfo}`,
    `/DPayloadDir=${payload}`,
    `/DInnoOutputDir=${path.join(root, 'dist')}`,
    path.join(root, 'installer', 'xce.iss')
], {stdio: 'inherit'});

console.log(`安装包已生成：dist${path.sep}XCE-Setup-${pkg.version}.exe`);
