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
const {dialog} = require('electron');

const PROJECT_EXTENSION = /\.(?:sb3|sb2|sb|xce)$/i;
// .chat.xce / .output.xce 也是 .xce 结尾，但它们是 AI 的对话记录和设置备份，不是作品
const AI_EXPORT = /\.(?:chat|output)\.xce$/i;

const isAiExport = file => AI_EXPORT.test(String(file || '').split(/[\\/]/).pop() || '');

const explainAiExport = (window, filePath) => {
    const chat = /\.chat\.xce$/i.test(filePath);
    const options = {
        type: 'info',
        title: '这是 AI 文件，不是作品',
        message: chat ? '这是 XCE 的 AI 对话记录' : '这是 XCE 的 AI 设置备份',
        detail: chat ?
            '打开编辑器后，在 AI 面板的对话记录里点「导入对话记录」来打开它。' :
            '打开编辑器后，在 AI 设置 → 备份与迁移里点「导入配置」来打开它。',
        buttons: ['好'],
        noLink: true
    };
    if (window && !window.isDestroyed()) {
        dialog.showMessageBox(window, options);
    } else {
        dialog.showMessageBox(options);
    }
};

/**
 * Windows 把双击关联文件后的路径放在 argv 里。打包后是 [exe, 文件]，
 * 开发态（electron .）是 [electron, app, 文件]，所以按 process.defaultApp 跳过前两项。
 * @param {string[]} argv
 * @returns {string[]} 存在的作品/导出文件（AI 导出的过滤留给 open-files 解释）
 */
const filesFromArgv = argv => {
    const args = argv.filter(arg => !arg.startsWith('--')).slice(process.defaultApp ? 2 : 1);
    return args.filter(file => {
        try {
            return fs.statSync(file).isFile() && PROJECT_EXTENSION.test(file);
        } catch (e) {
            return false;
        }
    });
};

module.exports = {filesFromArgv, isAiExport, explainAiExport};
