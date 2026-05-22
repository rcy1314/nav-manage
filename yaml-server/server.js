const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cors = require('cors');
const crypto = require('crypto');
const { exec } = require('child_process');
const axios = require('axios'); // 用于发送 HTTP 请求

const app = express();
const PORT = Number(process.env.PORT || 8990);

// 控制是否启用本地 Hugo 编译功能（纯 API 模式下可关闭）
const ENABLE_HUGO = process.env.ENABLE_HUGO !== 'false';
// 如果未启用本地 Hugo，且希望在数据更新后调用远程 Webhook/API 触发更新，可以配置此项
const REMOTE_UPDATE_WEBHOOK = process.env.REMOTE_UPDATE_WEBHOOK || '';

// API Token 鉴权中间件配置
const API_TOKEN = String(process.env.API_TOKEN || '').trim();

function verifyToken(req, res, next) {
    if (!API_TOKEN) {
        return res.status(503).json({ error: '服务端未配置 API_TOKEN' });
    }
    const token = req.headers.authorization || req.headers['x-auth-token'];
    if (!token) {
        return res.status(401).json({ error: '未提供认证 Token' });
    }
    const actualToken = String(token).startsWith('Bearer ') ? String(token).slice(7) : String(token);
    if (actualToken !== API_TOKEN) {
        return res.status(403).json({ error: '无效的 Token' });
    }
    next();
}

// Hugo 根目录（启用本地编译时使用），纯 API 模式下可以只挂载 data 目录到该路径下的 data/
const baseDir = process.env.BASE_DIR || path.resolve(__dirname, '../../');

// CORS 设置 - 支持跨域
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS', 'PUT'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-auth-token',
        'Accept',
        'Mcp-Session-Id',
        'MCP-Protocol-Version',
        'Last-Event-ID'
    ],
    exposedHeaders: [
        'Mcp-Session-Id',
        'MCP-Protocol-Version',
        'Content-Type'
    ]
}));

app.use(express.json());

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const serverSettingsFilePath = (() => {
    const configuredPath = String(process.env.SERVER_SETTINGS_PATH || '').trim();
    return configuredPath ? path.resolve(configuredPath) : path.resolve(baseDir, 'server_settings.json');
})();
const legacyServerSettingsFilePath = path.resolve(__dirname, 'server_settings.json');
let serverSettings = {};

function loadServerSettings() {
    const raw = readJsonFile(serverSettingsFilePath);
    if (raw && typeof raw === 'object' && Object.keys(raw).length > 0) {
        serverSettings = raw;
        return;
    }
    if (serverSettingsFilePath !== legacyServerSettingsFilePath) {
        const legacy = readJsonFile(legacyServerSettingsFilePath);
        if (legacy && typeof legacy === 'object' && Object.keys(legacy).length > 0) {
            serverSettings = legacy;
            writeJsonFile(serverSettingsFilePath, serverSettings);
            return;
        }
    }
    serverSettings = raw && typeof raw === 'object' ? raw : {};
}

function persistServerSettings(next) {
    const data = next && typeof next === 'object' ? next : {};
    serverSettings = data;
    writeJsonFile(serverSettingsFilePath, serverSettings);
}

function getEffectiveWebhookUrl() {
    const v = serverSettings && serverSettings.webhookUrl ? String(serverSettings.webhookUrl).trim() : '';
    return v || String(process.env.WEBHOOK_URL || '').trim();
}

function getEffectiveTelegramChatId() {
    const v = serverSettings && serverSettings.telegramChatId ? String(serverSettings.telegramChatId).trim() : '';
    return v || String(process.env.TELEGRAM_CHAT_ID || '').trim();
}

function getEffectiveTelegramBotToken() {
    const v = serverSettings && serverSettings.telegramBotToken ? String(serverSettings.telegramBotToken).trim() : '';
    return v || String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

function getServerSettingString(key, fallbackValue) {
    const v = serverSettings && serverSettings[key] !== undefined ? String(serverSettings[key] || '').trim() : '';
    return v || String(fallbackValue || '').trim();
}

function getEffectiveRssChannelTitle() {
    return getServerSettingString('rssChannelTitle', 'NOISE导航收录更新');
}

function getEffectiveRssChannelLink() {
    return getServerSettingString('rssChannelLink', 'http://www.noisedh.cn');
}

function getEffectiveRssChannelDescription() {
    return getServerSettingString('rssChannelDescription', '最新更新通知');
}

function getEffectiveRssImageUrl() {
    return getServerSettingString('rssImageUrl', 'https://s2.loli.net/2025/02/26/a6yMIxOUZjHDghp.png');
}

function getEffectiveRssImageTitle() {
    return getServerSettingString('rssImageTitle', 'NOISE导航');
}

function getEffectiveRssImageLink() {
    return getServerSettingString('rssImageLink', 'http://www.noisedh.cn');
}

function getEffectiveTelegramMessageTitle() {
    return getServerSettingString('telegramMessageTitle', '📢导航站收录更新通知！');
}

function getEffectiveTelegramNavText() {
    return getServerSettingString('telegramNavText', 'www.noisedh.cn 或 www.noisedh.link');
}

function normalizeDirList(input) {
    const parts = Array.isArray(input)
        ? input
        : String(input || '').split(',');
    return Array.from(new Set(parts
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .map((x) => path.resolve(x))));
}

function getConfiguredSearchDataDirs() {
    const baseDataDir = path.resolve(baseDir, 'data');
    const envSearchDirs = normalizeDirList(process.env.SEARCH_DATA_DIRS || '');
    const envDataDir = normalizeDirList(process.env.DATA_DIR || '');
    const settingSearchDirs = normalizeDirList(serverSettings && serverSettings.searchDataDirs !== undefined ? serverSettings.searchDataDirs : '');
    return Array.from(new Set([baseDataDir, ...envSearchDirs, ...envDataDir, ...settingSearchDirs]));
}

function safeResolveWithinDir(dir, relativePath) {
    const target = path.resolve(dir, relativePath);
    if (target === dir || target.startsWith(`${dir}${path.sep}`)) {
        return target;
    }
    return '';
}

async function sendWebhookNotification(notification) {
    const webhookUrl = getEffectiveWebhookUrl();

    // 检查 webhook URL 是否有效
    if (!webhookUrl) {
        console.log('Webhook URL 未设置，跳过发送 webhook 通知。');
        return; // 如果没有设置 webhook URL，直接返回
    }

    try {
        console.log('Sending webhook notification:', notification); // 打印请求体
        await axios.post(webhookUrl, notification);
    } catch (error) {
        console.error('发送 webhook 通知时出错:', error.response ? error.response.data : error.message);
    }
}

const invalidCountsFilePath = process.env.INVALID_LINKS_COUNTS || path.resolve(__dirname, 'invalidlink_counts.json');
const invalidLinksMdFilePath = process.env.INVALID_LINKS_MD || path.resolve(baseDir, 'content', 'invalidlinks.md');
const invalid404Threshold = Number(process.env.INVALID_404_THRESHOLD || 3);
const invalidCheckTimeoutMs = Number(process.env.INVALID_CHECK_TIMEOUT_MS || 8000);
const invalidCheckConcurrency = Math.max(1, Math.min(Number(process.env.INVALID_CHECK_CONCURRENCY || 8) || 8, 50));
const invalidCheckUseGetFallback = process.env.INVALID_CHECK_USE_GET_FALLBACK !== 'false';
const invalidCheckMinIntervalMs = Math.max(0, Number(process.env.INVALID_CHECK_MIN_INTERVAL_MS || 0) || 0);

const http = require('http');
const https = require('https');

const httpKeepAliveAgent = new http.Agent({
    keepAlive: true,
    maxSockets: Math.max(16, Math.min(Number(process.env.HTTP_MAX_SOCKETS || 64) || 64, 256)),
    maxFreeSockets: Math.max(8, Math.min(Number(process.env.HTTP_MAX_FREE_SOCKETS || 16) || 16, 128)),
    timeout: 60000
});
const httpsKeepAliveAgent = new https.Agent({
    keepAlive: true,
    maxSockets: Math.max(16, Math.min(Number(process.env.HTTPS_MAX_SOCKETS || 64) || 64, 256)),
    maxFreeSockets: Math.max(8, Math.min(Number(process.env.HTTPS_MAX_FREE_SOCKETS || 16) || 16, 128)),
    timeout: 60000
});

const httpClient = axios.create({
    httpAgent: httpKeepAliveAgent,
    httpsAgent: httpsKeepAliveAgent,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { 'User-Agent': 'NavManageLinkChecker/1.0' }
});

function shellEscape(v) {
    return `'${String(v || '').replace(/'/g, `'\\''`)}'`;
}

function readJsonFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return {};
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.trim()) return {};
        return JSON.parse(raw);
    } catch (e) {
        return {};
    }
}

function writeJsonFile(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

loadServerSettings();

function parseIsoToMs(v) {
    const s = String(v || '').trim();
    if (!s) return 0;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
}

async function getUrlStatus(url) {
    const u = String(url || '').trim();
    if (!u) return { status: 0, is404: false, ok: false };
    try {
        const head = await httpClient.request({
            method: 'HEAD',
            url: u,
            timeout: invalidCheckTimeoutMs,
            maxBodyLength: 1
        });
        if (head && typeof head.status === 'number' && head.status !== 405) {
            const st = head.status;
            return { status: st, is404: st === 404, ok: st >= 200 && st < 400 };
        }
    } catch (e) {}
    if (!invalidCheckUseGetFallback) return { status: 0, is404: false, ok: false };
    try {
        const get = await httpClient.request({
            method: 'GET',
            url: u,
            timeout: invalidCheckTimeoutMs,
            responseType: 'stream',
            maxBodyLength: 1
        });
        try {
            if (get && get.data && typeof get.data.destroy === 'function') get.data.destroy();
        } catch (_) {}
        const st = get && typeof get.status === 'number' ? get.status : 0;
        return { status: st, is404: st === 404, ok: st >= 200 && st < 400 };
    } catch (e) {
        return { status: 0, is404: false, ok: false };
    }
}

async function asyncPool(items, concurrency, iteratorFn) {
    const list = Array.isArray(items) ? items : [];
    const limit = Math.max(1, Math.floor(concurrency || 1));
    const results = new Array(list.length);
    let i = 0;
    const workers = new Array(Math.min(limit, list.length)).fill(null).map(async () => {
        while (i < list.length) {
            const idx = i++;
            try {
                results[idx] = await iteratorFn(list[idx], idx);
            } catch (e) {
                results[idx] = { error: e };
            }
        }
    });
    await Promise.all(workers);
    return results;
}

function formatDateCN(d) {
    const pad = (n) => String(n).padStart(2, '0');
    const dt = d instanceof Date ? d : new Date();
    return `${dt.getFullYear()}年${pad(dt.getMonth() + 1)}月${pad(dt.getDate())}日 ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function formatDateCNDay(d) {
    const pad = (n) => String(n).padStart(2, '0');
    const dt = d instanceof Date ? d : new Date();
    return `${dt.getFullYear()}年${pad(dt.getMonth() + 1)}月${pad(dt.getDate())}日`;
}

function ensureInvalidLinksMdFile() {
    const dir = path.dirname(invalidLinksMdFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(invalidLinksMdFilePath)) return;
    const now = new Date();
    const header =
        `---\n` +
        `title: "失效链接归档"\n` +
        `date: 2020-07-28T19:27:08+08:00\n` +
        `draft: false\n` +
        `---\n\n` +
        `🗂️这里存放过往检测的链接记录，从最早到最晚按此排列，查看最新纪录请拉到最下方\n\n` +
        `⚠️：检测时可能因部分站点dns污染等干扰影响，如果你发现被误删除了，请联系管理\n\n` +
        `上一次检查日期：${formatDateCNDay(now)}\n\n` +
        `------\n`;
    fs.writeFileSync(invalidLinksMdFilePath, header, 'utf8');
}

function updateInvalidLinksMdLastChecked(d) {
    ensureInvalidLinksMdFile();
    const day = formatDateCNDay(d);
    const prefix = '上一次检查日期：';
    const raw = fs.readFileSync(invalidLinksMdFilePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const idx = lines.findIndex((l) => String(l || '').startsWith(prefix));
    if (idx !== -1) {
        lines[idx] = `${prefix}${day}`;
        fs.writeFileSync(invalidLinksMdFilePath, lines.join('\n'), 'utf8');
        return;
    }
    let sepIdx = lines.findIndex((l) => String(l || '').trim() === '------');
    if (sepIdx === -1) sepIdx = lines.length;
    const insert = [`${prefix}${day}`, ''];
    lines.splice(sepIdx, 0, ...insert);
    fs.writeFileSync(invalidLinksMdFilePath, lines.join('\n'), 'utf8');
}

function detectYamlKind(filename, yamlData) {
    const f = String(filename || '').toLowerCase();
    if (f.includes('friendlinks')) return 'friendlinks';
    if (f.includes('headers')) return 'headers';
    const arr = Array.isArray(yamlData) ? yamlData : [];
    const first = arr[0] || {};
    if (first && typeof first === 'object') {
        if (Object.prototype.hasOwnProperty.call(first, 'taxonomy')) return 'webstack';
        if (Object.prototype.hasOwnProperty.call(first, 'item')) return 'headers';
        if (Object.prototype.hasOwnProperty.call(first, 'title') && Object.prototype.hasOwnProperty.call(first, 'url')) return 'friendlinks';
    }
    return 'webstack';
}

function appendInvalidLinksMd(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return;
    ensureInvalidLinksMdFile();
    const now = new Date();
    try { updateInvalidLinksMdLastChecked(now); } catch (e) {}
    let out = `\n\n------\n\n## 检查日期: ${formatDateCN(now)}\n\n## 已失效链接\n\n`;
    list.forEach((it) => {
        const title = it && it.title ? String(it.title) : '';
        const url = it && it.url ? String(it.url) : '';
        const description = it && it.description ? String(it.description) : '';
        out += `- 标题: ${title}\n  URL: ${url}\n`;
        if (description) out += `  描述: ${description}\n`;
    });
    fs.appendFileSync(invalidLinksMdFilePath, out, 'utf8');
}

function collectWebstackLinks(yamlData) {
    const items = [];
    const arr = Array.isArray(yamlData) ? yamlData : [];
    arr.forEach((cat) => {
        const taxonomy = cat && cat.taxonomy ? String(cat.taxonomy) : '';
        const links = Array.isArray(cat && cat.links) ? cat.links : [];
        links.forEach((l) => {
            if (!l || !l.url) return;
            items.push({
                taxonomy,
                term: '',
                title: l.title || '',
                url: l.url || '',
                description: l.description || ''
            });
        });
        const list = Array.isArray(cat && cat.list) ? cat.list : [];
        list.forEach((t) => {
            const term = t && t.term ? String(t.term) : '';
            const tlinks = Array.isArray(t && t.links) ? t.links : [];
            tlinks.forEach((l) => {
                if (!l || !l.url) return;
                items.push({
                    taxonomy,
                    term,
                    title: l.title || '',
                    url: l.url || '',
                    description: l.description || ''
                });
            });
        });
    });
    return items;
}

function normalizeSiteUrl(url) {
    return String(url == null ? '' : url)
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '');
}

function removeLinksByUrl(yamlData, urlsToRemove) {
    const urls = urlsToRemove instanceof Set ? urlsToRemove : new Set();
    if (!Array.isArray(yamlData) || urls.size === 0) return { yamlData, removed: [] };
    const removed = [];
    yamlData.forEach((cat) => {
        const taxonomy = cat && cat.taxonomy ? String(cat.taxonomy) : '';
        if (Array.isArray(cat.links)) {
            cat.links = cat.links.filter((l) => {
                const u = l && l.url ? String(l.url) : '';
                if (u && urls.has(u)) {
                    removed.push({ taxonomy, term: '', title: l.title || '', url: u, description: l.description || '' });
                    return false;
                }
                return true;
            });
        }
        if (Array.isArray(cat.list)) {
            cat.list.forEach((t) => {
                const term = t && t.term ? String(t.term) : '';
                if (!Array.isArray(t.links)) return;
                t.links = t.links.filter((l) => {
                    const u = l && l.url ? String(l.url) : '';
                    if (u && urls.has(u)) {
                        removed.push({ taxonomy, term, title: l.title || '', url: u, description: l.description || '' });
                        return false;
                    }
                    return true;
                });
            });
        }
    });
    return { yamlData, removed };
}

const parsedYamlCache = new Map();
const parsedYamlInFlight = new Map();

async function getParsedYamlItemsCached(filePath) {
    const abs = path.resolve(String(filePath || '').trim());
    if (!abs) return { mtimeMs: 0, kind: 'unknown', items: [] };

    let stat;
    try {
        stat = await fs.promises.stat(abs);
        if (!stat.isFile()) return { mtimeMs: 0, kind: 'unknown', items: [] };
    } catch (_) {
        return { mtimeMs: 0, kind: 'unknown', items: [] };
    }

    const cached = parsedYamlCache.get(abs);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

    const inflight = parsedYamlInFlight.get(abs);
    if (inflight) return await inflight;

    const task = (async () => {
        let raw = '';
        try {
            raw = await fs.promises.readFile(abs, 'utf8');
        } catch (_) {
            const empty = { mtimeMs: stat.mtimeMs, kind: 'unknown', items: [] };
            parsedYamlCache.set(abs, empty);
            return empty;
        }

        let yamlData;
        try {
            yamlData = yaml.load(raw) || [];
        } catch (_) {
            const empty = { mtimeMs: stat.mtimeMs, kind: 'unknown', items: [] };
            parsedYamlCache.set(abs, empty);
            return empty;
        }

        const kind = detectYamlKind(path.basename(abs), yamlData);
        const items = [];

        if (kind === 'friendlinks') {
            (Array.isArray(yamlData) ? yamlData : []).forEach((it) => {
                const title = it && it.title ? String(it.title) : '';
                const url = it && it.url ? String(it.url) : '';
                const description = it && it.description ? String(it.description) : '';
                if (!url) return;
                items.push({ title, url, description, kind: 'friendlinks', taxonomy: '', term: '' });
            });
        } else if (kind === 'headers') {
            (Array.isArray(yamlData) ? yamlData : []).forEach((it) => {
                if (!it) return;
                const item = it.item ? String(it.item) : '';
                const link = it.link ? String(it.link) : '';
                if (link) {
                    items.push({ title: item, url: link, description: it.icon ? String(it.icon) : '', kind: 'headers', taxonomy: 'headers', term: '' });
                }
                const list = Array.isArray(it.list) ? it.list : [];
                list.forEach((s) => {
                    const name = s && s.name ? String(s.name) : '';
                    const url = s && s.url ? String(s.url) : '';
                    if (!url) return;
                    items.push({ title: name, url, description: item, kind: 'headers', taxonomy: 'headers', term: item });
                });
            });
        } else {
            const list = collectWebstackLinks(yamlData);
            list.forEach((l) => {
                const title = l && l.title ? String(l.title) : '';
                const url = l && l.url ? String(l.url) : '';
                const description = l && l.description ? String(l.description) : '';
                if (!url) return;
                items.push({
                    title,
                    url,
                    description,
                    kind: 'webstack',
                    taxonomy: l && l.taxonomy ? String(l.taxonomy) : '',
                    term: l && l.term ? String(l.term) : ''
                });
            });
        }

        const next = { mtimeMs: stat.mtimeMs, kind, items };
        parsedYamlCache.set(abs, next);
        return next;
    })();

    parsedYamlInFlight.set(abs, task);
    try {
        return await task;
    } finally {
        parsedYamlInFlight.delete(abs);
    }
}

// 输出书签格式的目录
const BOOKMARKS_OUTPUT_DIR = path.resolve(baseDir, 'bookmarks');

// 确保目录存在的辅助函数
async function ensureDirectoryExists(dirPath) {
    try {
        await fs.promises.access(dirPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.promises.mkdir(dirPath, { recursive: true });
        } else {
            throw error;
        }
    }
}

// 删除文件的辅助函数
async function deleteOldBookmarks(dirPath) {
    const files = await fs.promises.readdir(dirPath);
    const now = Date.now();

    for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fs.promises.stat(filePath);

        // 检查文件是否超过 3 分钟（180000 毫秒）
        if (now - stats.mtimeMs > 180000) {
            await fs.promises.unlink(filePath);
            console.log(`Deleted old bookmark file: ${filePath}`);
        }
    }
}

// 启动定时器每 3 分钟检查并删除旧文件
setInterval(() => {
    deleteOldBookmarks(BOOKMARKS_OUTPUT_DIR).catch(err => console.error('Error deleting old bookmarks:', err));
}, 180000); // 180000 毫秒 = 3 分钟

app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'yaml-server' });
});

