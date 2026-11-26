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
const http = require('http');
const os = require('os');
const path = require('path');
const {randomBytes, timingSafeEqual} = require('crypto');
const {WebSocketServer, WebSocket} = require('ws');
const {app, ipcMain} = require('electron');

const CALL_TIMEOUT_MS = 180000;
const EDITOR_WAIT_MS = 3000;
// 对外接口的固定端口：要能被别的机器 / 别的 AI 客户端记住，端口就不能每次变
const ACCESS_PORT = 49621;
const ACCESS_BODY_LIMIT = 1024 * 1024;

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

    // ---------------------------------------------------------------- 对外接口
    //
    // 给「别的机器 / 别的 AI 客户端」用的 HTTP 入口。默认**不开**：用户在编辑器里
    // 打开「外部接入」才生成密钥并开始监听。密钥跟着用户走（存在同一个目录，
    // 重启不变），关掉开关就停监听 —— 密钥本身留着，下次打开还是那一串。
    //
    // 只暴露三件事：健康检查、工具清单、调用。没有文件系统、没有 shell、没有别的路由。

    const accessFile = path.join(dir, 'ai-access.json');
    const readAccess = () => {
        try {
            const raw = JSON.parse(fs.readFileSync(accessFile, 'utf8'));
            return {
                enabled: !!raw.enabled,
                key: typeof raw.key === 'string' ? raw.key : '',
                port: Number(raw.port) || ACCESS_PORT
            };
        } catch (error) {
            return {enabled: false, key: '', port: ACCESS_PORT};
        }
    };
    const access = readAccess();
    let accessServer = null;
    let accessError = '';

    const writeAccess = () => {
        try {
            fs.mkdirSync(dir, {recursive: true});
            fs.writeFileSync(accessFile, JSON.stringify({...access, pid: process.pid}, null, 2));
        } catch (error) {
            // 写不了就只是下次要重新开，这一次照样能用
        }
    };

    const newKey = () => `xce_${randomBytes(20).toString('hex')}`;

    const lanAddresses = () => {
        const out = [];
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const entry of interfaces[name] || []) {
                if (entry.family === 'IPv4' && !entry.internal) {
                    out.push(entry.address);
                }
            }
        }
        return out;
    };

    const accessInfo = () => {
        const running = !!(accessServer && accessServer.listening);
        return {
            enabled: !!access.enabled,
            running,
            port: access.port,
            key: access.key,
            endpoint: `http://127.0.0.1:${access.port}/v1`,
            urls: running ? lanAddresses().map(ip => `http://${ip}:${access.port}/v1`) : [],
            error: accessError
        };
    };

    const json = (res, status, payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'authorization, content-type, x-xce-key',
            'access-control-allow-methods': 'GET, POST, OPTIONS'
        });
        res.end(body);
    };

    const authorized = req => {
        const header = String(req.headers.authorization || '');
        const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
        const given = bearer || String(req.headers['x-xce-key'] || '');
        if (!access.key || !given || given.length !== access.key.length) {
            return false;
        }
        try {
            return timingSafeEqual(Buffer.from(given), Buffer.from(access.key));
        } catch (error) {
            return false;
        }
    };

    const readBody = req => new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > ACCESS_BODY_LIMIT) {
                reject(new Error('Request body too large.'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });

    // 跟 WS 客户端共用一条队列：写入必须串行，否则两个客户端会互相盖
    const serialized = work => new Promise(resolve => {
        queue = queue.then(work).then(resolve, error => resolve({
            error: 'E_INTERNAL',
            message: String((error && error.message) || error)
        }));
    });

    const handleAccess = async (req, res) => {
        const route = String(req.url || '/').split('?')[0].replace(/\/+$/, '');
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'access-control-allow-origin': '*',
                'access-control-allow-headers': 'authorization, content-type, x-xce-key',
                'access-control-allow-methods': 'GET, POST, OPTIONS'
            });
            res.end();
            return;
        }
        if (route === '/v1/health') {
            json(res, 200, {
                ok: true,
                app: 'XMUER Coding Engine',
                version: app.getVersion(),
                editor: !!editor,
                auth: 'bearer'
            });
            return;
        }
        if (!authorized(req)) {
            json(res, 401, {
                error: 'E_AUTH',
                message: 'Missing or wrong API key. Turn on external access in the editor\'s ' +
                    'settings and copy the key again.'
            });
            return;
        }
        if (route === '/v1/tools' && req.method === 'GET') {
            await waitForEditor();
            json(res, 200, {tools, skills});
            return;
        }
        if (route === '/v1/call' && req.method === 'POST') {
            let payload;
            try {
                payload = JSON.parse(await readBody(req));
            } catch (error) {
                json(res, 400, {error: 'E_BODY', message: 'Body must be JSON: {"name": "...", "args": {}}'});
                return;
            }
            if (!payload || typeof payload.name !== 'string' || !payload.name) {
                json(res, 400, {error: 'E_BODY', message: 'Missing "name".'});
                return;
            }
            const result = await serialized(() => dispatch(payload.name, payload.args || {}));
            if (result.error) {
                json(res, 502, {error: result.error, message: result.message});
            } else {
                json(res, 200, {
                    ok: true,
                    content: result.content,
                    isError: !!result.isError,
                    images: result.images || null
                });
            }
            return;
        }
        json(res, 404, {
            error: 'E_NOT_FOUND',
            message: 'Available: GET /v1/health, GET /v1/tools, POST /v1/call'
        });
    };

    const startAccess = () => new Promise(resolve => {
        if (accessServer && accessServer.listening) {
            resolve(true);
            return;
        }
        accessError = '';
        const server = http.createServer((req, res) => {
            handleAccess(req, res).catch(error => {
                try {
                    json(res, 500, {error: 'E_INTERNAL', message: String((error && error.message) || error)});
                } catch (inner) {
                    // 头已经发出去了
                }
            });
        });
        server.on('error', error => {
            accessError = error && error.code === 'EADDRINUSE' ?
                `端口 ${access.port} 被别的程序占用了` :
                String((error && error.message) || error);
            accessServer = null;
            resolve(false);
        });
        server.listen(access.port, '0.0.0.0', () => {
            accessServer = server;
            resolve(true);
        });
    });

    const stopAccess = () => {
        if (!accessServer) {
            return;
        }
        try {
            accessServer.close();
            if (accessServer.closeAllConnections) {
                accessServer.closeAllConnections();
            }
        } catch (error) {
            // 已经关了
        }
        accessServer = null;
    };

    // 渲染端（设置页）读写这一块；preload 在建窗口前同步取一次
    ipcMain.on('xce:ai-access-sync', event => {
        event.returnValue = accessInfo();
    });
    ipcMain.handle('xce:ai-access-get', () => accessInfo());
    ipcMain.handle('xce:ai-access-set', async (event, patch) => {
        if (!patch || typeof patch !== 'object') {
            return accessInfo();
        }
        if (patch.rotate) {
            access.key = newKey();
        }
        if (typeof patch.enabled === 'boolean') {
            if (patch.enabled && !access.key) {
                access.key = newKey();
            }
            access.enabled = patch.enabled;
        }
        if (access.enabled) {
            // 起不来（端口被占）就当没开，别让界面显示"已开启"却连不上
            access.enabled = await startAccess();
        } else {
            stopAccess();
        }
        writeAccess();
        return accessInfo();
    });

    const publish = () => {
        // preload 在建窗口之前同步要一次，所以监听成功后才允许建窗口
        ipcMain.on('xce:ai-bridge-info-sync', event => {
            event.returnValue = port ? {port, token} : null;
        });
        resolve({
            info: port ? {port, token} : null,
            stop: () => {
                stopAccess();
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

    wss.on('listening', async () => {
        port = wss.address().port;
        // 上次开着「外部接入」的话，这次启动就接着开（密钥不变，别的机器上的配置不用改）
        if (access.enabled) {
            if (!access.key) {
                access.key = newKey();
            }
            access.enabled = await startAccess();
            writeAccess();
        }
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
