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
// 素材上传（音频等）：走 /v1/assets 的原始字节，不塞进 JSON。Scratch 自己的声音上限是 10MB，
// 这里留一点余量；内存里最多压 30 分钟，编辑器取走后就不该再占着。
const ASSET_BODY_LIMIT = 16 * 1024 * 1024;
const ASSET_TTL_MS = 30 * 60 * 1000;
// 截图结果：外部客户端 / 模型不一定吃 base64，落成一个短时效的地址交给对方自己取。
// 文件名带时间戳 + 随机串，猜不到；只活 10 分钟，内存里最多留 32 张。
const SHOT_TTL_MS = 10 * 60 * 1000;
const SHOT_MAX = 32;
const SHOT_PATH = /^\/xce\/shots\/([a-z0-9-]+)\.(png|jpg|jpeg)$/i;

const setupAiBridge = ({dir}) => new Promise(resolve => {
    const file = path.join(dir, 'ai-bridge.json');
    const token = randomBytes(24).toString('hex');
    // 上次退出时留下的清单和提示词先接着用：MCP 客户端可能在编辑器连上之前就启动，
    // 而下面 persist() 会把文件重写一遍 —— 先读进来，别让这一瞬间变成空清单。
    let previous = null;
    try {
        previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        previous = null;
    }
    let port = 0;
    let editor = null;
    let tools = previous && Array.isArray(previous.tools) ? previous.tools : [];
    let skills = previous && Array.isArray(previous.skills) ? previous.skills : [];
    // 编辑器的系统提示词（跟面板里那份同源）。每次编辑器连上都会重发一遍，落盘给 MCP 启动时用。
    let instructions = previous && typeof previous.instructions === 'string' ? previous.instructions : '';
    let queue = Promise.resolve();
    let seq = 0;
    let assetSeq = 0;
    const pending = new Map();
    const waiters = new Set();
    /** @type {Map<string, {name: string, mime: string, data: Buffer, expires: number}>} */
    const assets = new Map();
    /** @type {Map<string, {mime: string, data: Buffer, expires: number}>} */
    const shots = new Map();
    let shotsServer = null;
    let shotsPort = 0;

    const wss = new WebSocketServer({host: '127.0.0.1', port: 0});

    const send = (socket, message) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(message));
        }
    };

    const persist = () => {
        try {
            fs.mkdirSync(dir, {recursive: true});
            fs.writeFileSync(file, JSON.stringify({port, token, pid: process.pid, tools, skills, instructions}));
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

    // 素材 id -> 真正字节。编辑器侧的工具有 1MB 的 JSON 老限制，声音动辄几 MB，
    // 所以 /v1/assets 先把原始字节收在这里，调用时再换成 data / mimeType / name 三个参数。
    const pruneAssets = () => {
        const now = Date.now();
        for (const [id, entry] of assets) {
            if (entry.expires <= now) {
                assets.delete(id);
            }
        }
    };

    const expandAsset = args => {
        if (!args || typeof args.assetId !== 'string' || !args.assetId) {
            return {args};
        }
        pruneAssets();
        const asset = assets.get(args.assetId);
        if (!asset) {
            return {
                error: 'E_ASSET',
                message: `Unknown or expired assetId: ${args.assetId}. POST the file to /v1/assets again.`
            };
        }
        const out = {...args};
        if (!out.data) out.data = asset.data.toString('base64');
        if (!out.mimeType && asset.mime) out.mimeType = asset.mime;
        if (!out.name && asset.name) out.name = asset.name;
        delete out.assetId;
        return {args: out};
    };

    // 截图（xce_read_stage / xce_read_costume）在结果里是 data URL。外置模型不一定读得了
    // base64，也没法把它当附件，所以落成 http 地址：文件名 = 时间戳 + 随机串，猜不到，
    // 10 分钟后失效。content 里再补一行，老客户端不认 images 也能把地址转给模型。
    const pruneShots = () => {
        const now = Date.now();
        for (const [id, entry] of shots) {
            if (entry.expires <= now) {
                shots.delete(id);
            }
        }
    };

    const storeShot = (mime, data) => {
        pruneShots();
        const type = /^image\//i.test(mime || '') ? mime : 'image/png';
        const ext = /jpe?g/i.test(type) ? 'jpg' : 'png';
        const id = `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
        shots.set(id, {mime: type, data, expires: Date.now() + SHOT_TTL_MS});
        while (shots.size > SHOT_MAX) {
            shots.delete(shots.keys().next().value);
        }
        return `${id}.${ext}`;
    };

    const hostImages = (result, base) => {
        if (!base || !result || !Array.isArray(result.images) || !result.images.length) {
            return result;
        }
        const urls = [];
        const images = result.images.map(image => {
            const match = /^data:([^;,]+);base64,(.+)$/s.exec(String((image && image.url) || ''));
            if (!match) {
                return image;
            }
            const mime = (image && image.mimeType) || match[1] || 'image/png';
            const data = Buffer.from(match[2], 'base64');
            const url = `${base}/xce/shots/${storeShot(mime, data)}`;
            urls.push(url);
            return {url, mimeType: mime, size: data.length};
        });
        if (!urls.length) {
            return result;
        }
        const content = String(result.content || '');
        return {
            ...result,
            images,
            content: `${content}${content ? '\n\n' : ''}Image: ${urls.join('\nImage: ')}`
        };
    };

    // 图片地址不需要密钥：路径本身就是一次性的凭据，客户端 / 模型直接 GET 就行。
    const serveShot = (req, res) => {
        const match = SHOT_PATH.exec(String(req.url || '/').split('?')[0]);
        if (!match) {
            return false;
        }
        pruneShots();
        const entry = shots.get(match[1]);
        if (!entry) {
            res.writeHead(404, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
            res.end('Shot not found or expired.');
            return true;
        }
        res.writeHead(200, {
            'content-type': entry.mime,
            'content-length': entry.data.length,
            'cache-control': 'no-store',
            'access-control-allow-origin': '*'
        });
        res.end(entry.data);
        return true;
    };

    // MCP 客户端走 WS、和编辑器同一台机器：固定给回环地址。对外 HTTP 那条路会用
    // 请求自己的 Host（内网 IP 或 127.0.0.1）拼地址，见 /v1/call。
    const startShots = () => new Promise(done => {
        const server = http.createServer((req, res) => {
            if (req.method === 'GET' && serveShot(req, res)) {
                return;
            }
            res.writeHead(404, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
            res.end('Not found.');
        });
        server.on('error', () => {
            shotsServer = null;
            done();
        });
        server.listen(0, '127.0.0.1', () => {
            shotsServer = server;
            shotsPort = server.address().port;
            done();
        });
    });

    const dispatch = (name, rawArgs) => new Promise(done => {
        if (!editor) {
            done({
                error: 'E_NO_EDITOR',
                message: 'XMUER Coding Engine desktop is running, but its editor is not connected. ' +
                    'Open a project and retry.'
            });
            return;
        }
        const resolved = expandAsset(rawArgs);
        if (resolved.error) {
            done({error: resolved.error, message: resolved.message});
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
        send(editor, {type: 'call', id, name, args: resolved.args || {}});
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
                    skills: role === 'client' ? skills : [],
                    instructions: role === 'client' ? instructions : ''
                });
                return;
            }
            if (role === 'editor') {
                if (message.type === 'tools' && Array.isArray(message.tools)) {
                    tools = message.tools;
                    skills = Array.isArray(message.skills) ? message.skills : [];
                    instructions = typeof message.instructions === 'string' ? message.instructions : '';
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
                    waitForEditor().then(() => send(socket, {type: 'tools', tools, skills, instructions}));
                } else if (message.type === 'call') {
                    const id = message.id;
                    // 串行：两个客户端同时写同一个项目只会互相盖
                    queue = queue.then(async () => {
                        const result = await dispatch(message.name, message.args);
                        if (result.error) {
                            send(socket, {type: 'error', id, code: result.error, message: result.message});
                        } else {
                            // MCP 客户端和编辑器在同一台机器上：截图给回环地址（见 hostImages）
                            const hosted = hostImages(result,
                                shotsPort ? `http://127.0.0.1:${shotsPort}` : '');
                            send(socket, {type: 'result', id, ...hosted});
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
                port: Number(raw.port) || ACCESS_PORT,
                // true = 只听 127.0.0.1（同一台机器上的 AI 才连得上）
                local: !!raw.local
            };
        } catch (error) {
            return {enabled: false, key: '', port: ACCESS_PORT, local: false};
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
            local: !!access.local,
            port: access.port,
            key: access.key,
            endpoint: `http://127.0.0.1:${access.port}/v1`,
            // 只听本机的时候，局域网地址给出去也没用，干脆不列
            urls: running && !access.local ?
                lanAddresses().map(ip => `http://${ip}:${access.port}/v1`) : [],
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

    const readBody = (req, limit = ACCESS_BODY_LIMIT) => new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error(`Request body too large (limit ${Math.round(limit / 1024 / 1024)}MB).`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
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
        // 截图地址：路径里的随机串就是凭据，不再要密钥（模型拿到的就是一个能直接打开的地址）
        if (req.method === 'GET' && serveShot(req, res)) {
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
            json(res, 200, {tools, skills, instructions});
            return;
        }
        if (route === '/v1/instructions' && req.method === 'GET') {
            await waitForEditor();
            json(res, 200, {instructions});
            return;
        }
        // 原始字节上传：?name=blast.mp3&mime=audio/mpeg。返回的 assetId 交给 xce_add_sound。
        if (route === '/v1/assets' && req.method === 'POST') {
            let body;
            try {
                body = await readBody(req, ASSET_BODY_LIMIT);
            } catch (error) {
                json(res, 413, {error: 'E_BODY', message: String((error && error.message) || error)});
                return;
            }
            if (!body.length) {
                json(res, 400, {error: 'E_BODY', message: 'The body is empty. POST the file bytes.'});
                return;
            }
            const query = new URL(req.url, 'http://127.0.0.1');
            pruneAssets();
            const id = `a${++assetSeq}`;
            const entry = {
                name: String(query.searchParams.get('name') || '')
                    .slice(0, 200),
                mime: String(query.searchParams.get('mime') || '')
                    .slice(0, 100),
                data: body,
                expires: Date.now() + ASSET_TTL_MS
            };
            assets.set(id, entry);
            // 授权客户端也不该靠反复上传把内存喂爆：只留最近 8 份
            while (assets.size > 8) {
                assets.delete(assets.keys().next().value);
            }
            json(res, 200, {
                ok: true,
                assetId: id,
                name: entry.name,
                mime: entry.mime,
                size: body.length,
                message: `Pass assetId "${id}" to xce_add_sound (or another tool that takes one) within ` +
                    `${Math.round(ASSET_TTL_MS / 60000)} minutes.`
            });
            return;
        }
        if (route === '/v1/call' && req.method === 'POST') {
            let raw;
            try {
                raw = await readBody(req);
            } catch (error) {
                json(res, 413, {
                    error: 'E_BODY',
                    message: `${(error && error.message) || error} A file too large for this body should be ` +
                        'POSTed to /v1/assets instead, then passed as assetId.'
                });
                return;
            }
            let payload;
            try {
                payload = JSON.parse(raw.toString('utf8'));
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
                // 用客户端自己连过来的地址拼截图 URL：同一台机器就是 127.0.0.1，
                // 内网另一台机器就是它访问的那个 IP（和 Host 头一致）
                const base = req.headers.host ? `http://${req.headers.host}` :
                    (shotsPort ? `http://127.0.0.1:${shotsPort}` : '');
                const hosted = hostImages(result, base);
                json(res, 200, {
                    ok: true,
                    content: hosted.content,
                    isError: !!hosted.isError,
                    images: hosted.images || null
                });
            }
            return;
        }
        json(res, 404, {
            error: 'E_NOT_FOUND',
            message: 'Available: GET /v1/health, GET /v1/tools, GET /v1/instructions, ' +
                'POST /v1/assets, POST /v1/call, and GET /xce/shots/<id>.<png|jpg> for screenshots ' +
                'returned by a tool.'
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
        server.listen(access.port, access.local ? '127.0.0.1' : '0.0.0.0', () => {
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
        let rebind = false;
        if (typeof patch.local === 'boolean' && patch.local !== !!access.local) {
            access.local = patch.local;
            rebind = true;
        }
        if (typeof patch.enabled === 'boolean') {
            if (patch.enabled && !access.key) {
                access.key = newKey();
            }
            access.enabled = patch.enabled;
        }
        if (access.enabled) {
            // 只改监听范围也得重开一次：绑定地址是 listen 那一刻定下的
            if (rebind) {
                stopAccess();
            }
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
                if (shotsServer) {
                    try {
                        shotsServer.close();
                    } catch (error) {
                        // 已经关了
                    }
                    shotsServer = null;
                }
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
        // 截图地址要能立刻取，先把这个只监听回环的小服务起好（MCP 客户端走它）
        await startShots();
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
