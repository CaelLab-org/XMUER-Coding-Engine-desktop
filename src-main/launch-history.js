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
 * 启动记录：决定这一次要不要演启动动画。
 *
 * 用户 2026-10-04 的要求：「启动别那么久，只有首次久，或者好久没启动过了才算」。
 * 启动动画本身不花时间（它跟页面加载并行），**但每次都演一遍会让人以为软件慢** ——
 * 而且冷启动（当天第一次 / 刚更新过）才是真的需要它挡一下的场合：那一次磁盘缓存是凉的。
 *
 * 判据就三条，任一条命中就演：
 *   1. 从来没记过（第一次装完就跑）；
 *   2. 版本变了（刚更新完，第一次启动）；
 *   3. **本机日期变了** —— 也就是每天第一次启动。同一天之内再开就直接出窗口。
 *
 * 存在 userData 下的 launch.json，坏了/丢了按「没记过」处理（多演一次而已，不影响启动）。
 */

const fs = require('fs');
const path = require('path');
const {app} = require('electron');

const recordFile = () => path.join(app.getPath('userData'), 'launch.json');

// 本机日期，只到天。用本地时间 —— 用户感知的「今天」就是本机时间。
const todayKey = (now = new Date()) =>
    `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

const readRecord = () => {
    try {
        const parsed = JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        return null;
    }
};

/**
 * 这次启动要不要演启动动画？
 * @param {object} opts
 *   version 当前应用版本（app.getVersion()）
 *   now     当前时间（测试用）
 * @returns {boolean}
 */
const shouldShowSplash = ({version, now} = {}) => {
    const record = readRecord();
    if (!record) return true;
    if (record.version !== version) return true;
    return record.day !== todayKey(now);
};

// 记下这一次（演不演都记 —— 同一天第二开要靠它跳过）
const markLaunched = ({version, now} = {}) => {
    const previous = readRecord();
    const record = {
        version,
        day: todayKey(now),
        launches: ((previous && previous.launches) || 0) + 1,
        lastLaunchAt: (now || new Date()).toISOString()
    };
    try {
        fs.writeFileSync(recordFile(), JSON.stringify(record));
    } catch (error) {
        // 写不进去就每次都演 —— 只是慢一点，不是坏了
    }
    return record;
};

module.exports = {shouldShowSplash, markLaunched, todayKey};
