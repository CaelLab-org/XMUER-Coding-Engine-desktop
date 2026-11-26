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

/**
 * 自动更新（只有 Windows 版；装的本来就是 Inno 的 exe）。
 *
 * 流程跟 GPCL 那套一致，但少一件东西：**没有 sha1 旁路文件**，校验值直接写在清单里。
 *   1. 读 latest.json（下载站根目录，跟安装包放一起）：版本号、地址、sha256、大小
 *   2. 有新版 → 下载到用户目录的 updates/，边下边报进度，落盘前再算一遍 sha256
 *   3. 用户点安装 → 起安装程序（/VERYSILENT + /RELAUNCH=1 + /WAITPID=本进程），然后退出
 *      安装器那边等本进程真退了才动文件，装完自己把新版启动起来（见 installer/xce.iss）
 *
 * 不自己造 UI、不常驻：主进程只维护一份状态，渲染端要看就 invoke，变了就 push。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const {spawn} = require('child_process');
const {app, BrowserWindow, ipcMain, shell} = require('electron');

const MANIFEST_URL = process.env.XCE_UPDATE_MANIFEST ||
    'https://dl.caellab.com/file/xmuer/coding/engine/latest.json';
const DOWNLOAD_PAGE = 'https://engine.xmuer.online/desktop/';
const CHECK_TIMEOUT_MS = 15000;
const AUTO_CHECK_DELAY_MS = 12000;
const MAX_REDIRECTS = 4;

const state = {
    status: 'idle', // idle | checking | available | latest | downloading | ready | installing | error
    current: '',
    latest: '',
    notes: '',
    page: DOWNLOAD_PAGE,
    url: '',
    size: 0,
    percent: 0,
    error: '',
    // 只有 Windows 能静默装 exe；别的平台只提示去下载页
    supported: process.platform === 'win32'
};

let installerPath = '';
let downloadReq = null;
let autoCheckTimer = null;

const send = () => {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
            win.webContents.send('xce:update-state', {...state});
        }
    }
};

const setState = patch => {
    Object.assign(state, patch);
    send();
    return {...state};
};

// "4.8.10" > "4.8.9"：按段比数字，带后缀的段取前导数字（alpha 之类不算新版）
const partOf = value => {
    const match = String(value || '').match(/^(\d+)/);
    return match ? Number(match[1]) : 0;
};

const compareVersion = (a, b) => {
    const left = String(a || '').split('.');
    const right = String(b || '').split('.');
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const av = partOf(left[i]);
        const bv = partOf(right[i]);
        if (bv > av) return 1;
        if (av > bv) return -1;
    }
    return 0;
};

const fetchText = (url, redirects = 0) => new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
        reject(new Error('重定向太多'));
        return;
    }
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, {headers: {'user-agent': 'XCE-Desktop/' + app.getVersion()}}, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            resolve(fetchText(new URL(res.headers.location, url).toString(), redirects + 1));
            return;
        }
        if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
            text += chunk;
            if (text.length > 256 * 1024) {
                req.destroy(new Error('清单太大'));
            }
        });
        res.on('end', () => resolve(text));
        res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(CHECK_TIMEOUT_MS, () => req.destroy(new Error('检查更新超时')));
});

const updatesDir = () => path.join(app.getPath('appData'), 'XMUER Coding Engine', 'updates');

const check = async ({manual = false} = {}) => {
    if (state.status === 'downloading' || state.status === 'installing') {
        return {...state};
    }
    setState({status: 'checking', error: '', percent: 0});
    try {
        const manifest = JSON.parse(await fetchText(MANIFEST_URL));
        const latest = String(manifest.version || '').trim();
        if (!/^\d+(\.\d+)*$/.test(latest)) {
            throw new Error('清单里的版本号不合法');
        }
        const current = app.getVersion();
        const base = {
            current,
            latest,
            notes: typeof manifest.notes === 'string' ? manifest.notes : '',
            page: typeof manifest.page === 'string' && manifest.page ? manifest.page : DOWNLOAD_PAGE,
            url: typeof manifest.url === 'string' ? manifest.url : '',
            size: Number(manifest.size) || 0,
            sha256: typeof manifest.sha256 === 'string' ? manifest.sha256.toLowerCase() : ''
        };
        if (compareVersion(current, latest) <= 0) {
            return setState({...base, status: 'latest', error: ''});
        }
        // 上次已经下好了同一个版本的包：直接用（大小对得上就算，别每次启动都重算 117MB 的 sha）
        const cached = path.join(updatesDir(), `XCE-Setup-${latest}.exe`);
        try {
            const stat = fs.statSync(cached);
            if (!base.size || Math.abs(stat.size - base.size) < 1024) {
                installerPath = cached;
                return setState({...base, status: 'ready', percent: 100, error: ''});
            }
        } catch (error) {
            // 没下过，走正常流程
        }
        return setState({...base, status: 'available', error: ''});
    } catch (error) {
        // 手动检查才把错误说出来；自动检查失败就当没这回事（离线、墙、服务器抽风都正常）
        return setState({
            status: manual ? 'error' : 'idle',
            current: app.getVersion(),
            error: manual ? String((error && error.message) || error) : ''
        });
    }
};

const sha256File = file => new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
});

const download = (url, target, redirects = 0) => new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
        reject(new Error('重定向太多'));
        return;
    }
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, {headers: {'user-agent': 'XCE-Desktop/' + app.getVersion()}}, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            download(new URL(res.headers.location, url).toString(), target, redirects + 1)
                .then(resolve, reject);
            return;
        }
        if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
        }
        const total = Number(res.headers['content-length']) || state.size || 0;
        let received = 0;
        let lastSent = 0;
        const file = fs.createWriteStream(target);
        downloadReq = req;
        res.on('data', chunk => {
            received += chunk.length;
            file.write(chunk);
            // 每 1% 或每 2MB 推一次，别拿 IPC 刷屏
            const percent = total ? Math.min(99, Math.floor((received / total) * 100)) : 0;
            if (percent > state.percent || received - lastSent > 2 * 1024 * 1024) {
                lastSent = received;
                setState({percent});
            }
        });
        res.on('end', () => file.end(() => resolve(received)));
        res.on('error', error => {
            file.destroy();
            reject(error);
        });
        file.on('error', reject);
    });
    req.on('error', reject);
    // 117MB 走慢网要几分钟；只防彻底不动的情况
    req.setTimeout(120000, () => req.destroy(new Error('下载超时')));
});

const startDownload = async () => {
    if (!state.supported) {
        return {...state, error: '这个平台不支持自动安装，请到下载页手动装。'};
    }
    if (state.status === 'downloading' || state.status === 'installing') {
        return {...state};
    }
    if (state.status !== 'available' && state.status !== 'ready') {
        const checked = await check();
        if (checked.status !== 'available') {
            return {...checked};
        }
    }
    if (!state.url) {
        return setState({status: 'error', error: '清单里没有下载地址'});
    }

    const dir = updatesDir();
    const target = path.join(dir, `XCE-Setup-${state.latest}.exe`);
    const part = `${target}.part`;
    try {
        fs.mkdirSync(dir, {recursive: true});
    } catch (error) {
        return setState({status: 'error', error: `建不了下载目录：${error.message}`});
    }

    setState({status: 'downloading', percent: 0, error: ''});
    try {
        const received = await download(state.url, part);
        if (state.sha256) {
            const actual = await sha256File(part);
            if (actual !== state.sha256) {
                try {
                    fs.unlinkSync(part);
                } catch (error) {
                    // 删不掉就留着，下次覆盖
                }
                return setState({status: 'error', error: '安装包校验没通过，已丢弃，请重试。'});
            }
        }
        try {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
            fs.renameSync(part, target);
        } catch (error) {
            return setState({status: 'error', error: `保存安装包失败：${error.message}`});
        }
        installerPath = target;
        return setState({status: 'ready', percent: 100, size: received || state.size});
    } catch (error) {
        downloadReq = null;
        try {
            if (fs.existsSync(part)) fs.unlinkSync(part);
        } catch (inner) {
            // 删不掉就下次覆盖
        }
        return setState({status: 'error', error: String((error && error.message) || error)});
    }
};

const install = () => {
    if (!installerPath || !fs.existsSync(installerPath)) {
        return {...state, error: '安装包不在本地，请先下载。'};
    }
    // Inno 的参数：静默、不弹错误框、不自动重启系统、装前让旧进程先退（/WAITPID 是我们在 .iss 里加的）
    const args = [
        '/VERYSILENT',
        '/SUPPRESSMSGBOXES',
        '/NORESTART',
        '/SP-',
        '/RELAUNCH=1',
        `/WAITPID=${process.pid}`
    ];
    try {
        const child = spawn(installerPath, args, {detached: true, stdio: 'ignore', windowsHide: true});
        child.unref();
    } catch (error) {
        return setState({status: 'error', error: `启动安装程序失败：${error.message}`});
    }
    setState({status: 'installing', error: ''});
    // 给 IPC 回包留一拍再退，否则渲染端收不到最后这次状态
    setTimeout(() => app.quit(), 400);
    return {...state};
};

const register = () => {
    state.current = app.getVersion();
    ipcMain.handle('xce:update-state', () => ({...state}));
    ipcMain.handle('xce:update-check', () => check({manual: true}));
    ipcMain.handle('xce:update-download', () => startDownload());
    ipcMain.handle('xce:update-install', () => install());
    ipcMain.handle('xce:update-open-page', () => {
        shell.openExternal(state.page || DOWNLOAD_PAGE);
        return {ok: true};
    });
    ipcMain.handle('xce:update-open-notes', () => {
        if (state.notes) {
            shell.openExternal(state.notes);
        }
        return {ok: true};
    });

    // 冷启动后过一会儿再查，别跟启动画面抢带宽
    if (!process.env.XCE_SMOKE_TEST) {
        autoCheckTimer = setTimeout(() => {
            check().catch(() => {});
        }, AUTO_CHECK_DELAY_MS);
        if (autoCheckTimer.unref) {
            autoCheckTimer.unref();
        }
    }
};

module.exports = {register, check, download: startDownload, install, getState: () => ({...state})};