// 导出为书签格式的路由
app.get('/api/export-bookmarks', async (req, res) => {
    console.log('Received request for export-bookmarks:', req.query);
    const { outputDir } = req.query; // 从查询参数获取输出目录
    const dataDir = path.resolve(baseDir, 'data');
    const bookmarkTree = [];

    // 确保输出目录存在
    const outputPath = path.resolve(outputDir || BOOKMARKS_OUTPUT_DIR);
    await ensureDirectoryExists(outputPath);

    const yamlFiles = await fs.promises.readdir(dataDir);

    for (const file of yamlFiles) {
        if (file.endsWith('.yaml') || file.endsWith('.yml')) {
            const filePath = path.join(dataDir, file);
            const yamlContent = await fs.promises.readFile(filePath, 'utf8');
            const yamlData = yaml.load(yamlContent);

            yamlData.forEach(category => {
                const taxonomyTitle = category.taxonomy;
                if (!taxonomyTitle) return;

                const taxonomyNode = {
                    title: taxonomyTitle,
                    links: Array.isArray(category.links) ? category.links : [],
                    terms: Array.isArray(category.list) ? category.list : []
                };

                bookmarkTree.push(taxonomyNode);
            });
        }
    }

    // 生成书签 HTML
    let bookmarkHtml = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n';
    bookmarkHtml += '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n';
    bookmarkHtml += '<TITLE>Noise导航-Bookmarks</TITLE>\n<H1>Noise导航-Bookmarks</H1>\n<DL><p>\n';

    const nowTs = Math.floor(Date.now() / 1000);

    const renderLink = (link) => {
        const title = escapeHtml(link.title || '');
        const url = escapeHtml(link.url || '');
        const logo = escapeHtml(link.logo || '');
        const description = escapeHtml(link.description || '');

        const iconAttr = logo ? ` ICON_URI="${logo}"` : '';
        let html = `    <DT><A HREF="${url}" ADD_DATE="${nowTs}"${iconAttr}>${title}</A>\n`;
        if (description) {
            html += `    <DD>${description}</DD>\n`;
        }
        return html;
    };

    bookmarkTree.forEach(taxonomy => {
        bookmarkHtml += `    <DT><H3 ADD_DATE="${nowTs}">${escapeHtml(taxonomy.title)}</H3>\n`;
        bookmarkHtml += '    <DL><p>\n';

        (taxonomy.links || []).forEach(link => {
            if (!link || !link.url) return;
            bookmarkHtml += renderLink(link);
        });

        (taxonomy.terms || []).forEach(termNode => {
            const termTitle = termNode && termNode.term ? String(termNode.term) : '';
            const termLinks = Array.isArray(termNode && termNode.links) ? termNode.links : [];

            const validLinks = termLinks.filter(l => l && l.url);
            if (!termTitle || validLinks.length === 0) {
                return;
            }

            bookmarkHtml += `        <DT><H3 ADD_DATE="${nowTs}">${escapeHtml(termTitle)}</H3>\n`;
            bookmarkHtml += '        <DL><p>\n';
            validLinks.forEach(link => {
                bookmarkHtml += renderLink(link);
            });
            bookmarkHtml += '        </DL><p>\n';
        });

        bookmarkHtml += '    </DL><p>\n';
    });

    bookmarkHtml += '</DL><p>';

    // 写入书签文件
    const outputFilename = `bookmarks_${Date.now()}.html`;
    const fullOutputPath = path.join(outputPath, outputFilename);
    await fs.promises.writeFile(fullOutputPath, bookmarkHtml, 'utf8');

    // 直接下载生成的书签文件
    res.download(fullOutputPath, outputFilename, (err) => {
        if (err) {
            console.error('Error downloading file:', err);
            res.status(500).send('文件下载失败');
        }
    });
});

// GET 路由，用于获取 data 文件夹中的文件列表
app.get('/data', (req, res) => {
    const dataDir = path.resolve(baseDir, 'data');
    fs.readdir(dataDir, (err, files) => {
        if (err) {
            console.error('读取文件夹时出错:', err);
            return res.status(500).send('读取文件夹失败');
        }
        const yamlFiles = files.filter(file => file.endsWith('.yaml') || file.endsWith('.yml'));
        res.json(yamlFiles);
    });
});

// GET 路由，用于获取特定的数据内容
app.get('/data/:filename', (req, res) => {
    const filename = req.params.filename;
    const dataDir = path.resolve(baseDir, 'data');
    const filePath = path.join(dataDir, filename);

    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return res.status(404).send('文件未找到');
            console.error('读取文件时出错:', err);
            return res.status(500).send('读取文件失败');
        }
        res.send(data);
    });
});

// 定义存储路径
const storagePath = ENABLE_HUGO ? path.resolve(baseDir, 'themes/noisedh-nav/static') : path.resolve(__dirname);

