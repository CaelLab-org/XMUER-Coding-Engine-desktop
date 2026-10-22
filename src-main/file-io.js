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

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {dialog, ipcMain} = require('electron');
const {explainAiExport, isAiExport} = require('./project-files');

const PROJECT_FILTERS = [
    {name: 'Scratch / XCE 项目', extensions: ['sb3', 'sb2', 'sb', 'xce']},
    {name: '所有文件', extensions: ['*']}
];

/**
 * 主进程手里的文件句柄表。渲染端只拿得到随机 id，拿不到真实路径 ——
 * 这样第三方扩展没法拿 id 去读写任意文件，也避免把用户目录结构暴露给页面。
 * @type {Map<string, {path: string, name: string}>}
 */
const handles = new Map();

/**
 * 正在写的文件：先写同目录的临时文件，关掉时再改名覆盖。
 * 存盘存一半崩了，用户手里的原项目还是完好的。
 * @type {Map<string, {targetPath: string, tempPath: string, handle: fs.FileHandle}>}
 */
const writers = new Map();

const registerHandle = filePath => {
    const id = crypto.randomUUID();
    const name = path.basename(filePath);
    handles.set(id, {path: filePath, name});
    return {id, name};
};

const lookup = id => {
    const entry = handles.get(id);
    if (!entry) {
        throw new Error('文件句柄已失效，请重新选择文件');
    }
    return entry;
};

const finishWrite = async (id, {commit}) => {
    const writer = writers.get(id);
    if (!writer) {
        return;
    }
    writers.delete(id);

    try {
        await writer.handle.close();
    } catch (e) {
        // 关不掉也继续走下面的改名/清理，别把错吞掉影响后面判断
    }

    if (commit) {
        await fs.rename(writer.tempPath, writer.targetPath);
    } else {
        try {
            await fs.unlink(writer.tempPath);
        } catch (e) {
            // 临时文件可能压根没建起来
        }
    }
};

const abortAllWriters = async () => {
    await Promise.all(Array.from(writers.keys()).map(id => finishWrite(id, {commit: false})));
};

const setupFileIO = ({getWindow}) => {
    ipcMain.handle('xce:pick-open-file', async () => {
        const {canceled, filePaths} = await dialog.showOpenDialog(getWindow(), {
            title: '打开项目',
            filters: PROJECT_FILTERS,
            properties: ['openFile']
        });
        if (canceled || filePaths.length === 0) {
            return null;
        }
        if (isAiExport(filePaths[0])) {
            explainAiExport(getWindow(), filePaths[0]);
            return null;
        }
        return registerHandle(filePaths[0]);
    });

    ipcMain.handle('xce:pick-save-file', async (event, suggestedName) => {
        const defaultName = typeof suggestedName === 'string' && suggestedName ? suggestedName : 'project.sb3';
        const {canceled, filePath} = await dialog.showSaveDialog(getWindow(), {
            title: '保存项目',
            defaultPath: defaultName,
            filters: PROJECT_FILTERS
        });
        if (canceled || !filePath) {
            return null;
        }
        return registerHandle(filePath);
    });

    ipcMain.handle('xce:read-file', (event, id) => fs.readFile(lookup(id).path));

    ipcMain.handle('xce:write-file-chunk', async (event, id, chunk) => {
        const entry = lookup(id);
        let writer = writers.get(id);
        if (!writer) {
            const tempPath = `${entry.path}.xce-tmp-${crypto.randomBytes(4).toString('hex')}`;
            writer = {
                targetPath: entry.path,
                tempPath,
                handle: await fs.open(tempPath, 'w')
            };
            writers.set(id, writer);
        }
        await writer.handle.write(Buffer.from(chunk));
        return null;
    });

    ipcMain.handle('xce:close-file', (event, id) => finishWrite(id, {commit: true}));
    ipcMain.handle('xce:abort-file', (event, id) => finishWrite(id, {commit: false}));
};

module.exports = {setupFileIO, abortAllWriters, registerHandle};
