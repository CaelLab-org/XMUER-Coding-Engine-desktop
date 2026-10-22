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

const {registerHandle} = require('./file-io');
const {explainAiExport, isAiExport} = require('./project-files');

let getWindow = () => null;
const pending = [];

const deliver = descriptor => {
    const window = getWindow();
    if (!window || window.isDestroyed()) {
        pending.push(descriptor);
        return;
    }
    if (window.webContents.isLoading()) {
        window.webContents.once('did-finish-load', () => {
            if (!window.isDestroyed()) {
                window.webContents.send('xce:open-file', descriptor);
            }
        });
        return;
    }
    window.webContents.send('xce:open-file', descriptor);
};

/**
 * 把系统递来的文件交给渲染端（一次只开一个：现有的窗口就是编辑器本体）。
 * @param {string[]} files
 */
const openFiles = files => {
    const file = (files || []).find(Boolean);
    if (!file) {
        return;
    }
    if (isAiExport(file)) {
        explainAiExport(getWindow(), file);
        return;
    }
    deliver(registerHandle(file));
};

const flushPending = () => {
    const queued = pending.splice(0);
    queued.forEach(deliver);
};

const setupOpenFiles = ({getWindow: readWindow}) => {
    getWindow = readWindow;
};

module.exports = {setupOpenFiles, openFiles, flushPending};