// GET 路由，用于获取更新通知
app.get('/api/notifications', (req, res) => {
    const notifications = readNotifications();
    if (notifications.length === 0) {
        return res.json({ message: '暂无更新的内容' });
    }
    res.json(notifications);
});

app.get('/api/server-settings', verifyToken, (req, res) => {
    const webhookUrl = getEffectiveWebhookUrl();
    const telegramChatId = getEffectiveTelegramChatId();
    const telegramBotToken = getEffectiveTelegramBotToken();
    const maskedToken = telegramBotToken ? `${telegramBotToken.slice(0, 3)}...${telegramBotToken.slice(-4)}` : '';
    res.json({
        webhookUrl,
        telegramChatId,
        telegramBotTokenMasked: maskedToken,
        telegramBotTokenSet: Boolean(telegramBotToken),
        rssChannelTitle: getEffectiveRssChannelTitle(),
        rssChannelLink: getEffectiveRssChannelLink(),
        rssChannelDescription: getEffectiveRssChannelDescription(),
        rssImageUrl: getEffectiveRssImageUrl(),
        rssImageTitle: getEffectiveRssImageTitle(),
        rssImageLink: getEffectiveRssImageLink(),
        telegramMessageTitle: getEffectiveTelegramMessageTitle(),
        telegramNavText: getEffectiveTelegramNavText(),
        searchDataDirs: getConfiguredSearchDataDirs()
    });
});

app.post('/api/server-settings', verifyToken, (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const webhookUrl = body.webhookUrl !== undefined ? String(body.webhookUrl || '').trim() : (serverSettings.webhookUrl ? String(serverSettings.webhookUrl).trim() : '');
        const telegramChatId = body.telegramChatId !== undefined ? String(body.telegramChatId || '').trim() : (serverSettings.telegramChatId ? String(serverSettings.telegramChatId).trim() : '');
        const telegramBotToken = body.telegramBotToken !== undefined ? String(body.telegramBotToken || '').trim() : (serverSettings.telegramBotToken ? String(serverSettings.telegramBotToken).trim() : '');
        const rssChannelTitle = body.rssChannelTitle !== undefined ? String(body.rssChannelTitle || '').trim() : getEffectiveRssChannelTitle();
        const rssChannelLink = body.rssChannelLink !== undefined ? String(body.rssChannelLink || '').trim() : getEffectiveRssChannelLink();
        const rssChannelDescription = body.rssChannelDescription !== undefined ? String(body.rssChannelDescription || '').trim() : getEffectiveRssChannelDescription();
        const rssImageUrl = body.rssImageUrl !== undefined ? String(body.rssImageUrl || '').trim() : getEffectiveRssImageUrl();
        const rssImageTitle = body.rssImageTitle !== undefined ? String(body.rssImageTitle || '').trim() : getEffectiveRssImageTitle();
        const rssImageLink = body.rssImageLink !== undefined ? String(body.rssImageLink || '').trim() : getEffectiveRssImageLink();
        const telegramMessageTitle = body.telegramMessageTitle !== undefined ? String(body.telegramMessageTitle || '').trim() : getEffectiveTelegramMessageTitle();
        const telegramNavText = body.telegramNavText !== undefined ? String(body.telegramNavText || '').trim() : getEffectiveTelegramNavText();
        const searchDataDirs = body.searchDataDirs !== undefined
            ? normalizeDirList(body.searchDataDirs)
            : normalizeDirList(serverSettings && serverSettings.searchDataDirs !== undefined ? serverSettings.searchDataDirs : []);

        if (webhookUrl && !/^https?:\/\//i.test(webhookUrl)) {
            return res.status(400).json({ error: 'webhookUrl 必须以 http:// 或 https:// 开头' });
        }

        if (rssChannelLink && !/^https?:\/\//i.test(rssChannelLink)) {
            return res.status(400).json({ error: 'rssChannelLink 必须以 http:// 或 https:// 开头' });
        }

        if (rssImageUrl && !/^https?:\/\//i.test(rssImageUrl)) {
            return res.status(400).json({ error: 'rssImageUrl 必须以 http:// 或 https:// 开头' });
        }

        if (rssImageLink && !/^https?:\/\//i.test(rssImageLink)) {
            return res.status(400).json({ error: 'rssImageLink 必须以 http:// 或 https:// 开头' });
        }

        persistServerSettings({
            webhookUrl,
            telegramChatId,
            telegramBotToken,
            rssChannelTitle,
            rssChannelLink,
            rssChannelDescription,
            rssImageUrl,
            rssImageTitle,
            rssImageLink,
            telegramMessageTitle,
            telegramNavText,
            searchDataDirs
        });

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e && e.message ? e.message : '保存失败' });
    }
});

// 读取现有通知
function readNotifications() {
    const notificationsPath = path.join(storagePath, 'notifications.json'); // 存储在指定路径
    try {
        if (!fs.existsSync(notificationsPath)) return [];
        const data = fs.readFileSync(notificationsPath, 'utf8');
        if (!String(data || '').trim()) return [];
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

// 写入更新后的通知
function writeNotifications(notifications) {
    const notificationsPath = path.join(storagePath, 'notifications.json'); // 存储在指定路径
    const dir = path.dirname(notificationsPath);
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}

    const data = JSON.stringify(Array.isArray(notifications) ? notifications : [], null, 2);
    const tmpPath = `${notificationsPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, data, 'utf8');
    fs.renameSync(tmpPath, notificationsPath);
}

// 转义特殊字符
function escapeXML(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// 生成 RSS XML
function generateRSS(notifications) {
    const rssChannelTitle = getEffectiveRssChannelTitle();
    const rssChannelLink = getEffectiveRssChannelLink();
    const rssChannelDescription = getEffectiveRssChannelDescription();
    const rssImageUrl = getEffectiveRssImageUrl();
    const rssImageTitle = getEffectiveRssImageTitle();
    const rssImageLink = getEffectiveRssImageLink();

    // 生成 RSS 条目
    const rssItems = notifications.map(notification => `
        <item>
            <title>${escapeXML(notification.title)}</title>
            <link>${escapeXML(notification.url)}</link>
            <description>${escapeXML(notification.description)}</description>
            <guid>${escapeXML(notification.url)}</guid>
            <pubDate>${new Date(notification.date).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</pubDate>
        </item>
    `).join('');

    // 返回生成的 RSS XML
    return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
<channel>
    <title>${escapeXML(rssChannelTitle)}</title>
    <link>${escapeXML(rssChannelLink)}</link>
    <description>${escapeXML(rssChannelDescription)}</description>
    <image>
        <url>${escapeXML(rssImageUrl)}</url>
        <title>${escapeXML(rssImageTitle)}</title>
        <link>${escapeXML(rssImageLink)}</link>
    </image>
    ${rssItems}
</channel>
</rss>`;
}

// POST 路由，用于添加数据到指定的数据源
app.post('/api/yaml', verifyToken, async (req, res) => {
    const { filename, newDataEntry } = req.body;
    const kind = (req.body && req.body.kind) || (newDataEntry && newDataEntry.kind) || 'webstack';
    const allowCreateCategory = !(req.body && req.body.allowCreateCategory === false);

    const basePath = path.resolve(baseDir, 'data');
    const absolutePath = path.join(basePath, filename);

    if (!absolutePath.startsWith(basePath)) {
        return res.status(400).send('无效的文件路径');
    }

    fs.readFile(absolutePath, 'utf8', (err, data) => {
        let yamlData = []; // 确保 yamlData 被初始化

        if (err) {
            if (err.code === 'ENOENT') {
                yamlData = []; // 文件不存在时初始化为空数组
            } else {
                console.error('读取文件时出错:', err);
                return res.status(500).send('读取数据失败');
            }
        } else {
            if (data.trim() === '') {
                yamlData = []; // 文件为空时初始化为空数组
            } else {
                try {
                    yamlData = yaml.load(data) || [];
                } catch (parseError) {
                    console.error('解析数据失败:', parseError);
                    return res.status(500).send('解析数据失败');
                }
            }
        }

        if (!Array.isArray(yamlData)) {
            return res.status(400).send('数据顶层结构必须为数组');
        }

        const resolvedKind = detectYamlKind(filename, yamlData);
        const effectiveKind = String(kind || resolvedKind || 'webstack');

        if (effectiveKind === 'friendlinks') {
            if (!newDataEntry || !newDataEntry.title || !newDataEntry.url) {
                return res.status(400).send('所有字段（标题、地址）都必须填写！');
            }
            const exists = Array.isArray(yamlData) && yamlData.some((x) => x && x.url === newDataEntry.url);
            if (!exists) {
                yamlData.push({
                    title: newDataEntry.title,
                    url: newDataEntry.url,
                    description: newDataEntry.description || ''
                });
            }

            const yamlString = '---\n' + yaml.dump(yamlData, { noRefs: true, lineWidth: -1 });
            fs.writeFile(absolutePath, yamlString, async (err) => {
                if (err) {
                    console.error('写入文件时出错:', err);
                    return res.status(500).send('写入数据失败');
                }

                if (ENABLE_HUGO) {
                    exec(`cd ${baseDir} && hugo`, (error, stdout, stderr) => {
                        if (error) console.error(`执行 hugo 时出错: ${error.message}`);
                        else console.log(`hugo 命令输出: ${stdout}`);
                    });
                } else if (fs.existsSync(path.resolve(__dirname, 'trigger_hugo.sh'))) {
                    const script = path.resolve(__dirname, 'trigger_hugo.sh');
                    exec(`sh ${shellEscape(script)} update ${shellEscape(filename)} ${shellEscape(newDataEntry.title)}`, (error, stdout, stderr) => {
                        if (error) console.error(`执行 trigger_hugo.sh 时出错: ${error.message}`);
                        else console.log(`trigger_hugo.sh 命令输出: ${stdout}`);
                    });
                } else if (REMOTE_UPDATE_WEBHOOK) {
                    try {
                        await axios.post(REMOTE_UPDATE_WEBHOOK, { action: 'update', filename, title: newDataEntry.title });
                    } catch (e) {
                        console.error('触发远程 Hugo 更新失败:', e && e.message ? e.message : e);
                    }
                }

                return res.send('数据添加成功！');
            });
            return;
        }

        if (effectiveKind === 'headers') {
            if (!newDataEntry || !newDataEntry.title || !newDataEntry.url) {
                return res.status(400).send('所有字段（导航名称、链接）都必须填写！');
            }
            const headersType = newDataEntry && newDataEntry.headersType ? String(newDataEntry.headersType) : 'top';

            if (headersType === 'sub') {
                const parentItem = newDataEntry && newDataEntry.parentItem ? String(newDataEntry.parentItem) : '';
                if (!parentItem) return res.status(400).send('未提供父级菜单（item）');
                const name = String(newDataEntry.title);
                const url = String(newDataEntry.url);

                let parent = Array.isArray(yamlData) ? yamlData.find((x) => x && x.item === parentItem) : null;
                if (!parent) {
                    parent = { item: parentItem, icon: '', link: '', list: [] };
                    yamlData.push(parent);
                }
                parent.list = Array.isArray(parent.list) ? parent.list : [];
                const existed = parent.list.find((x) => x && x.name === name);
                if (existed) {
                    existed.url = url;
                } else {
                    parent.list.push({ name, url });
                }
            } else {
                const item = String(newDataEntry.title);
                const link = String(newDataEntry.url);
                const icon = newDataEntry.logo ? String(newDataEntry.logo) : '';
                const existing = Array.isArray(yamlData) ? yamlData.find((x) => x && x.item === item) : null;
                if (existing) {
                    existing.link = link;
                    if (icon) existing.icon = icon;
                } else {
                    yamlData.push({ item, icon, link });
                }
            }

            const yamlString = '---\n' + yaml.dump(yamlData, { noRefs: true, lineWidth: -1 });
            fs.writeFile(absolutePath, yamlString, async (err) => {
                if (err) {
                    console.error('写入文件时出错:', err);
                    return res.status(500).send('写入数据失败');
                }

                if (ENABLE_HUGO) {
                    exec(`cd ${baseDir} && hugo`, (error, stdout, stderr) => {
                        if (error) console.error(`执行 hugo 时出错: ${error.message}`);
                        else console.log(`hugo 命令输出: ${stdout}`);
                    });
                } else if (fs.existsSync(path.resolve(__dirname, 'trigger_hugo.sh'))) {
                    const script = path.resolve(__dirname, 'trigger_hugo.sh');
                    exec(`sh ${shellEscape(script)} update ${shellEscape(filename)} ${shellEscape(item)}`, (error, stdout, stderr) => {
                        if (error) console.error(`执行 trigger_hugo.sh 时出错: ${error.message}`);
                        else console.log(`trigger_hugo.sh 命令输出: ${stdout}`);
                    });
                } else if (REMOTE_UPDATE_WEBHOOK) {
                    try {
                        await axios.post(REMOTE_UPDATE_WEBHOOK, { action: 'update', filename, title: item });
                    } catch (e) {
                        console.error('触发远程 Hugo 更新失败:', e && e.message ? e.message : e);
                    }
                }

                return res.send('数据添加成功！');
            });
            return;
        }

        if (!newDataEntry || !newDataEntry.title || !newDataEntry.url) {
            return res.status(400).send('所有字段（标题、地址）都必须填写！');
        }
        if (!newDataEntry.taxonomy) {
            return res.status(400).send('请选择分类');
        }

        const taxonomyEntry = yamlData.find(entry => entry && entry.taxonomy === newDataEntry.taxonomy);

        if (taxonomyEntry) {
            if (newDataEntry.term) {
                taxonomyEntry.list = Array.isArray(taxonomyEntry.list) ? taxonomyEntry.list : [];
                let termEntry = taxonomyEntry.list.find(term => term && term.term === newDataEntry.term);
                if (!termEntry) {
                    if (!allowCreateCategory) {
                        return res.status(400).send('子分类不存在，且当前不允许自动创建');
                    }
                    termEntry = { term: newDataEntry.term, links: [] };
                    taxonomyEntry.list.push(termEntry);
                }
                termEntry.links = Array.isArray(termEntry.links) ? termEntry.links : [];
                termEntry.links.push({
                    title: newDataEntry.title,
                    logo: newDataEntry.logo || '',
                    url: newDataEntry.url,
                    description: newDataEntry.description || ''
                });
            } else {
                taxonomyEntry.links = Array.isArray(taxonomyEntry.links) ? taxonomyEntry.links : [];
                taxonomyEntry.links.push({
                    title: newDataEntry.title,
                    logo: newDataEntry.logo || '',
                    url: newDataEntry.url,
                    description: newDataEntry.description || ''
                });
            }
        } else {
            if (!allowCreateCategory) {
                return res.status(400).send('分类不存在，且当前不允许自动创建');
            }
            const newTaxonomyEntry = {
                taxonomy: newDataEntry.taxonomy,
                icon: newDataEntry.icon || '',
                links: newDataEntry.term ? [] : [{
                    title: newDataEntry.title,
                    logo: newDataEntry.logo || '',
                    url: newDataEntry.url,
                    description: newDataEntry.description || ''
                }],
                list: newDataEntry.term ? [{
                    term: newDataEntry.term,
                    links: [{
                        title: newDataEntry.title,
                        logo: newDataEntry.logo || '',
                        url: newDataEntry.url,
                        description: newDataEntry.description || ''
                    }]
                }] : []
            };
            yamlData.push(newTaxonomyEntry);
        }

        // 生成数据字符串
        const yamlString = '---\n' + yaml.dump(yamlData, { noRefs: true, lineWidth: -1 });

        // 写入数据的部分
        fs.writeFile(absolutePath, yamlString, async (err) => {
            if (err) {
                console.error('写入文件时出错:', err);
                return res.status(500).send('写入数据失败');
            }

            // 添加更新通知
            const notification = {
                title: newDataEntry.title,
                logo: newDataEntry.logo,
                url: newDataEntry.url,
                description: newDataEntry.description,
                date: new Date() // 添加收录时间
            };

            // 读取现有通知
            let notifications = readNotifications();
            notifications.unshift(notification); // 在数组前面添加新通知

            // 保持最多 40 条通知
            if (notifications.length > 40) {
                notifications = notifications.slice(0, 40);
            }

            // 写入更新后的通知
            writeNotifications(notifications);

            // 生成 RSS 文件
            const rssXml = generateRSS(notifications);
            const rssPath = path.join(storagePath, 'rss.xml'); // 存储为 rss.xml
            fs.writeFileSync(rssPath, rssXml, 'utf8');

            // 发送 Telegram 通知
            await sendTelegramNotification(notification, newDataEntry.term, newDataEntry.taxonomy);

            // 发送 webhook 通知
            await sendWebhookNotification(notification);

            // 触发更新机制
            if (ENABLE_HUGO) {
                exec(`cd ${baseDir} && hugo`, (error, stdout, stderr) => {
                    if (error) console.error(`执行 hugo 时出错: ${error.message}`);
                    else console.log(`hugo 命令输出: ${stdout}`);
                });
            } else if (fs.existsSync(path.resolve(__dirname, 'trigger_hugo.sh'))) {
                const script = path.resolve(__dirname, 'trigger_hugo.sh');
                exec(`sh ${shellEscape(script)} update ${shellEscape(filename)} ${shellEscape(newDataEntry.title)}`, (error, stdout, stderr) => {
                    if (error) console.error(`执行 trigger_hugo.sh 时出错: ${error.message}`);
                    else console.log(`trigger_hugo.sh 命令输出: ${stdout}`);
                });
            } else if (REMOTE_UPDATE_WEBHOOK) {
                try {
                    await axios.post(REMOTE_UPDATE_WEBHOOK, { action: 'update', filename, title: newDataEntry.title });
                } catch (e) {
                    console.error('触发远程 Hugo 更新失败:', e && e.message ? e.message : e);
                }
            }
            res.send('数据添加成功！');
        });
    });
});




// 发送 Telegram 通知的函数
async function sendTelegramNotification(notification, term, taxonomy) {
    const telegramChatId = getEffectiveTelegramChatId();
    const telegramBotToken = getEffectiveTelegramBotToken();
    const telegramApiBase = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
    const timeoutMs = Number(process.env.TELEGRAM_TIMEOUT_MS || 15000);
    const maxRetries = Number(process.env.TELEGRAM_MAX_RETRIES || 2);
    const retryDelayMs = Number(process.env.TELEGRAM_RETRY_DELAY_MS || 1200);
    const telegramMessageTitle = getEffectiveTelegramMessageTitle();
    const telegramNavText = getEffectiveTelegramNavText();

    if (!telegramChatId || !telegramBotToken) {
        console.log('Telegram 配置未设置，跳过发送 Telegram 通知。');
        return;
    }

    // 创建消息内容
    let message = `${telegramMessageTitle}\n`;

    // 如果 term 和 taxonomy 存在，则添加到消息中
    if (term || taxonomy) {
        if (term) {
            message += `#${term} `;
        }
        if (taxonomy) {
            message += `#${taxonomy}`;
        }
        message += `\n`; // 添加换行
    }

    message += `站点名称: ${notification.title}\n描述: ${notification.description}\n链接: ${notification.url}\n前往导航: ${telegramNavText}`;

    try {
        const url = `${telegramApiBase}/bot${telegramBotToken}/sendMessage`;
        const payload = {
            chat_id: telegramChatId,
            text: message,
            parse_mode: 'HTML'
        };

        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                await axios.post(url, payload, {
                    timeout: timeoutMs,
                    maxBodyLength: Infinity
                });
                return;
            } catch (err) {
                lastError = err;
                const isLast = attempt >= maxRetries;
                const code = err && err.code ? err.code : '';
                const status = err && err.response ? err.response.status : '';
                const data = err && err.response ? err.response.data : '';
                console.error('发送 Telegram 通知失败:', {
                    attempt: attempt + 1,
                    maxAttempts: maxRetries + 1,
                    code,
                    status,
                    message: err && err.message ? err.message : String(err),
                    response: data
                });
                if (isLast) break;
                await sleep(retryDelayMs * (attempt + 1));
            }
        }

        throw lastError;
    } catch (error) {
        console.error('发送 Telegram 通知最终失败:', error && error.message ? error.message : error);
    }
}

