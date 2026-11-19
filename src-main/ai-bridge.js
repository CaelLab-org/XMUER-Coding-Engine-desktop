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

// 本机 AI 桥：编辑器和外部 MCP 客户端之间的中转。
// 只监听 127.0.0.1，端口随机、口令每次启动现生成；MCP 那一侧从用户目录的
// ai-bridge.json 读到端口和口令，没有口令的连接一句话都递不进去。

const fs = require('fs');
const path = require('path');
const {randomBytes} = require('crypto');
const {WebSocketServer, WebSocket} = require('ws');
const {ipcMain} = require('electron');

const CALL_TIMEOUT_MS = 180000;
const EDITOR_WAIT_MS = 3000;

const setupAiBridge = ({dir}) => new Promise(resolve => {
    const file = path.join(dir, 'ai-bridge.json');
    const token = randomBytes(24).toString('hex');
    let port = 0;
    let editor = null;
    let tools = [];
    let skills = [];
    let queue = Promise.resolve();
    let seq = 0;
    const pending = new Map();
    const waiters = new Set();

    const wss = new WebSocketServer({host: '127.0.0.1', port: 0});

    const send = (socket, message) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(message));
        }
    };

    const persist = () => {
        try {
            fs.mkdirSync(dir, {recursive: true});
            fs.writeFileSync(file, JSON.stringify({port, token, pid: process.pid, tools, skills}));
        } catch (error) {
            // 写不了就只是 MCP 找不到这条链，编辑器自己照常
        }
    };

    // 客户端在启动那一刻可能比页面早：等一小会儿编辑器连上来再回工具清单
    const waitForEditor = () => new Promise(done => {
        if (editor) {
            done();
            return;
        }
        let timer = 0;
        const finish = () => {
            clearTimeout(timer);
            waiters.delete(finish);
            done();
        };
        timer = setTimeout(finish, EDITOR_WAIT_MS);
        waiters.add(finish);
    });

    const dispatch = (name, args) => new Promise(done => {
        if (!editor) {
            done({
                error: 'E_NO_EDITOR',
                message: 'XMUER Coding Engine desktop is running, but its editor is not connected. ' +
                    'Open a project and retry.'
            });
            return;
        }
        const id = `c${++seq}`;
        let timer = 0;
        const finish = result => {
            clearTimeout(timer);
            done(result);
        };
        timer = setTimeout(() => {
            pending.delete(id);
            done({error: 'E_TIMEOUT', message: 'The editor did not answer in time.'});
        }, CALL_TIMEOUT_MS);
        pending.set(id, finish);
        send(editor, {type: 'call', id, name, args: args || {}});
    });

    wss.on('connection', socket => {
        let role = null;
        socket.on('message', raw => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch (error) {
                return;
            }
            if (message.type === 'hello') {
                if (message.token !== token) {
                    send(socket, {type: 'error', code: 'E_AUTH', message: 'Bad bridge token.'});
                    socket.close();
                    return;
                }
                role = message.role === 'editor' ? 'editor' : 'client';
                if (role === 'editor') {
                    if (editor && editor !== socket) {
                        try {
                            editor.close();
                        } catch (error) {
                            // 已经关了
                        }
                    }
                    editor = socket;
                    waiters.forEach(finish => finish());
                    waiters.clear();
                }
                send(socket, {
                    type: 'welcome',
                    tools: role === 'client' ? tools : [],
                    skills: role === 'client' ? skills : []
                });
                return;
            }
            if (role === 'editor') {
                if (message.type === 'tools' && Array.isArray(message.tools)) {
                    tools = message.tools;
                    skills = Array.isArray(message.skills) ? message.skills : [];
                    persist();
                } else if (message.type === 'result') {
                    const finish = pending.get(message.id);
                    if (!finish) {
                        return;
                    }
                    pending.delete(message.id);
                    finish({
                        ok: true,
                        content: message.content,
                        isError: message.isError,
                        images: message.images
                    });
                }
                return;
            }
            if (role === 'client') {
                if (message.type === 'list') {
                    waitForEditor().then(() => send(socket, {type: 'tools', tools, skills}));
                } else if (message.type === 'call') {
                    const id = message.id;
                    // 串行：两个客户端同时写同一个项目只会互相盖
                    queue = queue.then(async () => {
                        const result = await dispatch(message.name, message.args);
                        if (result.error) {
                            send(socket, {type: 'error', id, code: result.error, message: result.message});
                        } else {
                            send(socket, {type: 'result', id, ...result});
                        }
                    });
                }
            }
        });
        socket.on('close', () => {
            if (role === 'editor' && editor === socket) {
                editor = null;
                pending.forEach(finish => finish({error: 'E_NO_EDITOR', message: 'The editor disconnected.'}));
                pending.clear();
            }
        });
    });

    const publish = () => {
        // preload 在建窗口之前同步要一次，所以监听成功后才允许建窗口
        ipcMain.on('xce:ai-bridge-info-sync', event => {
            event.returnValue = port ? {port, token} : null;
        });
        resolve({
            info: port ? {port, token} : null,
            stop: () => {
                try {
                    wss.close();
                } catch (error) {
                    // 已经关了
                }
                try {
                    fs.unlinkSync(file);
                } catch (error) {
                    // 本来就不在
                }
            }
        });
    };

    wss.on('listening', () => {
        port = wss.address().port;
        persist();
        publish();
    });

    wss.on('error', () => {
        if (port) {
            return;
        }
        publish();
    });
});

module.exports = {setupAiBridge};
