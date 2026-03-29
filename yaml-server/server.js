const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cors = require('cors');
const { exec } = require('child_process');
const axios = require('axios'); // 用于发送 HTTP 请求

const app = express();
const PORT = Number(process.env.PORT || 8990);

// 控制是否启用本地 Hugo 编译功能（纯 API 模式下可关闭）
const ENABLE_HUGO = process.env.ENABLE_HUGO !== 'false';
// 如果未启用本地 Hugo，且希望在数据更新后调用远程 Webhook/API 触发更新，可以配置此项
const REMOTE_UPDATE_WEBHOOK = process.env.REMOTE_UPDATE_WEBHOOK || '';

// API Token 鉴权中间件配置
const API_TOKEN = process.env.API_TOKEN || 'your_default_secret_token';

function verifyToken(req, res, next) {
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
    allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token']
}));

app.use(express.json());

let notifications = []; // 存储更新通知的数组
const notificationsFilePath = path.resolve(__dirname, 'notifications.json'); // 指定 JSON 文件路径

// 读取通知数据
function readNotifications() {
    if (fs.existsSync(notificationsFilePath)) {
        const data = fs.readFileSync(notificationsFilePath, 'utf8');
        if (data.trim() === '') {
            return []; // 如果文件为空，返回空数组
        }
        return JSON.parse(data);
    }
    return []; // 如果文件不存在，返回空数组
}

// 写入通知数据
function writeNotifications(notifications) {
    fs.writeFileSync(notificationsFilePath, JSON.stringify(notifications, null, 2));
}

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

const serverSettingsFilePath = path.resolve(__dirname, 'server_settings.json');
let serverSettings = {};