// 搜索路由
app.get('/api/search', async (req, res) => {
    const { keyword, filePath } = req.query;
    const maxResultsRaw = req.query && req.query.limit !== undefined ? Number(req.query.limit) : Number(process.env.SEARCH_MAX_RESULTS || 300);
    const maxResults = Number.isFinite(maxResultsRaw) && maxResultsRaw > 0 ? Math.min(Math.floor(maxResultsRaw), 2000) : 300;

    if (!filePath) {
        return res.status(400).send('未提供文件路径');
    }

    const rawFilePath = String(filePath).trim();
    if (!rawFilePath) {
        return res.status(400).send('文件路径无效');
    }

    const allowedDirs = getConfiguredSearchDataDirs();
    const candidatePaths = [];
    if (path.isAbsolute(rawFilePath)) {
        const normalizedAbs = path.resolve(rawFilePath);
        const isAllowedAbsolute = allowedDirs.some((dir) => normalizedAbs === dir || normalizedAbs.startsWith(`${dir}${path.sep}`));
        if (isAllowedAbsolute) {
            candidatePaths.push(normalizedAbs);
        }
        const fileName = path.basename(normalizedAbs);
        allowedDirs.forEach((dir) => {
            candidatePaths.push(path.join(dir, fileName));
        });
    } else {
        allowedDirs.forEach((dir) => {
            const safePath = safeResolveWithinDir(dir, rawFilePath);
            if (safePath) candidatePaths.push(safePath);
        });
    }

    const uniqueCandidates = Array.from(new Set(candidatePaths));
    const resolvedPath = uniqueCandidates.find((p) => {
        try {
            return fs.existsSync(p) && fs.statSync(p).isFile();
        } catch (_) {
            return false;
        }
    });
    if (!resolvedPath) {
        return res.status(404).send('文件未找到');
    }

    try {
        const parsed = await getParsedYamlItemsCached(resolvedPath);
        const kw = String(keyword || '').trim().toLowerCase();
        const results = [];

        const matches = (text) => {
            if (!kw) return true;
            return String(text || '').toLowerCase().includes(kw);
        };

        for (let i = 0; i < parsed.items.length; i++) {
            const it = parsed.items[i] || {};
            if (
                matches(it.title) ||
                matches(it.url) ||
                matches(it.description) ||
                (parsed.kind === 'webstack' && (matches(it.taxonomy) || matches(it.term)))
            ) {
                results.push({
                    title: it.title || '',
                    url: it.url || '',
                    description: it.description || '',
                    kind: it.kind || parsed.kind || 'webstack',
                    taxonomy: it.taxonomy || '',
                    term: it.term || ''
                });
                if (results.length >= maxResults) break;
            }
        }

        return res.json(results);
    } catch (e) {
        console.error('搜索失败:', e && e.message ? e.message : e);
        return res.status(500).send('搜索失败');
    }
});

function parseBooleanEnv(name) {
    const v = String(process.env[name] || '').trim().toLowerCase();
    if (!v) return false;
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isMcpStdioMode() {
    if (process.argv.includes('--mcp') || process.argv.includes('--mcp-stdio')) return true;
    const mode = String(process.env.MCP_MODE || '').trim().toLowerCase();
    if (mode === 'stdio') return true;
    if (mode === 'http') return false;
    return parseBooleanEnv('MCP_ENABLED');
}

function isMcpHttpMode() {
    if (process.argv.includes('--mcp-http')) return true;
    const mode = String(process.env.MCP_MODE || '').trim().toLowerCase();
    if (mode === 'http') return true;
    return parseBooleanEnv('MCP_HTTP');
}

function shouldStartHttpServer() {
    if (process.argv.includes('--no-http')) return false;
    if (parseBooleanEnv('HTTP_DISABLED')) return false;
    if (isMcpHttpMode()) return true;
    if (isMcpStdioMode() && !parseBooleanEnv('MCP_WITH_HTTP')) return false;
    return true;
}

function parseBooleanEnvDefaultTrue(name) {
    const raw = String(process.env[name] || '').trim().toLowerCase();
    if (!raw) return true;
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function getClientIp(req) {
    const xfwd = req && req.headers ? String(req.headers['x-forwarded-for'] || '') : '';
    if (xfwd) {
        const first = xfwd.split(',')[0].trim();
        if (first) return first;
    }
    const xRealIp = req && req.headers ? String(req.headers['x-real-ip'] || '') : '';
    if (xRealIp) return xRealIp.trim();
    const addr = req && req.socket ? String(req.socket.remoteAddress || '') : '';
    if (!addr) return 'unknown';
    return addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
}

function getBearerTokenFromRequest(req) {
    const token = req && req.headers ? (req.headers.authorization || req.headers['x-auth-token']) : '';
    if (!token) return '';
    const actualToken = String(token).startsWith('Bearer ') ? String(token).slice(7) : String(token);
    return String(actualToken || '').trim();
}

const mcpRateState = new Map();

function mcpRateLimit(req, res, next) {
    if (parseBooleanEnv('MCP_RATE_LIMIT_DISABLED')) return next();
    const windowMs = Math.max(1000, Number(process.env.MCP_RATE_LIMIT_WINDOW_MS || 60000));
    const max = Math.max(1, Number(process.env.MCP_RATE_LIMIT_MAX || 120));
    const now = Date.now();

    const ip = getClientIp(req);
    const key = ip || 'unknown';
    const current = mcpRateState.get(key);

    if (!current || now >= current.resetAtMs) {
        mcpRateState.set(key, { count: 1, resetAtMs: now + windowMs });
        return next();
    }

    current.count += 1;
    if (current.count <= max) return next();

    const retryAfterMs = Math.max(0, current.resetAtMs - now);
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', '0');
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(current.resetAtMs / 1000)));
    return res.status(429).json({ error: '请求过多，请稍后再试', retryAfterSeconds });
}

function verifyMcpToken(req, res, next) {
    const expected = String(process.env.MCP_TOKEN || process.env.API_TOKEN || '').trim();
    const actual = getBearerTokenFromRequest(req);
    if (!expected) {
        return res.status(500).json({ error: 'MCP Token 未配置' });
    }
    if (!actual) {
        return res.status(401).json({ error: '未提供认证 Token' });
    }
    if (actual !== expected) {
        return res.status(403).json({ error: '无效的 Token' });
    }
    return next();
}

function maybeVerifyMcpToken(req, res, next) {
    if (!isMcpHttpMode() && !isMcpStdioMode()) {
        return res.status(404).json({ error: 'MCP 未启用' });
    }
    if (!parseBooleanEnvDefaultTrue('MCP_REQUIRE_TOKEN')) return next();
    return verifyMcpToken(req, res, next);
}

const mcpIndex = {
    lastScanAtMs: 0,
    scanIntervalMs: Number(process.env.MCP_SCAN_INTERVAL_MS || 60000),
    files: [],
    cacheByFile: new Map()
};
const mcpSessions = new Map();
const mcpAnonymousStreams = new Set();
const MCP_SUPPORTED_PROTOCOL_VERSION_LIST = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const MCP_SUPPORTED_PROTOCOL_VERSIONS = new Set(MCP_SUPPORTED_PROTOCOL_VERSION_LIST);

function getLatestMcpProtocolVersion() {
    return MCP_SUPPORTED_PROTOCOL_VERSION_LIST[MCP_SUPPORTED_PROTOCOL_VERSION_LIST.length - 1];
}

function isDateLikeMcpProtocolVersion(version) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(version || '').trim());
}

function getRequestedMcpProtocolVersion(req, msg) {
    const fromHeader = req && req.headers ? String(req.headers['mcp-protocol-version'] || '').trim() : '';
    if (fromHeader) return fromHeader;
    if (msg && msg.params && typeof msg.params.protocolVersion === 'string' && msg.params.protocolVersion.trim()) {
        return msg.params.protocolVersion.trim();
    }
    return '';
}

function negotiateMcpProtocolVersion(req, msg) {
    const requested = getRequestedMcpProtocolVersion(req, msg);
    if (!requested) return getLatestMcpProtocolVersion();
    if (MCP_SUPPORTED_PROTOCOL_VERSIONS.has(requested)) return requested;
    // Be lenient with newer date-based revisions so clients like Cherry Studio
    // can continue using this server even before we explicitly whitelist them.
    if (isDateLikeMcpProtocolVersion(requested)) return getLatestMcpProtocolVersion();
    return null;
}

function createMcpSession() {
    const id = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');
    const session = { id, createdAtMs: Date.now(), updatedAtMs: Date.now(), protocolVersion: getLatestMcpProtocolVersion(), streams: new Set() };
    mcpSessions.set(id, session);
    return session;
}

function getMcpSessionIdFromRequest(req) {
    return req && req.headers ? String(req.headers['mcp-session-id'] || '').trim() : '';
}

function getMcpSessionFromRequest(req) {
    const id = getMcpSessionIdFromRequest(req);
    if (!id) return null;
    return mcpSessions.get(id) || null;
}

function requestPrefersSseResponse(req) {
    const accept = String((req && req.headers && req.headers.accept) || '').toLowerCase();
    if (!accept.includes('text/event-stream')) return false;
    if (accept.includes('application/json')) return false;
    return true;
}

function touchMcpSession(session, protocolVersion) {
    if (!session) return;
    session.updatedAtMs = Date.now();
    if (protocolVersion) session.protocolVersion = protocolVersion;
}

function removeMcpSseConnection(conn) {
    if (!conn) return;
    if (conn.heartbeat) clearInterval(conn.heartbeat);
    if (conn.session && conn.session.streams) conn.session.streams.delete(conn);
    mcpAnonymousStreams.delete(conn);
}

function writeSseEvent(res, msg, options) {
    const eventName = options && options.event ? String(options.event) : 'message';
    const eventId = options && options.id ? String(options.id) : '';
    if (eventName) res.write(`event: ${eventName}\n`);
    if (eventId) res.write(`id: ${eventId}\n`);
    res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

function openMcpSseStream(req, res, session) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (session) {
        res.setHeader('Mcp-Session-Id', session.id);
        res.setHeader('MCP-Protocol-Version', session.protocolVersion || getLatestMcpProtocolVersion());
    }
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(':\n\n');

    const conn = {
        req,
        res,
        session,
        heartbeat: setInterval(() => {
            try {
                res.write('event: ping\ndata: {}\n\n');
            } catch (_) {
                removeMcpSseConnection(conn);
            }
        }, 30000)
    };

    if (session) {
        session.streams.add(conn);
    } else {
        mcpAnonymousStreams.add(conn);
    }

    req.on('close', () => removeMcpSseConnection(conn));
    return conn;
}

function listYamlFilesRecursive(rootDir) {
    const out = [];
    const maxDepth = Number(process.env.MCP_SCAN_MAX_DEPTH || 6);
    const maxFiles = Number(process.env.MCP_SCAN_MAX_FILES || 5000);
    const stack = [{ dir: rootDir, depth: 0 }];
    while (stack.length > 0) {
        const { dir, depth } = stack.pop();
        if (depth > maxDepth) continue;
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            continue;
        }
        for (const ent of entries) {
            if (!ent) continue;
            const name = ent.name || '';
            if (!name) continue;
            const full = path.join(dir, name);
            if (ent.isDirectory()) {
                stack.push({ dir: full, depth: depth + 1 });
                continue;
            }
            if (!ent.isFile()) continue;
            const lower = name.toLowerCase();
            if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
                out.push(full);
                if (out.length >= maxFiles) return out;
            }
        }
    }
    return out;
}

function refreshMcpFileList(force) {
    const now = Date.now();
    if (!force && now - mcpIndex.lastScanAtMs < mcpIndex.scanIntervalMs) return;
    mcpIndex.lastScanAtMs = now;
    const dirs = getConfiguredSearchDataDirs();
    const files = [];
    dirs.forEach((dir) => {
        const resolved = path.resolve(dir);
        try {
            if (!fs.existsSync(resolved)) return;
            const st = fs.statSync(resolved);
            if (!st.isDirectory()) return;
        } catch (_) {
            return;
        }
        files.push(...listYamlFilesRecursive(resolved));
    });
    const unique = Array.from(new Set(files.map((x) => path.resolve(x))));
    mcpIndex.files = unique;
    const set = new Set(unique);
    for (const key of mcpIndex.cacheByFile.keys()) {
        if (!set.has(key)) mcpIndex.cacheByFile.delete(key);
    }
}

function extractSiteItemsFromYamlFile(filePath) {
    let stat;
    try {
        stat = fs.statSync(filePath);
        if (!stat.isFile()) return { mtimeMs: 0, items: [], kind: 'unknown' };
    } catch (_) {
        return { mtimeMs: 0, items: [], kind: 'unknown' };
    }

    const cached = mcpIndex.cacheByFile.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

    let raw = '';
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
        const empty = { mtimeMs: stat.mtimeMs, items: [], kind: 'unknown' };
        mcpIndex.cacheByFile.set(filePath, empty);
        return empty;
    }

    let yamlData;
    try {
        yamlData = yaml.load(raw) || [];
    } catch (_) {
        const empty = { mtimeMs: stat.mtimeMs, items: [], kind: 'unknown' };
        mcpIndex.cacheByFile.set(filePath, empty);
        return empty;
    }

    const kind = detectYamlKind(path.basename(filePath), yamlData);
    const items = [];

    if (kind === 'friendlinks') {
        (Array.isArray(yamlData) ? yamlData : []).forEach((it) => {
            if (!it || !it.url) return;
            items.push({
                title: it.title || '',
                url: it.url || '',
                description: it.description || '',
                taxonomy: '',
                term: '',
                kind,
                source: filePath
            });
        });
    } else if (kind === 'headers') {
        (Array.isArray(yamlData) ? yamlData : []).forEach((it) => {
            if (!it) return;
            const item = it.item ? String(it.item) : '';
            const link = it.link ? String(it.link) : '';
            if (link) {
                items.push({
                    title: item,
                    url: link,
                    description: it.icon ? String(it.icon) : '',
                    taxonomy: 'headers',
                    term: '',
                    kind,
                    source: filePath
                });
            }
            const list = Array.isArray(it.list) ? it.list : [];
            list.forEach((s) => {
                if (!s || !s.url) return;
                items.push({
                    title: s.name ? String(s.name) : '',
                    url: String(s.url),
                    description: item,
                    taxonomy: 'headers',
                    term: item,
                    kind,
                    source: filePath
                });
            });
        });
    } else {
        const list = collectWebstackLinks(yamlData);
        list.forEach((l) => {
            if (!l || !l.url) return;
            items.push({
                title: l.title || '',
                url: l.url || '',
                description: l.description || '',
                taxonomy: l.taxonomy || '',
                term: l.term || '',
                kind: 'webstack',
                source: filePath
            });
        });
    }

    const next = { mtimeMs: stat.mtimeMs, items, kind };
    mcpIndex.cacheByFile.set(filePath, next);
    return next;
}

function normalizeSearchTokens(q) {
    const raw = String(q || '').trim().toLowerCase();
    if (!raw) return [];
    const parts = raw.split(/[\s,，。.;；、/|]+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length === 0) return [raw];
    if (parts.length === 1) return parts;
    return parts.filter((p) => p.length > 0);
}

function scoreSiteMatch(site, tokens, fullQuery) {
    const title = site && site.title ? String(site.title) : '';
    const url = site && site.url ? String(site.url) : '';
    const description = site && site.description ? String(site.description) : '';
    const taxonomy = site && site.taxonomy ? String(site.taxonomy) : '';
    const term = site && site.term ? String(site.term) : '';
    const hay = `${title} ${url} ${description} ${taxonomy} ${term}`.toLowerCase();
    let score = 0;
    if (fullQuery && hay.includes(fullQuery)) score += 10;
    tokens.forEach((t) => {
        if (!t) return;
        if (hay.includes(t)) score += 2;
    });
    if (title && tokens.some((t) => title.toLowerCase().includes(t))) score += 2;
    if (description && tokens.some((t) => description.toLowerCase().includes(t))) score += 1;
    if (url && tokens.some((t) => url.toLowerCase().includes(t))) score += 1;
    return score;
}

function normalizePagination({ page, pageSize, limit }) {
    const p = Number(page);
    const ps = Number(pageSize);
    const l = Number(limit);
    if (Number.isFinite(ps) && ps > 0) {
        const pageNum = Number.isFinite(p) && p > 0 ? Math.floor(p) : 1;
        return { page: pageNum, pageSize: Math.max(1, Math.min(Math.floor(ps), 100)) };
    }
    if (Number.isFinite(l) && l > 0) {
        return { page: 1, pageSize: Math.max(1, Math.min(Math.floor(l), 100)) };
    }
    const pageNum = Number.isFinite(p) && p > 0 ? Math.floor(p) : 1;
    return { page: pageNum, pageSize: 20 };
}

function buildSearchResourceUri(args) {
    const q = args && args.query !== undefined ? String(args.query) : '';
    const page = args && args.page !== undefined ? String(args.page) : '';
    const pageSize = args && args.pageSize !== undefined ? String(args.pageSize) : '';
    const kind = args && args.kind !== undefined ? String(args.kind) : '';
    const taxonomy = args && args.taxonomy !== undefined ? String(args.taxonomy) : '';
    const term = args && args.term !== undefined ? String(args.term) : '';

    const params = [];
    if (q) params.push(`query=${encodeURIComponent(q)}`);
    if (page) params.push(`page=${encodeURIComponent(page)}`);
    if (pageSize) params.push(`pageSize=${encodeURIComponent(pageSize)}`);
    if (kind) params.push(`kind=${encodeURIComponent(kind)}`);
    if (taxonomy) params.push(`taxonomy=${encodeURIComponent(taxonomy)}`);
    if (term) params.push(`term=${encodeURIComponent(term)}`);
    const qs = params.length > 0 ? `?${params.join('&')}` : '';
    return `resource://noisedh/search${qs}`;
}

function sortFacetEntries(map, limit) {
    const list = Array.from(map.entries()).map(([value, count]) => ({ value, count }));
    list.sort((a, b) => b.count - a.count);
    return list.slice(0, Math.max(1, Math.min(Number(limit || 10) || 10, 50)));
}