function loadServerSettings() {
    const raw = readJsonFile(serverSettingsFilePath);
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
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

loadServerSettings();

async function getUrlStatus(url) {
    const u = String(url || '').trim();
    if (!u) return { status: 0, is404: false, ok: false };
    try {
        const head = await axios.request({
            method: 'HEAD',
            url: u,
            timeout: invalidCheckTimeoutMs,
            maxRedirects: 5,
            validateStatus: () => true,
            headers: { 'User-Agent': 'NavManageLinkChecker/1.0' }
        });
        if (head && typeof head.status === 'number' && head.status !== 405) {
            const st = head.status;
            return { status: st, is404: st === 404, ok: st >= 200 && st < 400 };
        }
    } catch (e) {}
    try {
        const get = await axios.request({
            method: 'GET',
            url: u,
            timeout: invalidCheckTimeoutMs,
            maxRedirects: 5,
            validateStatus: () => true,
            headers: { 'User-Agent': 'NavManageLinkChecker/1.0' }
        });
        const st = get && typeof get.status === 'number' ? get.status : 0;
        return { status: st, is404: st === 404, ok: st >= 200 && st < 400 };
    } catch (e) {
        return { status: 0, is404: false, ok: false };
    }
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

// GET 路由，用于获取特定的 YAML 文件内容
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
    if (fs.existsSync(notificationsPath)) {
        const data = fs.readFileSync(notificationsPath, 'utf8');
        return JSON.parse(data);
    }
    return [];
}

// 写入更新后的通知
function writeNotifications(notifications) {
    const notificationsPath = path.join(storagePath, 'notifications.json'); // 存储在指定路径
    fs.writeFileSync(notificationsPath, JSON.stringify(notifications, null, 2), 'utf8');
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

// POST 路由，用于添加数据到指定的 YAML 文件
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
                return res.status(500).send('读取 YAML 文件失败');
            }
        } else {
            if (data.trim() === '') {
                yamlData = []; // 文件为空时初始化为空数组
            } else {
                try {
                    yamlData = yaml.load(data) || [];
                } catch (parseError) {
                    console.error('解析 YAML 文件失败:', parseError);
                    return res.status(500).send('解析 YAML 文件失败');
                }
            }
        }

        if (!Array.isArray(yamlData)) {
            return res.status(400).send('YAML 顶层结构必须为数组');
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
                    return res.status(500).send('写入 YAML 文件失败');
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
                    return res.status(500).send('写入 YAML 文件失败');
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

        // 生成 YAML 字符串
        const yamlString = '---\n' + yaml.dump(yamlData, { noRefs: true, lineWidth: -1 });

        // 写入 YAML 文件的部分
        fs.writeFile(absolutePath, yamlString, async (err) => {
            if (err) {
                console.error('写入文件时出错:', err);
                return res.status(500).send('写入 YAML 文件失败');
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
app.get('/api/search', (req, res) => {
    const { keyword, filePath } = req.query;

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

    fs.readFile(resolvedPath, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return res.status(404).send('文件未找到');
            console.error('读取文件时出错:', err);
            return res.status(500).send('读取文件失败');
        }

        let yamlData;
        try {
            yamlData = yaml.load(data) || [];
        } catch (parseError) {
            console.error('解析 YAML 文件失败:', parseError);
            return res.status(500).send('解析 YAML 文件失败');
        }

        const results = [];
        const kw = String(keyword || '').toLowerCase();
        const kind = detectYamlKind(path.basename(resolvedPath), yamlData);

        if (kind === 'friendlinks') {
            (yamlData || []).forEach((it) => {
                const title = it && it.title ? String(it.title) : '';
                const url = it && it.url ? String(it.url) : '';
                const description = it && it.description ? String(it.description) : '';
                if (
                    title.toLowerCase().includes(kw) ||
                    url.toLowerCase().includes(kw) ||
                    description.toLowerCase().includes(kw)
                ) {
                    results.push({ title, url, description, kind: 'friendlinks' });
                }
            });
            return res.json(results);
        }

        if (kind === 'headers') {
            (yamlData || []).forEach((it) => {
                const item = it && it.item ? String(it.item) : '';
                const link = it && it.link ? String(it.link) : '';
                const icon = it && it.icon ? String(it.icon) : '';
                if (
                    item.toLowerCase().includes(kw) ||
                    link.toLowerCase().includes(kw) ||
                    icon.toLowerCase().includes(kw)
                ) {
                    results.push({ title: item, url: link, description: icon, kind: 'headers' });
                }
                const list = it && Array.isArray(it.list) ? it.list : [];
                list.forEach((s) => {
                    const name = s && s.name ? String(s.name) : '';
                    const url = s && s.url ? String(s.url) : '';
                    if (name.toLowerCase().includes(kw) || url.toLowerCase().includes(kw)) {
                        results.push({ title: name, url, description: item, kind: 'headers' });
                    }
                });
            });
            return res.json(results);
        }

        (yamlData || []).forEach(entry => {
            if (entry.links) {
                entry.links.forEach(link => {
                    if (
                        (link.title && typeof link.title === 'string' && link.title.toLowerCase().includes(kw)) ||
                        (link.url && typeof link.url === 'string' && link.url.toLowerCase().includes(kw)) ||
                        (link.description && typeof link.description === 'string' && link.description.toLowerCase().includes(kw))
                    ) {
                        results.push({
                            title: link.title,
                            url: link.url,
                            description: link.description,
                            kind: 'webstack'
                        });
                    }
                });
            }
            if (entry.list) {
                entry.list.forEach(termEntry => {
                    if (termEntry.links) {
                        termEntry.links.forEach(link => {
                            if (
                                (link.title && typeof link.title === 'string' && link.title.toLowerCase().includes(kw)) ||
                                (link.url && typeof link.url === 'string' && link.url.toLowerCase().includes(kw)) ||
                                (link.description && typeof link.description === 'string' && link.description.toLowerCase().includes(kw))
                            ) {
                                results.push({
                                    title: link.title,
                                    url: link.url,
                                    description: link.description,
                                    kind: 'webstack'
                                });
                            }
                        });
                    }
                });
            }
        });

        return res.json(results);
    });
});
// GET 路由，用于统计 data 文件夹中 webstack.yml 文件中 url 字段的数量
app.get('/api/statistics', async (req, res) => {
    const dataDir = path.resolve(baseDir, 'data');
    const yamlFilePath = path.join(dataDir, 'webstack.yml');
    let urlCount = 0;

    try {
        if (fs.existsSync(yamlFilePath)) {
            const yamlContent = await fs.promises.readFile(yamlFilePath, 'utf8');
            const yamlData = yaml.load(yamlContent);

            if (Array.isArray(yamlData)) {
                yamlData.forEach(category => {
                    if (Array.isArray(category.links)) {
                        urlCount += category.links.length;
                    }

                    if (Array.isArray(category.list)) {
                        category.list.forEach(subCategory => {
                            if (Array.isArray(subCategory.links)) {
                                urlCount += subCategory.links.length;
                            }
                        });
                    }
                });
            } else {
                console.error('YAML 文件格式不正确:', yamlFilePath);
                res.status(400).json({ error: 'YAML 文件格式不正确' });
                return;
            }
        } else {
            console.error('文件未找到:', yamlFilePath);
            res.status(404).json({ error: 'webstack.yml 文件未找到' });
            return;
        }

        // 移除了成功的日志记录
        res.json({ urlCount });
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
        if (!Array.isArray(yamlData)) return res.status(400).json({ error: 'YAML 文件格式不正确' });

        const allLinks = collectWebstackLinks(yamlData);
        const totalLinks = allLinks.length;
        const targets = allLinks.slice(offset, offset + limit);

        const counts = readJsonFile(invalidCountsFilePath);
        const fileCounts = counts[filename] && typeof counts[filename] === 'object' ? counts[filename] : {};

        const deleteUrls = new Set();
        let checkedCount = 0;
        for (const link of targets) {
            const u = link && link.url ? String(link.url) : '';
            if (!u) continue;
            const r = await getUrlStatus(u);
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
        }

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
            return res.status(500).send('读取 YAML 文件失败');
        }

        let yamlData;
        try {
            yamlData = yaml.load(data) || [];
        } catch (parseError) {
            console.error('解析 YAML 文件失败:', parseError);
            return res.status(500).send('解析 YAML 文件失败');
        }
        if (!Array.isArray(yamlData)) {
            return res.status(400).send('YAML 顶层结构必须为数组');
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

        // 将更新后的数据写回 YAML 文件
        const yamlString = '---\n' + yaml.dump(yamlData, { noRefs: true, lineWidth: -1 });
        fs.writeFile(absolutePath, yamlString, async (err) => {
            if (err) {
                console.error('写入文件时出错:', err);
                return res.status(500).send('写入 YAML 文件失败');
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
app.listen(PORT, () => {
    console.log(`服务器正在运行在 http://localhost:${PORT}`);
    console.log('可用的路由:');
    console.log('GET /api/export-bookmarks');
    console.log('GET /data');
    console.log('GET /data/:filename');
    console.log('GET /api/notifications');
    console.log('POST /api/yaml');
    console.log('GET /api/search');
    console.log('DELETE /api/delete');
    console.log('GET /api/statistics');
});