function renderSearchMarkdown(out) {
    const results = Array.isArray(out && out.results) ? out.results : [];
    const total = Number(out && out.total) || 0;
    const page = Number(out && out.page) || 1;
    const pages = Number(out && out.pages) || 1;
    const pageSize = Number(out && out.pageSize) || 20;
    const hints = Array.isArray(out && out.hints) ? out.hints : [];

    const nav = out && out.navigation ? out.navigation : {};
    const prev = nav && nav.prev && nav.prev.resource ? String(nav.prev.resource) : '';
    const next = nav && nav.next && nav.next.resource ? String(nav.next.resource) : '';
    const first = nav && nav.first && nav.first.resource ? String(nav.first.resource) : '';
    const last = nav && nav.last && nav.last.resource ? String(nav.last.resource) : '';
    const shownStart = total > 0 ? ((page - 1) * pageSize) + 1 : 0;
    const shownEnd = total > 0 ? Math.min(total, shownStart + Math.max(results.length - 1, 0)) : 0;
    const remaining = total > 0 ? Math.max(0, total - shownEnd) : 0;

    const pageLinks = [];
    const windowSize = 7;
    const half = Math.floor(windowSize / 2);
    const startPage = Math.max(1, Math.min(page - half, Math.max(1, pages - windowSize + 1)));
    const endPage = Math.min(pages, startPage + windowSize - 1);
    for (let p = startPage; p <= endPage; p++) {
        const uri = buildSearchResourceUri({ ...(out && out.request ? out.request : {}), page: p });
        pageLinks.push(p === page ? `**${p}**` : `[${p}](${uri})`);
    }

    let md = `共 ${total} 条，当前第 ${page}/${pages} 页（每页 ${pageSize} 条）\n\n`;

    const navParts = [];
    if (first) navParts.push(`[首页](${first})`);
    if (prev) navParts.push(`[上一页](${prev})`);
    if (next) navParts.push(`[下一页](${next})`);
    if (last) navParts.push(`[末页](${last})`);
    if (navParts.length > 0) md += `${navParts.join('  ')}\n\n`;
    if (pages > 1) md += `${pageLinks.join('  ')}\n\n`;

    if (total > 0) {
        md += `本页显示第 ${shownStart}-${shownEnd} 条结果。`;
        if (remaining > 0 && next) {
            md += ` 还有 ${remaining} 条未显示，可继续点击[下一页](${next})查看`;
            if (last) md += `，也可直接点击[末页](${last})。`;
            else md += `。`;
        } else {
            md += ` 已显示全部结果。`;
        }
        md += `\n\n`;
    }

    const suggestedFacets = out && out.suggestedFacets ? out.suggestedFacets : null;
    const facets = out && out.facets ? out.facets : null;
    const followups = Array.isArray(out && out.followups) ? out.followups : [];
    const questions = [];
    if (out && out.query === '') {
        questions.push('你想找什么关键词（站点名/描述/域名）？');
        questions.push('你更偏向哪个一级分类或二级分类？');
    } else if (total === 0) {
        questions.push('要不要换一个更短的关键词或只输入域名的一部分？');
        questions.push('要不要先点一个一级分类/二级分类缩小范围？');
    } else if (total > Math.max(200, pageSize * 10)) {
        questions.push(`当前只显示了第 ${shownStart}-${shownEnd} 条，还剩 ${remaining} 条未显示，要不要继续翻页？`);
        questions.push('结果很多，要不要先点一个一级分类/二级分类缩小范围？');
        questions.push('是否需要把每页数量调大一点方便翻？');
    } else {
        if (remaining > 0) questions.push(`当前还剩 ${remaining} 条结果未显示，要继续翻页吗？`);
        questions.push('要继续翻页，还是按一级分类/二级分类缩小范围？');
    }

    if (questions.length > 0) {
        md += `${questions.slice(0, 3).map((q) => `- ${q}`).join('\n')}\n\n`;
    }

    const quick = [];
    const sourceFacets = (total === 0 && suggestedFacets) ? suggestedFacets : facets;
    if (sourceFacets && Array.isArray(sourceFacets.taxonomies)) {
        sourceFacets.taxonomies.slice(0, 5).forEach((t) => {
            const args = { ...(out && out.request ? out.request : {}), page: 1, taxonomy: t.value };
            quick.push({ label: `只看 一级分类：${t.value}（${t.count}）`, resource: buildSearchResourceUri(args) });
        });
    }
    if (sourceFacets && Array.isArray(sourceFacets.terms)) {
        sourceFacets.terms.slice(0, 5).forEach((t) => {
            const args = { ...(out && out.request ? out.request : {}), page: 1, term: t.value };
            quick.push({ label: `只看 二级分类：${t.value}（${t.count}）`, resource: buildSearchResourceUri(args) });
        });
    }
    if (sourceFacets && Array.isArray(sourceFacets.kinds)) {
        sourceFacets.kinds.slice(0, 3).forEach((k) => {
            const args = { ...(out && out.request ? out.request : {}), page: 1, kind: k.value };
            quick.push({ label: `只看 ${k.value}（${k.count}）`, resource: buildSearchResourceUri(args) });
        });
    }
    [10, 20, 50].forEach((ps) => {
        if (ps === pageSize) return;
        const args = { ...(out && out.request ? out.request : {}), page: 1, pageSize: ps };
        quick.push({ label: `每页 ${ps} 条`, resource: buildSearchResourceUri(args) });
    });

    const mergedQuick = [];
    const seen = new Set();
    [...followups, ...quick].forEach((x) => {
        const key = x && x.resource ? String(x.resource) : '';
        if (!key || seen.has(key)) return;
        seen.add(key);
        mergedQuick.push(x);
    });
    if (mergedQuick.length > 0) {
        md += `快速操作：\n`;
        mergedQuick.slice(0, 10).forEach((f) => {
            const label = f && f.label ? String(f.label) : '';
            const resource = f && f.resource ? String(f.resource) : '';
            if (label && resource) md += `- [${label}](${resource})\n`;
        });
        md += `\n`;
    }

    if (results.length === 0) {
        md += `未找到匹配结果。\n\n`;
    } else {
        results.forEach((r, idx) => {
            const title = r && r.title ? String(r.title) : (r && r.url ? String(r.url) : '未命名');
            const url = r && r.url ? String(r.url) : '';
            const description = r && r.description ? String(r.description) : '';
            const taxonomy = r && r.taxonomy ? String(r.taxonomy) : '';
            const term = r && r.term ? String(r.term) : '';
            const meta = [];
            if (taxonomy) meta.push(`一级分类:${taxonomy}`);
            if (term) meta.push(`二级分类:${term}`);
            const metaText = meta.length > 0 ? `  ${meta.map((x) => `【${x}】`).join('')}` : '';
            md += `${idx + 1}. ${url ? `[${title}](${url})` : title}${metaText}\n`;
            if (description) md += `   - ${description}\n`;
        });
        md += `\n`;
    }
    if (hints.length > 0) {
        md += `可能的处理：\n`;
        hints.slice(0, 6).forEach((h) => {
            md += `- ${String(h)}\n`;
        });
        md += `\n`;
    }

    return md.trim();
}

function searchSites({ query, limit, page, pageSize, kind, files, taxonomy, term, refresh }) {
    const q = String(query || '').trim();
    const fullQuery = q.toLowerCase();
    const tokens = normalizeSearchTokens(q);
    const paging = normalizePagination({ page, pageSize, limit });
    refreshMcpFileList(Boolean(refresh));

    const allowedKinds = new Set(['any', 'webstack', 'friendlinks', 'headers']);
    const kindFilter = allowedKinds.has(String(kind || 'any')) ? String(kind || 'any') : 'any';
    const taxonomyFilter = taxonomy !== undefined ? String(taxonomy || '').trim().toLowerCase() : '';
    const termFilter = term !== undefined ? String(term || '').trim().toLowerCase() : '';

    const fileSet = Array.isArray(files) && files.length > 0
        ? new Set(files.map((x) => path.resolve(String(x || '').trim())).filter(Boolean))
        : null;

    const ranked = [];
    const sourcesCount = mcpIndex.files.length;
    const facetKind = new Map();
    const facetTaxonomy = new Map();
    const facetTerm = new Map();
    const candidates = fileSet ? mcpIndex.files.filter((f) => fileSet.has(f)) : mcpIndex.files;
    candidates.forEach((filePath) => {
        const extracted = extractSiteItemsFromYamlFile(filePath);
        extracted.items.forEach((site) => {
            if (!site || !site.url) return;
            if (kindFilter !== 'any' && site.kind !== kindFilter) return;
            if (taxonomyFilter && String(site.taxonomy || '').toLowerCase() !== taxonomyFilter) return;
            if (termFilter && String(site.term || '').toLowerCase() !== termFilter) return;
            let score = 0;
            if (q) {
                score = scoreSiteMatch(site, tokens, fullQuery);
                if (score <= 0) return;
            }
            ranked.push({ score, site });
            const k = String(site.kind || '').trim();
            const tx = String(site.taxonomy || '').trim();
            const tm = String(site.term || '').trim();
            if (k) facetKind.set(k, (facetKind.get(k) || 0) + 1);
            if (tx) facetTaxonomy.set(tx, (facetTaxonomy.get(tx) || 0) + 1);
            if (tm) facetTerm.set(tm, (facetTerm.get(tm) || 0) + 1);
        });
    });
    if (q) {
        ranked.sort((a, b) => b.score - a.score);
    } else {
        ranked.sort((a, b) => {
            const sa = a && a.site ? a.site : {};
            const sb = b && b.site ? b.site : {};
            const ax = String(sa.taxonomy || '');
            const bx = String(sb.taxonomy || '');
            if (ax !== bx) return ax.localeCompare(bx, 'zh-CN');
            const at = String(sa.term || '');
            const bt = String(sb.term || '');
            if (at !== bt) return at.localeCompare(bt, 'zh-CN');
            const an = String(sa.title || '');
            const bn = String(sb.title || '');
            if (an !== bn) return an.localeCompare(bn, 'zh-CN');
            const au = String(sa.url || '');
            const bu = String(sb.url || '');
            return au.localeCompare(bu);
        });
    }
    const total = ranked.length;
    const pages = Math.max(1, Math.ceil(total / paging.pageSize));
    const safePage = Math.max(1, Math.min(paging.page, pages));
    const start = (safePage - 1) * paging.pageSize;
    const end = start + paging.pageSize;
    const toPublicSite = (site) => {
        const s = site && typeof site === 'object' ? site : {};
        return {
            title: s.title ? String(s.title) : '',
            url: s.url ? String(s.url) : '',
            description: s.description ? String(s.description) : '',
            taxonomy: s.taxonomy ? String(s.taxonomy) : '',
            term: s.term ? String(s.term) : '',
            kind: s.kind ? String(s.kind) : ''
        };
    };
    const results = ranked.slice(start, end).map((r) => toPublicSite(r.site));
    const baseArgs = {
        query: q,
        page: safePage,
        pageSize: paging.pageSize,
        kind: kindFilter !== 'any' ? kindFilter : '',
        taxonomy: taxonomyFilter ? String(taxonomy || '') : '',
        term: termFilter ? String(term || '') : ''
    };
    const prevArgs = safePage > 1 ? { ...baseArgs, page: safePage - 1 } : null;
    const nextArgs = safePage < pages ? { ...baseArgs, page: safePage + 1 } : null;
    const firstArgs = pages > 1 && safePage !== 1 ? { ...baseArgs, page: 1 } : null;
    const lastArgs = pages > 1 && safePage !== pages ? { ...baseArgs, page: pages } : null;

    const followups = [];
    if (safePage > 1) followups.push({ label: '上一页', resource: buildSearchResourceUri(prevArgs) });
    if (safePage < pages) followups.push({ label: '下一页', resource: buildSearchResourceUri(nextArgs) });

    if (!taxonomyFilter) {
        const topTax = sortFacetEntries(facetTaxonomy, 5);
        topTax.forEach((t) => {
            const args = { ...baseArgs, page: 1, taxonomy: t.value };
            followups.push({ label: `只看 一级分类：${t.value}（${t.count}）`, resource: buildSearchResourceUri(args) });
        });
    }

    if (!termFilter) {
        const topTerm = sortFacetEntries(facetTerm, 5);
        topTerm.forEach((t) => {
            const args = { ...baseArgs, page: 1, term: t.value };
            followups.push({ label: `只看 二级分类：${t.value}（${t.count}）`, resource: buildSearchResourceUri(args) });
        });
    }

    let suggestedFacets = null;
    if (q && total === 0) {
        const gKind = new Map();
        const gTax = new Map();
        const gTerm = new Map();
        candidates.forEach((filePath) => {
            const extracted = extractSiteItemsFromYamlFile(filePath);
            extracted.items.forEach((site) => {
                if (!site || !site.url) return;
                if (kindFilter !== 'any' && site.kind !== kindFilter) return;
                const k = String(site.kind || '').trim();
                const tx = String(site.taxonomy || '').trim();
                const tm = String(site.term || '').trim();
                if (k) gKind.set(k, (gKind.get(k) || 0) + 1);
                if (tx) gTax.set(tx, (gTax.get(tx) || 0) + 1);
                if (tm) gTerm.set(tm, (gTerm.get(tm) || 0) + 1);
            });
        });
        suggestedFacets = {
            kinds: sortFacetEntries(gKind, 10),
            taxonomies: sortFacetEntries(gTax, 10),
            terms: sortFacetEntries(gTerm, 10)
        };
    }
    const hints = [];
    if (sourcesCount === 0) {
        hints.push('未检测到可用数据源：请检查 SEARCH_DATA_DIRS 或 BASE_DIR 是否指向正确的数据目录（通常是 .../data）。');
        hints.push('如果你使用 Docker 方式运行，请确认已把宿主机的 data 目录挂载到容器内可访问的位置。');
    } else if (total === 0) {
        if (q) hints.push('尝试换更短或更通用的关键词。');
        hints.push('点击上方的“只看 一级分类/二级分类”先缩小范围。');
    }

    return {
        query: q,
        total,
        page: safePage,
        pageSize: paging.pageSize,
        pages,
        returned: results.length,
        hasPrev: safePage > 1,
        hasNext: safePage < pages,
        facets: {
            kinds: sortFacetEntries(facetKind, 10),
            taxonomies: sortFacetEntries(facetTaxonomy, 10),
            terms: sortFacetEntries(facetTerm, 10)
        },
        navigation: {
            first: firstArgs ? { page: 1, resource: buildSearchResourceUri(firstArgs) } : null,
            prev: prevArgs ? { page: safePage - 1, resource: buildSearchResourceUri(prevArgs) } : null,
            next: nextArgs ? { page: safePage + 1, resource: buildSearchResourceUri(nextArgs) } : null,
            last: lastArgs ? { page: pages, resource: buildSearchResourceUri(lastArgs) } : null
        },
        followups,
        suggestedFacets,
        request: baseArgs,
        sourcesCount,
        hints,
        results
    };
}

function createMcpJsonRpcError(code, message, data) {
    const err = { code: Number(code) || -32603, message: String(message || 'Error') };
    if (data !== undefined) err.data = data;
    return err;
}

let mcpProcessor = null;

function createMcpProcessor() {
    const tools = [
        {
            name: 'search_sites',
            description: '在站内收录数据中按标题/title、地址/url、描述/description、一级分类/taxonomy、二级分类/term 搜索站点，支持分页返回匹配列表。',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '搜索关键词；可为空用于先浏览再筛选。' },
                    page: { type: 'integer', minimum: 1, description: '页码（从 1 开始）。', default: 1 },
                    pageSize: { type: 'integer', minimum: 1, maximum: 100, description: '每页数量（1-100）。', default: 20 },
                    limit: { type: 'integer', minimum: 1, maximum: 100, description: '兼容参数：等价于 pageSize。' },
                    kind: { type: 'string', enum: ['any', 'webstack', 'friendlinks', 'headers'], description: '数据类型过滤。', default: 'any' },
                    files: { type: 'array', items: { type: 'string' }, description: '限定搜索范围为指定文件路径集合（可选）。' },
                    taxonomy: { type: 'string', description: '一级分类过滤（完全匹配）。' },
                    term: { type: 'string', description: '二级分类过滤（完全匹配）。' },
                    format: { type: 'string', enum: ['markdown', 'json'], description: '返回格式：markdown（默认，适合阅读/可点击翻页）或 json（结构化，字段更完整）。', default: 'markdown' },
                    refresh: { type: 'boolean', description: '强制刷新索引（通常不需要）。', default: false }
                }
            }
        }
    ];

    const serverInfo = { name: 'noisedh-yaml-server', version: '1.0.0' };
    const capabilities = { tools: { listChanged: false } };

    function readSearchResource(uri) {
        let u;
        try {
            u = new URL(String(uri || ''));
        } catch (_) {
            return null;
        }
        if (u.protocol !== 'resource:' || u.hostname !== 'noisedh') return null;
        if (u.pathname !== '/search') return null;

        const args = {
            query: u.searchParams.get('query') || '',
            page: u.searchParams.get('page') ? Number(u.searchParams.get('page')) : 1,
            pageSize: u.searchParams.get('pageSize') ? Number(u.searchParams.get('pageSize')) : 20,
            kind: u.searchParams.get('kind') || 'any',
            taxonomy: u.searchParams.get('taxonomy') || '',
            term: u.searchParams.get('term') || '',
            refresh: false
        };
        const out = searchSites(args);
        const text = renderSearchMarkdown(out);
        return { uri: String(uri), mimeType: 'text/markdown', text };
    }

    function handleRequest(msg, context) {
        const id = msg && Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : undefined;
        const method = msg && msg.method ? String(msg.method) : '';
        const params = msg && msg.params ? msg.params : {};
        const protocolVersion = (context && context.protocolVersion) || getLatestMcpProtocolVersion();

        if (method === 'initialize') {
            return { jsonrpc: '2.0', id, result: { protocolVersion, capabilities, serverInfo } };
        }
        if (method === 'tools/list') {
            return { jsonrpc: '2.0', id, result: { tools } };
        }
        if (method === 'resources/list') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    resources: [
                        { uri: 'resource://noisedh/start', name: '开始', mimeType: 'text/markdown' },
                        { uri: 'resource://noisedh/help', name: '帮助', mimeType: 'text/markdown' },
                        { uri: 'resource://noisedh/search', name: '搜索', mimeType: 'text/markdown' }
                    ]
                }
            };
        }
        if (method === 'resources/read') {
            const uri = params && params.uri ? String(params.uri) : '';
            if (uri === 'resource://noisedh/start') {
                const text =
                    `NOISE导航 MCP\n\n` +
                    `- [打开搜索（可点击翻页）](resource://noisedh/search)\n` +
                    `- [帮助](resource://noisedh/help)\n\n` +
                    `示例\n\n` +
                    `- [搜索：AI](resource://noisedh/search?query=AI&page=1&pageSize=20)\n` +
                    `- [搜索：设计](resource://noisedh/search?query=%E8%AE%BE%E8%AE%A1&page=1&pageSize=20)\n\n` +
                    `提示\n\n` +
                    `- 搜索结果支持点击“首页/上一页/下一页/末页/页码”翻页\n` +
                    `- 关键词可匹配站点名/域名/描述\n` +
                    `- 可点击“只看 一级分类/二级分类”缩小范围\n`;
                return { jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: 'text/markdown', text }] } };
            }
            if (uri === 'resource://noisedh/help') {
                const text =
                    `可用能力\n\n` +
                    `- 搜索站点：使用工具 search_sites\n` +
                    `- 起始页：resource://noisedh/start\n` +
                    `- 搜索页：resource://noisedh/search\n` +
                    `- 翻页：在搜索结果中点击“首页/上一页/下一页/末页”或页码\n\n` +
                    `提示\n\n` +
                    `- 关键词可匹配标题/域名/描述（description）\n` +
                    `- 如果结果很多，优先点“只看 一级分类/二级分类”来缩小范围\n`;
                return { jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: 'text/markdown', text }] } };
            }
            const content = readSearchResource(uri);
            if (content) {
                return { jsonrpc: '2.0', id, result: { contents: [content] } };
            }
            return {
                jsonrpc: '2.0',
                id,
                error: createMcpJsonRpcError(
                    -32602,
                    'Invalid resource uri',
                    { examples: ['resource://noisedh/start', 'resource://noisedh/search?query=AI&page=1&pageSize=20'] }
                )
            };
        }
        if (method === 'tools/call') {
            const name = params && params.name ? String(params.name) : '';
            const args = params && params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
            if (name === 'search_sites') {
                const out = searchSites(args || {});
                const format = args && args.format ? String(args.format) : 'markdown';
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [{
                            type: 'text',
                            text: format === 'json' ? JSON.stringify(out, null, 2) : renderSearchMarkdown(out)
                        }]
                    }
                };
            }
            return { jsonrpc: '2.0', id, error: createMcpJsonRpcError(-32601, `Unknown tool: ${name}`) };
        }
        return { jsonrpc: '2.0', id, error: createMcpJsonRpcError(-32601, `Method not found: ${method}`) };
    }

    return { handleRequest };
}

function getMcpProcessor() {
    if (!mcpProcessor) mcpProcessor = createMcpProcessor();
    return mcpProcessor;
}

app.get('/mcp', mcpRateLimit, maybeVerifyMcpToken, (req, res) => {
    const accept = String(req.headers.accept || '').toLowerCase();
    if (!accept.includes('text/event-stream')) {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const requestedVersion = negotiateMcpProtocolVersion(req, null);
    if (!requestedVersion) {
        return res.status(400).json({ error: 'Unsupported MCP protocol version' });
    }

    const sessionId = getMcpSessionIdFromRequest(req);
    const session = sessionId ? mcpSessions.get(sessionId) : null;
    if (sessionId && !session) {
        return res.status(404).json({ error: 'MCP session not found' });
    }
    if (session) touchMcpSession(session, requestedVersion);

    openMcpSseStream(req, res, session);
    return undefined;
});

app.post('/mcp', mcpRateLimit, maybeVerifyMcpToken, (req, res) => {
    const msg = req.body;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        return res.status(400).json({ jsonrpc: '2.0', id: null, error: createMcpJsonRpcError(-32700, 'Parse error') });
    }

    const protocolVersion = negotiateMcpProtocolVersion(req, msg);
    if (!protocolVersion) {
        return res.status(400).json({ error: 'Unsupported MCP protocol version' });
    }

    const method = msg && msg.method ? String(msg.method) : '';
    let session = getMcpSessionFromRequest(req);
    if (getMcpSessionIdFromRequest(req) && !session) {
        return res.status(404).json({ error: 'MCP session not found' });
    }
    if (method === 'initialize' && !session) {
        session = createMcpSession();
    }
    touchMcpSession(session, protocolVersion);
    if (session) {
        res.setHeader('Mcp-Session-Id', session.id);
        res.setHeader('MCP-Protocol-Version', session.protocolVersion || protocolVersion);
    }

    const isNotification = !Object.prototype.hasOwnProperty.call(msg, 'id');
    const isResponse = !method && Object.prototype.hasOwnProperty.call(msg, 'id')
        && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'));
    if (isResponse) return res.status(202).end();
    if (isNotification) return res.status(204).end();

    const { handleRequest } = getMcpProcessor();
    const resp = handleRequest(msg, { protocolVersion, session });
    if (requestPrefersSseResponse(req)) {
        openMcpSseStream(req, res, session);
        writeSseEvent(res, resp, { event: 'message', id: `${Date.now()}` });
        return res.end();
    }
    return res.json(resp);
});

app.delete('/mcp', mcpRateLimit, maybeVerifyMcpToken, (req, res) => {
    const sessionId = getMcpSessionIdFromRequest(req);
    if (!sessionId) {
        return res.status(400).json({ error: 'MCP session id required' });
    }

    const session = mcpSessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'MCP session not found' });
    }

    Array.from(session.streams).forEach((conn) => {
        try {
            conn.res.end();
        } catch (_) {
            // ignore close errors
        }
        removeMcpSseConnection(conn);
    });
    mcpSessions.delete(sessionId);
    return res.status(204).end();
});

function sendMcpMessage(write, msg) {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = `Content-Length: ${body.length}\r\n\r\n`;
    write(Buffer.concat([Buffer.from(header, 'utf8'), body]));
}

function startMcpStdioServer() {
    const write = (buf) => process.stdout.write(buf);
    let buffer = Buffer.alloc(0);
    const { handleRequest } = getMcpProcessor();

    function tryParseFrames() {
        while (buffer.length > 0) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            const headerRaw = buffer.slice(0, headerEnd).toString('utf8');
            const lines = headerRaw.split('\r\n').map((l) => l.trim()).filter(Boolean);
            let contentLength = 0;
            for (const l of lines) {
                const idx = l.toLowerCase().indexOf('content-length:');
                if (idx === 0) {
                    const v = l.slice('content-length:'.length).trim();
                    contentLength = Number(v) || 0;
                }
            }
            const bodyStart = headerEnd + 4;
            const bodyEnd = bodyStart + contentLength;
            if (buffer.length < bodyEnd) return;
            const body = buffer.slice(bodyStart, bodyEnd).toString('utf8');
            buffer = buffer.slice(bodyEnd);
            let msg;
            try {
                msg = JSON.parse(body);
            } catch (e) {
                sendMcpMessage(write, { jsonrpc: '2.0', id: null, error: createMcpJsonRpcError(-32700, 'Parse error') });
                continue;
            }
            const isNotification = msg && !Object.prototype.hasOwnProperty.call(msg, 'id');
            if (isNotification) continue;
            const resp = handleRequest(msg);
            if (resp) sendMcpMessage(write, resp);
        }
    }

    process.stdin.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        tryParseFrames();
    });
}
// GET 路由，用于统计 webstack.yml 中唯一网站数量
app.get('/api/statistics', async (req, res) => {
    const dataDir = path.resolve(baseDir, 'data');
    const yamlFilePath = path.join(dataDir, 'webstack.yml');

    try {
        if (fs.existsSync(yamlFilePath)) {
            const yamlContent = await fs.promises.readFile(yamlFilePath, 'utf8');
            const yamlData = yaml.load(yamlContent);

            if (!Array.isArray(yamlData)) {
                console.error('数据格式不正确:', yamlFilePath);
                res.status(400).json({ error: '数据格式不正确' });
                return;
            }

            const links = collectWebstackLinks(yamlData);
            const uniqueUrls = new Set();

            links.forEach((item) => {
                const normalizedUrl = normalizeSiteUrl(item && item.url);
                if (normalizedUrl) uniqueUrls.add(normalizedUrl);
            });

            const rawUrlCount = links.length;
            const uniqueUrlCount = uniqueUrls.size;
            const duplicateUrlCount = Math.max(0, rawUrlCount - uniqueUrlCount);

            // 兼容旧前端字段：urlCount 现在明确表示唯一网站数
            res.json({
                urlCount: uniqueUrlCount,
                uniqueUrlCount,
                rawUrlCount,
                duplicateUrlCount,
                countMode: 'unique_url'
            });
            return;
        } else {
            console.error('文件未找到:', yamlFilePath);
            res.status(404).json({ error: 'webstack.yml 文件未找到' });
            return;
        }
    } catch (error) {
        console.error('统计 URL 时出错:', error);
        res.status(500).json({ error: '统计 URL 时出错' });
    }
});

app.post('/api/invalid-links/check', verifyToken, async (req, res) => {
    const filename = req.body && req.body.filename ? String(req.body.filename) : '';
    const limitRaw = req.body && req.body.limit !== undefined ? Number(req.body.limit) : 40;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 40;
    const offsetRaw = req.body && req.body.offset !== undefined ? Number(req.body.offset) : 0;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    
    if (!filename) return res.status(400).json({ error: '未提供文件名' });

    const dataDir = path.resolve(baseDir, 'data');
    const absolutePath = path.join(dataDir, filename);
    if (!absolutePath.startsWith(dataDir)) return res.status(400).json({ error: '无效的文件路径' });

    try {
        const raw = await fs.promises.readFile(absolutePath, 'utf8');
        const yamlData = yaml.load(raw) || [];
        if (!Array.isArray(yamlData)) return res.status(400).json({ error: '数据格式不正确' });

        const allLinks = collectWebstackLinks(yamlData);
        const totalLinks = allLinks.length;
        const targets = allLinks.slice(offset, offset + limit);

        const counts = readJsonFile(invalidCountsFilePath);
        const fileCounts = counts[filename] && typeof counts[filename] === 'object' ? counts[filename] : {};

        const deleteUrls = new Set();
        let checkedCount = 0;
        let skippedCount = 0;
        const nowMs = Date.now();

        const itemsToCheck = targets
            .map((link) => {
                const u = link && link.url ? String(link.url) : '';
                if (!u) return null;
                const prev = fileCounts[u] && typeof fileCounts[u] === 'object' ? fileCounts[u] : {};
                const lastMs = parseIsoToMs(prev.lastCheckedAt);
                if (invalidCheckMinIntervalMs > 0 && lastMs > 0 && (nowMs - lastMs) < invalidCheckMinIntervalMs) {
                    skippedCount += 1;
                    const prevCount = Number(prev.count404 || 0);
                    const lastStatus = Number(prev.lastStatus || 0);
                    const is404 = lastStatus === 404;
                    const ok = lastStatus >= 200 && lastStatus < 400;
                    const nextCount = is404 ? prevCount + 1 : (ok ? 0 : prevCount);
                    fileCounts[u] = { ...prev, count404: nextCount, lastStatus: lastStatus, lastCheckedAt: prev.lastCheckedAt || new Date().toISOString() };
                    if (is404 && nextCount >= invalid404Threshold) deleteUrls.add(u);
                    return null;
                }
                return { url: u };
            })
            .filter(Boolean);

        const checkResults = await asyncPool(itemsToCheck, invalidCheckConcurrency, async (item) => {
            const u = item && item.url ? String(item.url) : '';
            if (!u) return null;
            const r = await getUrlStatus(u);
            return { url: u, status: r.status, is404: r.is404, ok: r.ok };
        });

        checkResults.forEach((r) => {
            if (!r || !r.url) return;
            const u = String(r.url);
            const prev = fileCounts[u] && typeof fileCounts[u] === 'object' ? fileCounts[u] : {};
            const prevCount = Number(prev.count404 || 0);
            const nextCount = r.is404 ? prevCount + 1 : (r.ok ? 0 : prevCount);
            fileCounts[u] = {
                count404: nextCount,
                lastStatus: r.status,
                lastCheckedAt: new Date().toISOString()
            };
            checkedCount += 1;
            if (r.is404 && nextCount >= invalid404Threshold) {
                deleteUrls.add(u);
            }
        });

        counts[filename] = fileCounts;
        try { writeJsonFile(invalidCountsFilePath, counts); } catch (e) {}

        let removedCount = 0;
        let removedItems = [];
        if (deleteUrls.size > 0) {
            const removed = removeLinksByUrl(yamlData, deleteUrls);
            removedItems = (removed && removed.removed) ? removed.removed : [];
            removedItems = removedItems.map((it) => {
                const u = it && it.url ? String(it.url) : '';
                const c = fileCounts[u] && typeof fileCounts[u] === 'object' ? Number(fileCounts[u].count404 || invalid404Threshold) : invalid404Threshold;
                return { ...it, count404: c };
            });
            removedCount = removedItems.length;

            const yamlString = '---\n' + yaml.dump(yamlData, { noRefs: true, lineWidth: -1 });
            await fs.promises.writeFile(absolutePath, yamlString, 'utf8');

            appendInvalidLinksMd(removedItems);

            if (ENABLE_HUGO) {
                exec(`cd ${baseDir} && hugo`, (error, stdout, stderr) => {
                    if (error) console.error(`执行 hugo 时出错: ${error.message}`);
                    else console.log(`hugo 命令输出: ${stdout}`);
                });
            } else if (fs.existsSync(path.resolve(__dirname, 'trigger_hugo.sh'))) {
                const script = path.resolve(__dirname, 'trigger_hugo.sh');
                exec(`sh ${shellEscape(script)} update ${shellEscape(filename)} ''`, (error, stdout, stderr) => {
                    if (error) console.error(`执行 trigger_hugo.sh 时出错: ${error.message}`);
                    else console.log(`trigger_hugo.sh 命令输出: ${stdout}`);
                });
            } else if (REMOTE_UPDATE_WEBHOOK) {
                try {
                    await axios.post(REMOTE_UPDATE_WEBHOOK, { action: 'update', filename });
                } catch (e) {
                    console.error('触发远程 Hugo 更新失败:', e && e.message ? e.message : e);
                }
            }
        }

        const nextOffset = offset + limit;
        const hasMore = nextOffset < totalLinks;

        if (!hasMore) {
            try { updateInvalidLinksMdLastChecked(new Date()); } catch (e) {}
        }

        res.json({
            checkedCount,
            skippedCount,
            concurrency: invalidCheckConcurrency,
            timeoutMs: invalidCheckTimeoutMs,
            removedCount,
            threshold: invalid404Threshold,
            reportFile: invalidLinksMdFilePath,
            removedItems: removedItems,
            totalLinks,
            hasMore,
            nextOffset
        });
    } catch (e) {
        res.status(500).json({ error: e && e.message ? e.message : '失效链接检测失败' });
    }
});
// 删除路由
app.delete('/api/delete', verifyToken, (req, res) => {
    const { filename, title, kind } = req.body; // 从请求体中获取文件名和标题

    if (!filename) {
        return res.status(400).send('未提供文件路径');
    }

    const absolutePath = path.resolve(baseDir, 'data', filename);

    fs.readFile(absolutePath, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                return res.status(404).send('文件未找到');
            }
            console.error('读取文件时出错:', err);
            return res.status(500).send('读取数据失败');
        }

        let yamlData;
        try {
            yamlData = yaml.load(data) || [];
        } catch (parseError) {
            console.error('解析数据失败:', parseError);
            return res.status(500).send('解析数据失败');
        }
        if (!Array.isArray(yamlData)) {
            return res.status(400).send('数据顶层结构必须为数组');
        }

        const effectiveKind = String(kind || detectYamlKind(filename, yamlData) || 'webstack');
        let deleted = false;

        if (effectiveKind === 'friendlinks') {
            const before = yamlData.length;
            yamlData = (yamlData || []).filter((it) => !(it && it.title === title));
            deleted = yamlData.length !== before;
        } else if (effectiveKind === 'headers') {
            const before = yamlData.length;
            yamlData = (yamlData || [])
                .map((it) => {
                    if (!it) return it;
                    if (Array.isArray(it.list)) {
                        const b = it.list.length;
                        it.list = it.list.filter((x) => !(x && x.name === title));
                        if (it.list.length !== b) deleted = true;
                    }
                    return it;
                })
                .filter((it) => !(it && it.item === title));
            if (yamlData.length !== before) deleted = true;
        } else {
            yamlData.forEach(entry => {
                if (entry.links) {
                    entry.links = entry.links.filter(link => {
                        if (link.title === title) {
                            deleted = true;
                            return false;
                        }
                        return true;
                    });
                }
                if (entry.list) {
                    entry.list.forEach(termEntry => {
                        if (termEntry.links) {
                            termEntry.links = termEntry.links.filter(link => {
                                if (link.title === title) {
                                    deleted = true;
                                    return false;
                                }
                                return true;
                            });
                        }
                    });
                }
            });
        }

        // 如果没有找到要删除的条目
        if (!deleted) {
            return res.status(404).send('未找到匹配的条目');
        }

        // 将更新后的数据写回数据源
        const yamlString = '---\n' + yaml.dump(yamlData, { noRefs: true, lineWidth: -1 });
        fs.writeFile(absolutePath, yamlString, async (err) => {
            if (err) {
                console.error('写入文件时出错:', err);
                return res.status(500).send('写入数据失败');
            }

            // 触发更新机制
            if (ENABLE_HUGO) {
                exec(`cd ${baseDir} && hugo`, (error, stdout, stderr) => {
                    if (error) console.error(`执行 hugo 时出错: ${error.message}`);
                    else console.log(`hugo 命令输出: ${stdout}`);
                });
            } else if (fs.existsSync(path.resolve(__dirname, 'trigger_hugo.sh'))) {
                const script = path.resolve(__dirname, 'trigger_hugo.sh');
                exec(`sh ${shellEscape(script)} delete ${shellEscape(filename)} ${shellEscape(title)}`, (error, stdout, stderr) => {
                    if (error) console.error(`执行 trigger_hugo.sh 时出错: ${error.message}`);
                    else console.log(`trigger_hugo.sh 命令输出: ${stdout}`);
                });
            } else if (REMOTE_UPDATE_WEBHOOK) {
                try {
                    await axios.post(REMOTE_UPDATE_WEBHOOK, { action: 'delete', filename, title });
                } catch (e) {
                    console.error('触发远程 Hugo 更新失败:', e && e.message ? e.message : e);
                }
            }

            // 反馈
            res.send('条目删除成功！');
        });
    });
});

// 启动服务器
if (isMcpStdioMode()) {
    console.log = (...args) => console.error(...args);
    if (!parseBooleanEnv('MCP_WITH_HTTP') || parseBooleanEnv('HTTP_DISABLED') || process.argv.includes('--no-http')) {
        console.error('MCP stdio 已启用：HTTP 默认不启动。如需同时提供 HTTP API，请设置 MCP_WITH_HTTP=true 且不要传 --no-http/HTTP_DISABLED。');
    }
    startMcpStdioServer();
}

if (shouldStartHttpServer()) {
    app.listen(PORT, () => {
        console.log(`服务器正在运行在 http://localhost:${PORT}`);
        console.log('可用的路由:');
        console.log('GET /api/health');
        console.log('GET /api/export-bookmarks');
        console.log('GET /data');
        console.log('GET /data/:filename');
        console.log('GET /api/notifications');
        console.log('POST /api/yaml');
        console.log('GET /api/search');
        console.log('DELETE /api/delete');
        console.log('GET /api/statistics');
        console.log('POST /mcp');
    });
}
