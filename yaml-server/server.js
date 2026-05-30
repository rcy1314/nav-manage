const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cors = require('cors');
const crypto = require('crypto');
const { exec } = require('child_process');
const axios = require('axios'); // 用于发送 HTTP 请求
const TOML = require('@iarna/toml');
const { paginateArray } = require('./utils/pagination');

const app = express();
const PORT = Number(process.env.PORT || 8990);

// 控制是否启用本地 Hugo 编译功能（纯 API 模式下可关闭）
const ENABLE_HUGO = String(process.env.ENABLE_HUGO || '').trim().toLowerCase() === 'true';
// 如果未启用本地 Hugo，且希望在数据更新后调用远程 Webhook/API 触发更新，可以配置此项
const REMOTE_UPDATE_WEBHOOK = process.env.REMOTE_UPDATE_WEBHOOK || '';
// 是否在“写入/删除/失效检测”等变更后自动触发同步（默认开启；可通过 server_settings.json 的 autoSync 覆盖）
const AUTO_SYNC_ENV_DEFAULT = process.env.AUTO_SYNC !== 'false';

const GIT_SYNC_ENABLED = String(process.env.GIT_SYNC_ENABLED || '').trim().toLowerCase() === 'true';
const GIT_SYNC_DIR = String(process.env.GIT_SYNC_DIR || '').trim();
const GIT_SYNC_REMOTE = String(process.env.GIT_SYNC_REMOTE || 'origin').trim() || 'origin';
const GIT_SYNC_BRANCH = String(process.env.GIT_SYNC_BRANCH || '').trim();
const GIT_SYNC_MESSAGE = String(process.env.GIT_SYNC_MESSAGE || '').trim() || 'chore: content update';

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

function base64UrlEncode(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''), 'utf8');
    return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecodeToString(input) {
    const s = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    return Buffer.from(`${s}${pad}`, 'base64').toString('utf8');
}

function fnv1a32(input) {
    let h = 0x811c9dc5;
    const s = String(input || '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function serverSettingsMerge(patch) {
    const next = { ...(serverSettings && typeof serverSettings === 'object' ? serverSettings : {}), ...(patch && typeof patch === 'object' ? patch : {}) };
    persistServerSettings(next);
    return next;
}

function getConsoleJwtSecret() {
    const envSecret = String(process.env.CONSOLE_JWT_SECRET || process.env.JWT_SECRET || '').trim();
    const current = serverSettings && serverSettings.consoleJwtSecret ? String(serverSettings.consoleJwtSecret) : '';
    if (envSecret) return envSecret;
    if (current) return current;
    const generated = crypto.randomBytes(32).toString('hex');
    serverSettingsMerge({ consoleJwtSecret: generated });
    return generated;
}

function signConsoleToken(payload) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const p = payload && typeof payload === 'object' ? payload : {};
    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(p));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const sig = crypto.createHmac('sha256', getConsoleJwtSecret()).update(signingInput).digest();
    return `${signingInput}.${base64UrlEncode(sig)}`;
}

function verifyConsoleToken(token) {
    const raw = String(token || '').trim();
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const signingInput = `${h}.${p}`;
    const expected = crypto.createHmac('sha256', getConsoleJwtSecret()).update(signingInput).digest();
    const expectedB64 = base64UrlEncode(expected);
    if (String(s) !== String(expectedB64)) return null;
    let payload;
    try {
        payload = JSON.parse(base64UrlDecodeToString(p));
    } catch {
        return null;
    }
    const exp = payload && payload.exp ? Number(payload.exp) : 0;
    if (exp && Date.now() > exp) return null;
    return payload;
}

function normalizeConsoleUsers() {
    const users = serverSettings && Array.isArray(serverSettings.consoleUsers) ? serverSettings.consoleUsers : [];
    return users.filter((u) => u && typeof u === 'object' && u.id && u.username);
}

function hashPassword(password, options) {
    const salt = options && options.salt ? Buffer.from(String(options.salt), 'hex') : crypto.randomBytes(16);
    const iterations = options && options.iterations ? Number(options.iterations) : 120000;
    const keylen = options && options.keylen ? Number(options.keylen) : 32;
    const digest = options && options.digest ? String(options.digest) : 'sha256';
    const derived = crypto.pbkdf2Sync(String(password || ''), salt, iterations, keylen, digest);
    return { salt: salt.toString('hex'), iterations, keylen, digest, hash: derived.toString('hex') };
}

function verifyPassword(password, record) {
    if (!record || typeof record !== 'object') return false;
    if (!record.salt || !record.hash) return false;
    const next = hashPassword(password, record);
    return next.hash === String(record.hash);
}

function ensureConsoleBootstrap() {
    const users = normalizeConsoleUsers();
    if (users.length > 0) return;
    if (!API_TOKEN) return;
    const password = API_TOKEN;
    const admin = {
        id: crypto.randomBytes(8).toString('hex'),
        username: 'admin',
        isAdmin: true,
        password: hashPassword(password),
        createdAt: new Date().toISOString()
    };
    serverSettingsMerge({ consoleUsers: [admin] });
}

function extractBearer(req) {
    const raw = req && req.headers ? (req.headers.authorization || '') : '';
    const s = String(raw || '').trim();
    if (!s) return '';
    return s.toLowerCase().startsWith('bearer ') ? s.slice(7).trim() : s;
}

function getConsoleAuthUser(req) {
    const token = extractBearer(req);
    const payload = verifyConsoleToken(token);
    if (!payload || !payload.sub) return null;
    const users = normalizeConsoleUsers();
    const user = users.find((u) => String(u.id) === String(payload.sub));
    if (!user) return null;
    return { id: user.id, username: user.username, isAdmin: Boolean(user.isAdmin) };
}

function requireConsoleAuth(req, res, next) {
    ensureConsoleBootstrap();
    const user = getConsoleAuthUser(req);
    if (!user) return res.status(401).json({ message: '需要登录' });
    req.consoleUser = user;
    next();
}

function requireConsoleAdmin(req, res, next) {
    requireConsoleAuth(req, res, () => {
        if (!req.consoleUser || !req.consoleUser.isAdmin) return res.status(403).json({ message: '需要管理员权限' });
        next();
    });
}

function verifyApiTokenOrConsoleAdmin(req, res, next) {
    const token = req.headers.authorization || req.headers['x-auth-token'];
    const actualToken = token ? (String(token).startsWith('Bearer ') ? String(token).slice(7) : String(token)) : '';
    if (API_TOKEN && actualToken && actualToken === API_TOKEN) return next();
    ensureConsoleBootstrap();
    const user = getConsoleAuthUser(req);
    if (user && user.isAdmin) {
        req.consoleUser = user;
        return next();
    }
    if (!API_TOKEN) return res.status(503).json({ error: '服务端未配置 API_TOKEN' });
    return res.status(401).json({ error: '未提供认证 Token' });
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

app.use(express.json({ limit: '20mb' }));

app.use('/admin/assets', express.static(path.resolve(__dirname, 'admin'), { index: false, maxAge: '7d' }));

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function wrapAsync(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
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

function parseBookmarksHtmlToWebstackArray(html) {
    const raw = String(html || '');
    if (!raw.trim()) return [];
    const lines = raw.split(/\r?\n/);
    const stack = [];
    const out = new Map();
    let lastLink = null;

    const ensureTax = (taxonomy) => {
        const key = String(taxonomy || '').trim() || '书签';
        if (!out.has(key)) out.set(key, { taxonomy: key, links: [], list: [] });
        return out.get(key);
    };
    const ensureTerm = (taxObj, term) => {
        const t = String(term || '').trim();
        if (!t) return null;
        let node = (taxObj.list || []).find((x) => x && String(x.term || '') === t) || null;
        if (!node) {
            node = { term: t, links: [] };
            taxObj.list = Array.isArray(taxObj.list) ? taxObj.list : [];
            taxObj.list.push(node);
        }
        return node;
    };
    const pushLink = (taxonomy, term, link) => {
        if (!link || !link.url) return;
        const taxObj = ensureTax(taxonomy);
        const termNode = ensureTerm(taxObj, term);
        if (termNode) {
            termNode.links = Array.isArray(termNode.links) ? termNode.links : [];
            if (!termNode.links.some((x) => x && String(x.url || '') === String(link.url))) termNode.links.push(link);
            return;
        }
        taxObj.links = Array.isArray(taxObj.links) ? taxObj.links : [];
        if (!taxObj.links.some((x) => x && String(x.url || '') === String(link.url))) taxObj.links.push(link);
    };

    for (const line0 of lines) {
        const line = String(line0 || '').trim();
        if (!line) continue;

        const closeDl = /<\/DL>/i.test(line);
        if (closeDl) {
            if (stack.length) stack.pop();
            lastLink = null;
            continue;
        }

        const h3m = line.match(/<H3\b[^>]*>([\s\S]*?)<\/H3>/i);
        if (h3m) {
            const title = String(h3m[1] || '').replace(/<[^>]+>/g, '').trim();
            if (title) stack.push(title);
            lastLink = null;
            continue;
        }

        const ddm = line.match(/<DD\b[^>]*>([\s\S]*?)<\/DD>/i);
        if (ddm && lastLink) {
            const desc = String(ddm[1] || '').replace(/<[^>]+>/g, '').trim();
            if (desc) lastLink.description = desc;
            continue;
        }

        const am = line.match(/<A\b[^>]*\bHREF\s*=\s*"(.*?)"[^>]*>([\s\S]*?)<\/A>/i) || line.match(/<A\b[^>]*\bHREF\s*=\s*'(.*?)'[^>]*>([\s\S]*?)<\/A>/i);
        if (am) {
            const url = String(am[1] || '').trim();
            const title = String(am[2] || '').replace(/<[^>]+>/g, '').trim();
            const icon = (line.match(/\bICON_URI\s*=\s*"(.*?)"/i) || line.match(/\bICON_URI\s*=\s*'(.*?)'/i) || [])[1] || '';
            if (url) {
                const taxonomy = stack[0] || '书签';
                const term = stack.length > 1 ? stack.slice(1).join(' / ') : '';
                const link = { title: title || url, url, description: '', logo: String(icon || '').trim() };
                pushLink(taxonomy, term, link);
                lastLink = link;
            }
            continue;
        }
    }

    const arr = Array.from(out.values());
    arr.forEach((x) => {
        x.links = Array.isArray(x.links) ? x.links : [];
        x.list = Array.isArray(x.list) ? x.list : [];
        x.list.forEach((t) => { t.links = Array.isArray(t.links) ? t.links : []; });
    });
    return arr;
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

function getEffectiveDataSource() {
    const v = serverSettings && serverSettings.dataSource !== undefined ? String(serverSettings.dataSource || '').trim().toLowerCase() : '';
    const env = String(process.env.DATA_SOURCE || '').trim().toLowerCase();
    const out = v || env || 'local';
    return out === 'github' ? 'github' : 'local';
}

function getEffectiveGithubUser() {
    const v = serverSettings && serverSettings.githubUser ? String(serverSettings.githubUser).trim() : '';
    return v || String(process.env.GITHUB_USER || process.env.GITHUB_OWNER || '').trim();
}

function getEffectiveGithubRepo() {
    const v = serverSettings && serverSettings.githubRepo ? String(serverSettings.githubRepo).trim() : '';
    return v || String(process.env.GITHUB_REPO || '').trim();
}

function getEffectiveGithubBranch() {
    const v = serverSettings && serverSettings.githubBranch ? String(serverSettings.githubBranch).trim() : '';
    return v || String(process.env.GITHUB_BRANCH || '').trim() || 'main';
}

function getEffectiveGithubPath() {
    const v = serverSettings && serverSettings.githubPath ? String(serverSettings.githubPath).trim() : '';
    return v || String(process.env.GITHUB_PATH || '').trim() || 'data';
}

function getEffectiveGithubToken() {
    const v = serverSettings && serverSettings.githubToken ? String(serverSettings.githubToken).trim() : '';
    return v || String(process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || '').trim();
}

function isGithubDataSource() {
    return getEffectiveDataSource() === 'github';
}

function githubApiHeaders() {
    const token = getEffectiveGithubToken();
    const headers = { Accept: 'application/vnd.github.v3+json' };
    if (token) headers.Authorization = `token ${token}`;
    return headers;
}

function githubPathPrefix() {
    const p = String(getEffectiveGithubPath() || 'data').replace(/^\/+/, '').replace(/\/+$/, '');
    return p ? p : 'data';
}

function normalizeDataFilename(filename) {
    const name = String(filename || '').trim();
    if (!name) return '';
    if (name.includes('/') || name.includes('\\')) return '';
    const lower = name.toLowerCase();
    if (!lower.endsWith('.yml') && !lower.endsWith('.yaml')) return '';
    return name;
}

async function githubListYamlFiles() {
    const user = getEffectiveGithubUser();
    const repo = getEffectiveGithubRepo();
    const branch = getEffectiveGithubBranch();
    const p = githubPathPrefix();
    if (!user || !repo) return [];
    const url = `https://api.github.com/repos/${encodeURIComponent(user)}/${encodeURIComponent(repo)}/contents/${p}?ref=${encodeURIComponent(branch)}`;
    const res = await axios.get(url, { headers: githubApiHeaders(), validateStatus: () => true });
    if (!res || res.status === 404) return [];
    if (res.status < 200 || res.status >= 300) throw new Error(`GitHub 列目录失败: HTTP ${res.status}`);
    const data = res.data;
    if (!Array.isArray(data)) return [];
    return data
        .filter((x) => x && x.type === 'file' && x.name && /\.ya?ml$/i.test(String(x.name)))
        .map((x) => String(x.name));
}

async function githubGetFile(filename) {
    const user = getEffectiveGithubUser();
    const repo = getEffectiveGithubRepo();
    const branch = getEffectiveGithubBranch();
    const p = githubPathPrefix();
    const name = normalizeDataFilename(filename);
    if (!user || !repo) throw new Error('GitHub 配置不完整');
    if (!name) throw new Error('filename 无效');
    const url = `https://api.github.com/repos/${encodeURIComponent(user)}/${encodeURIComponent(repo)}/contents/${p}/${encodeURIComponent(name)}?ref=${encodeURIComponent(branch)}`;
    const res = await axios.get(url, { headers: githubApiHeaders(), validateStatus: () => true });
    if (res.status === 404) return { exists: false, content: '', sha: null };
    if (res.status < 200 || res.status >= 300) throw new Error(`GitHub 读取失败: HTTP ${res.status}`);
    const data = res.data || {};
    const contentBase64 = data && data.content ? String(data.content) : '';
    const content = contentBase64 ? Buffer.from(contentBase64.replace(/\n/g, ''), 'base64').toString('utf8') : '';
    return { exists: true, content, sha: data && data.sha ? String(data.sha) : null };
}

async function githubPutFile(filename, content, sha, message) {
    const user = getEffectiveGithubUser();
    const repo = getEffectiveGithubRepo();
    const branch = getEffectiveGithubBranch();
    const p = githubPathPrefix();
    const name = normalizeDataFilename(filename);
    if (!user || !repo) throw new Error('GitHub 配置不完整');
    if (!name) throw new Error('filename 无效');
    const url = `https://api.github.com/repos/${encodeURIComponent(user)}/${encodeURIComponent(repo)}/contents/${p}/${encodeURIComponent(name)}`;
    const body = {
        message: message || `Update ${name}`,
        content: Buffer.from(String(content || ''), 'utf8').toString('base64'),
        branch
    };
    if (sha) body.sha = sha;
    const res = await axios.put(url, body, { headers: { ...githubApiHeaders(), 'Content-Type': 'application/json' }, validateStatus: () => true });
    if (res.status < 200 || res.status >= 300) throw new Error(`GitHub 写入失败: HTTP ${res.status}`);
    const data = res.data || {};
    const nextSha = data && data.content && data.content.sha ? String(data.content.sha) : null;
    return { sha: nextSha };
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

function writeTextFileAtomic(filePath, content) {
    const dir = path.dirname(filePath);
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch {}
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, String(content || ''), 'utf8');
    fs.renameSync(tmp, filePath);
}

function findTomlTableRange(lines, header) {
    const h = String(header || '').trim();
    const reHeader = new RegExp(`^\\s*\\[\\s*${h.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\]\\s*$`);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (reHeader.test(lines[i])) {
            start = i + 1;
            break;
        }
    }
    const isAnyHeader = (s) => /^\s*\[\[?.+\]\]?\s*$/.test(String(s || '').trim());
    if (start < 0) return null;
    let end = lines.length;
    for (let i = start; i < lines.length; i++) {
        if (isAnyHeader(lines[i])) {
            end = i;
            break;
        }
    }
    return { start, end };
}

function tomlAssignmentLines(key, value, indent) {
    const raw = String(TOML.stringify({ v: value }) || '').trimEnd();
    const lines = raw.split('\n');
    if (lines.length === 0) return [`${String(indent || '')}${key} = ""`];
    lines[0] = lines[0].replace(/^v\s*=\s*/, `${key} = `);
    return lines.map((l) => `${String(indent || '')}${l}`);
}

function tomlLiteral(value) {
    const raw = String(TOML.stringify({ v: value }) || '').trimEnd();
    const line = raw.split('\n')[0] || '';
    const idx = line.indexOf('=');
    return idx >= 0 ? line.slice(idx + 1).trim() : '""';
}

function formatInlineTable(item, order) {
    const it = item && typeof item === 'object' ? item : {};
    const keys = Array.isArray(order) && order.length ? order : Object.keys(it);
    const parts = [];
    keys.forEach((k) => {
        if (it[k] === undefined || it[k] === null) return;
        const v = String(it[k]).trim();
        if (!v) return;
        parts.push(`${k} = ${tomlLiteral(v)}`);
    });
    return `{ ${parts.join(', ')} }`;
}

function formatInlineTableArrayLines(key, items, order, indent) {
    const base = String(indent || '');
    const inner = `${base}  `;
    const arr = Array.isArray(items) ? items : [];
    const lines = [`${base}${key} = [`];
    arr.forEach((it, idx) => {
        const t = formatInlineTable(it, order);
        lines.push(`${inner}${t}${idx < arr.length - 1 ? ',' : ''}`);
    });
    lines.push(`${base}]`);
    return lines;
}

function replaceTomlKeyBlock(lines, tableHeader, key, nextLines) {
    const range = tableHeader ? findTomlTableRange(lines, tableHeader) : { start: 0, end: lines.findIndex((l) => /^\s*\[/.test(String(l || '').trim())) };
    const effectiveRange = range && range.end >= 0 ? range : { start: 0, end: lines.length };
    const start = effectiveRange.start;
    const end = effectiveRange.end;
    const reKey = new RegExp(`^\\s*${String(key).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*=`);
    for (let i = start; i < end; i++) {
        if (!reKey.test(lines[i])) continue;
        const indent = (lines[i].match(/^(\s*)/) || ['', ''])[1];
        const first = lines[i];
        const rhs = first.split('=').slice(1).join('=').trim();
        let j = i + 1;
        if (rhs.startsWith('"""') || rhs.includes('"""')) {
            while (j < lines.length) {
                if (lines[j].includes('"""')) {
                    j += 1;
                    break;
                }
                j += 1;
            }
        } else if (rhs.startsWith('[') && !rhs.includes(']')) {
            let depth = (rhs.match(/\[/g) || []).length - (rhs.match(/\]/g) || []).length;
            while (j < lines.length && depth > 0) {
                depth += (lines[j].match(/\[/g) || []).length;
                depth -= (lines[j].match(/\]/g) || []).length;
                j += 1;
            }
        }
        const replaced = (Array.isArray(nextLines) ? nextLines : [String(nextLines || '')]).map((l) => `${indent}${String(l).replace(/^\s*/, '')}`);
        lines.splice(i, Math.max(1, j - i), ...replaced);
        return true;
    }
    const insertAt = end;
    const inserted = Array.isArray(nextLines) ? nextLines : [String(nextLines || '')];
    lines.splice(insertAt, 0, ...inserted);
    return true;
}

function replaceTomlArrayOfTables(lines, header, buildLines) {
    const h = String(header || '').trim();
    const re = new RegExp(`^\\s*\\[\\[\\s*${h.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\]\\]\\s*$`);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
            start = i;
            break;
        }
    }
    if (start < 0) return false;
    const isAnyHeader = (s) => /^\s*\[\[?.+\]\]?\s*$/.test(String(s || '').trim());
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        const trimmed = String(lines[i] || '').trim();
        if (isAnyHeader(trimmed) && !re.test(trimmed)) {
            end = i;
            break;
        }
    }
    const next = Array.isArray(buildLines) ? buildLines : [];
    lines.splice(start, end - start, ...next);
    return true;
}

function buildHugoConfigDto(parsed) {
    const cfg = parsed && typeof parsed === 'object' ? parsed : {};
    const params = cfg.params && typeof cfg.params === 'object' ? cfg.params : {};
    const header = params.header && typeof params.header === 'object' ? params.header : {};
    const footer = params.footer && typeof params.footer === 'object' ? params.footer : {};
    const hotlist = header.hotlist && typeof header.hotlist === 'object' ? header.hotlist : {};
    const hotApi = params.hotApi && typeof params.hotApi === 'object' ? params.hotApi : {};
    const bookmarks = params.bookmarks && typeof params.bookmarks === 'object' ? params.bookmarks : {};
    const minify = cfg.minify && typeof cfg.minify === 'object' ? cfg.minify : {};
    const outputs = cfg.outputs && typeof cfg.outputs === 'object' ? cfg.outputs : {};
    const outputFormats = cfg.outputFormats && typeof cfg.outputFormats === 'object' ? cfg.outputFormats : {};
    const markup = cfg.markup && typeof cfg.markup === 'object' ? cfg.markup : {};
    const goldmark = markup.goldmark && typeof markup.goldmark === 'object' ? markup.goldmark : {};
    const renderer = goldmark.renderer && typeof goldmark.renderer === 'object' ? goldmark.renderer : {};
    return {
        meta: {
            hasAi: Boolean(params.ai && typeof params.ai === 'object'),
            hasBilibili: Boolean(params.bilibili && typeof params.bilibili === 'object'),
            hasRedirect: Boolean(params.redirect && typeof params.redirect === 'object')
        },
        base: {
            baseURL: cfg.baseURL || '',
            languageCode: cfg.languageCode || '',
            title: cfg.title || '',
            theme: cfg.theme || '',
            preserveTaxonomyNames: Boolean(cfg.preserveTaxonomyNames),
            publishDir: cfg.publishDir || '',
            relativeURLs: Boolean(cfg.relativeURLs),
            disablePathToLower: Boolean(cfg.disablePathToLower),
            hasCJKLanguage: Boolean(cfg.hasCJKLanguage)
        },
        build: {
            minify: {
                disableHTML: minify.disableHTML === undefined ? false : Boolean(minify.disableHTML),
                disableCSS: minify.disableCSS === undefined ? false : Boolean(minify.disableCSS),
                disableJS: minify.disableJS === undefined ? false : Boolean(minify.disableJS),
                minifyOutput: minify.minifyOutput === undefined ? true : Boolean(minify.minifyOutput)
            },
            outputs: {
                home: Array.isArray(outputs.home) ? outputs.home : []
            },
            outputFormats: {
                bookmarks: outputFormats.bookmarks && typeof outputFormats.bookmarks === 'object' ? outputFormats.bookmarks : {}
            },
            markup: {
                unsafe: renderer && renderer.unsafe !== undefined ? Boolean(renderer.unsafe) : false
            }
        },
        params: {
            author: params.author || '',
            siteurl: params.siteurl || '',
            about: params.about || '',
            repository: params.repository || '',
            musicServer: params.musicServer || '',
            musicId: params.musicId || '',
            description: params.description || '',
            keywords: params.keywords || '',
            og_title: params.og_title || '',
            og_description: params.og_description || '',
            og_image: params.og_image || '',
            og_url: params.og_url || '',
            twitter_title: params.twitter_title || '',
            twitter_description: params.twitter_description || '',
            twitter_image: params.twitter_image || '',
            enablePreLoad: params.enablePreLoad === undefined ? true : Boolean(params.enablePreLoad),
            textPreLoad: params.textPreLoad || '',
            logosPath: params.logosPath || '',
            defaultLogo: params.defaultLogo || '',
            nightMode: params.nightMode === undefined ? false : Boolean(params.nightMode),
            cardListCollapseLimit: params.cardListCollapseLimit === undefined ? null : params.cardListCollapseLimit,
            seo: params.seo && typeof params.seo === 'object' ? params.seo : {},
            ai: params.ai && typeof params.ai === 'object'
                ? { ...params.ai, apiKey: '', welcomeTips: Array.isArray(params.ai.welcomeTips) ? params.ai.welcomeTips : [] }
                : { apiKey: '', welcomeTips: [] },
            cdn: params.cdn && typeof params.cdn === 'object' ? params.cdn : {},
            images: params.images && typeof params.images === 'object' ? params.images : {},
            redirect: params.redirect && typeof params.redirect === 'object' ? params.redirect : {},
            footer: { ...(footer || {}), toggleMenu: Array.isArray(footer.toggleMenu) ? footer.toggleMenu : [] },
            header: {
                ...(header || {}),
                heroActions: Array.isArray(header.heroActions) ? header.heroActions : [],
                heroStickers: Array.isArray(header.heroStickers) ? header.heroStickers : [],
                heroFloatingBadges: Array.isArray(header.heroFloatingBadges) ? header.heroFloatingBadges : [],
                heroHighlights: Array.isArray(header.heroHighlights) ? header.heroHighlights : [],
                heroStats: Array.isArray(header.heroStats) ? header.heroStats : [],
                tabs: Array.isArray(header.tabs) ? header.tabs : [],
                announcements: Array.isArray(header.announcements) ? header.announcements : [],
                adList: Array.isArray(header.adList) ? header.adList : []
            },
            hotApi: {
                endpoints: Array.isArray(hotApi.endpoints) ? hotApi.endpoints : []
            },
            hot: {
                items: Array.isArray(hotlist.items) ? hotlist.items : []
            },
            bookmarks: bookmarks,
            bilibili: params.bilibili && typeof params.bilibili === 'object' ? params.bilibili : {}
        }
    };
}

function applyHugoConfigPatch(rawToml, payload) {
    const raw = String(rawToml || '');
    const lines = raw.split(/\r?\n/);
    const base = payload && payload.base && typeof payload.base === 'object' ? payload.base : {};
    const build = payload && payload.build && typeof payload.build === 'object' ? payload.build : {};
    const params = payload && payload.params && typeof payload.params === 'object' ? payload.params : {};
    const seo = params.seo && typeof params.seo === 'object' ? params.seo : {};
    const ai = params.ai && typeof params.ai === 'object' ? params.ai : {};
    const cdn = params.cdn && typeof params.cdn === 'object' ? params.cdn : {};
    const images = params.images && typeof params.images === 'object' ? params.images : {};
    const redirect = params.redirect && typeof params.redirect === 'object' ? params.redirect : {};
    const footer = params.footer && typeof params.footer === 'object' ? params.footer : {};
    const header = params.header && typeof params.header === 'object' ? params.header : {};
    const bilibili = params.bilibili && typeof params.bilibili === 'object' ? params.bilibili : {};
    const hot = params.hot && typeof params.hot === 'object' ? params.hot : {};
    const hotApi = params.hotApi && typeof params.hotApi === 'object' ? params.hotApi : {};
    const bookmarks = params.bookmarks && typeof params.bookmarks === 'object' ? params.bookmarks : {};
    const buildMinify = build.minify && typeof build.minify === 'object' ? build.minify : {};
    const buildOutputs = build.outputs && typeof build.outputs === 'object' ? build.outputs : {};
    const buildOutputFormats = build.outputFormats && typeof build.outputFormats === 'object' ? build.outputFormats : {};
    const buildMarkup = build.markup && typeof build.markup === 'object' ? build.markup : {};

    replaceTomlKeyBlock(lines, null, 'baseURL', tomlAssignmentLines('baseURL', String(base.baseURL || '').trim(), ''));
    replaceTomlKeyBlock(lines, null, 'languageCode', tomlAssignmentLines('languageCode', String(base.languageCode || '').trim(), ''));
    replaceTomlKeyBlock(lines, null, 'title', tomlAssignmentLines('title', String(base.title || '').trim(), ''));
    replaceTomlKeyBlock(lines, null, 'theme', tomlAssignmentLines('theme', String(base.theme || '').trim(), ''));
    replaceTomlKeyBlock(lines, null, 'preserveTaxonomyNames', tomlAssignmentLines('preserveTaxonomyNames', Boolean(base.preserveTaxonomyNames), ''));
    replaceTomlKeyBlock(lines, null, 'publishDir', tomlAssignmentLines('publishDir', String(base.publishDir || '').trim(), ''));
    replaceTomlKeyBlock(lines, null, 'relativeURLs', tomlAssignmentLines('relativeURLs', Boolean(base.relativeURLs), ''));
    replaceTomlKeyBlock(lines, null, 'disablePathToLower', tomlAssignmentLines('disablePathToLower', Boolean(base.disablePathToLower), ''));
    replaceTomlKeyBlock(lines, null, 'hasCJKLanguage', tomlAssignmentLines('hasCJKLanguage', Boolean(base.hasCJKLanguage), ''));

    replaceTomlKeyBlock(lines, 'minify', 'disableHTML', tomlAssignmentLines('disableHTML', Boolean(buildMinify.disableHTML), '  '));
    replaceTomlKeyBlock(lines, 'minify', 'disableCSS', tomlAssignmentLines('disableCSS', Boolean(buildMinify.disableCSS), '  '));
    replaceTomlKeyBlock(lines, 'minify', 'disableJS', tomlAssignmentLines('disableJS', Boolean(buildMinify.disableJS), '  '));
    replaceTomlKeyBlock(lines, 'minify', 'minifyOutput', tomlAssignmentLines('minifyOutput', Boolean(buildMinify.minifyOutput), '  '));

    replaceTomlKeyBlock(lines, 'outputs', 'home', tomlAssignmentLines('home', Array.isArray(buildOutputs.home) ? buildOutputs.home : [], '  '));
    const fmtBookmarks = buildOutputFormats.bookmarks && typeof buildOutputFormats.bookmarks === 'object' ? buildOutputFormats.bookmarks : {};
    replaceTomlKeyBlock(lines, 'outputFormats.bookmarks', 'mediaType', tomlAssignmentLines('mediaType', String(fmtBookmarks.mediaType || ''), '    '));
    replaceTomlKeyBlock(lines, 'outputFormats.bookmarks', 'baseName', tomlAssignmentLines('baseName', String(fmtBookmarks.baseName || ''), '    '));
    replaceTomlKeyBlock(lines, 'outputFormats.bookmarks', 'isPlainText', tomlAssignmentLines('isPlainText', Boolean(fmtBookmarks.isPlainText), '    '));
    replaceTomlKeyBlock(lines, 'outputFormats.bookmarks', 'notAlternative', tomlAssignmentLines('notAlternative', Boolean(fmtBookmarks.notAlternative), '    '));

    replaceTomlKeyBlock(lines, 'markup.goldmark.renderer', 'unsafe', tomlAssignmentLines('unsafe', Boolean(buildMarkup.unsafe), '  '));

    replaceTomlKeyBlock(lines, 'params', 'author', tomlAssignmentLines('author', String(params.author || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'siteurl', tomlAssignmentLines('siteurl', String(params.siteurl || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'about', tomlAssignmentLines('about', String(params.about || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'repository', tomlAssignmentLines('repository', String(params.repository || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'musicServer', tomlAssignmentLines('musicServer', String(params.musicServer || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'musicId', tomlAssignmentLines('musicId', String(params.musicId || ''), '  '));

    replaceTomlKeyBlock(lines, 'params', 'description', tomlAssignmentLines('description', String(params.description || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'keywords', tomlAssignmentLines('keywords', String(params.keywords || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'og_title', tomlAssignmentLines('og_title', String(params.og_title || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'og_description', tomlAssignmentLines('og_description', String(params.og_description || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'og_image', tomlAssignmentLines('og_image', String(params.og_image || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'og_url', tomlAssignmentLines('og_url', String(params.og_url || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'twitter_title', tomlAssignmentLines('twitter_title', String(params.twitter_title || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'twitter_description', tomlAssignmentLines('twitter_description', String(params.twitter_description || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'twitter_image', tomlAssignmentLines('twitter_image', String(params.twitter_image || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'enablePreLoad', tomlAssignmentLines('enablePreLoad', Boolean(params.enablePreLoad), '  '));
    replaceTomlKeyBlock(lines, 'params', 'textPreLoad', tomlAssignmentLines('textPreLoad', String(params.textPreLoad || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'logosPath', tomlAssignmentLines('logosPath', String(params.logosPath || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'defaultLogo', tomlAssignmentLines('defaultLogo', String(params.defaultLogo || ''), '  '));
    replaceTomlKeyBlock(lines, 'params', 'nightMode', tomlAssignmentLines('nightMode', Boolean(params.nightMode), '  '));
    replaceTomlKeyBlock(lines, 'params', 'cardListCollapseLimit', tomlAssignmentLines('cardListCollapseLimit', Number(params.cardListCollapseLimit || 0) || 0, '  '));

    replaceTomlKeyBlock(lines, 'params.seo', 'baiduhmid', tomlAssignmentLines('baiduhmid', String(seo.baiduhmid || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.seo', 'baiduSiteVer', tomlAssignmentLines('baiduSiteVer', String(seo.baiduSiteVer || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.seo', 'enable51la', tomlAssignmentLines('enable51la', Boolean(seo.enable51la), '  '));
    replaceTomlKeyBlock(lines, 'params.seo', 'tj51laid', tomlAssignmentLines('tj51laid', String(seo.tj51laid || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.seo', 'tj51lack', tomlAssignmentLines('tj51lack', String(seo.tj51lack || ''), '  '));

    replaceTomlKeyBlock(lines, 'params.cdn', 'fontawesome', tomlAssignmentLines('fontawesome', String(cdn.fontawesome || ''), '  '));

    replaceTomlKeyBlock(lines, 'params.images', 'favicon', tomlAssignmentLines('favicon', String(images.favicon || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.images', 'logoExpandLight', tomlAssignmentLines('logoExpandLight', String(images.logoExpandLight || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.images', 'logoExpandDark', tomlAssignmentLines('logoExpandDark', String(images.logoExpandDark || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.images', 'logoCollapseLight', tomlAssignmentLines('logoCollapseLight', String(images.logoCollapseLight || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.images', 'logoCollapseDark', tomlAssignmentLines('logoCollapseDark', String(images.logoCollapseDark || ''), '  '));

    replaceTomlKeyBlock(lines, 'params.redirect', 'siteName', tomlAssignmentLines('siteName', String(redirect.siteName || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.redirect', 'siteTip', tomlAssignmentLines('siteTip', String(redirect.siteTip || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.redirect', 'leaveTip', tomlAssignmentLines('leaveTip', String(redirect.leaveTip || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.redirect', 'logo', tomlAssignmentLines('logo', String(redirect.logo || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.redirect', 'favicon', tomlAssignmentLines('favicon', String(redirect.favicon || ''), '  '));

    replaceTomlKeyBlock(lines, 'params.footer', 'copyright', tomlAssignmentLines('copyright', String(footer.copyright || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.footer', 'busuanzi', tomlAssignmentLines('busuanzi', Boolean(footer.busuanzi), '  '));
    replaceTomlKeyBlock(lines, 'params.footer', 'enableForceReloadTip', tomlAssignmentLines('enableForceReloadTip', Boolean(footer.enableForceReloadTip), '  '));
    replaceTomlKeyBlock(lines, 'params.footer', 'toggleMenu', formatInlineTableArrayLines('toggleMenu', footer.toggleMenu || [], ['url', 'key', 'icon', 'title', 'target'], '  '));

    replaceTomlKeyBlock(lines, 'params.header', 'heroBadge', tomlAssignmentLines('heroBadge', String(header.heroBadge || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'heroBackdropWord', tomlAssignmentLines('heroBackdropWord', String(header.heroBackdropWord || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'heroTitle', tomlAssignmentLines('heroTitle', String(header.heroTitle || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'heroSubtitle', tomlAssignmentLines('heroSubtitle', String(header.heroSubtitle || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'heroSubnote', tomlAssignmentLines('heroSubnote', String(header.heroSubnote || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'heroCardLabel', tomlAssignmentLines('heroCardLabel', String(header.heroCardLabel || ''), ''));

    replaceTomlKeyBlock(lines, 'params.header', 'heroActions', formatInlineTableArrayLines('heroActions', header.heroActions || [], ['label', 'url', 'icon', 'target'], ''));
    replaceTomlKeyBlock(lines, 'params.header', 'heroStickers', tomlAssignmentLines('heroStickers', Array.isArray(header.heroStickers) ? header.heroStickers : [], ''));
    replaceTomlKeyBlock(lines, 'params.header', 'heroFloatingBadges', tomlAssignmentLines('heroFloatingBadges', Array.isArray(header.heroFloatingBadges) ? header.heroFloatingBadges : [], ''));
    replaceTomlKeyBlock(lines, 'params.header', 'heroHighlights', formatInlineTableArrayLines('heroHighlights', header.heroHighlights || [], ['icon', 'text'], ''));
    replaceTomlKeyBlock(lines, 'params.header', 'heroStats', formatInlineTableArrayLines('heroStats', header.heroStats || [], ['value', 'label'], ''));
    replaceTomlKeyBlock(lines, 'params.header', 'tabs', formatInlineTableArrayLines('tabs', header.tabs || [], ['key', 'icon', 'label', 'iframeHeight', 'iframeWidth', 'iframeUrl', 'html'], ''));

    replaceTomlKeyBlock(lines, 'params.header', 'adList', formatInlineTableArrayLines('adList', header.adList || [], ['img', 'url', 'desc'], ''));
    replaceTomlKeyBlock(lines, 'params.header', 'announcements', formatInlineTableArrayLines('announcements', header.announcements || [], ['url', 'text'], ''));
    replaceTomlKeyBlock(lines, 'params.header', 'rssmergeUrl', tomlAssignmentLines('rssmergeUrl', String(header.rssmergeUrl || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'talkUrl', tomlAssignmentLines('talkUrl', String(header.talkUrl || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'rssApiUrl', tomlAssignmentLines('rssApiUrl', String(header.rssApiUrl || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'exportBookmarksUrl', tomlAssignmentLines('exportBookmarksUrl', String(header.exportBookmarksUrl || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'recentSitesApi', tomlAssignmentLines('recentSitesApi', String(header.recentSitesApi || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'statisticsMode', tomlAssignmentLines('statisticsMode', String(header.statisticsMode || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'serverUrl', tomlAssignmentLines('serverUrl', String(header.serverUrl || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'consoleUrl', tomlAssignmentLines('consoleUrl', String(header.consoleUrl || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'statisticsApi', tomlAssignmentLines('statisticsApi', String(header.statisticsApi || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'searchPlaceholder', tomlAssignmentLines('searchPlaceholder', String(header.searchPlaceholder || ''), ''));
    replaceTomlKeyBlock(lines, 'params.header', 'recentSitesTitle', tomlAssignmentLines('recentSitesTitle', String(header.recentSitesTitle || ''), ''));

    replaceTomlKeyBlock(lines, 'params.bilibili', 'mediaId', tomlAssignmentLines('mediaId', String(bilibili.mediaId || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.bilibili', 'iframeUrl', tomlAssignmentLines('iframeUrl', String(bilibili.iframeUrl || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.bilibili', 'width', tomlAssignmentLines('width', String(bilibili.width || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.bilibili', 'height', tomlAssignmentLines('height', String(bilibili.height || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.bilibili', 'iframeWidth', tomlAssignmentLines('iframeWidth', String(bilibili.iframeWidth || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.bilibili', 'iframeHeight', tomlAssignmentLines('iframeHeight', String(bilibili.iframeHeight || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.bilibili', 'iframeStyle', tomlAssignmentLines('iframeStyle', String(bilibili.iframeStyle || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.bilibili', 'iframeLoading', tomlAssignmentLines('iframeLoading', String(bilibili.iframeLoading || ''), '  '));

    replaceTomlKeyBlock(lines, 'params.ai', 'enable', tomlAssignmentLines('enable', Boolean(ai.enable), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'iconUrl', tomlAssignmentLines('iconUrl', String(ai.iconUrl || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'buttonIconUrl', tomlAssignmentLines('buttonIconUrl', String(ai.buttonIconUrl || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'panelIconUrl', tomlAssignmentLines('panelIconUrl', String(ai.panelIconUrl || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'panelHeaderTitle', tomlAssignmentLines('panelHeaderTitle', String(ai.panelHeaderTitle || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'assistantAvatarUrl', tomlAssignmentLines('assistantAvatarUrl', String(ai.assistantAvatarUrl || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'userAvatarUrl', tomlAssignmentLines('userAvatarUrl', String(ai.userAvatarUrl || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'assistantAvatarLabel', tomlAssignmentLines('assistantAvatarLabel', String(ai.assistantAvatarLabel || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'userAvatarLabel', tomlAssignmentLines('userAvatarLabel', String(ai.userAvatarLabel || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'apiUrl', tomlAssignmentLines('apiUrl', String(ai.apiUrl || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'apiKey', tomlAssignmentLines('apiKey', '', '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'model', tomlAssignmentLines('model', String(ai.model || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'mcpUrl', tomlAssignmentLines('mcpUrl', String(ai.mcpUrl || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'mcpSearchUrl', tomlAssignmentLines('mcpSearchUrl', String(ai.mcpSearchUrl || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'enableMcp', tomlAssignmentLines('enableMcp', Boolean(ai.enableMcp), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'enableLocalSearch', tomlAssignmentLines('enableLocalSearch', Boolean(ai.enableLocalSearch), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'searchMode', tomlAssignmentLines('searchMode', String(ai.searchMode || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'enableThinking', tomlAssignmentLines('enableThinking', Boolean(ai.enableThinking), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'maxTokens', tomlAssignmentLines('maxTokens', Number(ai.maxTokens || 0) || 0, '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'temperature', tomlAssignmentLines('temperature', Number(ai.temperature || 0) || 0, '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'systemPrompt', tomlAssignmentLines('systemPrompt', String(ai.systemPrompt || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'placeholder', tomlAssignmentLines('placeholder', String(ai.placeholder || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'welcomeTitle', tomlAssignmentLines('welcomeTitle', String(ai.welcomeTitle || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.ai', 'welcomeText', tomlAssignmentLines('welcomeText', String(ai.welcomeText || ''), '  '));

    replaceTomlKeyBlock(lines, 'params.bookmarks', 'title', tomlAssignmentLines('title', String(bookmarks.title || ''), '  '));
    replaceTomlKeyBlock(lines, 'params.hotApi', 'endpoints', tomlAssignmentLines('endpoints', Array.isArray(hotApi.endpoints) ? hotApi.endpoints : [], ''));

    const welcomeTips = Array.isArray(ai.welcomeTips) ? ai.welcomeTips : [];
    const wtLines = [];
    welcomeTips.forEach((it) => {
        const label = it && it.label ? String(it.label).trim() : '';
        const q = it && it.q ? String(it.q).trim() : '';
        if (!label && !q) return;
        wtLines.push('  [[params.ai.welcomeTips]]');
        if (label) wtLines.push(`    label = ${tomlLiteral(label)}`);
        if (q) wtLines.push(`    q = ${tomlLiteral(q)}`);
    });
    replaceTomlArrayOfTables(lines, 'params.ai.welcomeTips', wtLines);

    const hotItems = Array.isArray(hot.items) ? hot.items : [];
    const hiLines = [];
    hotItems.forEach((it) => {
        const id = it && it.id ? String(it.id).trim() : '';
        const title = it && it.title ? String(it.title).trim() : '';
        const icon = it && it.icon ? String(it.icon).trim() : '';
        const color = it && it.color ? String(it.color).trim() : '';
        if (!id && !title && !icon && !color) return;
        hiLines.push('  [[params.header.hotlist.items]]');
        if (id) hiLines.push(`    id = ${tomlLiteral(id)}`);
        if (title) hiLines.push(`    title = ${tomlLiteral(title)}`);
        if (icon) hiLines.push(`    icon = ${tomlLiteral(icon)}`);
        if (color) hiLines.push(`    color = ${tomlLiteral(color)}`);
    });
    replaceTomlArrayOfTables(lines, 'params.header.hotlist.items', hiLines);

    return `${lines.join('\n')}\n`;
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

const invalidAutoState = {
    timer: null,
    running: false,
    lastRunAt: null,
    lastError: '',
    lastResult: null
};

function getInvalidCheckAutoEnabled() {
    if (serverSettings && typeof serverSettings === 'object' && serverSettings.invalidCheckAutoEnabled !== undefined) {
        return Boolean(serverSettings.invalidCheckAutoEnabled);
    }
    return parseBooleanEnv('INVALID_CHECK_AUTO');
}

function getInvalidCheckIntervalMinutes() {
    if (serverSettings && typeof serverSettings === 'object' && serverSettings.invalidCheckIntervalMinutes !== undefined) {
        const v = Number(serverSettings.invalidCheckIntervalMinutes);
        if (Number.isFinite(v) && v > 0) return v;
    }
    const env = Number(process.env.INVALID_CHECK_INTERVAL_MINUTES || 0);
    if (Number.isFinite(env) && env > 0) return env;
    return 1440;
}

function getInvalidCheckAutoFilename() {
    const fromSettings = serverSettings && typeof serverSettings === 'object' && serverSettings.invalidCheckFilename !== undefined
        ? String(serverSettings.invalidCheckFilename || '').trim()
        : '';
    const fromEnv = String(process.env.INVALID_CHECK_FILENAME || '').trim();
    const picked = fromSettings || fromEnv || defaultWebstackFilename();
    const safe = normalizeDataFilename(picked);
    return safe || defaultWebstackFilename();
}

async function runInvalidCheckAutoOnce(reason) {
    if (invalidAutoState.running) return invalidAutoState.lastResult;
    invalidAutoState.running = true;
    invalidAutoState.lastError = '';
    try {
        const filename = getInvalidCheckAutoFilename();
        let offset = 0;
        const limit = 200;
        let checkedCount = 0;
        let skippedCount = 0;
        let removedCount = 0;
        let totalLinks = 0;
        let batches = 0;
        while (true) {
            const r = await runInvalidLinksCheckBatch({ filename, limit, offset, by: 'auto' });
            batches += 1;
            totalLinks = Number(r.totalLinks || 0) || totalLinks;
            checkedCount += Number(r.checkedCount || 0) || 0;
            skippedCount += Number(r.skippedCount || 0) || 0;
            removedCount += Number(r.removedCount || 0) || 0;
            offset = Number(r.nextOffset || 0) || 0;
            if (!r.hasMore) break;
        }
        invalidAutoState.lastRunAt = new Date().toISOString();
        invalidAutoState.lastResult = {
            reason: String(reason || ''),
            filename,
            totalLinks,
            checkedCount,
            skippedCount,
            removedCount,
            batches,
            at: invalidAutoState.lastRunAt
        };
        return invalidAutoState.lastResult;
    } catch (e) {
        invalidAutoState.lastRunAt = new Date().toISOString();
        invalidAutoState.lastError = e && e.message ? String(e.message) : String(e);
        throw e;
    } finally {
        invalidAutoState.running = false;
    }
}

function refreshInvalidCheckAutoTimer() {
    try {
        if (invalidAutoState.timer) clearInterval(invalidAutoState.timer);
    } catch {}
    invalidAutoState.timer = null;
    if (!getInvalidCheckAutoEnabled()) return;
    const minutes = getInvalidCheckIntervalMinutes();
    const intervalMs = Math.max(60 * 1000, Math.min(minutes * 60 * 1000, 365 * 24 * 60 * 60 * 1000));
    invalidAutoState.timer = setInterval(() => {
        runInvalidCheckAutoOnce('timer').catch((e) => {
            console.error('自动失效检测失败:', e && e.message ? e.message : e);
        });
    }, intervalMs);
    if (invalidAutoState.timer && typeof invalidAutoState.timer.unref === 'function') invalidAutoState.timer.unref();
}

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

const _syncState = {
    dirty: false,
    changes: [],
    backups: [],
    running: false,
    lastRunAt: null,
    lastError: '',
    lastResult: null
};
let _syncInFlight = null;
const SYNC_BACKUP_DIR = path.resolve(baseDir, '.yaml-server-sync-backup');

function isAutoSyncEnabled() {
    if (serverSettings && typeof serverSettings === 'object' && serverSettings.autoSync !== undefined) {
        return Boolean(serverSettings.autoSync);
    }
    return AUTO_SYNC_ENV_DEFAULT;
}

function safeBackupPathTarget(absPath) {
    const p = path.resolve(String(absPath || ''));
    if (!p) return '';
    const base = path.resolve(baseDir);
    if (p === base || p.startsWith(`${base}${path.sep}`)) return p;
    return '';
}

function ensureBackupForFile(absPath) {
    const safeAbs = safeBackupPathTarget(absPath);
    if (!safeAbs) return null;
    const list = Array.isArray(_syncState.backups) ? _syncState.backups : [];
    if (list.some((b) => b && String(b.absPath) === safeAbs)) return list.find((b) => b && String(b.absPath) === safeAbs) || null;

    const existed = (() => {
        try { return fs.existsSync(safeAbs) && fs.statSync(safeAbs).isFile(); } catch { return false; }
    })();
    const id = crypto.createHash('sha256').update(safeAbs).digest('hex').slice(0, 24);
    const backupFile = path.join(SYNC_BACKUP_DIR, `${id}.bak`);

    try {
        if (!fs.existsSync(SYNC_BACKUP_DIR)) fs.mkdirSync(SYNC_BACKUP_DIR, { recursive: true });
        if (existed) {
            const buf = fs.readFileSync(safeAbs);
            fs.writeFileSync(backupFile, buf);
        }
    } catch {
        return null;
    }

    const entry = { id, absPath: safeAbs, backupFile, existed };
    _syncState.backups = [entry, ...(list || [])].slice(0, 2000);
    return entry;
}

function clearSyncBackups() {
    const list = Array.isArray(_syncState.backups) ? _syncState.backups : [];
    list.forEach((b) => {
        if (!b || !b.backupFile) return;
        try { if (fs.existsSync(b.backupFile)) fs.unlinkSync(b.backupFile); } catch {}
    });
    _syncState.backups = [];
    try {
        if (fs.existsSync(SYNC_BACKUP_DIR)) {
            const rest = fs.readdirSync(SYNC_BACKUP_DIR);
            if (!rest || rest.length === 0) fs.rmdirSync(SYNC_BACKUP_DIR);
        }
    } catch {}
}

function ensureBackupsForChange(change) {
    const c = change && typeof change === 'object' ? change : {};
    const filename = String(c.filename || '').trim();

    if (filename === 'data/*') {
        const dataDir = path.resolve(baseDir, 'data');
        try {
            const ents = fs.readdirSync(dataDir, { withFileTypes: true });
            ents.forEach((ent) => {
                if (!ent || !ent.isFile()) return;
                const name = String(ent.name || '');
                const lower = name.toLowerCase();
                if (!lower.endsWith('.yml') && !lower.endsWith('.yaml')) return;
                ensureBackupForFile(path.join(dataDir, name));
            });
        } catch {}
        return;
    }

    if (filename === 'config.toml') {
        ensureBackupForFile(path.resolve(baseDir, 'config.toml'));
        return;
    }

    if (filename === 'server_settings.json') {
        ensureBackupForFile(serverSettingsFilePath);
        return;
    }

    if (/\.ya?ml$/i.test(filename)) {
        ensureBackupForFile(path.resolve(baseDir, 'data', filename));
        return;
    }

    const contentDir = path.resolve(baseDir, 'content');
    const candContent = safeResolveWithinDir(contentDir, filename);
    if (candContent) {
        ensureBackupForFile(candContent);
        return;
    }

    const candBase = safeResolveWithinDir(path.resolve(baseDir), filename);
    if (candBase) ensureBackupForFile(candBase);
}

function recordPendingChange(change) {
    const c = change && typeof change === 'object' ? change : {};
    const entry = {
        id: crypto.randomBytes(8).toString('hex'),
        at: new Date().toISOString(),
        action: String(c.action || 'update'),
        filename: String(c.filename || ''),
        title: String(c.title || ''),
        by: String(c.by || '')
    };
    _syncState.dirty = true;
    _syncState.changes = [entry, ...(_syncState.changes || [])].slice(0, 200);
}

function clearPendingChanges() {
    _syncState.dirty = false;
    _syncState.changes = [];
}

function execPromise(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                const err = new Error(error && error.message ? error.message : '命令执行失败');
                err.stdout = stdout;
                err.stderr = stderr;
                return reject(err);
            }
            resolve({ stdout, stderr });
        });
    });
}

async function runUpdateMechanism(update) {
    const action = update && update.action ? String(update.action) : 'update';
    const filename = update && update.filename ? String(update.filename) : '';
    const title = update && update.title ? String(update.title) : '';

    if (isGithubDataSource()) {
        if (REMOTE_UPDATE_WEBHOOK) {
            await axios.post(REMOTE_UPDATE_WEBHOOK, { action, filename, title });
            return { mode: 'remote_webhook', action, filename, title };
        }
        return { mode: 'none', action, filename, title };
    }

    if (ENABLE_HUGO) {
        exec(`cd ${shellEscape(baseDir)} && hugo`, (error, stdout) => {
            if (error) console.error(`执行 hugo 时出错: ${error.message}`);
            else console.log(`hugo 命令输出: ${stdout}`);
        });
        return { mode: 'hugo', action, filename, title };
    }

    const script = path.resolve(__dirname, 'trigger_hugo.sh');
    if (fs.existsSync(script)) {
        exec(`sh ${shellEscape(script)} ${shellEscape(action)} ${shellEscape(filename)} ${shellEscape(title)}`, (error, stdout) => {
            if (error) console.error(`执行 trigger_hugo.sh 时出错: ${error.message}`);
            else console.log(`trigger_hugo.sh 命令输出: ${stdout}`);
        });
        return { mode: 'trigger_hugo.sh', action, filename, title };
    }

    if (REMOTE_UPDATE_WEBHOOK) {
        await axios.post(REMOTE_UPDATE_WEBHOOK, { action, filename, title });
        return { mode: 'remote_webhook', action, filename, title };
    }

    return { mode: 'none', action, filename, title };
}

async function runGitSync() {
    const dir = path.resolve(GIT_SYNC_DIR || baseDir);
    const remote = GIT_SYNC_REMOTE;
    const branch = GIT_SYNC_BRANCH;
    const msg = GIT_SYNC_MESSAGE;

    await execPromise(`cd ${shellEscape(dir)} && git rev-parse --is-inside-work-tree`);
    const st = await execPromise(`cd ${shellEscape(dir)} && git status --porcelain`);
    const changed = String(st && st.stdout ? st.stdout : '').trim();
    if (!changed) return { mode: 'git', dir, changed: false, committed: false, pushed: false };

    await execPromise(`cd ${shellEscape(dir)} && git add -A`);
    await execPromise(`cd ${shellEscape(dir)} && git commit -m ${shellEscape(msg)}`);

    if (branch) {
        await execPromise(`cd ${shellEscape(dir)} && git push ${shellEscape(remote)} ${shellEscape(branch)}`);
    } else {
        await execPromise(`cd ${shellEscape(dir)} && git push ${shellEscape(remote)}`);
    }
    return { mode: 'git', dir, changed: true, committed: true, pushed: true, remote, branch: branch || null };
}

async function runSyncNow(reason) {
    if (_syncInFlight) return _syncInFlight;
    _syncInFlight = (async () => {
        _syncState.running = true;
        _syncState.lastError = '';
        try {
            const latest = (_syncState.changes && _syncState.changes[0]) ? _syncState.changes[0] : { action: 'update', filename: '', title: '' };
            const result = GIT_SYNC_ENABLED
                ? await runGitSync()
                : await runUpdateMechanism({ action: latest.action || 'update', filename: latest.filename || '', title: latest.title || '' });
            _syncState.lastRunAt = new Date().toISOString();
            _syncState.lastResult = { reason: String(reason || ''), ...result };
            clearPendingChanges();
            clearSyncBackups();
            return _syncState.lastResult;
        } catch (e) {
            _syncState.lastRunAt = new Date().toISOString();
            _syncState.lastError = e && e.message ? String(e.message) : String(e);
            throw e;
        } finally {
            _syncState.running = false;
            _syncInFlight = null;
        }
    })();
    return _syncInFlight;
}

function recordAndMaybeAutoSync(change) {
    ensureBackupsForChange(change);
    recordPendingChange(change);
    if (!isAutoSyncEnabled()) return;
    runSyncNow('auto').catch((e) => {
        console.error('自动同步失败:', e && e.message ? e.message : e);
    });
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
refreshInvalidCheckAutoTimer();

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

function invalidLinksMdRelPath() {
    try {
        const rel = path.relative(baseDir, invalidLinksMdFilePath);
        return String(rel || '').replace(/\\/g, '/');
    } catch {
        return 'content/invalidlinks.md';
    }
}

async function runInvalidLinksCheckBatch(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const filenameRaw = o.filename !== undefined ? String(o.filename || '') : '';
    const filename = normalizeDataFilename(filenameRaw);
    if (!filename) throw new Error('无效的文件名');
    const by = o.by !== undefined ? String(o.by || '') : '';

    const limitRaw = o.limit !== undefined ? Number(o.limit) : 40;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 40;
    const offsetRaw = o.offset !== undefined ? Number(o.offset) : 0;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    const loaded = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(loaded && loaded.data) ? loaded.data : [];
    if (!Array.isArray(yamlData)) throw new Error('数据格式不正确');

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

        await writeYamlArrayToFile(loaded.absolutePath, yamlData, `Remove invalid links from ${filename}`);
        recordAndMaybeAutoSync({ action: 'update', filename, title: 'invalid-links', by });

        if (removedCount > 0) {
            try { ensureBackupForFile(invalidLinksMdFilePath); } catch {}
            appendInvalidLinksMd(removedItems);
            recordAndMaybeAutoSync({ action: 'update', filename: invalidLinksMdRelPath(), title: 'invalidlinks.md', by });
        }
    }

    const nextOffset = offset + limit;
    const hasMore = nextOffset < totalLinks;

    if (!hasMore) {
        try { updateInvalidLinksMdLastChecked(new Date()); } catch (e) {}
        try { ensureBackupForFile(invalidLinksMdFilePath); } catch {}
        recordAndMaybeAutoSync({ action: 'update', filename: invalidLinksMdRelPath(), title: 'invalidlinks.md', by });
    }

    return {
        checkedCount,
        skippedCount,
        concurrency: invalidCheckConcurrency,
        timeoutMs: invalidCheckTimeoutMs,
        removedCount,
        threshold: invalid404Threshold,
        reportFile: invalidLinksMdFilePath,
        reportRel: invalidLinksMdRelPath(),
        removedItems,
        totalLinks,
        hasMore,
        nextOffset
    };
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

app.get('/admin', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderConsoleHtml());
});

app.get('/admin/*', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderConsoleHtml());
});

app.get('/console', (req, res) => {
    res.redirect(302, '/admin');
});

app.get('/console/*', (req, res) => {
    const rest = String(req.path || '').replace(/^\/console/, '') || '';
    const target = `/admin${rest}${req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
    res.redirect(302, target);
});

app.post('/api/auth/login', (req, res) => {
    ensureConsoleBootstrap();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '').trim();
    if (!username || !password) return res.status(400).json({ message: '用户名或密码不能为空' });
    const users = normalizeConsoleUsers();
    let user = users.find((u) => String(u.username) === username);
    const apiTokenLogin = username === 'admin' && API_TOKEN && password === API_TOKEN;
    if (!user) {
        if (!apiTokenLogin) return res.status(401).json({ message: '用户名或密码错误' });
        user = {
            id: crypto.randomBytes(8).toString('hex'),
            username: 'admin',
            isAdmin: true,
            password: hashPassword(password),
            createdAt: new Date().toISOString()
        };
        serverSettingsMerge({ consoleUsers: [...users, user] });
    } else if (!verifyPassword(password, user.password)) {
        if (!apiTokenLogin) return res.status(401).json({ message: '用户名或密码错误' });
        const nextUsers = users.map((u) => {
            if (String(u.id) !== String(user.id)) return u;
            return { ...u, isAdmin: true, password: hashPassword(password) };
        });
        serverSettingsMerge({ consoleUsers: nextUsers });
        user = nextUsers.find((u) => String(u.id) === String(user.id)) || user;
    }
    const ttlMs = Math.max(5 * 60 * 1000, Math.min(Number(process.env.CONSOLE_TOKEN_TTL_MS || 7 * 24 * 60 * 60 * 1000) || 7 * 24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000));
    const token = signConsoleToken({
        sub: user.id,
        username: user.username,
        isAdmin: Boolean(user.isAdmin),
        exp: Date.now() + ttlMs
    });
    res.json({ user: { id: user.id, username: user.username, isAdmin: Boolean(user.isAdmin) }, token });
});

app.post('/api/auth/logout', (req, res) => {
    res.json({ ok: true });
});

app.get('/api/auth/me', requireConsoleAuth, (req, res) => {
    res.json({ user: req.consoleUser });
});

app.get('/api/yaml-files', requireConsoleAuth, async (req, res) => {
    const kindWanted = String(req.query.kind || 'webstack').trim().toLowerCase();
    try {
        const names = isGithubDataSource()
            ? await githubListYamlFiles()
            : (() => {
                const basePath = path.resolve(baseDir, 'data');
                let entries = [];
                try { entries = fs.readdirSync(basePath, { withFileTypes: true }); } catch { return []; }
                return entries
                    .filter((ent) => ent && ent.isFile && ent.isFile())
                    .map((ent) => String(ent.name || ''))
                    .filter((n) => /\.ya?ml$/i.test(n));
            })();

        const files = names.map((name) => {
            const safe = normalizeDataFilename(name) || String(name || '').trim();
            const kind = detectYamlKind(safe, []);
            return { name: safe, kind };
        }).filter((x) => x && x.name);

        const filtered = (kindWanted && kindWanted !== 'all')
            ? files.filter((f) => String(f.kind) === kindWanted)
            : files;

        filtered.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
        res.json({ files: filtered });
    } catch (e) {
        res.json({ files: [], error: e && e.message ? String(e.message) : '读取失败' });
    }
});

app.get('/api/auth/users', requireConsoleAdmin, (req, res) => {
    const users = normalizeConsoleUsers();
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const pageSize = Math.max(1, Math.min(Number(req.query.pageSize || 20) || 20, 200));
    const start = (page - 1) * pageSize;
    const slice = users.slice(start, start + pageSize).map((u) => ({ id: u.id, username: u.username, isAdmin: Boolean(u.isAdmin), createdAt: u.createdAt || null }));
    res.json({ users: slice, total: users.length });
});

app.post('/api/auth/register', requireConsoleAdmin, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '').trim();
    const isAdmin = Boolean(body.isAdmin);
    if (!username || !password) return res.status(400).json({ message: '用户名或密码不能为空' });
    const users = normalizeConsoleUsers();
    if (users.some((u) => String(u.username) === username)) return res.status(409).json({ message: '用户名已存在' });
    const nextUser = { id: crypto.randomBytes(8).toString('hex'), username, isAdmin, password: hashPassword(password), createdAt: new Date().toISOString() };
    serverSettingsMerge({ consoleUsers: [...users, nextUser] });
    res.json({ ok: true });
});

app.post('/api/auth/update-password', requireConsoleAdmin, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const userId = String(body.userId || '').trim();
    const newPassword = String(body.newPassword || '').trim();
    if (!userId || !newPassword) return res.status(400).json({ message: '参数不完整' });
    const users = normalizeConsoleUsers();
    const idx = users.findIndex((u) => String(u.id) === userId);
    if (idx < 0) return res.status(404).json({ message: '用户不存在' });
    const updated = { ...users[idx], password: hashPassword(newPassword) };
    const next = [...users];
    next[idx] = updated;
    serverSettingsMerge({ consoleUsers: next });
    res.json({ ok: true });
});

app.post('/api/auth/delete/:id', requireConsoleAdmin, (req, res) => {
    const id = String(req.params.id || '').trim();
    const users = normalizeConsoleUsers();
    const next = users.filter((u) => String(u.id) !== id);
    if (next.length === users.length) return res.status(404).json({ message: '用户不存在' });
    serverSettingsMerge({ consoleUsers: next });
    res.json({ ok: true });
});

const webhookLogMax = Math.max(50, Math.min(Number(process.env.WEBHOOK_LOG_MAX || 300) || 300, 2000));
const webhookLogTtlDays = Math.max(0, Math.min(Number(process.env.WEBHOOK_LOG_TTL_DAYS || 30) || 30, 3650));
let webhookLogs = Array.isArray(serverSettings && serverSettings.webhookLogs) ? serverSettings.webhookLogs : [];
if (!Array.isArray(webhookLogs)) webhookLogs = [];

function pruneWebhookLogs() {
    const list0 = Array.isArray(webhookLogs) ? webhookLogs : [];
    const ttlMs = webhookLogTtlDays > 0 ? webhookLogTtlDays * 24 * 60 * 60 * 1000 : 0;
    const now = Date.now();
    const keepByTime = ttlMs
        ? list0.filter((x) => {
            const at = x && x.at ? Date.parse(String(x.at)) : 0;
            if (!Number.isFinite(at) || at <= 0) return true;
            return (now - at) <= ttlMs;
        })
        : list0;
    const next = keepByTime.slice(0, webhookLogMax);
    webhookLogs = next;
    serverSettingsMerge({ webhookLogs: next });
    return next;
}

const _webhookLogPruneTimer = setInterval(() => {
    try { pruneWebhookLogs(); } catch {}
}, 60 * 60 * 1000);
if (_webhookLogPruneTimer && typeof _webhookLogPruneTimer.unref === 'function') _webhookLogPruneTimer.unref();

function appendWebhookLog(entry) {
    const e = entry && typeof entry === 'object' ? entry : {};
    const next = [{ id: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString(), ...e }, ...webhookLogs].slice(0, webhookLogMax);
    webhookLogs = next;
    serverSettingsMerge({ webhookLogs: next });
    pruneWebhookLogs();
}

app.get('/api/webhook/logs', verifyApiTokenOrConsoleAdmin, (req, res) => {
    pruneWebhookLogs();
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const pageSize = Math.max(1, Math.min(Number(req.query.pageSize || 20) || 20, 200));
    const q = String(req.query.q || '').trim().toLowerCase();
    const filtered = q
        ? webhookLogs.filter((x) => JSON.stringify(x || {}).toLowerCase().includes(q))
        : webhookLogs;
    const start = (page - 1) * pageSize;
    res.json({ logs: filtered.slice(start, start + pageSize), total: filtered.length, max: webhookLogMax, ttlDays: webhookLogTtlDays });
});

app.post('/api/webhook/logs/clear', verifyApiTokenOrConsoleAdmin, (req, res) => {
    webhookLogs = [];
    serverSettingsMerge({ webhookLogs: [] });
    res.json({ ok: true });
});

app.post('/api/webhook/update-ports', verifyApiTokenOrConsoleAdmin, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const luckyIp = String(body.luckyIp || body.ip || '').trim();
    const luckyPort = String(body.luckyPort || body.port || '').trim();
    const updatedAt = new Date().toISOString();
    serverSettingsMerge({ luckyNetwork: { luckyIp, luckyPort, updatedAt } });
    appendWebhookLog({ type: 'update-ports', luckyIp, luckyPort });
    res.json({ ok: true });
});

app.get('/api/network/resolve', (req, res) => {
    const n = serverSettings && serverSettings.luckyNetwork && typeof serverSettings.luckyNetwork === 'object' ? serverSettings.luckyNetwork : {};
    res.json({ luckyIp: String(n.luckyIp || ''), luckyPort: String(n.luckyPort || ''), updatedAt: n.updatedAt || null });
});

async function loadYamlArrayFromDataFile(filename) {
    const name = normalizeDataFilename(filename);
    if (!name) throw new Error('无效的文件路径');

    if (isGithubDataSource()) {
        const got = await githubGetFile(name);
        const raw = got && got.exists ? String(got.content || '') : '';
        const parsed = raw && raw.trim() ? (yaml.load(raw) || []) : [];
        if (!Array.isArray(parsed)) throw new Error('数据顶层结构必须为数组');
        return { absolutePath: { type: 'github', filename: name, sha: got && got.sha ? String(got.sha) : null }, data: parsed };
    }

    const basePath = path.resolve(baseDir, 'data');
    const safe = safeResolveWithinDir(basePath, name);
    if (!safe) throw new Error('无效的文件路径');
    const raw = fs.existsSync(safe) ? fs.readFileSync(safe, 'utf8') : '';
    const parsed = raw && raw.trim() ? (yaml.load(raw) || []) : [];
    if (!Array.isArray(parsed)) throw new Error('数据顶层结构必须为数组');
    return { absolutePath: safe, data: parsed };
}

async function writeYamlArrayToFile(absolutePath, data, message) {
    const yamlString = '---\n' + yaml.dump(Array.isArray(data) ? data : [], { noRefs: true, lineWidth: -1 });
    if (absolutePath && typeof absolutePath === 'object' && absolutePath.type === 'github') {
        const name = normalizeDataFilename(absolutePath.filename);
        if (!name) throw new Error('filename 无效');
        const sha = absolutePath.sha ? String(absolutePath.sha) : null;
        const result = await githubPutFile(name, yamlString, sha, message || `Update ${name}`);
        absolutePath.sha = result && result.sha ? String(result.sha) : absolutePath.sha;
        return;
    }
    fs.writeFileSync(String(absolutePath || ''), yamlString, 'utf8');
}

function defaultWebstackFilename() {
    return String(process.env.CONSOLE_WEBSTACK_FILE || 'webstack.yml');
}

function buildWebstackCategoryTree(filename, yamlData) {
    const roots = [];
    (yamlData || []).forEach((entry, taxIndex) => {
        if (!entry || !entry.taxonomy) return;
        const rootId = fnv1a32(`${filename}::taxonomy::${taxIndex}`);
        const node = {
            id: rootId,
            name: String(entry.taxonomy),
            en_name: entry.en_name ? String(entry.en_name) : null,
            icon: entry.icon ? String(entry.icon) : null,
            parent_id: null,
            sort_order: taxIndex,
            children: []
        };
        const list = Array.isArray(entry.list) ? entry.list : [];
        list.forEach((termEntry, termIndex) => {
            if (!termEntry || !termEntry.term) return;
            node.children.push({
                id: fnv1a32(`${filename}::term::${taxIndex}::${termIndex}`),
                name: String(termEntry.term),
                en_name: termEntry.en_name ? String(termEntry.en_name) : null,
                icon: termEntry.icon ? String(termEntry.icon) : null,
                parent_id: rootId,
                sort_order: termIndex,
                children: []
            });
        });
        roots.push(node);
    });
    return roots;
}

function findWebstackCategoryById(filename, yamlData, id) {
    for (let taxIndex = 0; taxIndex < (yamlData || []).length; taxIndex++) {
        const entry = yamlData[taxIndex];
        if (!entry || !entry.taxonomy) continue;
        const taxId = fnv1a32(`${filename}::taxonomy::${taxIndex}`);
        if (taxId === id) return { level: 'taxonomy', taxIndex, entry };
        const list = Array.isArray(entry.list) ? entry.list : [];
        for (let termIndex = 0; termIndex < list.length; termIndex++) {
            const termEntry = list[termIndex];
            if (!termEntry || !termEntry.term) continue;
            const termId = fnv1a32(`${filename}::term::${taxIndex}::${termIndex}`);
            if (termId === id) return { level: 'term', taxIndex, termIndex, entry, termEntry };
        }
    }
    return null;
}

function buildWebstackSites(filename, yamlData) {
    const rows = [];
    (yamlData || []).forEach((entry, taxIndex) => {
        if (!entry || !entry.taxonomy) return;
        const taxId = fnv1a32(`${filename}::taxonomy::${taxIndex}`);
        const topLinks = Array.isArray(entry.links) ? entry.links : [];
        topLinks.forEach((link, linkIndex) => {
            if (!link || !link.url || !link.title) return;
            rows.push({
                id: fnv1a32(`${filename}::link::${taxIndex}::links::${linkIndex}`),
                category_id: taxId,
                url: String(link.url),
                backup_url: link.backup_url ? String(link.backup_url) : null,
                internal_url: link.internal_url ? String(link.internal_url) : null,
                logo: link.logo ? String(link.logo) : null,
                title: String(link.title),
                desc: link.description ? String(link.description) : (link.desc ? String(link.desc) : null),
                sort_order: linkIndex,
                is_visible: link.is_visible === undefined ? true : Boolean(link.is_visible),
                update_port_enabled: link.update_port_enabled === undefined ? true : Boolean(link.update_port_enabled)
            });
        });
        const list = Array.isArray(entry.list) ? entry.list : [];
        list.forEach((termEntry, termIndex) => {
            if (!termEntry || !termEntry.term) return;
            const termId = fnv1a32(`${filename}::term::${taxIndex}::${termIndex}`);
            const termLinks = Array.isArray(termEntry.links) ? termEntry.links : [];
            termLinks.forEach((link, linkIndex) => {
                if (!link || !link.url || !link.title) return;
                rows.push({
                    id: fnv1a32(`${filename}::link::${taxIndex}::list::${termIndex}::${linkIndex}`),
                    category_id: termId,
                    url: String(link.url),
                    backup_url: link.backup_url ? String(link.backup_url) : null,
                    internal_url: link.internal_url ? String(link.internal_url) : null,
                    logo: link.logo ? String(link.logo) : null,
                    title: String(link.title),
                    desc: link.description ? String(link.description) : (link.desc ? String(link.desc) : null),
                    sort_order: linkIndex,
                    is_visible: link.is_visible === undefined ? true : Boolean(link.is_visible),
                    update_port_enabled: link.update_port_enabled === undefined ? true : Boolean(link.update_port_enabled)
                });
            });
        });
    });
    return rows;
}

function findWebstackSiteById(filename, yamlData, siteId) {
    for (let taxIndex = 0; taxIndex < (yamlData || []).length; taxIndex++) {
        const entry = yamlData[taxIndex];
        if (!entry || !entry.taxonomy) continue;
        const topLinks = Array.isArray(entry.links) ? entry.links : [];
        for (let linkIndex = 0; linkIndex < topLinks.length; linkIndex++) {
            const id = fnv1a32(`${filename}::link::${taxIndex}::links::${linkIndex}`);
            if (id === siteId) return { level: 'taxonomy', taxIndex, linkIndex, entry, link: topLinks[linkIndex] };
        }
        const list = Array.isArray(entry.list) ? entry.list : [];
        for (let termIndex = 0; termIndex < list.length; termIndex++) {
            const termEntry = list[termIndex];
            const termLinks = termEntry && Array.isArray(termEntry.links) ? termEntry.links : [];
            for (let linkIndex = 0; linkIndex < termLinks.length; linkIndex++) {
                const id = fnv1a32(`${filename}::link::${taxIndex}::list::${termIndex}::${linkIndex}`);
                if (id === siteId) return { level: 'term', taxIndex, termIndex, linkIndex, entry, termEntry, link: termLinks[linkIndex] };
            }
        }
    }
    return null;
}

function moveArrayItem(arr, fromIndex, toIndex) {
    const a = Array.isArray(arr) ? arr : [];
    const from = Number(fromIndex);
    const to = Number(toIndex);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return a;
    if (from < 0 || from >= a.length) return a;
    const target = Math.max(0, Math.min(to, a.length - 1));
    if (from === target) return a;
    const next = [...a];
    const [item] = next.splice(from, 1);
    next.splice(target, 0, item);
    return next;
}

app.get('/api/categories', requireConsoleAuth, async (req, res) => {
    try {
        const filename = String(req.query.filename || defaultWebstackFilename());
        const { data } = await loadYamlArrayFromDataFile(filename);
        const kind = detectYamlKind(filename, data);
        if (kind !== 'webstack') return res.status(400).json({ message: '当前数据源不支持分类管理' });
        res.json(buildWebstackCategoryTree(filename, data));
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '读取失败' });
    }
});

app.get('/api/categories/flat', requireConsoleAuth, async (req, res) => {
    try {
        const filename = String(req.query.filename || defaultWebstackFilename());
        const { data } = await loadYamlArrayFromDataFile(filename);
        const kind = detectYamlKind(filename, data);
        if (kind !== 'webstack') return res.status(400).json({ message: '当前数据源不支持分类管理' });
        const tree = buildWebstackCategoryTree(filename, data);
        const flat = [];
        const walk = (nodes) => {
            (nodes || []).forEach((n) => {
                flat.push({ id: n.id, name: n.name, parent_id: n.parent_id, sort_order: n.sort_order });
                if (n.children && n.children.length) walk(n.children);
            });
        };
        walk(tree);
        res.json(flat);
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '读取失败' });
    }
});

app.post('/api/categories/reorder', requireConsoleAdmin, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const filename = String(body.filename || defaultWebstackFilename());
        const parentId = body.parent_id === null || body.parent_id === undefined || body.parent_id === '' ? null : Number(body.parent_id);
        const categoryId = Number(body.category_id);
        const toIndex = Number(body.to_index);
        if (!Number.isFinite(categoryId) || !Number.isFinite(toIndex)) return res.status(400).json({ message: '参数无效' });
        const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
        const yamlData = Array.isArray(data) ? data : [];
        const kind = detectYamlKind(filename, yamlData);
        if (kind !== 'webstack') return res.status(400).json({ message: '当前数据源不支持分类管理' });
        const found = findWebstackCategoryById(filename, yamlData, categoryId);
        if (!found) return res.status(404).json({ message: '分类不存在' });

        if (parentId === null) {
            if (found.level !== 'taxonomy') return res.status(400).json({ message: '只能排序一级分类' });
            const next = moveArrayItem(yamlData, found.taxIndex, toIndex);
            await writeYamlArrayToFile(absolutePath, next, `categories.reorder:${filename}`);
            appendWebhookLog({ type: 'categories.reorder', filename, level: 'taxonomy', id: categoryId, toIndex });
            return res.json({ ok: true });
        }

        if (found.level !== 'term') return res.status(400).json({ message: '只能排序二级分类' });
        const expectedParent = fnv1a32(`${filename}::taxonomy::${found.taxIndex}`);
        if (Number(parentId) !== Number(expectedParent)) return res.status(400).json({ message: '父级分类不匹配' });
        found.entry.list = moveArrayItem(Array.isArray(found.entry.list) ? found.entry.list : [], found.termIndex, toIndex);
        await writeYamlArrayToFile(absolutePath, yamlData, `categories.reorder:${filename}`);
        appendWebhookLog({ type: 'categories.reorder', filename, level: 'term', id: categoryId, toIndex, parentId });
        return res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '保存失败' });
    }
});

app.post('/api/categories', requireConsoleAdmin, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const filename = String(body.filename || defaultWebstackFilename());
        const name = String(body.name || '').trim();
        const parentId = body.parent_id === null || body.parent_id === undefined ? null : Number(body.parent_id);
        const icon = body.icon === null || body.icon === undefined ? null : String(body.icon || '').trim();
        const sortOrder = body.sort_order === null || body.sort_order === undefined ? null : Number(body.sort_order);
        if (!name) return res.status(400).json({ message: '分类名称不能为空' });
        const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
        const yamlData = Array.isArray(data) ? data : [];
        if (parentId === null) {
            const newEntry = { taxonomy: name, icon: icon || '', links: [], list: [] };
            let next = [...yamlData, newEntry];
            if (sortOrder !== null && Number.isFinite(sortOrder)) {
                next = moveArrayItem(next, next.length - 1, sortOrder);
            }
            await writeYamlArrayToFile(absolutePath, next, `categories.create:${filename}`);
            appendWebhookLog({ type: 'categories.create', filename, level: 'taxonomy', name });
            return res.json({ ok: true });
        }
        const found = findWebstackCategoryById(filename, yamlData, parentId);
        if (!found || found.level !== 'taxonomy') return res.status(400).json({ message: '父级分类无效' });
        found.entry.list = Array.isArray(found.entry.list) ? found.entry.list : [];
        found.entry.list.push({ term: name, links: [] });
        if (sortOrder !== null && Number.isFinite(sortOrder)) {
            found.entry.list = moveArrayItem(found.entry.list, found.entry.list.length - 1, sortOrder);
        }
        await writeYamlArrayToFile(absolutePath, yamlData, `categories.create:${filename}`);
        appendWebhookLog({ type: 'categories.create', filename, level: 'term', name, parentId });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '保存失败' });
    }
});

app.post('/api/categories/update/:id', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const id = Number(req.params.id);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || defaultWebstackFilename());
    const name = body.name !== undefined ? String(body.name || '').trim() : '';
    const icon = body.icon === null || body.icon === undefined ? null : String(body.icon || '').trim();
    const sortOrder = body.sort_order === null || body.sort_order === undefined ? null : Number(body.sort_order);
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    const found = findWebstackCategoryById(filename, yamlData, id);
    if (!found) return res.status(404).json({ message: '分类不存在' });
    if (found.level === 'taxonomy') {
        if (name) found.entry.taxonomy = name;
        if (icon !== null) found.entry.icon = icon;
        let next = yamlData;
        if (sortOrder !== null && Number.isFinite(sortOrder)) next = moveArrayItem(yamlData, found.taxIndex, sortOrder);
        await writeYamlArrayToFile(absolutePath, next, `categories.update:${filename}`);
        appendWebhookLog({ type: 'categories.update', filename, level: 'taxonomy', id });
        return res.json({ ok: true });
    }
    if (name) found.termEntry.term = name;
    if (icon !== null) found.termEntry.icon = icon;
    if (sortOrder !== null && Number.isFinite(sortOrder)) {
        found.entry.list = moveArrayItem(Array.isArray(found.entry.list) ? found.entry.list : [], found.termIndex, sortOrder);
    }
    await writeYamlArrayToFile(absolutePath, yamlData, `categories.update:${filename}`);
    appendWebhookLog({ type: 'categories.update', filename, level: 'term', id });
    res.json({ ok: true });
}));

app.post('/api/categories/delete/:id', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const id = Number(req.params.id);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || defaultWebstackFilename());
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    const found = findWebstackCategoryById(filename, yamlData, id);
    if (!found) return res.status(404).json({ message: '分类不存在' });
    if (found.level === 'taxonomy') {
        const next = yamlData.filter((_, idx) => idx !== found.taxIndex);
        await writeYamlArrayToFile(absolutePath, next, `categories.delete:${filename}`);
        appendWebhookLog({ type: 'categories.delete', filename, level: 'taxonomy', id });
        return res.json({ ok: true });
    }
    found.entry.list = (Array.isArray(found.entry.list) ? found.entry.list : []).filter((_, idx) => idx !== found.termIndex);
    await writeYamlArrayToFile(absolutePath, yamlData, `categories.delete:${filename}`);
    appendWebhookLog({ type: 'categories.delete', filename, level: 'term', id });
    res.json({ ok: true });
}));

app.get('/api/sites', requireConsoleAuth, async (req, res) => {
    try {
        const filename = String(req.query.filename || defaultWebstackFilename());
        const { data } = await loadYamlArrayFromDataFile(filename);
        const kind = detectYamlKind(filename, data);
        if (kind !== 'webstack') return res.status(400).json({ message: '当前数据源不支持站点管理' });
        res.json(buildWebstackSites(filename, data));
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '读取失败' });
    }
});

app.get('/api/sites/list', requireConsoleAuth, async (req, res) => {
    try {
        const filename = String(req.query.filename || defaultWebstackFilename());
        const q = String(req.query.q || '').trim().toLowerCase();
        const catRaw = String(req.query.cat || '').trim();
        const catId = catRaw ? Number(catRaw) : 0;
        const pageSizeRaw = req.query.pageSize;
        let pageSize = Number(pageSizeRaw);
        if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = 200;

        const { data } = await loadYamlArrayFromDataFile(filename);
        const kind = detectYamlKind(filename, data);
        if (kind !== 'webstack') return res.status(400).json({ message: '当前数据源不支持站点管理' });
        const categories = buildWebstackCategoryTree(filename, data);
        const catMap = {};
        const catChildrenMap = {};
        const walk = (nodes) => {
            (nodes || []).forEach((n) => {
                const idKey = String(n.id);
                catMap[idKey] = String(n.name || '');
                const children = Array.isArray(n.children) ? n.children : [];
                catChildrenMap[idKey] = children.map((c) => String(c && c.id !== undefined ? c.id : '')).filter(Boolean);
                if (n.children && n.children.length) walk(n.children);
            });
        };
        walk(categories);

        let sites = buildWebstackSites(filename, data);
        if (Number.isFinite(catId) && catId > 0) {
            const allow = new Set();
            const stack = [String(catId)];
            while (stack.length) {
                const cur = stack.pop();
                if (!cur || allow.has(cur)) continue;
                allow.add(cur);
                const kids = catChildrenMap[cur] || [];
                kids.forEach((k) => stack.push(String(k)));
            }
            sites = (sites || []).filter((s) => allow.has(String(s.category_id || '')));
        }
        if (q) {
            sites = (sites || []).filter((s) => {
                const catName = catMap[String(s.category_id || '')] || '';
                const hay = `${String(s.title || '')} ${String(s.url || '')} ${String(s.desc || '')} ${catName}`.toLowerCase();
                return hay.includes(q);
            });
        }
        const paging = paginateArray(sites, { page: req.query.page, pageSize, maxPageSize: 10000 });
        res.json({ filename, q, cat: Number.isFinite(catId) && catId > 0 ? catId : '', ...paging });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '读取失败' });
    }
});

app.get('/api/friendlinks', requireConsoleAuth, async (req, res) => {
    try {
        const filename = String(req.query.filename || 'friendlinks.yml');
        const { data } = await loadYamlArrayFromDataFile(filename);
        const kind = detectYamlKind(filename, data);
        if (kind !== 'friendlinks') return res.status(400).json({ message: '当前数据源不是友链数据' });
        const items = (Array.isArray(data) ? data : []).map((x) => ({
            title: x && x.title ? String(x.title) : '',
            url: x && x.url ? String(x.url) : '',
            description: x && x.description ? String(x.description) : ''
        })).filter((x) => x.url);
        res.json({ filename, items });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '读取失败' });
    }
});

app.post('/api/friendlinks/save', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || 'friendlinks.yml');
    const title = String(body.title || '').trim();
    const url = String(body.url || '').trim();
    const description = String(body.description || '').trim();
    const oldUrl = body.oldUrl ? String(body.oldUrl).trim() : '';
    if (!title || !url) return res.status(400).json({ message: '标题和链接不能为空' });
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    const kind = detectYamlKind(filename, yamlData);
    if (kind !== 'friendlinks') return res.status(400).json({ message: '当前数据源不是友链数据' });
    const key = oldUrl || url;
    const idx = yamlData.findIndex((x) => x && String(x.url || '') === key);
    if (idx >= 0) {
        yamlData[idx].title = title;
        yamlData[idx].url = url;
        yamlData[idx].description = description;
    } else {
        yamlData.push({ title, url, description });
    }
    await writeYamlArrayToFile(absolutePath, yamlData, `friendlinks.save:${filename}`);
    appendWebhookLog({ type: 'friendlinks.save', filename, url });
    res.json({ ok: true });
}));

app.post('/api/friendlinks/delete', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || 'friendlinks.yml');
    const url = String(body.url || '').trim();
    if (!url) return res.status(400).json({ message: '链接不能为空' });
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    const kind = detectYamlKind(filename, yamlData);
    if (kind !== 'friendlinks') return res.status(400).json({ message: '当前数据源不是友链数据' });
    const next = yamlData.filter((x) => !(x && String(x.url || '') === url));
    await writeYamlArrayToFile(absolutePath, next, `friendlinks.delete:${filename}`);
    appendWebhookLog({ type: 'friendlinks.delete', filename, url });
    res.json({ ok: true });
}));

app.post('/api/friendlinks/reorder', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || 'friendlinks.yml');
    const url = String(body.url || '').trim();
    const toIndex = Number(body.toIndex);
    if (!url || !Number.isFinite(toIndex)) return res.status(400).json({ message: '参数无效' });
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    const kind = detectYamlKind(filename, yamlData);
    if (kind !== 'friendlinks') return res.status(400).json({ message: '当前数据源不是友链数据' });
    const fromIndex = yamlData.findIndex((x) => x && String(x.url || '') === url);
    if (fromIndex < 0) return res.status(404).json({ message: '友链不存在' });
    const next = moveArrayItem(yamlData, fromIndex, toIndex);
    await writeYamlArrayToFile(absolutePath, next, `friendlinks.reorder:${filename}`);
    appendWebhookLog({ type: 'friendlinks.reorder', filename, url, toIndex });
    res.json({ ok: true });
}));

app.get('/api/headers', requireConsoleAuth, async (req, res) => {
    try {
        const filename = String(req.query.filename || 'headers.yml');
        const { data } = await loadYamlArrayFromDataFile(filename);
        const kind = detectYamlKind(filename, data);
        if (kind !== 'headers') return res.status(400).json({ message: '当前数据源不是导航数据' });
        res.json({ filename, items: Array.isArray(data) ? data : [] });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '读取失败' });
    }
});

app.post('/api/headers/save-top', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || 'headers.yml');
    const item = String(body.item || '').trim();
    const link = String(body.link || '').trim();
    const icon = String(body.icon || '').trim();
    const oldItem = body.oldItem ? String(body.oldItem).trim() : '';
    if (!item || !link) return res.status(400).json({ message: '名称和链接不能为空' });
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    const kind = detectYamlKind(filename, yamlData);
    if (kind !== 'headers') return res.status(400).json({ message: '当前数据源不是导航数据' });
    const key = oldItem || item;
    const idx = yamlData.findIndex((x) => x && String(x.item || '') === key);
    if (idx >= 0) {
        const keepList = Array.isArray(yamlData[idx].list) ? yamlData[idx].list : undefined;
        yamlData[idx] = { ...(yamlData[idx] || {}), item, link, icon };
        if (keepList !== undefined) yamlData[idx].list = keepList;
    } else {
        yamlData.push({ item, icon, link });
    }
    await writeYamlArrayToFile(absolutePath, yamlData, `headers.saveTop:${filename}`);
    appendWebhookLog({ type: 'headers.saveTop', filename, item });
    res.json({ ok: true });
}));

app.post('/api/headers/delete-top', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || 'headers.yml');
    const item = String(body.item || '').trim();
    if (!item) return res.status(400).json({ message: '名称不能为空' });
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    const kind = detectYamlKind(filename, yamlData);
    if (kind !== 'headers') return res.status(400).json({ message: '当前数据源不是导航数据' });
    const next = yamlData.filter((x) => !(x && String(x.item || '') === item));
    await writeYamlArrayToFile(absolutePath, next, `headers.deleteTop:${filename}`);
    appendWebhookLog({ type: 'headers.deleteTop', filename, item });
    res.json({ ok: true });
}));

app.post('/api/headers/reorder-top', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || 'headers.yml');
    const item = String(body.item || '').trim();
    const toIndex = Number(body.toIndex);
    if (!item || !Number.isFinite(toIndex)) return res.status(400).json({ message: '参数无效' });
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    const kind = detectYamlKind(filename, yamlData);
    if (kind !== 'headers') return res.status(400).json({ message: '当前数据源不是导航数据' });
    const fromIndex = yamlData.findIndex((x) => x && String(x.item || '') === item);
    if (fromIndex < 0) return res.status(404).json({ message: '菜单不存在' });
    const next = moveArrayItem(yamlData, fromIndex, toIndex);
    await writeYamlArrayToFile(absolutePath, next, `headers.reorderTop:${filename}`);
    appendWebhookLog({ type: 'headers.reorderTop', filename, item, toIndex });
    res.json({ ok: true });
}));

app.post('/api/headers/save-sub', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || 'headers.yml');
    const parentItem = String(body.parentItem || '').trim();
    const name = String(body.name || '').trim();
    const url = String(body.url || '').trim();
    const oldName = body.oldName ? String(body.oldName).trim() : '';
    if (!parentItem || !name || !url) return res.status(400).json({ message: '参数不完整' });
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    const kind = detectYamlKind(filename, yamlData);
    if (kind !== 'headers') return res.status(400).json({ message: '当前数据源不是导航数据' });
    const parent = yamlData.find((x) => x && String(x.item || '') === parentItem);
    if (!parent) return res.status(404).json({ message: '父级菜单不存在' });
    parent.list = Array.isArray(parent.list) ? parent.list : [];
    const key = oldName || name;
    const idx = parent.list.findIndex((x) => x && String(x.name || '') === key);
    if (idx >= 0) parent.list[idx] = { ...(parent.list[idx] || {}), name, url };
    else parent.list.push({ name, url });
    await writeYamlArrayToFile(absolutePath, yamlData, `headers.saveSub:${filename}`);
    appendWebhookLog({ type: 'headers.saveSub', filename, parentItem, name });
    res.json({ ok: true });
}));

app.post('/api/headers/delete-sub', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || 'headers.yml');
    const parentItem = String(body.parentItem || '').trim();
    const name = String(body.name || '').trim();
    if (!parentItem || !name) return res.status(400).json({ message: '参数无效' });
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    const kind = detectYamlKind(filename, yamlData);
    if (kind !== 'headers') return res.status(400).json({ message: '当前数据源不是导航数据' });
    const parent = yamlData.find((x) => x && String(x.item || '') === parentItem);
    if (!parent) return res.status(404).json({ message: '父级菜单不存在' });
    parent.list = (Array.isArray(parent.list) ? parent.list : []).filter((x) => !(x && String(x.name || '') === name));
    await writeYamlArrayToFile(absolutePath, yamlData, `headers.deleteSub:${filename}`);
    appendWebhookLog({ type: 'headers.deleteSub', filename, parentItem, name });
    res.json({ ok: true });
}));

app.post('/api/headers/reorder-sub', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || 'headers.yml');
    const parentItem = String(body.parentItem || '').trim();
    const name = String(body.name || '').trim();
    const toIndex = Number(body.toIndex);
    if (!parentItem || !name || !Number.isFinite(toIndex)) return res.status(400).json({ message: '参数无效' });
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    const kind = detectYamlKind(filename, yamlData);
    if (kind !== 'headers') return res.status(400).json({ message: '当前数据源不是导航数据' });
    const parent = yamlData.find((x) => x && String(x.item || '') === parentItem);
    if (!parent) return res.status(404).json({ message: '父级菜单不存在' });
    parent.list = Array.isArray(parent.list) ? parent.list : [];
    const fromIndex = parent.list.findIndex((x) => x && String(x.name || '') === name);
    if (fromIndex < 0) return res.status(404).json({ message: '子菜单不存在' });
    parent.list = moveArrayItem(parent.list, fromIndex, toIndex);
    await writeYamlArrayToFile(absolutePath, yamlData, `headers.reorderSub:${filename}`);
    appendWebhookLog({ type: 'headers.reorderSub', filename, parentItem, name, toIndex });
    res.json({ ok: true });
}));

function isValidUrl(value) {
    if (!value) return true;
    try {
        new URL(String(value));
        return true;
    } catch {
        return false;
    }
}

function addSiteToCategory(filename, yamlData, categoryId, site) {
    const found = findWebstackCategoryById(filename, yamlData, categoryId);
    if (!found) throw new Error('分类不存在');
    const link = {
        title: site.title,
        logo: site.logo || '',
        url: site.url,
        description: site.desc || ''
    };
    if (site.is_visible !== undefined) link.is_visible = Boolean(site.is_visible);
    if (site.update_port_enabled !== undefined) link.update_port_enabled = Boolean(site.update_port_enabled);
    if (found.level === 'taxonomy') {
        found.entry.links = Array.isArray(found.entry.links) ? found.entry.links : [];
        found.entry.links.push(link);
        if (site.sort_order !== null && site.sort_order !== undefined && Number.isFinite(Number(site.sort_order))) {
            found.entry.links = moveArrayItem(found.entry.links, found.entry.links.length - 1, Number(site.sort_order));
        }
        return;
    }
    found.termEntry.links = Array.isArray(found.termEntry.links) ? found.termEntry.links : [];
    found.termEntry.links.push(link);
    if (site.sort_order !== null && site.sort_order !== undefined && Number.isFinite(Number(site.sort_order))) {
        found.termEntry.links = moveArrayItem(found.termEntry.links, found.termEntry.links.length - 1, Number(site.sort_order));
    }
}

app.post('/api/sites', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || defaultWebstackFilename());
    const categoryId = Number(body.category_id);
    const url = String(body.url || '').trim();
    const title = String(body.title || '').trim();
    const logo = body.logo === null || body.logo === undefined ? null : String(body.logo || '').trim();
    const desc = body.desc === null || body.desc === undefined ? null : String(body.desc || '').trim();
    if (!Number.isFinite(categoryId)) return res.status(400).json({ message: '分类无效' });
    if (!url || !title) return res.status(400).json({ message: '请提供必要的网站信息' });
    if (!isValidUrl(url)) return res.status(400).json({ message: 'URL格式不正确' });
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    addSiteToCategory(filename, yamlData, categoryId, { url, title, logo, desc, sort_order: body.sort_order, is_visible: body.is_visible, update_port_enabled: body.update_port_enabled });
    await writeYamlArrayToFile(absolutePath, yamlData, `sites.create:${filename}`);
    try {
        addRecentNotification({ title, logo: logo || '', url, description: desc || '', date: new Date() }, { max: 40, dedupe: true });
    } catch {}
    appendWebhookLog({ type: 'sites.create', filename, title, url, categoryId });
    recordAndMaybeAutoSync({ action: 'update', filename, title, by: req.consoleUser ? req.consoleUser.username : '' });
    res.json({ ok: true });
}));

app.post('/api/sites/update/:id', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const siteId = Number(req.params.id);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || defaultWebstackFilename());
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    const found = findWebstackSiteById(filename, yamlData, siteId);
    if (!found) return res.status(404).json({ message: '站点不存在' });
    const patch = {
        url: body.url !== undefined ? String(body.url || '').trim() : undefined,
        title: body.title !== undefined ? String(body.title || '').trim() : undefined,
        logo: body.logo === undefined ? undefined : (body.logo === null ? '' : String(body.logo || '').trim()),
        desc: body.desc === undefined ? undefined : (body.desc === null ? '' : String(body.desc || '').trim()),
        is_visible: body.is_visible === undefined ? undefined : Boolean(body.is_visible),
        update_port_enabled: body.update_port_enabled === undefined ? undefined : Boolean(body.update_port_enabled),
        sort_order: body.sort_order === undefined ? undefined : (body.sort_order === null ? null : Number(body.sort_order)),
        category_id: body.category_id === undefined ? undefined : Number(body.category_id)
    };
    if (patch.url !== undefined && !patch.url) return res.status(400).json({ message: 'URL不能为空' });
    if (patch.title !== undefined && !patch.title) return res.status(400).json({ message: '标题不能为空' });
    if (patch.url !== undefined && !isValidUrl(patch.url)) return res.status(400).json({ message: 'URL格式不正确' });
    const currentCategoryId = found.level === 'taxonomy'
        ? fnv1a32(`${filename}::taxonomy::${found.taxIndex}`)
        : fnv1a32(`${filename}::term::${found.taxIndex}::${found.termIndex}`);
    const targetCategoryId = patch.category_id !== undefined && Number.isFinite(patch.category_id) ? patch.category_id : currentCategoryId;
    const willMove = targetCategoryId !== currentCategoryId;
    if (willMove) {
        if (found.level === 'taxonomy') {
            found.entry.links = (Array.isArray(found.entry.links) ? found.entry.links : []).filter((_, idx) => idx !== found.linkIndex);
        } else {
            found.termEntry.links = (Array.isArray(found.termEntry.links) ? found.termEntry.links : []).filter((_, idx) => idx !== found.linkIndex);
        }
        addSiteToCategory(filename, yamlData, targetCategoryId, {
            url: patch.url !== undefined ? patch.url : String(found.link.url),
            title: patch.title !== undefined ? patch.title : String(found.link.title),
            logo: patch.logo !== undefined ? patch.logo : (found.link.logo ? String(found.link.logo) : null),
            desc: patch.desc !== undefined ? patch.desc : (found.link.description ? String(found.link.description) : null),
            sort_order: patch.sort_order !== undefined ? patch.sort_order : null,
            is_visible: patch.is_visible !== undefined ? patch.is_visible : (found.link.is_visible === undefined ? true : Boolean(found.link.is_visible)),
            update_port_enabled: patch.update_port_enabled !== undefined ? patch.update_port_enabled : (found.link.update_port_enabled === undefined ? true : Boolean(found.link.update_port_enabled))
        });
    } else {
        if (patch.url !== undefined) found.link.url = patch.url;
        if (patch.title !== undefined) found.link.title = patch.title;
        if (patch.logo !== undefined) found.link.logo = patch.logo;
        if (patch.desc !== undefined) found.link.description = patch.desc;
        if (patch.is_visible !== undefined) found.link.is_visible = patch.is_visible;
        if (patch.update_port_enabled !== undefined) found.link.update_port_enabled = patch.update_port_enabled;
        if (patch.sort_order !== undefined && patch.sort_order !== null && Number.isFinite(patch.sort_order)) {
            if (found.level === 'taxonomy') found.entry.links = moveArrayItem(Array.isArray(found.entry.links) ? found.entry.links : [], found.linkIndex, patch.sort_order);
            else found.termEntry.links = moveArrayItem(Array.isArray(found.termEntry.links) ? found.termEntry.links : [], found.linkIndex, patch.sort_order);
        }
    }
    await writeYamlArrayToFile(absolutePath, yamlData, `sites.update:${filename}`);
    appendWebhookLog({ type: 'sites.update', filename, siteId });
    recordAndMaybeAutoSync({ action: 'update', filename, title: patch.title !== undefined ? patch.title : '', by: req.consoleUser ? req.consoleUser.username : '' });
    res.json({ ok: true });
}));

app.post('/api/sites/delete/:id', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const siteId = Number(req.params.id);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || defaultWebstackFilename());
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    const found = findWebstackSiteById(filename, yamlData, siteId);
    if (!found) return res.status(404).json({ message: '站点不存在' });
    if (found.level === 'taxonomy') found.entry.links = (Array.isArray(found.entry.links) ? found.entry.links : []).filter((_, idx) => idx !== found.linkIndex);
    else found.termEntry.links = (Array.isArray(found.termEntry.links) ? found.termEntry.links : []).filter((_, idx) => idx !== found.linkIndex);
    await writeYamlArrayToFile(absolutePath, yamlData, `sites.delete:${filename}`);
    appendWebhookLog({ type: 'sites.delete', filename, siteId });
    recordAndMaybeAutoSync({ action: 'delete', filename, title: String(found.link && found.link.title ? found.link.title : ''), by: req.consoleUser ? req.consoleUser.username : '' });
    res.json({ ok: true });
}));

app.post('/api/sites/batch-update-category', requireConsoleAdmin, wrapAsync(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const filename = String(body.filename || defaultWebstackFilename());
    const categoryId = Number(body.categoryId || body.category_id);
    const siteIds = Array.isArray(body.siteIds) ? body.siteIds.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [];
    if (!Number.isFinite(categoryId) || siteIds.length === 0) return res.status(400).json({ message: '参数不完整' });
    const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
    const yamlData = Array.isArray(data) ? data : [];
    siteIds.forEach((siteId) => {
        const found = findWebstackSiteById(filename, yamlData, siteId);
        if (!found) return;
        const link = found.link;
        if (found.level === 'taxonomy') found.entry.links = (Array.isArray(found.entry.links) ? found.entry.links : []).filter((_, idx) => idx !== found.linkIndex);
        else found.termEntry.links = (Array.isArray(found.termEntry.links) ? found.termEntry.links : []).filter((_, idx) => idx !== found.linkIndex);
        addSiteToCategory(filename, yamlData, categoryId, {
            url: String(link.url),
            title: String(link.title),
            logo: link.logo ? String(link.logo) : null,
            desc: link.description ? String(link.description) : null,
            is_visible: link.is_visible === undefined ? true : Boolean(link.is_visible),
            update_port_enabled: link.update_port_enabled === undefined ? true : Boolean(link.update_port_enabled)
        });
    });
    await writeYamlArrayToFile(absolutePath, yamlData, `sites.batch-update-category:${filename}`);
    appendWebhookLog({ type: 'sites.batch-update-category', filename, categoryId, count: siteIds.length });
    recordAndMaybeAutoSync({ action: 'update', filename, title: `batch-move:${siteIds.length}`, by: req.consoleUser ? req.consoleUser.username : '' });
    res.json({ ok: true });
}));

function stripHtmlTags(input) {
    return String(input || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(base, maybeRelative) {
    try {
        return new URL(String(maybeRelative || ''), String(base || '')).toString();
    } catch {
        return String(maybeRelative || '');
    }
}

function pickFirstNonEmpty(...values) {
    for (const v of values) {
        const s = String(v || '').trim();
        if (s) return s;
    }
    return '';
}

async function fetchUrlSuggest(url) {
    const target = String(url || '').trim();
    if (!target) throw new Error('URL不能为空');
    if (!isValidUrl(target)) throw new Error('URL格式不正确');
    const response = await axios.get(target, {
        timeout: 12000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
            'User-Agent': 'NOISE-Console/1.0 (+https://www.noisedh.cn)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
    });
    if (!response || response.status < 200 || response.status >= 400) {
        throw new Error(`抓取失败：HTTP ${response && response.status ? response.status : 'unknown'}`);
    }
    const html = String(response.data || '');
    const head = html.slice(0, 160000);
    const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtmlTags(titleMatch[1]) : '';
    const meta = (name, attr) => {
        const re = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i');
        const m = head.match(re);
        return m ? stripHtmlTags(m[1]) : '';
    };
    const desc = pickFirstNonEmpty(
        meta('description', 'name'),
        meta('og:description', 'property'),
        meta('twitter:description', 'name')
    );
    const ogImage = pickFirstNonEmpty(
        meta('og:image', 'property'),
        meta('twitter:image', 'name')
    );
    const iconHref = (() => {
        const m1 = head.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/i);
        if (m1 && m1[1]) return m1[1];
        const m2 = head.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*icon[^"']*["'][^>]*>/i);
        if (m2 && m2[1]) return m2[1];
        return '/favicon.ico';
    })();
    const favicon = absoluteUrl(target, iconHref);
    const logo = ogImage ? absoluteUrl(target, ogImage) : favicon;
    return {
        url: target,
        title,
        desc,
        favicon,
        ogImage: ogImage ? absoluteUrl(target, ogImage) : '',
        logo
    };
}

app.get('/api/sites/suggest', requireConsoleAdmin, async (req, res) => {
    try {
        const url = String(req.query.url || '').trim();
        const data = await fetchUrlSuggest(url);
        appendWebhookLog({ type: 'sites.suggest', url });
        res.json(data);
    } catch (e) {
        res.status(400).json({ message: e && e.message ? e.message : '识别失败' });
    }
});

function reorderWebstackSiteInPlace(filename, yamlData, siteId, toIndex) {
    const found = findWebstackSiteById(filename, yamlData, siteId);
    if (!found) throw new Error('站点不存在');
    const idx = Number(found.linkIndex);
    const target = Number(toIndex);
    if (!Number.isInteger(target) || target < 0) throw new Error('toIndex 无效');
    if (found.level === 'taxonomy') {
        const list = Array.isArray(found.entry.links) ? found.entry.links : [];
        found.entry.links = moveArrayItem(list, idx, target);
        return;
    }
    const list = Array.isArray(found.termEntry.links) ? found.termEntry.links : [];
    found.termEntry.links = moveArrayItem(list, idx, target);
}

app.post('/api/sites/reorder', requireConsoleAdmin, wrapAsync(async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const filename = String(body.filename || defaultWebstackFilename());
        const siteId = Number(body.siteId || body.id);
        const toIndex = Number(body.toIndex);
        if (!Number.isFinite(siteId)) return res.status(400).json({ message: 'siteId 无效' });
        if (!Number.isFinite(toIndex)) return res.status(400).json({ message: 'toIndex 无效' });
        const { absolutePath, data } = await loadYamlArrayFromDataFile(filename);
        const yamlData = Array.isArray(data) ? data : [];
        reorderWebstackSiteInPlace(filename, yamlData, siteId, toIndex);
        await writeYamlArrayToFile(absolutePath, yamlData, `sites.reorder:${filename}`);
        appendWebhookLog({ type: 'sites.reorder', filename, siteId, toIndex });
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ message: e && e.message ? e.message : '排序失败' });
    }
}));

function listFilesRecursive(rootDir, options) {
    const exts = options && Array.isArray(options.exts) ? options.exts : [];
    const maxDepth = options && Number.isInteger(options.maxDepth) ? options.maxDepth : 6;
    const results = [];
    const walk = (dir, depth) => {
        if (depth > maxDepth) return;
        const items = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
        items.forEach((it) => {
            const full = path.join(dir, it.name);
            if (it.isDirectory()) return walk(full, depth + 1);
            if (it.isFile()) {
                const ext = path.extname(it.name).toLowerCase();
                if (exts.length === 0 || exts.includes(ext)) results.push(full);
            }
        });
    };
    walk(rootDir, 0);
    return results;
}

function parseFrontMatterTitle(mdText) {
    const s = String(mdText || '');
    const lines = s.split(/\r?\n/);
    const first = String(lines[0] || '').trim();
    if (first !== '---' && first !== '+++' && first !== ';;;') return '';
    let end = -1;
    for (let i = 1; i < Math.min(lines.length, 260); i++) {
        if (String(lines[i] || '').trim() === first) {
            end = i;
            break;
        }
    }
    if (end < 0) return '';
    const fm = lines.slice(1, end).join('\n');
    const t2 = fm.match(/^\s*title\s*:\s*(.+)\s*$/m);
    if (t2 && t2[1]) return String(t2[1]).replace(/^["']|["']$/g, '').trim();
    const t = fm.match(/^\s*title\s*=\s*["']([^"']+)["']\s*$/m);
    if (t && t[1]) return String(t[1]).trim();
    return '';
}

function getContentDir() {
    return path.resolve(baseDir, 'content');
}

function readTextFileHead(filePath, maxBytes) {
    const limit = Math.max(1024, Math.min(Number(maxBytes || 0) || 0, 1024 * 1024));
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(limit);
        const n = fs.readSync(fd, buf, 0, limit, 0);
        return buf.slice(0, Math.max(0, n)).toString('utf8');
    } finally {
        try { fs.closeSync(fd); } catch {}
    }
}

const postTitleCache = new Map();
function getPostTitleCached(abs, mtimeMs) {
    const key = String(abs || '');
    if (!key) return '';
    const prev = postTitleCache.get(key);
    if (prev && prev.mtimeMs === mtimeMs && typeof prev.title === 'string') return prev.title;
    let title = '';
    try {
        const head = readTextFileHead(key, 64 * 1024);
        title = parseFrontMatterTitle(head) || path.basename(key, '.md');
    } catch {
        title = path.basename(key, '.md');
    }
    postTitleCache.set(key, { mtimeMs, title });
    return title;
}

function safeContentPath(relativePath) {
    const base = getContentDir();
    const safe = safeResolveWithinDir(base, relativePath);
    return safe;
}

app.get('/api/posts/list', requireConsoleAdmin, (req, res) => {
    try {
        const dir = String(req.query.dir || 'posts').replace(/^\/+/, '');
        const q = String(req.query.q || '').trim().toLowerCase();
        const contentDir = getContentDir();
        const targetDir = safeResolveWithinDir(contentDir, dir);
        if (!targetDir) return res.status(400).json({ message: '目录无效' });
        const files = listFilesRecursive(targetDir, { exts: ['.md'], maxDepth: 8 });
        let items = files.map((abs) => {
            const rel = path.relative(contentDir, abs).split(path.sep).join('/');
            const stat = fs.statSync(abs);
            const baseTitle = path.basename(abs, '.md');
            return {
                path: rel,
                abs,
                baseTitle,
                mtimeMs: stat.mtimeMs,
                pathLower: rel.toLowerCase(),
                baseLower: baseTitle.toLowerCase()
            };
        }).sort((a, b) => b.mtimeMs - a.mtimeMs);
        if (q) {
            items = items.filter((it) => {
                if (it.pathLower.includes(q) || it.baseLower.includes(q)) return true;
                const title = getPostTitleCached(it.abs, it.mtimeMs);
                return String(title || '').toLowerCase().includes(q);
            });
        }
        const paging = paginateArray(items, { page: req.query.page, pageSize: req.query.pageSize, maxPageSize: 200000 });
        const outItems = (paging.items || []).map((it) => {
            const title = getPostTitleCached(it.abs, it.mtimeMs) || it.baseTitle || path.basename(it.abs, '.md');
            return { path: it.path, title, mtimeMs: it.mtimeMs };
        });
        res.json({ dir, q, page: paging.page, pageSize: paging.pageSize, total: paging.total, items: outItems });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '读取失败' });
    }
});

app.get('/api/posts/read', requireConsoleAdmin, (req, res) => {
    try {
        const rel = String(req.query.path || '').replace(/^\/+/, '');
        const abs = safeContentPath(rel);
        if (!abs) return res.status(400).json({ message: '路径无效' });
        if (!fs.existsSync(abs)) return res.status(404).json({ message: '文件不存在' });
        const content = fs.readFileSync(abs, 'utf8');
        res.json({ path: rel, content });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '读取失败' });
    }
});

app.post('/api/posts/save', requireConsoleAdmin, (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const rel = String(body.path || '').replace(/^\/+/, '');
        const content = String(body.content || '');
        const abs = safeContentPath(rel);
        if (!abs) return res.status(400).json({ message: '路径无效' });
        const dir = path.dirname(abs);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        appendWebhookLog({ type: 'posts.save', path: rel });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '保存失败' });
    }
});

app.post('/api/posts/delete', requireConsoleAdmin, (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const rel = String(body.path || '').replace(/^\/+/, '');
        const abs = safeContentPath(rel);
        if (!abs) return res.status(400).json({ message: '路径无效' });
        if (!fs.existsSync(abs)) return res.status(404).json({ message: '文件不存在' });
        fs.unlinkSync(abs);
        appendWebhookLog({ type: 'posts.delete', path: rel });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '删除失败' });
    }
});

app.post('/api/posts/rename', requireConsoleAdmin, (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const from = String(body.from || '').replace(/^\/+/, '');
        const to = String(body.to || '').replace(/^\/+/, '');
        if (!from || !to) return res.status(400).json({ message: '参数不完整' });
        const absFrom = safeContentPath(from);
        const absTo = safeContentPath(to);
        if (!absFrom || !absTo) return res.status(400).json({ message: '路径无效' });
        if (!fs.existsSync(absFrom)) return res.status(404).json({ message: '源文件不存在' });
        if (fs.existsSync(absTo)) return res.status(409).json({ message: '目标已存在' });
        const dir = path.dirname(absTo);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.renameSync(absFrom, absTo);
        appendWebhookLog({ type: 'posts.rename', from, to });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '重命名失败' });
    }
});

app.post('/api/posts/publish', requireConsoleAdmin, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const rel = String(body.path || '').replace(/^\/+/, '');
        const content = String(body.content || '');
        const abs = safeContentPath(rel);
        if (!abs) return res.status(400).json({ message: '路径无效' });
        const dir = path.dirname(abs);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        const title = parseFrontMatterTitle(content) || path.basename(abs, '.md');
        appendWebhookLog({ type: 'posts.publish', path: rel, title });
        recordAndMaybeAutoSync({ action: 'update', filename: rel, title, by: req.consoleUser ? req.consoleUser.username : '' });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '发布失败' });
    }
});

function renderConsoleHtml() {
    const title = 'NOISE 后台';
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/admin/assets/style.css" />
</head>
<body class="ndh-admin">
  <div id="root"></div>
  <div class="sheet-overlay hidden" id="ndhSheetOverlay" onclick="closeSheet()"></div>
  <div class="sheet hidden" id="ndhSheet"></div>
  <div class="toast" id="toast"></div>
  <script>
    const state = {
      token: localStorage.getItem('ndh-console-token') || '',
      user: null,
      filename: localStorage.getItem('ndh-console-filename') || '${escapeHtml(defaultWebstackFilename())}',
      dataFiles: [],
      dataFileKinds: {},
      dataFilesLoaded: false,
      invalid: {
        filename: localStorage.getItem('ndh-invalid-filename') || '',
        limit: Number(localStorage.getItem('ndh-invalid-limit') || 200) || 200,
        running: false,
        offset: 0,
        totalLinks: 0,
        checkedCount: 0,
        skippedCount: 0,
        removedCount: 0,
        removedItems: [],
        lastError: '',
        reportPreview: ''
      },
      ui: {
        sidebarCollapsed: localStorage.getItem('ndh-admin-sidebar-collapsed') === '1',
        menuOpen: false,
        theme: localStorage.getItem('ndh-admin-theme') || (()=>{
          try{ return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark' }catch{ return 'dark' }
        })()
      }
    }
    const elRoot = document.getElementById('root')
    const elToast = document.getElementById('toast')
    const elSheet = document.getElementById('ndhSheet')
    const elSheetOverlay = document.getElementById('ndhSheetOverlay')
    function toast(tone, title, detail){
      const item = document.createElement('div')
      item.className = 'item ' + (tone === 'ok' ? 'ok' : tone === 'bad' ? 'bad' : '')
      item.innerHTML = '<div style="font-weight:700">' + esc(title) + '</div><div class="muted" style="margin-top:4px">' + esc(detail || '') + '</div>'
      elToast.appendChild(item)
      setTimeout(()=>{ item.style.opacity='0'; item.style.transition='opacity .18s'; }, 2600)
      setTimeout(()=>{ item.remove() }, 3000)
    }
    function esc(s){ return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') }
    const ICONS = {
      dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/></svg>',
      cat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h10"/></svg>',
      site: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 4.93"/><path d="M14 11a5 5 0 0 0-7.07 0L5.52 12.41a5 5 0 0 0 7.07 7.07L14 19.07"/></svg>',
      hugo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 7v10"/><path d="M7.5 9.5h9"/></svg>',
      post: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/></svg>',
      user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21a8 8 0 1 0-16 0"/><path d="M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8"/></svg>',
      set: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/><path d="M19.4 15a7.8 7.8 0 0 0 .1-2l2-1.2-2-3.4-2.3.7a8.2 8.2 0 0 0-1.7-1L15 5h-6l-.5 2.1a8.2 8.2 0 0 0-1.7 1L4.5 7.4l-2 3.4 2 1.2a7.8 7.8 0 0 0 .1 2l-2 1.2 2 3.4 2.3-.7a8.2 8.2 0 0 0 1.7 1L9 22h6l.5-2.1a8.2 8.2 0 0 0 1.7-1l2.3.7 2-3.4z"/></svg>',
      log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h6"/></svg>',
      sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.3 6.4"/><path d="M3 12a9 9 0 0 1 15.3-6.4"/><path d="M21 3v6h-6"/><path d="M3 21v-6h6"/></svg>',
      backup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-3l-2-3H9L7 7H4"/><path d="M6 7v13h12V7"/><path d="M9 11h6"/><path d="M9 15h6"/></svg>',
      warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.2L1.9 19a2 2 0 0 0 1.8 3h16.6a2 2 0 0 0 1.8-3L13.7 3.2a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
      logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M21 3v18"/></svg>',
      menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg>',
      close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>',
      refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.3 6.4"/><path d="M3 12a9 9 0 0 1 15.3-6.4"/><path d="M21 3v6h-6"/><path d="M3 21v-6h6"/></svg>',
      collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/><path d="M19 6v12"/></svg>',
      expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/><path d="M5 6v12"/></svg>',
      sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.93 19.07l1.41-1.41"/><path d="M17.66 6.34l1.41-1.41"/></svg>',
      moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 0 1 11.2 3a7 7 0 1 0 9.8 9.8z"/></svg>'
    }
    function icon(name){ return ICONS[name] || '' }
    function applyTheme(){
      const t = String(state.ui.theme || '').trim()
      document.body.classList.remove('ndh-theme-dark','ndh-theme-light')
      if(t === 'dark') document.body.classList.add('ndh-theme-dark')
      if(t === 'light') document.body.classList.add('ndh-theme-light')
    }
    function appEl(){
      return document.querySelector('.app')
    }
    function syncAppClass(){
      const el = appEl()
      if(!el) return false
      el.classList.toggle('side-collapsed', Boolean(state.ui.sidebarCollapsed))
      el.classList.toggle('menu-open', Boolean(state.ui.menuOpen))
      return true
    }
    function syncThemeButtons(){
      const iconName = themeIcon()
      const titleText = (String(state.ui.theme||'').trim()==='dark' ? '切换到白天模式' : '切换到暗黑模式')
      document.querySelectorAll('button[onclick="toggleTheme()"]').forEach((btn)=>{
        try{ btn.title = titleText }catch{}
        const ic = btn.querySelector('.nav-icon')
        if(ic) ic.innerHTML = icon(iconName)
      })
    }
    function syncSidebarToggleButton(){
      const btn = document.querySelector('button[onclick="toggleSidebar()"]')
      if(!btn) return
      const titleText = state.ui.sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'
      try{ btn.title = titleText }catch{}
      const ic = btn.querySelector('.nav-icon')
      if(ic) ic.innerHTML = icon(state.ui.sidebarCollapsed ? 'expand' : 'collapse')
    }
    function toggleTheme(){
      const current = String(state.ui.theme || '').trim()
      const next = current === 'dark' ? 'light' : 'dark'
      state.ui.theme = next
      localStorage.setItem('ndh-admin-theme', next)
      applyTheme()
      syncThemeButtons()
    }
    function themeIcon(){
      return String(state.ui.theme || '').trim() === 'dark' ? 'sun' : 'moon'
    }
    applyTheme()
    async function api(path, options){
      const init = options || {}
      const headers = Object.assign({ 'Content-Type': 'application/json' }, init.headers || {})
      if (state.token) headers['Authorization'] = 'Bearer ' + state.token
      const res = await fetch(path, Object.assign({}, init, { headers }))
      const text = await res.text()
      let data = null
      try{ data = text ? JSON.parse(text) : null }catch{ data = { message: text } }
      if (!res.ok) throw new Error((data && (data.message || data.error)) || ('HTTP ' + res.status))
      return data
    }
    async function downloadJsonFromApi(url, filename){
      const headers = {}
      if (state.token) headers['Authorization'] = 'Bearer ' + state.token
      const res = await fetch(url, { headers })
      if (!res.ok){
        const text = await res.text().catch(()=> '')
        throw new Error(text || ('HTTP ' + res.status))
      }
      const blob = await res.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = filename || 'download.json'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(()=>{ try{ URL.revokeObjectURL(href) }catch{} }, 1000)
    }
    function navTo(path){
      history.pushState({}, '', path)
      render()
    }
    window.addEventListener('popstate', render)
    async function ensureMe(force){
      if (!state.token) {
        state.user = null
        state._meToken = ''
        state._meCheckedAt = 0
        return null
      }
      const ttlMs = 30 * 1000
      const checkedAt = Number(state._meCheckedAt || 0) || 0
      if(!force && state.user && state._meToken === state.token && (Date.now() - checkedAt) < ttlMs){
        return state.user
      }
      try{
        const r = await api('/api/auth/me')
        state.user = r.user
        state._meToken = state.token
        state._meCheckedAt = Date.now()
        return r.user
      }catch{
        state.user = null
        state._meToken = state.token
        state._meCheckedAt = Date.now()
        return null
      }
    }
    async function ensureDataFiles(){
      if (state.dataFilesLoaded) return
      state.dataFilesLoaded = true
      try{
        const r = await api('/api/yaml-files?kind=all')
        const list = Array.isArray(r && r.files) ? r.files : []
        const names = list.map(x=>x && x.name ? String(x.name) : '').filter(Boolean)
        state.dataFiles = Array.from(new Set(names))
        const kinds = {}
        list.forEach(x=>{
          const n = x && x.name ? String(x.name) : ''
          const k = x && x.kind ? String(x.kind) : ''
          if(n) kinds[n] = k
        })
        state.dataFileKinds = kinds
      }catch{
        state.dataFiles = []
        state.dataFileKinds = {}
      }
      if (state.filename && !state.dataFiles.includes(state.filename)) {
        state.dataFiles = [state.filename, ...state.dataFiles]
      }
    }
    function dataKindLabel(kind){
      const k = String(kind || '').trim()
      if(k === 'friendlinks') return '友链'
      if(k === 'headers') return '导航'
      return '站点'
    }
    function activeDataKind(){
      const fromMap = state.dataFileKinds && state.filename ? state.dataFileKinds[state.filename] : ''
      if(fromMap) return String(fromMap)
      const fn = String(state.filename || '').toLowerCase()
      if(fn.includes('friendlinks')) return 'friendlinks'
      if(fn.includes('headers')) return 'headers'
      return 'webstack'
    }
    function dataFileOptionsHtml(){
      const list = Array.isArray(state.dataFiles) && state.dataFiles.length ? state.dataFiles : [state.filename]
      return list.map(n=>{
        const kind = state.dataFileKinds && state.dataFileKinds[n] ? String(state.dataFileKinds[n]) : ''
        const label = kind ? (String(n) + '（' + dataKindLabel(kind) + '）') : String(n)
        return '<option value="' + esc(n) + '"' + (String(n)===String(state.filename) ? ' selected' : '') + '>' + esc(label) + '</option>'
      }).join('')
    }
    function changeDataFile(next){
      const v = String(next || '').trim()
      if (!v) return
      state.filename = v
      localStorage.setItem('ndh-console-filename', v)
      toast('ok','已切换数据源', v)
      render()
    }
    function isMobile(){
      try{ return window.matchMedia && window.matchMedia('(max-width: 960px)').matches }catch{ return false }
    }
    function toggleSidebar(){
      state.ui.sidebarCollapsed = !state.ui.sidebarCollapsed
      localStorage.setItem('ndh-admin-sidebar-collapsed', state.ui.sidebarCollapsed ? '1' : '0')
      if(!syncAppClass()) render()
      syncSidebarToggleButton()
    }
    function openMenu(){ state.ui.menuOpen = true; if(!syncAppClass()) render() }
    function closeMenu(){ state.ui.menuOpen = false; if(!syncAppClass()) render() }
    window.addEventListener('resize', ()=>{ if(!isMobile() && state.ui.menuOpen){ state.ui.menuOpen = false; if(!syncAppClass()) render() } })
    function layout(active, contentHtml){
      const appCls = 'app' + (state.ui.sidebarCollapsed ? ' side-collapsed' : '') + (state.ui.menuOpen ? ' menu-open' : '')
      const kind = activeDataKind()
      const navHtml = (() => {
        let out = ''
        out += link('/admin', '仪表盘', 'dash', active === 'dash')
        if(kind === 'webstack'){
          out += link('/admin/categories', '分类管理', 'cat', active === 'cat')
          out += link('/admin/sites', '站点管理', 'site', active === 'site')
          out += link('/admin/hugo', '站点配置', 'hugo', active === 'hugo')
        } else if(kind === 'friendlinks'){
          out += link('/admin/friendlinks', '友链管理', 'site', active === 'friend')
        } else if(kind === 'headers'){
          out += link('/admin/headers', '导航管理', 'cat', active === 'hdr')
        }
        out += link('/admin/posts', '文章管理', 'post', active === 'post')
        out += link('/admin/users', '用户管理', 'user', active === 'user')
        out += link('/admin/settings', '设置', 'set', active === 'set')
        out += link('/admin/sync', '同步', 'sync', active === 'sync')
        out += link('/admin/invalid', '失效检测', 'warn', active === 'inv')
        out += link('/admin/backup', '导入导出', 'backup', active === 'backup')
        out += link('/admin/logs', '日志', 'log', active === 'log')
        return out
      })()
      const side = '<div class="side">' +
        '<div class="brand"><div class="brand-mark"></div><span class="brand-text">' + esc('${title}') + '</span>' +
          '<div class="brand-actions">' +
            '<button class="btn icon" onclick="toggleSidebar()" title="' + (state.ui.sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏') + '"><span class="nav-icon" aria-hidden="true">' + icon(state.ui.sidebarCollapsed ? 'expand' : 'collapse') + '</span></button>' +
          '</div>' +
        '</div>' +
        '<div class="nav">' + navHtml + '</div>' +
        '<div class="side-meta" style="margin-top:14px">' +
          '<div class="muted" style="font-size:12px;margin-bottom:6px">数据源</div>' +
          '<select class="input" id="data_file" onchange="changeDataFile(this.value)">' + dataFileOptionsHtml() + '</select>' +
          '<div style="margin-top:10px" class="muted">用户：<span>' + esc(state.user ? state.user.username : '未登录') + '</span></div>' +
        '</div>' +
        '<div class="side-actions">' +
          '<button class="btn icon" onclick="toggleTheme()" title="' + (String(state.ui.theme||'').trim()==='dark' ? '切换到白天模式' : '切换到暗黑模式') + '" aria-label="切换主题"><span class="nav-icon" aria-hidden="true">' + icon(themeIcon()) + '</span></button>' +
          '<button class="btn icon" onclick="appLogout()" title="退出" aria-label="退出"><span class="nav-icon" aria-hidden="true">' + icon('logout') + '</span></button>' +
        '</div>' +
      '</div>'
      const mobileBar =
        '<div class="mobilebar">' +
          '<button class="btn icon-only-mobile" onclick="openMenu()" aria-label="菜单"><span class="nav-icon" aria-hidden="true">' + icon('menu') + '</span><span class="btn-text" style="font-weight:800">菜单</span></button>' +
          '<div class="title">' + esc('${title}') + '</div>' +
          '<div class="spacer"></div>' +
          '<button class="btn icon" onclick="toggleTheme()" title="' + (String(state.ui.theme||'').trim()==='dark' ? '切换到白天模式' : '切换到暗黑模式') + '" aria-label="切换主题"><span class="nav-icon" aria-hidden="true">' + icon(themeIcon()) + '</span></button>' +
          '<button class="btn icon-only-mobile" onclick="render()" aria-label="刷新"><span class="nav-icon" aria-hidden="true">' + icon('refresh') + '</span><span class="btn-text" style="font-weight:800">刷新</span></button>' +
        '</div>'
      return '<div class="' + appCls + '"><div class="overlay" onclick="closeMenu()"></div>' + side + '<div class="main">' + mobileBar + contentHtml + '</div></div>'
    }
    function link(href, label, iconName, isActive){
      return '<a href="' + href + '" title="' + esc(label) + '" class="' + (isActive ? 'active' : '') + '" onclick="event.preventDefault();if(isMobile()){ closeMenu() } navTo(\\'' + href + '\\')"><span class="nav-icon" aria-hidden="true">' + icon(iconName) + '</span><span class="nav-label">' + esc(label) + '</span></a>'
    }
    async function appLogout(){
      state.token = ''
      state.user = null
      state._meToken = ''
      state._meCheckedAt = 0
      localStorage.removeItem('ndh-console-token')
      navTo('/admin/login')
    }
    function renderLogin(){
      return '<div class="auth-shell">' +
        '<div class="auth-nav" style="max-width:520px;width:100%">' +
          '<a class="auth-brand" href="/admin" onclick="event.preventDefault();navTo(\\'/admin\\')"><div class="brand-mark"></div><span style="font-weight:900">后台</span></a>' +
          '<div class="spacer"></div>' +
          '<button class="btn icon" onclick="toggleTheme()" title="' + (String(state.ui.theme||'').trim()==='dark' ? '切换到白天模式' : '切换到暗黑模式') + '" aria-label="切换主题"><span class="nav-icon" aria-hidden="true">' + icon(themeIcon()) + '</span></button>' +
        '</div>' +
        '<div class="card auth-card" style="max-width:520px;width:100%">' +
          '<div style="font-size:18px;font-weight:900">登录</div>' +
          '<div class="muted" style="margin-top:8px">首次启动默认账号：admin，密码为 API_TOKEN。</div>' +
          '<div class="grid" style="margin-top:14px">' +
            '<div><div class="muted" style="font-size:12px;margin-bottom:6px">用户名</div><input class="input" id="lg_u" value="admin" autocomplete="username" /></div>' +
            '<div><div class="muted" style="font-size:12px;margin-bottom:6px">密码</div><input class="input" id="lg_p" type="password" autocomplete="current-password" onkeydown="if(event.key===\\'Enter\\'){ doLogin() }" /></div>' +
          '</div>' +
          '<div class="row" style="margin-top:14px;flex-wrap:wrap">' +
            '<button class="btn primary" onclick="doLogin()"><span style="font-weight:900">登录</span></button>' +
            '<div class="spacer"></div>' +
            '<span class="muted">密码不在客户端保存</span>' +
          '</div>' +
        '</div>' +
      '</div>'
    }
    async function doLogin(){
      const u = document.getElementById('lg_u').value.trim()
      const p = document.getElementById('lg_p').value
      try{
        const r = await api('/api/auth/login', { method:'POST', body: JSON.stringify({ username:u, password:p }) })
        state.token = r.token || ''
        localStorage.setItem('ndh-console-token', state.token)
        state.user = r.user || null
        state._meToken = state.token
        state._meCheckedAt = Date.now()
        toast('ok','登录成功', state.user ? state.user.username : '')
        navTo('/admin')
      }catch(e){
        toast('bad','登录失败', e.message || '请检查账号密码')
      }
    }
    async function renderRegister(){
      if (!(state.user && state.user.isAdmin)) {
        return layout('user', '<div class="card" style="max-width:640px"><div style="font-weight:900">无权限</div><div class="muted" style="margin-top:8px">创建用户需要管理员权限。</div></div>')
      }
      const form = '<div class="card">' +
        '<div class="auth-nav" style="margin-bottom:10px">' +
          '<a class="auth-brand" href="/admin" onclick="event.preventDefault();navTo(\\'/admin\\')"><div class="brand-mark"></div><span style="font-weight:900">后台</span></a>' +
          '<div class="spacer"></div>' +
        '</div>' +
        '<div style="font-size:18px;font-weight:900">注册</div>' +
        '<div class="muted" style="margin-top:8px">创建后台用户（需要管理员权限）</div>' +
        '<div class="grid cols-2" style="margin-top:12px">' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">用户名</div><input class="input" id="rg_u" placeholder="例如 editor" autocomplete="username" /></div>' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">管理员</div><select id="rg_admin" class="input"><option value="0">否</option><option value="1">是</option></select></div>' +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">密码</div><input class="input" id="rg_p1" type="password" placeholder="至少 6 位" autocomplete="new-password" /></div>' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">确认密码</div><input class="input" id="rg_p2" type="password" autocomplete="new-password" onkeydown="if(event.key===\\'Enter\\'){ doRegister() }" /></div>' +
        '</div>' +
        '<div class="row" style="margin-top:14px;flex-wrap:wrap">' +
          '<button class="btn primary" onclick="doRegister()"><span style="font-weight:900">创建</span></button>' +
          '<div class="spacer"></div>' +
          '<span class="muted">创建后可在用户管理重置密码/删除</span>' +
        '</div>' +
      '</div>'
      return layout('user', '<div style="max-width:760px">' + form + '</div>')
    }
    async function doRegister(){
      const username = (document.getElementById('rg_u') ? document.getElementById('rg_u').value : '').trim()
      const p1 = document.getElementById('rg_p1') ? document.getElementById('rg_p1').value : ''
      const p2 = document.getElementById('rg_p2') ? document.getElementById('rg_p2').value : ''
      const isAdmin = document.getElementById('rg_admin') ? (document.getElementById('rg_admin').value === '1') : false
      if (!username || !p1 || !p2) { toast('bad','请填写完整信息',''); return }
      if (p1.length < 6) { toast('bad','密码太短','至少 6 位'); return }
      if (p1 !== p2) { toast('bad','两次密码不一致',''); return }
      try{
        await api('/api/auth/register', { method:'POST', body: JSON.stringify({ username, password: p1, isAdmin }) })
        toast('ok','已创建用户', username)
        navTo('/admin/users')
      }catch(e){
        toast('bad','创建失败', e.message || '')
      }
    }
    async function renderDashboard(){
      const htmlHead = '<div class="top"><div><div style="font-size:18px;font-weight:800">仪表盘</div><div class="muted" style="margin-top:4px">分类/站点统计与常用入口</div></div><div class="row"><button class="btn" onclick="render()">刷新</button></div></div>'
      let cats = [], sites = [], sync = null, users = null
      try{
        ;[cats, sites, sync] = await Promise.all([
          api('/api/categories?filename=' + encodeURIComponent(state.filename)),
          api('/api/sites?filename=' + encodeURIComponent(state.filename)),
          api('/api/sync/status')
        ])
        try{ users = await api('/api/auth/users?page=1&pageSize=1') }catch{}
      }catch(e){
        return layout('dash', htmlHead + '<div class="card">加载失败：' + esc(e.message) + '</div>')
      }
      const flatCats = []
      const walk = (n)=>{ (n||[]).forEach(x=>{ flatCats.push(x); if(x.children&&x.children.length) walk(x.children) }) }
      walk(cats)
      const totalCategories = flatCats.length
      const rootCategories = cats.length
      const subCategories = Math.max(0, totalCategories - rootCategories)
      const totalSites = Array.isArray(sites)? sites.length : 0
      const visibleSites = sites.filter(x=>x.is_visible).length
      const updatePortEnabledSites = sites.filter(x=>x.update_port_enabled).length
      const usersTotal = users && typeof users.total === 'number' ? users.total : 0
      const pendingCount = sync && Array.isArray(sync.pending) ? sync.pending.length : 0
      const dirty = Boolean(sync && sync.dirty)
      const cards = '<div class="grid cols-4">' +
        kpiCard('分类总数', totalCategories, '<div class="muted">一级：' + rootCategories + ' 二级：' + subCategories + '</div>') +
        kpiCard('站点总数', totalSites, '<div class="muted">可见：' + visibleSites + ' 端口更新：' + updatePortEnabledSites + '</div>') +
        kpiCard('后台用户', usersTotal, '<div class="muted">' + esc(state.user && state.user.isAdmin ? '管理员权限用户' : '普通权限用户') + '</div>') +
        kpiCard('待同步', dirty ? String(pendingCount || 0) : '0', '<div class="muted">autoSync：' + esc(sync && sync.autoSync ? '开启' : '关闭') + '</div>') +
      '</div>'

      const syncCard = (() => {
        const autoSync = Boolean(sync && sync.autoSync)
        const running = Boolean(sync && sync.running)
        const backupsCount = sync && typeof sync.backupsCount === 'number' ? sync.backupsCount : 0
        const lastRunAt = sync && sync.lastRunAt ? String(sync.lastRunAt) : ''
        const lastError = sync && sync.lastError ? String(sync.lastError) : ''
        return '<div class="card" style="margin-top:12px">' +
          '<div class="row" style="flex-wrap:wrap">' +
            '<div><div style="font-weight:800">同步</div>' +
              '<div class="muted" style="margin-top:6px">autoSync：' + esc(autoSync ? '开启' : '关闭') + '；待同步：' + esc(dirty ? '是' : '否') + '；备份：' + esc(String(backupsCount)) + '</div>' +
              (lastRunAt ? ('<div class="muted mono" style="margin-top:6px">lastRunAt：' + esc(lastRunAt) + '</div>') : '') +
              (lastError ? ('<div class="muted" style="margin-top:6px">lastError：' + esc(lastError) + '</div>') : '') +
            '</div>' +
            '<div class="spacer"></div>' +
            '<button class="btn" onclick="navTo(\\'/admin/sync\\')">打开同步</button>' +
            '<button class="btn primary" ' + (running ? 'disabled' : '') + ' onclick="runSyncNow()">立即同步/提交</button>' +
            '<button class="btn danger" ' + (!dirty ? 'disabled' : '') + ' onclick="discardSyncChanges()">放弃修改</button>' +
          '</div>' +
        '</div>'
      })()

      const kind = activeDataKind()
      const quick = (() => {
        if(kind === 'friendlinks'){
          return '<div class="grid cols-2">' + quickLink('友链管理','/admin/friendlinks') + quickLink('文章管理','/admin/posts') + '</div>'
        }
        if(kind === 'headers'){
          return '<div class="grid cols-2">' + quickLink('导航管理','/admin/headers') + quickLink('文章管理','/admin/posts') + '</div>'
        }
        return '<div class="grid cols-2">' + quickLink('站点管理','/admin/sites') + quickLink('分类管理','/admin/categories') + quickLink('文章管理','/admin/posts') + '</div>'
      })()
      return layout('dash', htmlHead + cards + syncCard + '<div style="height:12px"></div>' + quick)
    }
    function kpiCard(title, value, meta){
      return '<div class="card"><div class="muted">' + esc(title) + '</div><div class="kpi">' + esc(value) + '</div><div style="margin-top:8px">' + meta + '</div></div>'
    }
    function quickLink(title, href){
      return '<a class="card" href="' + href + '" onclick="event.preventDefault();navTo(\\'' + href + '\\')"><div style="font-weight:900">' + esc(title) + '</div><div class="muted" style="margin-top:6px">打开</div></a>'
    }
    async function renderCategories(){
      const head = '<div class="top"><div><div style="font-size:18px;font-weight:800">分类管理</div><div class="muted" style="margin-top:4px">管理 taxonomy / term</div></div>' +
        '<div class="row"><button class="btn primary" onclick="openCatCreate()">新建</button><button class="btn" onclick="render()">刷新</button></div></div>'
      let cats=[], sites=[]
      try{
        ;[cats, sites] = await Promise.all([
          api('/api/categories?filename=' + encodeURIComponent(state.filename)),
          api('/api/sites?filename=' + encodeURIComponent(state.filename))
        ])
      }catch(e){ return layout('cat', head + '<div class="card">加载失败：' + esc(e.message) + '</div>') }
      const counts = {}
      ;(sites||[]).forEach(s=>{ const k = String(s.category_id||''); counts[k] = (counts[k]||0) + 1 })
      const tree = '<div class="cat-tree cat-tree-scroll">' + cats.map(c=>catTreeNode(c,0,counts)).join('') + '</div>'
      return layout('cat', head + '<div class="card">' + tree + '</div>' + catDialogHtml())
    }
    const catDragState = { id: 0, parentId: null }
    function catDragStart(ev, id, parentId){
      catDragState.id = Number(id)
      catDragState.parentId = parentId === null || parentId === undefined ? null : Number(parentId)
      try{ ev.dataTransfer.setData('text/plain', String(id)) }catch{}
    }
    function catDragOver(ev){ ev.preventDefault() }
    async function catDropToIndex(ev, parentId, toIndex){
      ev.preventDefault()
      const id = Number(catDragState.id)
      const pid = parentId === null || parentId === undefined ? null : Number(parentId)
      if(!id){ toast('bad','拖拽失败','未识别拖拽对象'); return }
      if(catDragState.parentId !== pid){ toast('bad','只能在同级排序',''); return }
      try{
        await api('/api/categories/reorder', { method:'POST', body: JSON.stringify({ filename: state.filename, parent_id: pid, category_id: id, to_index: Number(toIndex) }) })
        toast('ok','已调整排序','')
        render()
      }catch(e){ toast('bad','排序失败', e.message || '') }
    }
    function catTreeNode(n, depth, counts){
      const pid = n.parent_id === null || n.parent_id === undefined ? null : Number(n.parent_id)
      const count = counts && counts[String(n.id)] ? Number(counts[String(n.id)]) : 0
      const sort = (n.sort_order === null || n.sort_order === undefined) ? '' : String(n.sort_order)
      const icon = n.icon ? '<span class="mono">' + esc(n.icon) + '</span>' : '<span class="muted">-</span>'
      const up = sort === '' ? '' : '<button class="btn hide-mobile" onclick="moveCatSort(' + n.id + ',' + (Number(n.sort_order)-1) + ')">上移</button>'
      const down = sort === '' ? '' : '<button class="btn hide-mobile" onclick="moveCatSort(' + n.id + ',' + (Number(n.sort_order)+1) + ')">下移</button>'
      const children = Array.isArray(n.children) ? n.children : []
      const meta = '<span class="pill">' + (depth ? '二级' : '一级') + '</span>' +
        '<span class="pill">站点 ' + esc(String(count)) + '</span>' +
        '<span class="pill">排序 ' + esc(sort || '-') + '</span>'
      const row =
        '<div class="cat-node depth-' + depth + '" draggable="true" onclick="onCatTap(' + n.id + ')" ondragstart="catDragStart(event,' + n.id + ',' + (pid===null?'null':pid) + ')" ondragover="catDragOver(event)" ondrop="catDropToIndex(event,' + (pid===null?'null':pid) + ',' + (Number.isFinite(n.sort_order)?n.sort_order:0) + ')">' +
          '<div class="row" style="align-items:flex-start;flex-wrap:wrap">' +
            '<div class="cat-handle"></div>' +
            '<div style="min-width:0;flex:1">' +
              '<div style="font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(n.name || '') + '</div>' +
              '<div class="muted" style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">' + meta + '<span class="cat-extra"><span class="muted">图标</span>' + icon + '</span></div>' +
            '</div>' +
            '<div class="row cat-actions" style="justify-content:flex-end;flex-wrap:wrap">' +
              up + down +
              '<button class="btn" onclick="openCatEdit(' + n.id + ');event.stopPropagation()">编辑</button>' +
              '<button class="btn danger" onclick="deleteCat(' + n.id + ');event.stopPropagation()">删除</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      const childHtml = children.length
        ? ('<div class="cat-children">' + children.map(ch=>catTreeNode(ch, depth+1, counts)).join('') +
          '<div class="drop-hint muted" style="margin-top:10px" ondragover="catDragOver(event)" ondrop="catDropToIndex(event,' + n.id + ',' + children.length + ')">拖拽到此处可移动到末尾</div>' +
        '</div>')
        : ('<div class="cat-children"><div class="drop-hint muted" style="margin-top:10px" ondragover="catDragOver(event)" ondrop="catDropToIndex(event,' + n.id + ',0)">拖拽到此处可移动到该分类末尾</div></div>')
      if(depth === 0){
        const dropEnd = '<div class="drop-hint muted" style="margin-top:10px" ondragover="catDragOver(event)" ondrop="catDropToIndex(event,null,99999)">拖拽到此处可移动到一级分类末尾</div>'
        return '<div class="cat-root">' + row + childHtml + '</div>' + dropEnd
      }
      return row + childHtml
    }
    function catRow(n, depth, count){
      const indent = depth ? '<span class="pill">二级</span>' : '<span class="pill">一级</span>'
      const icon = n.icon ? '<span class="mono">' + esc(n.icon) + '</span>' : '<span class="muted">-</span>'
      const sort = (n.sort_order === null || n.sort_order === undefined) ? '' : String(n.sort_order)
      const up = sort === '' ? '' : '<button class="btn" onclick="moveCatSort(' + n.id + ',' + (Number(n.sort_order)-1) + ')">上移</button>'
      const down = sort === '' ? '' : '<button class="btn" onclick="moveCatSort(' + n.id + ',' + (Number(n.sort_order)+1) + ')">下移</button>'
      return '<tr><td>' + indent + ' <span style="font-weight:800;margin-left:6px">' + esc(n.name) + '</span></td><td>' + icon + '</td><td><span class="pill">' + esc(String(count||0)) + '</span></td><td class="muted">' + esc(sort) + '</td>' +
        '<td><div class="row" style="justify-content:flex-end">' + up + down + '<button class="btn" onclick="openCatEdit(' + n.id + ')">编辑</button><button class="btn danger" onclick="deleteCat(' + n.id + ')">删除</button></div></td></tr>'
    }
    function catDialogHtml(){
      return '<div id="catDlg" class="card hidden" style="position:fixed;inset:0;max-width:720px;margin:60px auto;z-index:9998">' +
        '<div class="row"><div style="font-weight:800" id="catDlgTitle">新建分类</div><div class="spacer"></div><button class="btn" onclick="closeCatDlg()">关闭</button></div>' +
        '<div class="grid cols-2" style="margin-top:12px">' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">名称</div><input class="input" id="cat_name" /></div>' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">图标</div><input class="input" id="cat_icon" placeholder="例如 far fa-star 或 ⭐" /></div>' +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">父级</div><select id="cat_parent" class="input"></select></div>' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">排序(数字)</div><input id="cat_sort" class="input" inputmode="numeric" /></div>' +
        '</div>' +
        '<div class="row" style="margin-top:12px"><button class="btn primary" onclick="submitCat()">保存</button><div class="spacer"></div><span class="muted" id="cat_hint"></span></div>' +
      '</div>'
    }
    const catDlgState = { mode:'create', editingId:0, cache:[] }
    async function openCatCreate(){
      catDlgState.mode='create'; catDlgState.editingId=0
      document.getElementById('catDlgTitle').textContent='新建分类'
      document.getElementById('cat_name').value=''
      document.getElementById('cat_icon').value=''
      document.getElementById('cat_sort').value=''
      await fillCatParents()
      show('catDlg')
    }
    async function openCatEdit(id){
      catDlgState.mode='edit'; catDlgState.editingId=id
      const cats = await api('/api/categories?filename=' + encodeURIComponent(state.filename))
      catDlgState.cache = cats
      let found=null
      const walk=(n)=>{ (n||[]).forEach(x=>{ if(x.id===id) found=x; if(x.children&&x.children.length) walk(x.children) }) }
      walk(cats)
      if(!found){ toast('bad','未找到分类',''); return }
      document.getElementById('catDlgTitle').textContent='编辑分类'
      document.getElementById('cat_name').value=found.name||''
      document.getElementById('cat_icon').value=found.icon||''
      document.getElementById('cat_sort').value=String(found.sort_order ?? '')
      await fillCatParents(found.parent_id)
      show('catDlg')
    }
    async function fillCatParents(selected){
      const cats = await api('/api/categories?filename=' + encodeURIComponent(state.filename))
      catDlgState.cache = cats
      const el = document.getElementById('cat_parent')
      el.innerHTML = ''
      const opt0 = document.createElement('option'); opt0.value=''; opt0.textContent='(无) 根分类'; el.appendChild(opt0)
      cats.forEach(c=>{
        const o = document.createElement('option'); o.value=String(c.id); o.textContent=c.name; el.appendChild(o)
      })
      el.value = selected ? String(selected) : ''
    }
    function closeCatDlg(){ hide('catDlg') }
    async function submitCat(){
      const name = document.getElementById('cat_name').value.trim()
      const icon = document.getElementById('cat_icon').value.trim()
      const parent = document.getElementById('cat_parent').value
      const sortRaw = document.getElementById('cat_sort').value.trim()
      const sort = sortRaw === '' ? null : Number(sortRaw)
      if(!name){ toast('bad','请填写名称',''); return }
      const payload = { filename: state.filename, name, icon: icon || null, parent_id: parent ? Number(parent) : null, sort_order: sort }
      try{
        if(catDlgState.mode==='edit') await api('/api/categories/update/' + catDlgState.editingId, { method:'POST', body: JSON.stringify(payload) })
        else await api('/api/categories', { method:'POST', body: JSON.stringify(payload) })
        toast('ok','保存成功', name)
        closeCatDlg()
        render()
      }catch(e){ toast('bad','保存失败', e.message || '') }
    }
    async function deleteCat(id){
      if(!confirm('确认删除该分类？')) return
      try{
        await api('/api/categories/delete/' + id, { method:'POST', body: JSON.stringify({ filename: state.filename }) })
        toast('ok','已删除','')
        render()
      }catch(e){ toast('bad','删除失败', e.message || '') }
    }
    async function moveCatSort(id, sort_order){
      const v = Number(sort_order)
      if(!Number.isFinite(v) || v < 0){ toast('bad','排序无效',''); return }
      try{
        await api('/api/categories/update/' + id, { method:'POST', body: JSON.stringify({ filename: state.filename, sort_order: v }) })
        toast('ok','已调整排序','')
        render()
      }catch(e){ toast('bad','排序失败', e.message || '') }
    }
    async function renderSites(){
      const sp = new URLSearchParams(location.search || '')
      const q0 = String(sp.get('q') || '').trim()
      const cat0 = String(sp.get('cat') || '').trim()
      const page0 = Math.max(1, Number(sp.get('page') || 1) || 1)
      const ps0raw = sp.get('pageSize')
      let pageSize0 = ps0raw === null ? 200 : Number(ps0raw)
      if(!Number.isFinite(pageSize0)) pageSize0 = 200
      if(pageSize0 <= 0) pageSize0 = 200
      pageSize0 = Math.max(20, Math.min(pageSize0, 200000))
      const inSort = location.pathname.startsWith('/admin/sites/sort')
      const headHtml = (catOptionsHtml)=>{
        const catOptions = catOptionsHtml || ''
        return '<div class="top"><div><div style="font-size:18px;font-weight:800">站点管理</div><div class="muted" style="margin-top:4px">按分类/关键词筛选（支持分页）</div></div>' +
          '<div class="row" style="flex-wrap:wrap">' +
            '<select id="site_cat_filter" class="input" style="width:200px" onchange="applySitesQuery()"><option value=""' + (!cat0 ? ' selected' : '') + '>全部分类</option>' + catOptions + '</select>' +
            '<input class="input" id="site_q" value="' + esc(q0) + '" placeholder="关键词（标题/URL/描述/分类）" style="width:220px" />' +
            '<select id="site_pageSize" class="input" style="width:120px"><option value="50"' + (pageSize0===50?' selected':'') + '>50/页</option><option value="100"' + (pageSize0===100?' selected':'') + '>100/页</option><option value="200"' + (pageSize0===200?' selected':'') + '>200/页</option><option value="500"' + (pageSize0===500?' selected':'') + '>500/页</option><option value="1000"' + (pageSize0===1000?' selected':'') + '>1000/页</option><option value="2000"' + (pageSize0===2000?' selected':'') + '>2000/页</option><option value="5000"' + (pageSize0===5000?' selected':'') + '>5000/页</option><option value="10000"' + (pageSize0===10000?' selected':'') + '>10000/页</option></select>' +
            '<button class="btn" onclick="applySitesQuery()">筛选</button>' +
            '<button class="btn primary" onclick="openSiteSmartAdd()">添加（智能）</button>' +
            '<button class="btn" onclick="toggleSitesSort()">' + (inSort ? '取消拖拽排序' : '拖拽排序') + '</button>' +
            '<button class="btn" onclick="render()">刷新</button>' +
          '</div></div>'
      }
      let cats=[], resp=null
      try{
        ;[cats, resp] = await Promise.all([
          api('/api/categories/flat?filename=' + encodeURIComponent(state.filename)),
          api('/api/sites/list?filename=' + encodeURIComponent(state.filename) + '&q=' + encodeURIComponent(q0) + '&cat=' + encodeURIComponent(cat0) + '&page=' + encodeURIComponent(String(page0)) + '&pageSize=' + encodeURIComponent(String(pageSize0)))
        ])
      }catch(e){ return layout('site', headHtml('') + '<div class="card">加载失败：' + esc(e.message) + '</div>') }
      const catOptionsHtml = (cats||[]).map(c=>{
        const id = c && c.id !== undefined ? String(c.id) : ''
        if(!id) return ''
        const label = (c.parent_id ? '— ' : '') + String(c.name || '')
        return '<option value="' + esc(id) + '"' + (id === cat0 ? ' selected' : '') + '>' + esc(label) + '</option>'
      }).filter(Boolean).join('')
      const head = headHtml(catOptionsHtml)
      if (location.pathname.startsWith('/admin/sites/sort')) {
        let allSites = []
        try{ allSites = await api('/api/sites?filename=' + encodeURIComponent(state.filename)) }catch{}
        state._catsFlat = cats; state._sitesCache = allSites
        state._sitesByCat = buildSitesByCat(allSites)
        const sortView = renderSitesSortHtml(cats, state._sitesByCat)
        return layout('site', head + sortView + siteDialogHtml())
      }
      const pageItems = resp && resp.items ? resp.items : []
      const total = resp && typeof resp.total === 'number' ? resp.total : pageItems.length
      const pageSize = resp && resp.pageSize !== undefined ? Number(resp.pageSize) : pageSize0
      const pageCount = Math.max(1, Math.ceil(total / (pageSize || 1)))
      const page = resp && resp.page ? Number(resp.page) : page0
      state._catsFlat = cats; state._sitesCache = pageItems
      const catMap = {}
      ;(cats||[]).forEach(c=>{ catMap[String(c.id)] = String(c.name || '') })
      const cards = pageItems.map(s=>{
        const catName = catMap[String(s.category_id || '')] || '未知'
        const badges = '<div class="meta">' +
          '<span class="pill">' + esc(catName) + '</span>' +
          '<span class="pill">' + (s.is_visible ? '可见' : '隐藏') + '</span>' +
          '<span class="pill">' + (s.update_port_enabled ? '端口更新' : '不更新') + '</span>' +
        '</div>'
        const logo = s.logo ? ('<div class="muted mono site-extra" style="margin-top:6px;word-break:break-all">logo：' + esc(s.logo) + '</div>') : ''
        const desc = s.desc ? ('<div class="muted site-extra" style="margin-top:6px">' + esc(s.desc) + '</div>') : ''
        return '<div class="card site-card" onclick="onSiteTap(' + s.id + ')">' +
          '<div class="row" style="align-items:flex-start">' +
            '<div style="min-width:0;flex:1">' +
              '<div style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(s.title) + '</div>' +
              '<div class="muted mono" style="margin-top:6px;word-break:break-all">' + esc(s.url) + '</div>' +
              desc +
              logo +
              badges +
            '</div>' +
            '<div class="row site-actions" style="justify-content:flex-end;flex-wrap:wrap">' +
              '<button class="btn" onclick="openSiteEdit(' + s.id + ');event.stopPropagation()">编辑</button>' +
              '<button class="btn danger" onclick="deleteSite(' + s.id + ');event.stopPropagation()">删除</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      })
      const pager = '<div class="row" style="margin-bottom:10px;flex-wrap:wrap">' +
        '<span class="pill">总数：' + esc(String(total)) + '</span>' +
        '<span class="pill">第 ' + esc(String(page)) + ' / ' + esc(String(pageCount)) + ' 页</span>' +
        '<div class="spacer"></div>' +
        '<button class="btn" ' + (page<=1?'disabled':'') + ' onclick="gotoSitesPage(1)">首页</button>' +
        '<button class="btn" ' + (page<=1?'disabled':'') + ' onclick="gotoSitesPage(' + (page-1) + ')">上一页</button>' +
        '<button class="btn" ' + (page>=pageCount?'disabled':'') + ' onclick="gotoSitesPage(' + (page+1) + ')">下一页</button>' +
        '<button class="btn" ' + (page>=pageCount?'disabled':'') + ' onclick="gotoSitesPage(' + pageCount + ')">末页</button>' +
        '<span class="muted">跳转</span>' +
        '<input class="input" id="site_jump" style="width:90px" inputmode="numeric" value="' + esc(String(page)) + '" />' +
        '<button class="btn" onclick="gotoSitesPage(Number(document.getElementById(\\'site_jump\\').value||1))">Go</button>' +
      '</div>'
      const grid = '<div class="site-grid-scroll"><div class="site-grid">' + cards.join('') + '</div></div>'
      return layout('site', head + pager + grid + siteDialogHtml())
    }
    function applySitesQuery(){
      const q = document.getElementById('site_q') ? document.getElementById('site_q').value.trim() : ''
      const ps = document.getElementById('site_pageSize') ? Number(document.getElementById('site_pageSize').value) : 0
      const cat = document.getElementById('site_cat_filter') ? String(document.getElementById('site_cat_filter').value || '').trim() : ''
      const next = new URLSearchParams()
      if(q) next.set('q', q)
      if(cat) next.set('cat', cat)
      next.set('page', '1')
      next.set('pageSize', String(Number.isFinite(ps) && ps > 0 ? ps : 200))
      navTo('/admin/sites?' + next.toString())
    }
    function gotoSitesPage(p){
      const sp = new URLSearchParams(location.search || '')
      sp.set('page', String(Math.max(1, Number(p||1)||1)))
      if(!sp.get('pageSize')) sp.set('pageSize', '200')
      navTo('/admin/sites?' + sp.toString())
    }
    function buildSitesByCat(sites){
      const by = {}
      ;(sites||[]).forEach(s=>{
        const k = String(s.category_id || '')
        if(!by[k]) by[k]=[]
        by[k].push(s)
      })
      Object.keys(by).forEach(k=>{ by[k].sort((a,b)=> (a.sort_order??0)-(b.sort_order??0)) })
      return by
    }
    function renderSitesSortHtml(cats, byCat){
      const map = {}
      ;(cats||[]).forEach(c=>{ map[String(c.id)] = { ...c, children: [] } })
      const roots = []
      Object.keys(map).forEach(k=>{
        const n = map[k]
        const pid = n && n.parent_id ? String(n.parent_id) : ''
        if(pid && map[pid]) map[pid].children.push(n)
        else roots.push(n)
      })
      const sortCats = (arr)=> (arr||[]).sort((a,b)=>{
        const as = Number.isFinite(a.sort_order) ? a.sort_order : 0
        const bs = Number.isFinite(b.sort_order) ? b.sort_order : 0
        if(as !== bs) return as - bs
        return String(a.name||'').localeCompare(String(b.name||''))
      })
      sortCats(roots).forEach(r=> sortCats(r.children))
      const siteCard = (s, catId)=>{
        return '<div class="card site-sort-item" draggable="true" ondragstart="dragStart(event,' + s.id + ',' + catId + ')" ondragover="dragOver(event)" ondrop="dragDrop(event,' + s.id + ',' + catId + ')">' +
          '<div class="row" style="align-items:flex-start">' +
            '<div style="width:14px;height:14px;border:1px solid var(--border);border-radius:4px;margin-top:2px"></div>' +
            '<div style="min-width:0;flex:1">' +
              '<div style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(s.title) + '</div>' +
              '<div class="muted mono" style="margin-top:4px;word-break:break-all">' + esc(s.url) + '</div>' +
            '</div>' +
            '<div class="row" style="justify-content:flex-end">' +
              '<button class="btn" onclick="openSiteEdit(' + s.id + ');event.stopPropagation()">编辑</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      }
      const listHtml = (catId, list)=>{
        const ps = Math.max(10, Math.min(Number(state._sitesSortPageSize || 30) || 30, 200))
        if(!state._sitesSortPages) state._sitesSortPages = {}
        const key = String(catId)
        const total = (list||[]).length
        const pageCount = Math.max(1, Math.ceil(total / ps))
        let page = Math.max(1, Number(state._sitesSortPages[key] || 1) || 1)
        if(page > pageCount) page = pageCount
        state._sitesSortPages[key] = page
        const start = (page - 1) * ps
        const slice = (list||[]).slice(start, start + ps)
        const items = slice.map(s=> siteCard(s, catId)).join('')
        const hint = '<div class="drop-hint muted" style="margin-top:8px" ondragover="dragOver(event)" ondrop="dropOnCategory(event,' + catId + ')" ondragenter="dropEnter(event)" ondragleave="dropLeave(event)">拖拽到此处可移动到该分类末尾</div>'
        const pager = '<div class="row" style="margin-top:10px;flex-wrap:wrap">' +
          '<span class="pill">第 ' + esc(String(page)) + ' / ' + esc(String(pageCount)) + ' 页</span>' +
          '<span class="pill">本分类：' + esc(String(total)) + '</span>' +
          '<div class="spacer"></div>' +
          '<button class="btn" ' + (page<=1?'disabled':'') + ' onclick="setSitesSortPage(' + catId + ',' + (page-1) + ')">上一页</button>' +
          '<button class="btn" ' + (page>=pageCount?'disabled':'') + ' onclick="setSitesSortPage(' + catId + ',' + (page+1) + ')">下一页</button>' +
        '</div>'
        return '<div class="site-sort-list">' + hint + items + pager + '</div>'
      }
      const sections = roots.map(root=>{
        const rootId = Number(root.id)
        const topSites = (byCat && byCat[String(rootId)]) ? byCat[String(rootId)] : []
        const children = Array.isArray(root.children) ? root.children : []
        const childCols = children.map(ch=>{
          const cid = Number(ch.id)
          const list = (byCat && byCat[String(cid)]) ? byCat[String(cid)] : []
          return '<div class="card site-sort-term" ondragover="dragOver(event)" ondrop="dropOnCategory(event,' + cid + ')" ondragenter="dropEnter(event)" ondragleave="dropLeave(event)">' +
            '<div class="row"><div style="font-weight:800">' + esc(ch.name || '') + '</div><div class="spacer"></div><span class="muted">数量：' + list.length + '</span></div>' +
            '<div style="margin-top:10px">' + listHtml(cid, list) + '</div>' +
          '</div>'
        }).join('')
        const right = childCols || '<div class="card site-sort-term"><div class="muted">暂无二级分类</div></div>'
        return '<div class="card site-sort-tax" style="margin-top:12px">' +
          '<div class="row" style="flex-wrap:wrap"><div style="font-weight:900;font-size:16px">' + esc(root.name || '') + '</div><div class="spacer"></div><span class="muted">一级站点：' + topSites.length + ' 二级分类：' + children.length + '</span></div>' +
          '<div class="sites-sort-grid">' +
            '<div class="card site-sort-top" ondragover="dragOver(event)" ondrop="dropOnCategory(event,' + rootId + ')" ondragenter="dropEnter(event)" ondragleave="dropLeave(event)">' +
              '<div class="row"><div style="font-weight:800">一级分类站点</div><div class="spacer"></div><span class="muted">数量：' + topSites.length + '</span></div>' +
              '<div style="margin-top:10px">' + listHtml(rootId, topSites) + '</div>' +
            '</div>' +
            '<div class="site-sort-terms">' + right + '</div>' +
          '</div>' +
        '</div>'
      }).join('')
      const ps = Math.max(10, Math.min(Number(state._sitesSortPageSize || 30) || 30, 200))
      const ctl = '<div class="card" style="margin-bottom:12px"><div class="row" style="flex-wrap:wrap">' +
        '<div style="font-weight:800">拖拽排序</div>' +
        '<span class="pill">每页</span>' +
        '<select class="input" style="width:120px" onchange="setSitesSortPageSize(this.value)">' +
          '<option value="20"' + (ps===20?' selected':'') + '>20</option>' +
          '<option value="30"' + (ps===30?' selected':'') + '>30</option>' +
          '<option value="50"' + (ps===50?' selected':'') + '>50</option>' +
          '<option value="100"' + (ps===100?' selected':'') + '>100</option>' +
          '<option value="200"' + (ps===200?' selected':'') + '>200</option>' +
        '</select>' +
        '<div class="spacer"></div>' +
        '<button class="btn" onclick="toggleSitesSort()">退出</button>' +
      '</div><div class="muted" style="margin-top:6px">支持同分类排序与跨分类移动；已分页并限制高度，避免页面无限拉长</div></div>'
      return ctl + '<div class="sites-sort-tree">' + sections + '</div>'
    }
    function toggleSitesSort(){
      const inSort = location.pathname.startsWith('/admin/sites/sort')
      if(inSort){
        const back = state._sitesListQuery ? ('/admin/sites' + state._sitesListQuery) : '/admin/sites'
        navTo(back)
        return
      }
      state._sitesListQuery = location.search || ''
      navTo('/admin/sites/sort')
    }
    function setSitesSortPage(catId, page){
      if(!state._sitesSortPages) state._sitesSortPages = {}
      state._sitesSortPages[String(catId)] = Math.max(1, Number(page||1)||1)
      render()
    }
    function setSitesSortPageSize(ps){
      const v = Math.max(10, Math.min(Number(ps||30)||30, 200))
      state._sitesSortPageSize = v
      if(state._sitesSortPages){
        Object.keys(state._sitesSortPages).forEach(k=>{ state._sitesSortPages[k] = 1 })
      }
      render()
    }
    function siteDialogHtml(){
      return '<div id="siteDlg" class="card hidden" style="position:fixed;inset:0;max-width:780px;margin:40px auto;z-index:9998">' +
        '<div class="row"><div style="font-weight:800" id="siteDlgTitle">新建站点</div><div class="spacer"></div><button class="btn" onclick="closeSiteDlg()">关闭</button></div>' +
        '<div class="grid cols-2" style="margin-top:12px">' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">分类</div><select id="site_cat" class="input"></select></div>' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">标题</div><input class="input" id="site_title" /></div>' +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          '<div><div class="row"><div class="muted" style="font-size:12px;margin-bottom:6px">URL</div><div class="spacer"></div><span id="site_suggest_state" class="muted" style="font-size:12px"></span><button class="btn" style="padding:4px 8px" onclick="suggestSiteIntoForm()">自动识别</button></div><input class="input" id="site_url" /></div>' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">Logo</div><input class="input" id="site_logo" /></div>' +
        '</div>' +
        '<div style="margin-top:10px"><div class="muted" style="font-size:12px;margin-bottom:6px">描述</div><textarea id="site_desc" class="input"></textarea></div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">可见</div><select id="site_visible" class="input"><option value="1">是</option><option value="0">否</option></select></div>' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">端口更新</div><select id="site_port" class="input"><option value="1">是</option><option value="0">否</option></select></div>' +
        '</div>' +
        '<div class="row" style="margin-top:12px"><button class="btn primary" onclick="submitSite()">保存</button><div class="spacer"></div><span class="muted" id="site_hint"></span></div>' +
      '</div>'
    }
    const siteDlgState = { mode:'create', editingId:0 }
    function resetSiteSuggestSession(){
      siteDlgState._suggest = {
        lastUrl: '',
        autoTitle: '',
        autoDesc: '',
        autoLogo: '',
        dirtyTitle: false,
        dirtyDesc: false,
        dirtyLogo: false
      }
      siteDlgState._lastSuggestUrl = ''
      setSuggestState('')
    }
    function bindSiteSuggestDirtyTrack(){
      const titleEl = document.getElementById('site_title')
      const descEl = document.getElementById('site_desc')
      const logoEl = document.getElementById('site_logo')
      if(titleEl && !titleEl._ndhSuggestDirtyBound){
        titleEl._ndhSuggestDirtyBound = true
        titleEl.addEventListener('input', ()=>{ if(siteDlgState._suggest) siteDlgState._suggest.dirtyTitle = true })
      }
      if(descEl && !descEl._ndhSuggestDirtyBound){
        descEl._ndhSuggestDirtyBound = true
        descEl.addEventListener('input', ()=>{ if(siteDlgState._suggest) siteDlgState._suggest.dirtyDesc = true })
      }
      if(logoEl && !logoEl._ndhSuggestDirtyBound){
        logoEl._ndhSuggestDirtyBound = true
        logoEl.addEventListener('input', ()=>{ if(siteDlgState._suggest) siteDlgState._suggest.dirtyLogo = true })
      }
    }
    function fillSiteCategories(selected){
      const el = document.getElementById('site_cat')
      el.innerHTML = ''
      const cats = state._catsFlat || []
      cats.forEach(c=>{
        const o = document.createElement('option')
        o.value = String(c.id)
        o.textContent = (c.parent_id ? '— ' : '') + c.name
        el.appendChild(o)
      })
      if(selected) el.value = String(selected)
    }
    function openSiteCreate(){
      siteDlgState.mode='create'; siteDlgState.editingId=0
      document.getElementById('siteDlgTitle').textContent='新建站点'
      document.getElementById('site_title').value=''
      document.getElementById('site_url').value=''
      document.getElementById('site_logo').value=''
      document.getElementById('site_desc').value=''
      document.getElementById('site_visible').value='1'
      document.getElementById('site_port').value='1'
      fillSiteCategories()
      show('siteDlg')
      resetSiteSuggestSession()
      setTimeout(()=>{ bindSiteSuggestDirtyTrack(); bindSiteUrlAutoSuggest() }, 0)
    }
    function openSiteEdit(id){
      const site = (state._sitesCache || []).find(x=>x.id===id)
      if(!site){ toast('bad','未找到站点',''); return }
      siteDlgState.mode='edit'; siteDlgState.editingId=id
      document.getElementById('siteDlgTitle').textContent='编辑站点'
      document.getElementById('site_title').value=site.title||''
      document.getElementById('site_url').value=site.url||''
      document.getElementById('site_logo').value=site.logo||''
      document.getElementById('site_desc').value=site.desc||''
      document.getElementById('site_visible').value = site.is_visible ? '1' : '0'
      document.getElementById('site_port').value = site.update_port_enabled ? '1' : '0'
      fillSiteCategories(site.category_id)
      show('siteDlg')
      resetSiteSuggestSession()
      if(siteDlgState._suggest) siteDlgState._suggest.lastUrl = String(site.url || '').trim()
      setTimeout(()=>{ bindSiteSuggestDirtyTrack(); bindSiteUrlAutoSuggest() }, 0)
    }
    function closeSiteDlg(){ hide('siteDlg') }
    async function openSiteSmartAdd(){
      if(location.pathname.startsWith('/admin/sites/sort')) navTo('/admin/sites')
      openSiteCreate()
      setTimeout(()=>{ try{ document.getElementById('site_url').focus() }catch{} }, 0)
    }
    async function suggestSiteIntoForm(){
      const url = document.getElementById('site_url').value.trim()
      if(!url){ toast('bad','请先填写 URL',''); return }
      try{
        setSuggestState('识别中…')
        const r = await api('/api/sites/suggest?url=' + encodeURIComponent(url))
        const titleEl = document.getElementById('site_title')
        const descEl = document.getElementById('site_desc')
        const logoEl = document.getElementById('site_logo')
        const s = siteDlgState._suggest || { autoTitle:'',autoDesc:'',autoLogo:'',dirtyTitle:false,dirtyDesc:false,dirtyLogo:false }
        const isEdit = siteDlgState.mode === 'edit'
        if(isEdit){
          const nextTitle = r.title ? String(r.title) : ''
          const nextDesc = r.desc ? String(r.desc) : ''
          const nextLogo = (r.logo || r.favicon) ? String(r.logo || r.favicon) : ''
          const curTitle = titleEl ? String(titleEl.value || '').trim() : ''
          const curDesc = descEl ? String(descEl.value || '').trim() : ''
          const curLogo = logoEl ? String(logoEl.value || '').trim() : ''
          const willOverwrite =
            (!s.dirtyTitle && nextTitle && curTitle && curTitle !== nextTitle) ||
            (!s.dirtyDesc && nextDesc && curDesc && curDesc !== nextDesc) ||
            (!s.dirtyLogo && nextLogo && curLogo && curLogo !== nextLogo)
          if(willOverwrite){
            if(!confirm('自动识别将覆盖未手动修改的字段（标题/描述/Logo），是否继续？')){
              setSuggestState('')
              return
            }
          }
        }
        const applyField = (el, nextVal, autoKey, dirtyKey)=>{
          if(!el || !nextVal) return
          const cur = String(el.value || '')
          const curTrim = cur.trim()
          if(!curTrim){
            el.value = nextVal
            s[autoKey] = String(nextVal)
            return
          }
          if(isEdit){
            if(s[dirtyKey]) return
            el.value = nextVal
            s[autoKey] = String(nextVal)
            return
          }
          const prevAuto = String(s[autoKey] || '')
          if(!s[dirtyKey] && prevAuto && curTrim === prevAuto.trim()){
            el.value = nextVal
            s[autoKey] = String(nextVal)
          }
        }
        applyField(titleEl, r.title ? String(r.title) : '', 'autoTitle', 'dirtyTitle')
        applyField(descEl, r.desc ? String(r.desc) : '', 'autoDesc', 'dirtyDesc')
        applyField(logoEl, (r.logo || r.favicon) ? String(r.logo || r.favicon) : '', 'autoLogo', 'dirtyLogo')
        s.lastUrl = url
        siteDlgState._suggest = s
        setSuggestState('')
        toast('ok','已自动识别', (r.title || r.desc || '').slice(0, 60))
      }catch(e){ toast('bad','识别失败', e.message || '') }
    }
    function setSuggestState(text){
      const el = document.getElementById('site_suggest_state')
      if(!el) return
      el.textContent = text || ''
    }
    function bindSiteUrlAutoSuggest(){
      const el = document.getElementById('site_url')
      if(!el || el._ndhBound) return
      el._ndhBound = true
      let timer = 0
      const schedule = (ms)=>{
        if(timer) clearTimeout(timer)
        timer = setTimeout(async ()=>{
          if(siteDlgState.mode === 'edit') return
          const url = String(el.value||'').trim()
          const titleEl = document.getElementById('site_title')
          const descEl = document.getElementById('site_desc')
          const logoEl = document.getElementById('site_logo')
          if(!url) return
          const s0 = siteDlgState._suggest || { lastUrl:'' }
          if (String(s0.lastUrl || '') === url) return
          try{
            setSuggestState('识别中…')
            const r = await api('/api/sites/suggest?url=' + encodeURIComponent(url))
            const s = siteDlgState._suggest || { lastUrl:'',autoTitle:'',autoDesc:'',autoLogo:'',dirtyTitle:false,dirtyDesc:false,dirtyLogo:false }
            const urlChanged = s.lastUrl && s.lastUrl !== url
            const applyField = (fieldEl, nextVal, autoKey, dirtyKey)=>{
              if(!fieldEl || !nextVal) return
              const cur = String(fieldEl.value || '')
              const curTrim = cur.trim()
              if(!curTrim){
                fieldEl.value = nextVal
                s[autoKey] = String(nextVal)
                return
              }
              const prevAuto = String(s[autoKey] || '')
              if((!s[dirtyKey] && prevAuto && curTrim === prevAuto.trim()) || (urlChanged && !s[dirtyKey] && prevAuto && curTrim === prevAuto.trim())){
                fieldEl.value = nextVal
                s[autoKey] = String(nextVal)
              }
            }
            applyField(titleEl, r.title ? String(r.title) : '', 'autoTitle', 'dirtyTitle')
            applyField(descEl, r.desc ? String(r.desc) : '', 'autoDesc', 'dirtyDesc')
            applyField(logoEl, (r.logo || r.favicon) ? String(r.logo || r.favicon) : '', 'autoLogo', 'dirtyLogo')
            s.lastUrl = url
            siteDlgState._suggest = s
            setSuggestState('')
          }catch(e){
            setSuggestState('')
          }
        }, ms)
      }
      el.addEventListener('blur', ()=> schedule(0))
      el.addEventListener('input', ()=> schedule(650))
    }
    const dragState = { id: 0, cat: 0 }
    function dragStart(ev, id, cat){
      dragState.id = Number(id); dragState.cat = Number(cat)
      try{ ev.dataTransfer.setData('text/plain', String(id)) }catch{}
    }
    function dragOver(ev){ ev.preventDefault() }
    function dropEnter(ev){
      const el = ev && ev.currentTarget ? ev.currentTarget : null
      if(el && el.classList && el.classList.contains('drop-hint')) el.classList.add('active')
    }
    function dropLeave(ev){
      const el = ev && ev.currentTarget ? ev.currentTarget : null
      if(el && el.classList && el.classList.contains('drop-hint')) el.classList.remove('active')
    }
    async function dropOnCategory(ev, catId){
      ev.preventDefault()
      const sid = Number(dragState.id)
      if(!sid){ toast('bad','拖拽失败','未识别拖拽对象'); return }
      const tc = Number(catId)
      if(!tc){ toast('bad','拖拽失败','目标分类无效'); return }
      const list = (state._sitesByCat && state._sitesByCat[String(tc)]) ? state._sitesByCat[String(tc)] : []
      const toIndex = list.length
      try{
        await api('/api/sites/update/' + sid, { method:'POST', body: JSON.stringify({ filename: state.filename, category_id: tc, sort_order: toIndex }) })
        toast('ok','已移动','')
        render()
      }catch(e){ toast('bad','移动失败', e.message || '') }
    }
    async function dragDrop(ev, targetId, targetCat){
      ev.preventDefault()
      const sid = Number(dragState.id)
      const sc = Number(dragState.cat)
      const tc = Number(targetCat)
      if(!sid || !sc){ toast('bad','拖拽失败','未识别拖拽对象'); return }
      if(sc === tc){
        const list = (state._sitesByCat && state._sitesByCat[String(sc)]) ? state._sitesByCat[String(sc)] : []
        const toIndex = list.findIndex(x=>x.id===Number(targetId))
        if(toIndex < 0){ toast('bad','拖拽失败','目标位置无效'); return }
        if(Number(targetId) === sid){ return }
        try{
          await api('/api/sites/reorder', { method:'POST', body: JSON.stringify({ filename: state.filename, siteId: sid, toIndex }) })
          toast('ok','已调整排序','')
          render()
        }catch(e){ toast('bad','排序失败', e.message || '') }
        return
      }
      const list = (state._sitesByCat && state._sitesByCat[String(tc)]) ? state._sitesByCat[String(tc)] : []
      const toIndex = list.findIndex(x=>x.id===Number(targetId))
      const idx = toIndex >= 0 ? toIndex : list.length
      try{
        await api('/api/sites/update/' + sid, { method:'POST', body: JSON.stringify({ filename: state.filename, category_id: tc, sort_order: idx }) })
        toast('ok','已移动','')
        render()
      }catch(e){ toast('bad','移动失败', e.message || '') }
    }
    async function submitSite(){
      const category_id = Number(document.getElementById('site_cat').value)
      const title = document.getElementById('site_title').value.trim()
      const url = document.getElementById('site_url').value.trim()
      const logo = document.getElementById('site_logo').value.trim()
      const desc = document.getElementById('site_desc').value.trim()
      const is_visible = document.getElementById('site_visible').value === '1'
      const update_port_enabled = document.getElementById('site_port').value === '1'
      if(!title || !url){ toast('bad','请填写标题与URL',''); return }
      const payload = { filename: state.filename, category_id, title, url, logo: logo || null, desc: desc || null, is_visible, update_port_enabled }
      try{
        if(siteDlgState.mode==='edit') await api('/api/sites/update/' + siteDlgState.editingId, { method:'POST', body: JSON.stringify(payload) })
        else await api('/api/sites', { method:'POST', body: JSON.stringify(payload) })
        toast('ok','保存成功', title)
        closeSiteDlg()
        render()
      }catch(e){ toast('bad','保存失败', e.message || '') }
    }
    async function deleteSite(id){
      if(!confirm('确认删除该站点？')) return
      try{
        await api('/api/sites/delete/' + id, { method:'POST', body: JSON.stringify({ filename: state.filename }) })
        toast('ok','已删除','')
        render()
      }catch(e){ toast('bad','删除失败', e.message || '') }
    }

    const friendDlgState = { mode:'create', oldUrl:'' }
    const friendDragState = { index: -1 }
    function friendDialogHtml(){
      return '<div id="friendDlg" class="card hidden" style="position:fixed;inset:0;max-width:780px;margin:40px auto;z-index:9998">' +
        '<div class="row"><div style="font-weight:800" id="friendDlgTitle">新增友链</div><div class="spacer"></div><button class="btn" onclick="closeFriendDlg()">关闭</button></div>' +
        '<div class="grid cols-2" style="margin-top:12px">' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">标题</div><input class="input" id="friend_title" /></div>' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">链接</div><input class="input" id="friend_url" /></div>' +
        '</div>' +
        '<div style="margin-top:10px"><div class="muted" style="font-size:12px;margin-bottom:6px">描述</div><textarea id="friend_desc" class="input"></textarea></div>' +
        '<div class="row" style="margin-top:12px"><button class="btn primary" onclick="submitFriend()">保存</button><div class="spacer"></div><span class="muted" id="friend_hint"></span></div>' +
      '</div>'
    }
    function openFriendCreate(){
      friendDlgState.mode='create'; friendDlgState.oldUrl=''
      document.getElementById('friendDlgTitle').textContent='新增友链'
      document.getElementById('friend_title').value=''
      document.getElementById('friend_url').value=''
      document.getElementById('friend_desc').value=''
      show('friendDlg')
    }
    function openFriendEdit(idx){
      const it = (state._friendlinksCache || [])[idx]
      if(!it){ toast('bad','未找到友链',''); return }
      friendDlgState.mode='edit'; friendDlgState.oldUrl=String(it.url||'')
      document.getElementById('friendDlgTitle').textContent='编辑友链'
      document.getElementById('friend_title').value=String(it.title||'')
      document.getElementById('friend_url').value=String(it.url||'')
      document.getElementById('friend_desc').value=String(it.description||'')
      show('friendDlg')
    }
    function closeFriendDlg(){ hide('friendDlg') }
    async function submitFriend(){
      const title = document.getElementById('friend_title').value.trim()
      const url = document.getElementById('friend_url').value.trim()
      const description = document.getElementById('friend_desc').value.trim()
      if(!title || !url){ toast('bad','请填写标题和链接',''); return }
      try{
        await api('/api/friendlinks/save', { method:'POST', body: JSON.stringify({ filename: state.filename, title, url, description, oldUrl: friendDlgState.oldUrl || '' }) })
        toast('ok','已保存','')
        closeFriendDlg()
        render()
      }catch(e){ toast('bad','保存失败', e.message || '') }
    }
    async function deleteFriend(idx){
      const it = (state._friendlinksCache || [])[idx]
      if(!it){ toast('bad','未找到友链',''); return }
      if(!confirm('确认删除该友链？')) return
      try{
        await api('/api/friendlinks/delete', { method:'POST', body: JSON.stringify({ filename: state.filename, url: it.url }) })
        toast('ok','已删除','')
        render()
      }catch(e){ toast('bad','删除失败', e.message || '') }
    }
    function friendDragStart(ev, idx){
      friendDragState.index = Number(idx)
      try{ ev.dataTransfer.setData('text/plain', String(idx)) }catch{}
    }
    function friendDragOver(ev){ ev.preventDefault() }
    async function friendDropToIndex(ev, targetIndex){
      ev.preventDefault()
      const from = Number(friendDragState.index)
      const to = Number(targetIndex)
      const list = state._friendlinksCache || []
      if(!Number.isInteger(from) || from < 0 || from >= list.length) { toast('bad','拖拽失败',''); return }
      if(!Number.isInteger(to)) { toast('bad','拖拽失败',''); return }
      const item = list[from]
      if(!item || !item.url) return
      try{
        await api('/api/friendlinks/reorder', { method:'POST', body: JSON.stringify({ filename: state.filename, url: item.url, toIndex: to }) })
        toast('ok','已调整排序','')
        render()
      }catch(e){ toast('bad','排序失败', e.message || '') }
    }
    async function renderFriendlinks(){
      const sp = new URLSearchParams(location.search || '')
      const page0 = Math.max(1, Number(sp.get('page') || 1) || 1)
      const pageSize0 = Math.max(20, Math.min(Number(sp.get('pageSize') || 60) || 60, 2000))
      const head = '<div class="top"><div><div style="font-size:18px;font-weight:800">友链管理</div><div class="muted" style="margin-top:4px">编辑友链数据源（已分页）</div></div>' +
        '<div class="row"><button class="btn primary" onclick="openFriendCreate()">新增</button><button class="btn" onclick="render()">刷新</button></div></div>'
      let data=null
      try{ data = await api('/api/friendlinks?filename=' + encodeURIComponent(state.filename)) }catch(e){ return layout('friend', head + '<div class="card">加载失败：' + esc(e.message) + '</div>') }
      const items = Array.isArray(data && data.items) ? data.items : []
      state._friendlinksCache = items
      const total = items.length
      const pageCount = Math.max(1, Math.ceil(total / pageSize0))
      const page = Math.min(pageCount, page0)
      const start = (page - 1) * pageSize0
      const slice = items.slice(start, start + pageSize0)
      const cards = slice.map((it, i)=>{
        const idx = start + i
        return '<div class="card friend-card" draggable="true" ondragstart="friendDragStart(event,' + idx + ')" ondragover="friendDragOver(event)" ondrop="friendDropToIndex(event,' + idx + ')">' +
          '<div class="row" style="align-items:flex-start">' +
            '<div style="width:14px;height:14px;border:1px solid var(--border);border-radius:4px;margin-top:2px"></div>' +
            '<div style="min-width:0;flex:1">' +
              '<div style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(it.title || '') + '</div>' +
              '<a class="muted mono" style="display:block;margin-top:6px;word-break:break-all" href="' + esc(it.url || '#') + '" target="_blank" rel="noreferrer">' + esc(it.url || '') + '</a>' +
              (it.description ? ('<div class="muted" style="margin-top:6px">' + esc(it.description) + '</div>') : '') +
            '</div>' +
            '<div class="row" style="justify-content:flex-end;flex-wrap:wrap">' +
              '<button class="btn" onclick="openFriendEdit(' + idx + ');event.stopPropagation()">编辑</button>' +
              '<button class="btn danger" onclick="deleteFriend(' + idx + ');event.stopPropagation()">删除</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      }).join('')
      const pager = '<div class="row" style="margin-bottom:10px;flex-wrap:wrap">' +
        '<span class="pill">总数：' + esc(String(total)) + '</span>' +
        '<span class="pill">第 ' + esc(String(page)) + ' / ' + esc(String(pageCount)) + ' 页</span>' +
        '<div class="spacer"></div>' +
        '<select id="friend_pageSize" class="input" style="width:120px"><option value="30"' + (pageSize0===30?' selected':'') + '>30/页</option><option value="60"' + (pageSize0===60?' selected':'') + '>60/页</option><option value="100"' + (pageSize0===100?' selected':'') + '>100/页</option><option value="200"' + (pageSize0===200?' selected':'') + '>200/页</option><option value="500"' + (pageSize0===500?' selected':'') + '>500/页</option><option value="1000"' + (pageSize0===1000?' selected':'') + '>1000/页</option></select>' +
        '<button class="btn" onclick="applyFriendQuery()">应用</button>' +
      '</div>' +
      '<div class="row" style="margin-bottom:10px;flex-wrap:wrap">' +
        '<button class="btn" ' + (page<=1?'disabled':'') + ' onclick="gotoFriendPage(' + (page-1) + ')">上一页</button>' +
        '<button class="btn" ' + (page>=pageCount?'disabled':'') + ' onclick="gotoFriendPage(' + (page+1) + ')">下一页</button>' +
        '<div class="spacer"></div>' +
        '<span class="muted">拖拽排序作用于全量列表</span>' +
      '</div>'
      const dropEnd = '<div class="drop-hint muted" style="margin-top:12px" ondragover="friendDragOver(event)" ondrop="friendDropToIndex(event,' + items.length + ')">拖拽到此处可移动到末尾</div>'
      const body = pager + '<div class="friend-grid friend-grid-scroll">' + cards + '</div>' + dropEnd
      return layout('friend', head + '<div class="card">' + body + '</div>' + friendDialogHtml())
    }
    function applyFriendQuery(){
      const ps = document.getElementById('friend_pageSize') ? Number(document.getElementById('friend_pageSize').value) : 60
      const sp = new URLSearchParams(location.search || '')
      sp.set('page', '1')
      sp.set('pageSize', String(ps || 60))
      navTo('/admin/friendlinks?' + sp.toString())
    }
    function gotoFriendPage(p){
      const sp = new URLSearchParams(location.search || '')
      sp.set('page', String(Math.max(1, Number(p||1)||1)))
      if(!sp.get('pageSize')) sp.set('pageSize', '60')
      navTo('/admin/friendlinks?' + sp.toString())
    }

    const hdrDlgState = { mode:'top', oldItem:'', parentItem:'', oldName:'' }
    function headersDialogHtml(){
      return '<div id="hdrDlg" class="card hidden" style="position:fixed;inset:0;max-width:820px;margin:40px auto;z-index:9998">' +
        '<div class="row"><div style="font-weight:800" id="hdrDlgTitle">新增导航</div><div class="spacer"></div><button class="btn" onclick="closeHdrDlg()">关闭</button></div>' +
        '<div id="hdrTopFields">' +
          '<div class="grid cols-2" style="margin-top:12px">' +
            '<div><div class="muted" style="font-size:12px;margin-bottom:6px">名称</div><input class="input" id="hdr_item" /></div>' +
            '<div><div class="muted" style="font-size:12px;margin-bottom:6px">链接</div><input class="input" id="hdr_link" /></div>' +
          '</div>' +
          '<div style="margin-top:10px"><div class="muted" style="font-size:12px;margin-bottom:6px">图标</div><input class="input" id="hdr_icon" placeholder="例如 fa fa-home" /></div>' +
        '</div>' +
        '<div id="hdrSubFields" class="hidden">' +
          '<div class="grid cols-2" style="margin-top:12px">' +
            '<div><div class="muted" style="font-size:12px;margin-bottom:6px">父级菜单</div><input class="input" id="hdr_parent" disabled /></div>' +
            '<div><div class="muted" style="font-size:12px;margin-bottom:6px">名称</div><input class="input" id="hdr_name" /></div>' +
          '</div>' +
          '<div style="margin-top:10px"><div class="muted" style="font-size:12px;margin-bottom:6px">链接</div><input class="input" id="hdr_url" /></div>' +
        '</div>' +
        '<div class="row" style="margin-top:12px"><button class="btn primary" onclick="submitHdr()">保存</button><div class="spacer"></div><span class="muted" id="hdr_hint"></span></div>' +
      '</div>'
    }
    function showHdrTop(){
      document.getElementById('hdrTopFields').classList.remove('hidden')
      document.getElementById('hdrSubFields').classList.add('hidden')
    }
    function showHdrSub(){
      document.getElementById('hdrTopFields').classList.add('hidden')
      document.getElementById('hdrSubFields').classList.remove('hidden')
    }
    function openHdrTopCreate(){
      hdrDlgState.mode='top'; hdrDlgState.oldItem=''
      document.getElementById('hdrDlgTitle').textContent='新增导航'
      showHdrTop()
      document.getElementById('hdr_item').value=''
      document.getElementById('hdr_link').value=''
      document.getElementById('hdr_icon').value=''
      show('hdrDlg')
    }
    function openHdrTopEdit(item){
      const list = state._headersCache || []
      const it = list.find(x=>x && String(x.item||'')===String(item||''))
      if(!it){ toast('bad','未找到菜单',''); return }
      hdrDlgState.mode='top'; hdrDlgState.oldItem=String(it.item||'')
      document.getElementById('hdrDlgTitle').textContent='编辑导航'
      showHdrTop()
      document.getElementById('hdr_item').value=String(it.item||'')
      document.getElementById('hdr_link').value=String(it.link||'')
      document.getElementById('hdr_icon').value=String(it.icon||'')
      show('hdrDlg')
    }
    function openHdrSubCreate(parentItem){
      hdrDlgState.mode='sub'; hdrDlgState.parentItem=String(parentItem||''); hdrDlgState.oldName=''
      document.getElementById('hdrDlgTitle').textContent='新增子菜单'
      showHdrSub()
      document.getElementById('hdr_parent').value=hdrDlgState.parentItem
      document.getElementById('hdr_name').value=''
      document.getElementById('hdr_url').value=''
      show('hdrDlg')
    }
    function openHdrSubEdit(parentItem, name){
      const list = state._headersCache || []
      const p = list.find(x=>x && String(x.item||'')===String(parentItem||''))
      const sub = p && Array.isArray(p.list) ? p.list.find(x=>x && String(x.name||'')===String(name||'')) : null
      if(!p || !sub){ toast('bad','未找到子菜单',''); return }
      hdrDlgState.mode='sub'; hdrDlgState.parentItem=String(parentItem||''); hdrDlgState.oldName=String(name||'')
      document.getElementById('hdrDlgTitle').textContent='编辑子菜单'
      showHdrSub()
      document.getElementById('hdr_parent').value=hdrDlgState.parentItem
      document.getElementById('hdr_name').value=String(sub.name||'')
      document.getElementById('hdr_url').value=String(sub.url||'')
      show('hdrDlg')
    }
    function closeHdrDlg(){ hide('hdrDlg') }
    async function submitHdr(){
      try{
        if(hdrDlgState.mode === 'sub'){
          const parentItem = String(hdrDlgState.parentItem||'').trim()
          const name = document.getElementById('hdr_name').value.trim()
          const url = document.getElementById('hdr_url').value.trim()
          if(!parentItem || !name || !url){ toast('bad','请填写完整信息',''); return }
          await api('/api/headers/save-sub', { method:'POST', body: JSON.stringify({ filename: state.filename, parentItem, name, url, oldName: hdrDlgState.oldName || '' }) })
        }else{
          const item = document.getElementById('hdr_item').value.trim()
          const link = document.getElementById('hdr_link').value.trim()
          const icon = document.getElementById('hdr_icon').value.trim()
          if(!item || !link){ toast('bad','请填写名称和链接',''); return }
          await api('/api/headers/save-top', { method:'POST', body: JSON.stringify({ filename: state.filename, item, link, icon, oldItem: hdrDlgState.oldItem || '' }) })
        }
        toast('ok','已保存','')
        closeHdrDlg()
        render()
      }catch(e){ toast('bad','保存失败', e.message || '') }
    }
    async function deleteHdrTop(item){
      if(!confirm('确认删除该菜单？')) return
      try{
        await api('/api/headers/delete-top', { method:'POST', body: JSON.stringify({ filename: state.filename, item }) })
        toast('ok','已删除','')
        render()
      }catch(e){ toast('bad','删除失败', e.message || '') }
    }
    async function deleteHdrSub(parentItem, name){
      if(!confirm('确认删除该子菜单？')) return
      try{
        await api('/api/headers/delete-sub', { method:'POST', body: JSON.stringify({ filename: state.filename, parentItem, name }) })
        toast('ok','已删除','')
        render()
      }catch(e){ toast('bad','删除失败', e.message || '') }
    }
    async function moveHdrTop(item, toIndex){
      try{
        await api('/api/headers/reorder-top', { method:'POST', body: JSON.stringify({ filename: state.filename, item, toIndex }) })
        render()
      }catch(e){ toast('bad','排序失败', e.message || '') }
    }
    async function moveHdrSub(parentItem, name, toIndex){
      try{
        await api('/api/headers/reorder-sub', { method:'POST', body: JSON.stringify({ filename: state.filename, parentItem, name, toIndex }) })
        render()
      }catch(e){ toast('bad','排序失败', e.message || '') }
    }
    async function renderHeaders(){
      const head = '<div class="top"><div><div style="font-size:18px;font-weight:800">导航管理</div><div class="muted" style="margin-top:4px">编辑顶部导航数据源</div></div>' +
        '<div class="row"><button class="btn primary" onclick="openHdrTopCreate()">新增</button><button class="btn" onclick="render()">刷新</button></div></div>'
      let data=null
      try{ data = await api('/api/headers?filename=' + encodeURIComponent(state.filename)) }catch(e){ return layout('hdr', head + '<div class="card">加载失败：' + esc(e.message) + '</div>') }
      const items = Array.isArray(data && data.items) ? data.items : []
      state._headersCache = items
      const body = items.map((it, idx)=>{
        const subs = Array.isArray(it.list) ? it.list : []
        const topActions =
          '<div class="row" style="justify-content:flex-end;flex-wrap:wrap">' +
            '<button class="btn" ' + (idx<=0?'disabled':'') + ' onclick="moveHdrTop(\\'' + esc(String(it.item||'')).replace(/'/g,'&#39;') + '\\',' + (idx-1) + ')">上移</button>' +
            '<button class="btn" ' + (idx>=items.length-1?'disabled':'') + ' onclick="moveHdrTop(\\'' + esc(String(it.item||'')).replace(/'/g,'&#39;') + '\\',' + (idx+1) + ')">下移</button>' +
            '<button class="btn" onclick="openHdrTopEdit(\\'' + esc(String(it.item||'')).replace(/'/g,'&#39;') + '\\')">编辑</button>' +
            '<button class="btn danger" onclick="deleteHdrTop(\\'' + esc(String(it.item||'')).replace(/'/g,'&#39;') + '\\')">删除</button>' +
          '</div>'
        const subRows = subs.map((s, sidx)=>{
          const nm = String(s && s.name ? s.name : '')
          return '<div class="row hdr-sub-row" style="margin-top:8px">' +
            '<div style="min-width:0;flex:1">' +
              '<div style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(nm) + '</div>' +
              '<a class="muted mono" style="display:block;margin-top:4px;word-break:break-all" href="' + esc(s.url || '#') + '" target="_blank" rel="noreferrer">' + esc(s.url || '') + '</a>' +
            '</div>' +
            '<div class="row" style="justify-content:flex-end;flex-wrap:wrap">' +
              '<button class="btn" ' + (sidx<=0?'disabled':'') + ' onclick="moveHdrSub(\\'' + esc(String(it.item||'')).replace(/'/g,'&#39;') + '\\',\\'' + esc(nm).replace(/'/g,'&#39;') + '\\',' + (sidx-1) + ')">上移</button>' +
              '<button class="btn" ' + (sidx>=subs.length-1?'disabled':'') + ' onclick="moveHdrSub(\\'' + esc(String(it.item||'')).replace(/'/g,'&#39;') + '\\',\\'' + esc(nm).replace(/'/g,'&#39;') + '\\',' + (sidx+1) + ')">下移</button>' +
              '<button class="btn" onclick="openHdrSubEdit(\\'' + esc(String(it.item||'')).replace(/'/g,'&#39;') + '\\',\\'' + esc(nm).replace(/'/g,'&#39;') + '\\')">编辑</button>' +
              '<button class="btn danger" onclick="deleteHdrSub(\\'' + esc(String(it.item||'')).replace(/'/g,'&#39;') + '\\',\\'' + esc(nm).replace(/'/g,'&#39;') + '\\')">删除</button>' +
            '</div>' +
          '</div>'
        }).join('')
        const subBlock = '<div style="margin-top:10px">' +
          '<div class="row"><div class="muted" style="font-size:12px">子菜单</div><div class="spacer"></div><button class="btn" onclick="openHdrSubCreate(\\'' + esc(String(it.item||'')).replace(/'/g,'&#39;') + '\\')">新增子菜单</button></div>' +
          (subs.length ? subRows : '<div class="muted" style="margin-top:8px">暂无子菜单</div>') +
        '</div>'
        return '<div class="card" style="margin-top:12px">' +
          '<div class="row" style="align-items:flex-start;flex-wrap:wrap">' +
            '<div style="min-width:0;flex:1">' +
              '<div style="font-weight:900;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(it.item || '') + '</div>' +
              '<div class="muted mono" style="margin-top:6px;word-break:break-all">' + esc(it.link || '') + '</div>' +
              (it.icon ? ('<div class="muted mono" style="margin-top:6px;word-break:break-all">' + esc(it.icon) + '</div>') : '') +
            '</div>' +
            topActions +
          '</div>' +
          subBlock +
        '</div>'
      }).join('')
      return layout('hdr', head + body + headersDialogHtml())
    }

    async function renderUsers(){
      const sp = new URLSearchParams(location.search || '')
      const page0 = Math.max(1, Number(sp.get('page') || 1) || 1)
      const pageSize0 = Math.max(10, Math.min(Number(sp.get('pageSize') || 50) || 50, 200))
      const head = '<div class="top"><div><div style="font-size:18px;font-weight:800">用户管理</div><div class="muted" style="margin-top:4px">创建/重置密码/删除（需要管理员权限）</div></div><div class="row">' +
        '<select id="user_pageSize" class="input" style="width:110px"><option value="20"' + (pageSize0===20?' selected':'') + '>20/页</option><option value="50"' + (pageSize0===50?' selected':'') + '>50/页</option><option value="100"' + (pageSize0===100?' selected':'') + '>100/页</option><option value="200"' + (pageSize0===200?' selected':'') + '>200/页</option></select>' +
        '<button class="btn" onclick="applyUserQuery()">应用</button>' +
        '<button class="btn" onclick="render()">刷新</button>' +
      '</div></div>'
      let data=null
      try{ data = await api('/api/auth/users?page=' + page0 + '&pageSize=' + pageSize0) }catch(e){ return layout('user', head + '<div class="card">加载失败：' + esc(e.message) + '</div>') }
      const users = data && data.users ? data.users : []
      const create = '<div class="card"><div style="font-weight:800">创建用户</div><div class="grid cols-2" style="margin-top:10px">' +
        '<div><div class="muted" style="font-size:12px;margin-bottom:6px">用户名</div><input class="input" id="u_new_name" placeholder="例如 editor" /></div>' +
        '<div><div class="muted" style="font-size:12px;margin-bottom:6px">密码</div><input class="input" id="u_new_pass" type="password" placeholder="至少 6 位" /></div>' +
      '</div><div class="grid cols-2" style="margin-top:10px">' +
        '<div><div class="muted" style="font-size:12px;margin-bottom:6px">管理员</div><select id="u_new_admin" class="input"><option value="0">否</option><option value="1">是</option></select></div>' +
        '<div class="row" style="align-items:end"><button class="btn primary" onclick="createUser()">创建</button><div class="spacer"></div><span class="muted">总数：' + esc(String(data.total || users.length)) + '</span></div>' +
      '</div></div>'
      const rows = users.map(u=>{
        const role = u.isAdmin ? '<span class="pill">管理员</span>' : '<span class="pill">普通</span>'
        const self = state.user && state.user.id === u.id
        return '<tr>' +
          '<td><span style="font-weight:700">' + esc(u.username) + '</span><div class="muted mono" style="margin-top:4px">' + esc(u.id) + '</div></td>' +
          '<td>' + role + '</td>' +
          '<td class="muted mono">' + esc(u.createdAt || '') + '</td>' +
          '<td><div class="row" style="justify-content:flex-end">' +
            '<button class="btn" onclick="resetUserPw(\\'' + esc(u.id) + '\\')">重置密码</button>' +
            (self ? '' : '<button class="btn danger" onclick="deleteUser(\\'' + esc(u.id) + '\\')">删除</button>') +
          '</div></td>' +
        '</tr>'
      }).join('')
      const total = typeof data.total === 'number' ? data.total : users.length
      const pageCount = Math.max(1, Math.ceil(total / pageSize0))
      const pager = '<div class="row" style="margin-top:12px">' +
        '<span class="pill">第 ' + esc(String(page0)) + ' / ' + esc(String(pageCount)) + ' 页</span>' +
        '<div class="spacer"></div>' +
        '<button class="btn" ' + (page0<=1?'disabled':'') + ' onclick="gotoUserPage(' + (page0-1) + ')">上一页</button>' +
        '<button class="btn" ' + (page0>=pageCount?'disabled':'') + ' onclick="gotoUserPage(' + (page0+1) + ')">下一页</button>' +
      '</div>'
      const table = '<div class="card" style="margin-top:12px"><table><thead><tr><th>用户</th><th>角色</th><th>创建时间</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' + pager + '</div>'
      return layout('user', head + create + table)
    }
    function applyUserQuery(){
      const ps = document.getElementById('user_pageSize') ? Number(document.getElementById('user_pageSize').value) : 50
      const sp = new URLSearchParams(location.search || '')
      sp.set('page', '1')
      sp.set('pageSize', String(ps || 50))
      navTo('/admin/users?' + sp.toString())
    }
    function gotoUserPage(p){
      const sp = new URLSearchParams(location.search || '')
      sp.set('page', String(Math.max(1, Number(p||1)||1)))
      if(!sp.get('pageSize')) sp.set('pageSize', '50')
      navTo('/admin/users?' + sp.toString())
    }

    async function createUser(){
      const username = document.getElementById('u_new_name').value.trim()
      const password = document.getElementById('u_new_pass').value
      const isAdmin = document.getElementById('u_new_admin').value === '1'
      if(!username || !password){ toast('bad','请填写用户名与密码',''); return }
      try{
        await api('/api/auth/register', { method:'POST', body: JSON.stringify({ username, password, isAdmin }) })
        toast('ok','已创建用户', username)
        render()
      }catch(e){ toast('bad','创建失败', e.message || '') }
    }

    async function resetUserPw(id){
      const pw = prompt('输入新密码（将直接覆盖）')
      if(!pw) return
      try{
        await api('/api/auth/update-password', { method:'POST', body: JSON.stringify({ userId: id, newPassword: pw }) })
        toast('ok','密码已重置', id)
      }catch(e){ toast('bad','重置失败', e.message || '') }
    }

    async function deleteUser(id){
      if(!confirm('确认删除该用户？')) return
      try{
        await api('/api/auth/delete/' + id, { method:'POST' })
        toast('ok','已删除', id)
        render()
      }catch(e){ toast('bad','删除失败', e.message || '') }
    }
    function mdToHtml(src){
      const raw0 = String(src || '')
      const stripFrontMatter = (input)=>{
        const lines0 = String(input || '').split('\\n')
        const first = (lines0[0] || '').trim()
        if (first !== '---' && first !== '+++' && first !== ';;;') return String(input || '')
        const between = []
        let endIdx = -1
        for (let i = 1; i < Math.min(lines0.length, 200); i++){
          const t = String(lines0[i] || '').trim()
          if (t === first) { endIdx = i; break }
          between.push(lines0[i] || '')
        }
        if (endIdx < 0) return String(input || '')
        const looksLikeFm = between.some(l=>/^[A-Za-z0-9_-]+\\s*(=|:)\\s+/.test(String(l || '').trim()))
        if (!looksLikeFm) return String(input || '')
        return lines0.slice(endIdx + 1).join('\\n').replace(/^\\n+/, '')
      }
      const s = stripFrontMatter(raw0)
      const escHtml = (x)=>String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;')
      const lines = s.split('\\n')
      const fence = String.fromCharCode(96,96,96)
      const tick = String.fromCharCode(96)
      const inline = (raw)=>{
        let p = escHtml(raw)
        p = p.replace(/~~([^~]+)~~/g, '<del>$1</del>')
        p = p.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        p = p.replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
        if(p.includes(tick)){
          const segs = p.split(tick)
          p = segs.map((x,i)=> i % 2 === 1 ? ('<code>' + x + '</code>') : x).join('')
        }
        p = p.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<img alt="$1" src="$2" loading="lazy" />')
        p = p.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
        return p
      }

      let out = ''
      let inCode = false
      let listType = ''
      const closeList = ()=>{ if(listType){ out += '</' + listType + '>'; listType = '' } }
      let inTable = false
      const tableRows = []
      const closeTable = ()=>{
        if(!inTable) return
        const rows = tableRows.splice(0, tableRows.length)
        inTable = false
        if(!rows.length) return
        const head = rows[0] || []
        const body = rows.slice(1)
        out += '<table><thead><tr>' + head.map(c=>'<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
          body.map(r=>'<tr>' + (r||[]).map(c=>'<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table>'
      }
      const parseTableRow = (line)=>{
        return String(line||'').trim().replace(/^\\|/,'').replace(/\\|$/,'').split('|').map(x=>String(x||'').trim())
      }

      for(let i=0;i<lines.length;i++){
        const line = lines[i] || ''
        const t = line.trim()
        if(t.startsWith(fence) || t.startsWith('~~~')){
          closeList(); closeTable()
          inCode = !inCode
          out += inCode ? '<pre><code>' : '</code></pre>'
          continue
        }
        if(inCode){ out += escHtml(line) + '\\n'; continue }
        if(!t){ closeList(); closeTable(); continue }

        const hr = t.match(/^(-{3,}|\\*{3,}|_{3,})$/)
        if(hr){ closeList(); closeTable(); out += '<hr />'; continue }

        const h = line.match(/^(#{1,6})\\s+(.*)$/)
        if(h){
          closeList(); closeTable()
          const level = h[1].length
          out += '<h' + level + '>' + inline(h[2]) + '</h' + level + '>'
          continue
        }

        const bq = line.match(/^\\s*>\\s?(.*)$/)
        if(bq){
          closeList(); closeTable()
          out += '<blockquote>' + inline(bq[1] || '') + '</blockquote>'
          continue
        }

        const next = (i + 1) < lines.length ? String(lines[i + 1] || '') : ''
        const isTableHeader = t.includes('|') && /^\\s*\\|?\\s*:?[-]{3,}:?\\s*(\\|\\s*:?[-]{3,}:?\\s*)+\\|?\\s*$/.test(next.trim())
        if(isTableHeader){
          closeList()
          inTable = true
          tableRows.push(parseTableRow(line))
          i += 1
          continue
        }
        if(inTable && t.includes('|')){
          tableRows.push(parseTableRow(line))
          continue
        }
        if(inTable){ closeTable() }

        const task = line.match(/^\\s*[-*+]\\s+\\[( |x|X)\\]\\s+(.*)$/)
        if(task){
          if(listType !== 'ul'){ closeList(); listType='ul'; out += '<ul>' }
          const checked = String(task[1] || '').toLowerCase() === 'x'
          out += '<li><input type="checkbox" disabled' + (checked ? ' checked' : '') + ' /> ' + inline(task[2] || '') + '</li>'
          continue
        }

        const ul = line.match(/^\\s*[-*+]\\s+(.*)$/)
        if(ul){
          if(listType !== 'ul'){ closeList(); listType='ul'; out += '<ul>' }
          out += '<li>' + inline(ul[1] || '') + '</li>'
          continue
        }
        const ol = line.match(/^\\s*\\d+\\.\\s+(.*)$/)
        if(ol){
          if(listType !== 'ol'){ closeList(); listType='ol'; out += '<ol>' }
          out += '<li>' + inline(ol[1] || '') + '</li>'
          continue
        }

        closeList()
        out += '<p>' + inline(line) + '</p>'
      }
      closeList()
      closeTable()
      return '<div class="md">' + out + '</div>'
    }
    function defaultPostTemplate(title, slug){
      const d = new Date()
      const y = d.getFullYear()
      const m = String(d.getMonth()+1).padStart(2,'0')
      const day = String(d.getDate()).padStart(2,'0')
      const hh = String(d.getHours()).padStart(2,'0')
      const mm = String(d.getMinutes()).padStart(2,'0')
      const ss = String(d.getSeconds()).padStart(2,'0')
      const date = y + '-' + m + '-' + day + ' ' + hh + ':' + mm + ':' + ss
      const safeTitle = title ? title : slug
      const safeTitleYaml = '"' + String(safeTitle).replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'\\"') + '"'
      return '---\\n' +
        'title: ' + safeTitleYaml + '\\n' +
        'date: ' + date + '\\n' +
        'draft: false\\n' +
        '---\\n\\n' +
        '# ' + safeTitle + '\\n\\n'
    }
    async function renderPosts(){
      const sp = new URLSearchParams(location.search || '')
      const q0 = String(sp.get('q') || '').trim()
      const page0 = Math.max(1, Number(sp.get('page') || 1) || 1)
      const ps0raw = sp.get('pageSize')
      let pageSize0 = ps0raw === null ? 200 : Number(ps0raw)
      if(!Number.isFinite(pageSize0)) pageSize0 = 0
      pageSize0 = Math.max(0, Math.min(pageSize0, 200000))
      if(pageSize0 !== 0) pageSize0 = Math.max(50, pageSize0)
      if(state._postSearch === undefined) state._postSearch = q0
      const head = '<div class="top"><div><div style="font-size:18px;font-weight:800">文章管理</div><div class="muted" style="margin-top:4px">所见即所得编辑（默认不展示预览）；快捷键 Ctrl/Cmd+S 保存、Ctrl/Cmd+Enter 发布</div></div>' +
        '<div class="row"><button class="btn primary" onclick="createPost()">新建</button><button class="btn" onclick="render()">刷新</button></div></div>'
      let list=null
      try{ list = await api('/api/posts/list?dir=posts&q=' + encodeURIComponent(q0) + '&page=' + encodeURIComponent(String(page0)) + '&pageSize=' + encodeURIComponent(String(pageSize0))) }catch(e){ return layout('post', head + '<div class="card">加载失败：' + esc(e.message) + '</div>') }
      const items = list && list.items ? list.items : []
      const total = list && typeof list.total === 'number' ? list.total : items.length
      const pageSize = list && list.pageSize !== undefined ? Number(list.pageSize) : pageSize0
      const pageCount = Math.max(1, Math.ceil(total / (pageSize || 1)))
      const page = list && list.page ? Number(list.page) : page0
      const active = state._postActive || (items[0] && items[0].path) || ''
      if(active && active !== state._postActive) state._postActive = active
      state._postsList = items
      const listCard = '<div class="card">' +
        '<div class="row" style="margin-bottom:10px;flex-wrap:wrap">' +
          '<input class="input" id="post_search" value="' + esc(q0) + '" placeholder="搜索标题/路径" style="flex:1;min-width:160px" />' +
          '<select id="post_pageSize" class="input" style="width:120px"><option value="50"' + (pageSize0===50?' selected':'') + '>50/页</option><option value="100"' + (pageSize0===100?' selected':'') + '>100/页</option><option value="200"' + (pageSize0===200?' selected':'') + '>200/页</option><option value="500"' + (pageSize0===500?' selected':'') + '>500/页</option><option value="2000"' + (pageSize0===2000?' selected':'') + '>2000/页</option><option value="5000"' + (pageSize0===5000?' selected':'') + '>5000/页</option><option value="10000"' + (pageSize0===10000?' selected':'') + '>10000/页</option><option value="0"' + (pageSize0===0?' selected':'') + '>全部</option></select>' +
          '<button class="btn" onclick="applyPostSearch()">查询</button>' +
        '</div>' +
        '<div class="row" style="margin-bottom:10px;flex-wrap:wrap">' +
          '<span class="pill">总数：' + esc(String(total)) + '</span>' +
          '<span class="pill">第 ' + esc(String(page)) + ' / ' + esc(String(pageCount)) + ' 页</span>' +
          '<div class="spacer"></div>' +
          '<button class="btn" ' + (page<=1?'disabled':'') + ' onclick="gotoPostPage(1)">首页</button>' +
          '<button class="btn" ' + (page<=1?'disabled':'') + ' onclick="gotoPostPage(' + (page-1) + ')">上一页</button>' +
          '<button class="btn" ' + (page>=pageCount?'disabled':'') + ' onclick="gotoPostPage(' + (page+1) + ')">下一页</button>' +
          '<button class="btn" ' + (page>=pageCount?'disabled':'') + ' onclick="gotoPostPage(' + pageCount + ')">末页</button>' +
          '<span class="muted">跳转</span>' +
          '<input class="input" id="post_jump" style="width:90px" inputmode="numeric" value="' + esc(String(page)) + '" />' +
          '<button class="btn" onclick="gotoPostPage(Number(document.getElementById(\\'post_jump\\').value||1))">Go</button>' +
        '</div>' +
        '<div class="post-list">' +
          (items.length ? items.map(it=>{
            const isA = it.path === active
            return '<a href="#" onclick="event.preventDefault();selectPost(\\'' + esc(it.path) + '\\')" style="display:block;padding:10px;border-radius:12px;border:1px solid ' + (isA ? 'var(--border)' : 'transparent') + ';background:' + (isA ? 'var(--accent-bg)' : 'transparent') + '">' +
              '<div style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(it.title) + '</div>' +
              '<div class="muted mono" style="margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(it.path) + '</div>' +
            '</a>'
          }).join('') : '<div class="muted">暂无文章</div>') +
        '</div>' +
      '</div>'
      const editorCard = '<div class="card">' +
        '<div class="row" style="flex-wrap:wrap;align-items:flex-end">' +
          '<div style="font-weight:800">文章编辑</div>' +
          '<span class="pill" id="post_dirty" style="display:none">未保存</span>' +
          '<span class="pill" id="post_saved" style="display:none">已保存</span>' +
          '<div class="spacer"></div>' +
          '<button class="btn" onclick="savePost()">保存</button>' +
          '<button class="btn primary" onclick="publishPost()">发布</button>' +
          '<button class="btn" onclick="renamePost()">重命名</button>' +
          '<button class="btn danger" onclick="deletePost()">删除</button>' +
        '</div>' +
        '<div class="post-meta">' +
          '<div class="post-meta-row">' +
            '<div class="post-meta-item"><div class="muted" style="font-size:12px;margin-bottom:6px">标题</div><input class="input" id="post_meta_title" placeholder="title" /></div>' +
            '<div class="post-meta-item"><div class="muted" style="font-size:12px;margin-bottom:6px">日期</div><input class="input mono" id="post_meta_date" placeholder="YYYY-MM-DD HH:mm:ss" /></div>' +
            '<div class="post-meta-item"><div class="muted" style="font-size:12px;margin-bottom:6px">草稿</div><select class="input" id="post_meta_draft"><option value="false">否</option><option value="true">是</option></select></div>' +
          '</div>' +
          '<div class="post-meta-path muted mono">路径：<span id="post_path">' + esc(active || '') + '</span></div>' +
        '</div>' +
        '<div class="row post-toolbar" style="margin-top:10px;flex-wrap:wrap">' +
          '<button class="btn" onclick="mdAct(\\'h1\\')">一级标题</button>' +
          '<button class="btn" onclick="mdAct(\\'h2\\')">二级标题</button>' +
          '<button class="btn" onclick="mdAct(\\'h3\\')">三级标题</button>' +
          '<button class="btn" onclick="mdAct(\\'h4\\')">四级标题</button>' +
          '<button class="btn" onclick="mdAct(\\'bold\\')">加粗</button>' +
          '<button class="btn" onclick="mdAct(\\'italic\\')">斜体</button>' +
          '<button class="btn" onclick="mdAct(\\'strike\\')">删除线</button>' +
          '<button class="btn" onclick="mdAct(\\'link\\')">链接</button>' +
          '<button class="btn" onclick="mdAct(\\'image\\')">图片</button>' +
          '<button class="btn" onclick="mdAct(\\'code\\')">行内代码</button>' +
          '<button class="btn" onclick="mdAct(\\'codeblock\\')">代码块</button>' +
          '<button class="btn" onclick="mdAct(\\'quote\\')">引用</button>' +
          '<button class="btn" onclick="mdAct(\\'ul\\')">无序列表</button>' +
          '<button class="btn" onclick="mdAct(\\'ol\\')">有序列表</button>' +
          '<button class="btn" onclick="mdAct(\\'task\\')">待办</button>' +
          '<button class="btn" onclick="mdAct(\\'table\\')">表格</button>' +
          '<button class="btn" onclick="mdAct(\\'hr\\')">分隔线</button>' +
          '<div class="spacer"></div>' +
          '<button class="btn" onclick="showPostPreview()">预览</button>' +
        '</div>' +
        '<div style="margin-top:10px">' +
          '<div id="post_editor" class="post-editor post-editor-wysiwyg" contenteditable="true" spellcheck="false"></div>' +
        '</div>' +
        '<div class="row muted" style="margin-top:10px;font-size:12px">' +
          '<span id="post_stat_left"></span>' +
          '<div class="spacer"></div>' +
          '<span id="post_stat_right"></span>' +
        '</div>' +
        '<div id="post_preview_overlay" class="post-preview-modal hidden" onclick="hidePostPreview()">' +
          '<div class="post-preview-sheet card" onclick="event.stopPropagation()">' +
            '<div class="row" style="align-items:center;flex-wrap:wrap">' +
              '<div style="font-weight:800">预览</div>' +
              '<div class="spacer"></div>' +
              '<button class="btn" onclick="hidePostPreview()">关闭</button>' +
            '</div>' +
            '<div id="post_preview_body" class="post-preview-body" style="margin-top:10px"></div>' +
          '</div>' +
        '</div>' +
      '</div>'
      setTimeout(()=>{ if(active) loadPost(active) }, 0)
      setTimeout(()=>{ bindPostKeysOnce(); }, 0)
      return layout('post', head + '<div class="post-layout">' + listCard + editorCard + '</div>')
    }
    function applyPostSearch(){
      const q = document.getElementById('post_search') ? document.getElementById('post_search').value.trim() : ''
      const ps = document.getElementById('post_pageSize') ? Number(document.getElementById('post_pageSize').value) : 0
      state._postSearch = q
      const sp = new URLSearchParams(location.search || '')
      if(q) sp.set('q', q); else sp.delete('q')
      sp.set('page', '1')
      sp.set('pageSize', String(Number.isFinite(ps) ? ps : 200))
      navTo('/admin/posts?' + sp.toString())
    }
    function gotoPostPage(p){
      const sp = new URLSearchParams(location.search || '')
      sp.set('page', String(Math.max(1, Number(p||1)||1)))
      if(!sp.get('pageSize')) sp.set('pageSize', '200')
      navTo('/admin/posts?' + sp.toString())
    }
    async function selectPost(p){
      if(state._postDirty && !confirm('当前文章未保存，确认切换？')) return
      state._postActive = p; state._postLoaded = ''; state._postDirty = false
      render()
    }
    async function loadPost(p){
      if(!p) return
      if(state._postLoaded === p) return
      try{
        const r = await api('/api/posts/read?path=' + encodeURIComponent(p))
        const el = document.getElementById('post_editor')
        const pathEl = document.getElementById('post_path')
        if(pathEl) pathEl.textContent = p
        const serverContent = String(r.content || '')
        const draftKey = 'ndh-admin-post-draft::' + p
        const draft = localStorage.getItem(draftKey)
        const content = (draft && draft !== serverContent) ? draft : serverContent
        const parts = splitPostFrontMatter(content)
        state._postFrontMatter = parts.frontMatter
        state._postBodyMd = parts.body
        state._postMeta = parsePostMeta(parts.frontMatter)
        if(el) el.innerHTML = mdToEditableInner(parts.body)
        syncPostMetaToUi()
        state._postLoaded = p
        state._postDirty = Boolean(draft && draft !== serverContent)
        bindPostEditor()
        if(draft && draft !== serverContent) toast('ok','已恢复本地草稿', p)
        updatePostStats()
      }catch(e){ toast('bad','读取失败', e.message || '') }
    }
    function getPostPayload(){
      const p = state._postActive || ''
      const content = buildPostMarkdownFromEditor()
      return { path: p, content }
    }
    async function savePost(){
      const payload = getPostPayload()
      if(!payload.path){ toast('bad','未选择文章',''); return }
      try{
        await api('/api/posts/save', { method:'POST', body: JSON.stringify(payload) })
        localStorage.removeItem('ndh-admin-post-draft::' + payload.path)
        state._postDirty = false
        flashSaved()
        toast('ok','已保存', payload.path)
      }catch(e){ toast('bad','保存失败', e.message || '') }
    }
    async function publishPost(){
      const payload = getPostPayload()
      if(!payload.path){ toast('bad','未选择文章',''); return }
      try{
        await api('/api/posts/publish', { method:'POST', body: JSON.stringify(payload) })
        localStorage.removeItem('ndh-admin-post-draft::' + payload.path)
        state._postDirty = false
        flashSaved()
        toast('ok','已发布', payload.path)
      }catch(e){ toast('bad','发布失败', e.message || '') }
    }
    function pad2(n){ return String(n).padStart(2,'0') }
    function nowDateTime(){
      const d = new Date()
      return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    }
    function splitPostFrontMatter(raw){
      const s = String(raw || '')
      const lines = s.split('\\n')
      const first = String(lines[0] || '').trim()
      const isDelim = (x)=> x === '---' || x === '+++' || x === ';;;'
      if(!isDelim(first)) return { frontMatter:'', body:s.replace(/^\\n+/, '') }
      let end = -1
      for(let i=1;i<Math.min(lines.length, 260);i++){
        if(String(lines[i] || '').trim() === first){ end = i; break }
      }
      if(end < 0) return { frontMatter:'', body:s.replace(/^\\n+/, '') }
      const frontMatter = lines.slice(0, end + 1).join('\\n') + '\\n'
      const body = lines.slice(end + 1).join('\\n').replace(/^\\n+/, '')
      return { frontMatter, body }
    }
    function parsePostMeta(frontMatter){
      const fm = String(frontMatter || '')
      const titleM = fm.match(/^\\s*title\\s*:\\s*(.+)\\s*$/m)
      const dateM = fm.match(/^\\s*date\\s*:\\s*(.+)\\s*$/m)
      const draftM = fm.match(/^\\s*draft\\s*:\\s*(true|false)\\s*$/mi)
      const clean = (v)=>{
        const s = String(v || '').trim()
        return s.replace(/^["']|["']$/g,'').trim()
      }
      return {
        title: titleM ? clean(titleM[1]) : '',
        date: dateM ? clean(dateM[1]) : '',
        draft: draftM ? String(draftM[1]).toLowerCase() === 'true' : false
      }
    }
    function yamlQuote(v){
      const s = String(v ?? '')
      return '"' + s.replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'\\"') + '"'
    }
    function applyMetaToFrontMatter(frontMatter, patch){
      const p = patch && typeof patch === 'object' ? patch : {}
      const base = String(frontMatter || '')
      const ensureBlock = ()=>{
        const t = p.title !== undefined ? String(p.title || '').trim() : ''
        const d = p.date !== undefined ? String(p.date || '').trim() : ''
        const dr = p.draft !== undefined ? Boolean(p.draft) : false
        return '---\\n' +
          'title: ' + yamlQuote(t) + '\\n' +
          'date: ' + (d || nowDateTime()) + '\\n' +
          'draft: ' + (dr ? 'true' : 'false') + '\\n' +
          '---\\n'
      }
      if(!base.trim()) return ensureBlock()
      const parts = splitPostFrontMatter(base + '\\n')
      if(!parts.frontMatter) return ensureBlock()
      const lines = parts.frontMatter.split('\\n')
      const delim = String(lines[0] || '').trim()
      if(delim !== '---') return parts.frontMatter
      const replaceOrAppend = (key, nextLine)=>{
        const re = new RegExp('^\\\\s*' + key + '\\\\s*:\\\\s*.*$','i')
        for(let i=1;i<lines.length-1;i++){
          if(re.test(lines[i])) { lines[i] = nextLine; return }
        }
        lines.splice(Math.max(1, lines.length-1), 0, nextLine)
      }
      if(p.title !== undefined) replaceOrAppend('title', 'title: ' + yamlQuote(String(p.title || '').trim()))
      if(p.date !== undefined) replaceOrAppend('date', 'date: ' + String(p.date || '').trim())
      if(p.draft !== undefined) replaceOrAppend('draft', 'draft: ' + (Boolean(p.draft) ? 'true' : 'false'))
      return lines.join('\\n').replace(/\\n+$/,'') + '\\n'
    }
    function mdToEditableInner(md){
      const wrap = document.createElement('div')
      wrap.innerHTML = mdToHtml(md)
      const mdEl = wrap.querySelector('.md')
      return mdEl ? mdEl.innerHTML : ''
    }
    function cleanEditableHtml(html){
      const s = String(html || '')
      if(!s.trim()) return ''
      const box = document.createElement('div')
      box.innerHTML = s
      box.querySelectorAll('script,style').forEach(x=>x.remove())
      box.querySelectorAll('*').forEach((el)=>{
        const tag = String(el.tagName || '').toLowerCase()
        if(tag === 'img'){
          const src = el.getAttribute('src') || ''
          const alt = el.getAttribute('alt') || ''
          el.getAttributeNames().forEach(n=>{
            if(n === 'src' || n === 'alt' || n === 'title') return
            el.removeAttribute(n)
          })
          if(src) el.setAttribute('src', src)
          if(alt) el.setAttribute('alt', alt)
          return
        }
        if(tag === 'a'){
          const href = el.getAttribute('href') || ''
          el.getAttributeNames().forEach(n=>{
            if(n === 'href' || n === 'title' || n === 'target' || n === 'rel') return
            el.removeAttribute(n)
          })
          if(href) el.setAttribute('href', href)
          el.setAttribute('target','_blank')
          el.setAttribute('rel','noreferrer')
          return
        }
        el.getAttributeNames().forEach(n=>{
          if(n === 'data-lang') return
          el.removeAttribute(n)
        })
      })
      return box.innerHTML
    }
    function textOf(node){
      return String(node && node.textContent !== undefined ? node.textContent : '')
    }
    function normalizeText(s){
      return String(s || '').replace(/\\r\\n/g,'\\n').replace(/\\r/g,'\\n')
    }
    const MD_TICK = String.fromCharCode(96)
    const MD_FENCE = MD_TICK + MD_TICK + MD_TICK
    function inlineMdFromNode(node){
      if(!node) return ''
      if(node.nodeType === 3){
        return normalizeText(node.nodeValue || '')
      }
      if(node.nodeType !== 1) return ''
      const tag = String(node.tagName || '').toLowerCase()
      if(tag === 'br') return '\\n'
      if(tag === 'strong' || tag === 'b') return '**' + Array.from(node.childNodes).map(inlineMdFromNode).join('') + '**'
      if(tag === 'em' || tag === 'i') return '*' + Array.from(node.childNodes).map(inlineMdFromNode).join('') + '*'
      if(tag === 'del' || tag === 's') return '~~' + Array.from(node.childNodes).map(inlineMdFromNode).join('') + '~~'
      if(tag === 'code' && !(node.parentElement && String(node.parentElement.tagName||'').toLowerCase() === 'pre')){
        const t = textOf(node)
        const safe = String(t || '').split(MD_TICK).join('\\\\' + MD_TICK)
        return MD_TICK + safe + MD_TICK
      }
      if(tag === 'a'){
        const href = node.getAttribute('href') || ''
        const label = Array.from(node.childNodes).map(inlineMdFromNode).join('').trim() || href
        return '[' + label + '](' + href + ')'
      }
      if(tag === 'img'){
        const src = node.getAttribute('src') || ''
        const alt = node.getAttribute('alt') || ''
        return '![' + alt + '](' + src + ')'
      }
      return Array.from(node.childNodes).map(inlineMdFromNode).join('')
    }
    function mdFromBlock(node, indent){
      const pre = String(indent || '')
      if(!node) return ''
      if(node.nodeType === 3){
        const t = normalizeText(node.nodeValue || '').trim()
        return t ? (pre + t + '\\n\\n') : ''
      }
      if(node.nodeType !== 1) return ''
      const tag = String(node.tagName || '').toLowerCase()
      if(tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6'){
        const level = Number(tag.slice(1)) || 1
        const text = Array.from(node.childNodes).map(inlineMdFromNode).join('').trim()
        return pre + '#'.repeat(level) + ' ' + text + '\\n\\n'
      }
      if(tag === 'p' || tag === 'div'){
        const text = Array.from(node.childNodes).map(inlineMdFromNode).join('').replace(/\\n{3,}/g,'\\n\\n').trim()
        return text ? (pre + text + '\\n\\n') : ''
      }
      if(tag === 'blockquote'){
        const inner = Array.from(node.childNodes).map((n)=>mdFromBlock(n, '')).join('').trim().replace(/\\n\\n+/g,'\\n')
        const lines = inner.split('\\n').map(l=>'> ' + l)
        return pre + lines.join('\\n') + '\\n\\n'
      }
      if(tag === 'hr'){
        return pre + '---\\n\\n'
      }
      if(tag === 'pre'){
        const code = node.querySelector('code')
        const lang = (code && code.getAttribute('data-lang')) ? String(code.getAttribute('data-lang')||'').trim() : ''
        const t = normalizeText(textOf(code || node))
        return pre + MD_FENCE + lang + '\\n' + t.replace(/\\n+$/,'') + '\\n' + MD_FENCE + '\\n\\n'
      }
      if(tag === 'ul' || tag === 'ol'){
        const isOl = tag === 'ol'
        let idx = 1
        const items = Array.from(node.children).filter(x=>String(x.tagName||'').toLowerCase()==='li').map((li)=>{
          const prefix = isOl ? (String(idx++) + '. ') : '- '
          const parts = []
          Array.from(li.childNodes).forEach((n)=>{
            const t = String(n.tagName||'').toLowerCase()
            if(t === 'ul' || t === 'ol'){
              parts.push('\\n' + mdFromBlock(n, pre + '  ').trimEnd())
            }else{
              parts.push(inlineMdFromNode(n))
            }
          })
          const head = parts.join('').trim().replace(/\\n\\n+/g,'\\n')
          return pre + prefix + head.replace(/\\n/g,'\\n' + pre + '  ') + '\\n'
        }).join('')
        return items + (items ? '\\n' : '')
      }
      if(tag === 'table'){
        const rows = Array.from(node.querySelectorAll('tr')).map(tr=>{
          const cells = Array.from(tr.children).filter(x=>{
            const t = String(x.tagName||'').toLowerCase()
            return t === 'th' || t === 'td'
          }).map(td=>Array.from(td.childNodes).map(inlineMdFromNode).join('').trim().replace(/\\|/g,'\\\\|'))
          return cells
        }).filter(r=>r.length)
        if(!rows.length) return ''
        const head = rows[0]
        const cols = head.length
        const sep = new Array(cols).fill('---')
        const body = rows.slice(1)
        const line = (arr)=>'| ' + arr.map(x=>x || '').join(' | ') + ' |'
        const out = [line(head), line(sep)]
        body.forEach(r=>{
          const rr = r.slice(0, cols)
          while(rr.length < cols) rr.push('')
          out.push(line(rr))
        })
        return pre + out.join('\\n') + '\\n\\n'
      }
      return Array.from(node.childNodes).map((n)=>mdFromBlock(n, pre)).join('')
    }
    function htmlToMarkdown(html){
      const box = document.createElement('div')
      box.innerHTML = cleanEditableHtml(html)
      const nodes = Array.from(box.childNodes)
      const md = nodes.map(n=>mdFromBlock(n, '')).join('').replace(/\\n{3,}/g,'\\n\\n').trimEnd()
      return md + (md ? '\\n' : '')
    }
    function syncPostMetaToUi(){
      const m = state._postMeta && typeof state._postMeta === 'object' ? state._postMeta : { title:'', date:'', draft:false }
      const t = document.getElementById('post_meta_title')
      const d = document.getElementById('post_meta_date')
      const dr = document.getElementById('post_meta_draft')
      if(t) t.value = m.title || ''
      if(d) d.value = m.date || ''
      if(dr) dr.value = m.draft ? 'true' : 'false'
    }
    function readMetaFromUi(){
      const t = document.getElementById('post_meta_title')
      const d = document.getElementById('post_meta_date')
      const dr = document.getElementById('post_meta_draft')
      return {
        title: t ? String(t.value || '').trim() : '',
        date: d ? String(d.value || '').trim() : '',
        draft: dr ? String(dr.value || '') === 'true' : false
      }
    }
    function buildPostMarkdownFromEditor(){
      const ed = document.getElementById('post_editor')
      const html = ed ? String(ed.innerHTML || '') : ''
      const bodyMd = htmlToMarkdown(html)
      const meta = readMetaFromUi()
      const fm0 = state._postFrontMatter || ''
      const fm = applyMetaToFrontMatter(fm0, { title: meta.title, date: meta.date || nowDateTime(), draft: meta.draft })
      const out = fm + '\\n' + bodyMd.replace(/^\\n+/, '')
      return out.replace(/\\n{4,}/g,'\\n\\n\\n').trimEnd() + '\\n'
    }
    function enhanceMdCodeCopy(root){
      if(!root) return
      const blocks = root.querySelectorAll('pre')
      blocks.forEach((pre)=>{
        if(pre.querySelector('.ndh-code-copy')) return
        const code = pre.querySelector('code')
        if(!code) return
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'ndh-code-copy'
        btn.textContent = '复制'
        btn.addEventListener('click', async ()=>{
          const text = String(code.textContent || '')
          try{ await navigator.clipboard.writeText(text); toast('ok','已复制','') }catch{ toast('bad','复制失败','') }
        })
        pre.style.position = 'relative'
        pre.appendChild(btn)
      })
    }
    function showPostPreview(){
      const overlay = document.getElementById('post_preview_overlay')
      const body = document.getElementById('post_preview_body')
      if(!overlay || !body) return
      try{
        const md = buildPostMarkdownFromEditor()
        const parts = splitPostFrontMatter(md)
        body.innerHTML = mdToHtml(parts.body || '')
        enhanceMdCodeCopy(body)
      }catch(e){
        body.innerHTML = '<div class="card">预览失败：' + esc(e && e.message ? e.message : String(e || '')) + '</div>'
      }
      overlay.classList.remove('hidden')
    }
    function hidePostPreview(){
      const overlay = document.getElementById('post_preview_overlay')
      if(!overlay) return
      overlay.classList.add('hidden')
    }
    function flashSaved(){
      const ok = document.getElementById('post_saved')
      const dirty = document.getElementById('post_dirty')
      if(dirty) dirty.style.display = 'none'
      if(ok){
        ok.style.display = ''
        setTimeout(()=>{ try{ ok.style.display = 'none' }catch{} }, 1200)
      }
    }
    function markDirty(){
      state._postDirty = true
      const dirty = document.getElementById('post_dirty')
      const ok = document.getElementById('post_saved')
      if(ok) ok.style.display = 'none'
      if(dirty) dirty.style.display = ''
    }
    function bindPostEditor(){
      const ed = document.getElementById('post_editor')
      if(!ed || ed._ndhBound) return
      ed._ndhBound = true
      let t = 0
      const persistDraft = ()=>{
        if(t) clearTimeout(t)
        t = setTimeout(()=>{
          const p = state._postActive || ''
          if(!p) return
          localStorage.setItem('ndh-admin-post-draft::' + p, buildPostMarkdownFromEditor())
        }, 300)
      }
      const onDirty = ()=>{
        persistDraft()
        markDirty()
        updatePostStats()
      }
      ed.addEventListener('input', onDirty)
      ed.addEventListener('keyup', updatePostStats)
      ed.addEventListener('click', updatePostStats)
      ed.addEventListener('paste', (e)=>{
        try{
          e.preventDefault()
          const text = (e.clipboardData || window.clipboardData).getData('text/plain') || ''
          document.execCommand('insertText', false, text)
        }catch{}
      })
      const titleEl = document.getElementById('post_meta_title')
      const dateEl = document.getElementById('post_meta_date')
      const draftEl = document.getElementById('post_meta_draft')
      ;[titleEl, dateEl].forEach(x=>{ if(x) x.addEventListener('input', onDirty) })
      if(draftEl) draftEl.addEventListener('change', onDirty)

      ed.addEventListener('keydown', (e)=>{
        const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '')
        const mod = isMac ? e.metaKey : e.ctrlKey
        if(mod && !e.shiftKey && e.key.toLowerCase() === 'b'){ e.preventDefault(); mdAct('bold'); return }
        if(mod && !e.shiftKey && e.key.toLowerCase() === 'i'){ e.preventDefault(); mdAct('italic'); return }
        if(mod && !e.shiftKey && e.key.toLowerCase() === 'k'){ e.preventDefault(); mdAct('link'); return }
        if(e.key === 'Tab'){
          e.preventDefault()
          try{ document.execCommand('insertText', false, '  ') }catch{}
          onDirty()
        }
      })
    }
    function updatePostStats(){
      const ed = document.getElementById('post_editor')
      const left = document.getElementById('post_stat_left')
      const right = document.getElementById('post_stat_right')
      if(!ed || !left || !right) return
      const txt = String(ed.innerText || '').replace(/\\u00a0/g,' ')
      const chars = txt.length
      const words = txt.replace(/\\s+/g,' ').trim() ? txt.replace(/\\s+/g,' ').trim().split(' ').length : 0
      const blocks = ed.querySelectorAll('p,h1,h2,h3,h4,h5,h6,blockquote,pre,ul,ol,table').length || 0
      left.textContent = '字：' + words + '  字符：' + chars + '  段落：' + blocks
      const sel = window.getSelection ? window.getSelection() : null
      const selected = sel && sel.toString ? String(sel.toString() || '') : ''
      right.textContent = selected ? ('选中：' + selected.length) : '就绪'
    }
    function bindPostKeysOnce(){
      if(window._ndhPostKeysBound) return
      window._ndhPostKeysBound = true
      window.addEventListener('keydown', (e)=>{
        const onPosts = location.pathname.startsWith('/admin/posts')
        if(!onPosts) return
        const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '')
        const mod = isMac ? e.metaKey : e.ctrlKey
        if(mod && e.key.toLowerCase() === 's'){
          e.preventDefault()
          savePost()
          return
        }
        if(mod && e.key === 'Enter'){
          e.preventDefault()
          publishPost()
        }
      })
    }
    function mdAct(kind){
      const ed = document.getElementById('post_editor')
      if(!ed) return
      ed.focus()
      const insertHtml = (html)=>{
        try{ document.execCommand('insertHTML', false, html) }catch{}
      }
      if(kind === 'bold'){ try{ document.execCommand('bold') }catch{} }
      else if(kind === 'italic'){ try{ document.execCommand('italic') }catch{} }
      else if(kind === 'strike'){ try{ document.execCommand('strikeThrough') }catch{} }
      else if(kind === 'h1'){ try{ document.execCommand('formatBlock', false, 'H1') }catch{} }
      else if(kind === 'h2'){ try{ document.execCommand('formatBlock', false, 'H2') }catch{} }
      else if(kind === 'h3'){ try{ document.execCommand('formatBlock', false, 'H3') }catch{} }
      else if(kind === 'h4'){ try{ document.execCommand('formatBlock', false, 'H4') }catch{} }
      else if(kind === 'quote'){ try{ document.execCommand('formatBlock', false, 'BLOCKQUOTE') }catch{} }
      else if(kind === 'ul'){ try{ document.execCommand('insertUnorderedList') }catch{} }
      else if(kind === 'ol'){ try{ document.execCommand('insertOrderedList') }catch{} }
      else if(kind === 'hr'){ insertHtml('<hr />') }
      else if(kind === 'link'){
        const url = prompt('输入链接 URL')
        if(!url) return
        try{ document.execCommand('createLink', false, url) }catch{}
      }else if(kind === 'image'){
        const url = prompt('输入图片 URL')
        if(!url) return
        const alt = prompt('输入图片说明') || ''
        insertHtml('<img src="' + esc(url) + '" alt="' + esc(alt) + '" loading="lazy" />')
      }else if(kind === 'code'){
        const sel = window.getSelection ? window.getSelection() : null
        if(!sel || sel.rangeCount === 0) return
        const range = sel.getRangeAt(0)
        const code = document.createElement('code')
        try{ range.surroundContents(code) }catch{
          const text = sel.toString() || ''
          if(text) insertHtml('<code>' + esc(text) + '</code>')
        }
      }else if(kind === 'codeblock'){
        const lang = String(prompt('代码块语言（可留空）', 'js') || '').trim()
        const sel = window.getSelection ? window.getSelection() : null
        const text = sel && sel.toString ? String(sel.toString() || '') : ''
        insertHtml('<pre><code' + (lang ? (' data-lang="' + esc(lang) + '"') : '') + '>' + esc(text) + '</code></pre>')
      }else if(kind === 'task'){
        insertHtml('<ul><li><input type="checkbox" disabled /> 待办</li></ul>')
      }else if(kind === 'table'){
        insertHtml('<table><thead><tr><th>标题</th><th>内容</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table>')
      }
      bindPostEditor()
      localStorage.setItem('ndh-admin-post-draft::' + (state._postActive||''), buildPostMarkdownFromEditor())
      markDirty()
      updatePostStats()
    }
    async function deletePost(){
      const p = String(state._postActive || '')
      if(!p){ toast('bad','未选择文章',''); return }
      if(!confirm('确认删除：' + p + ' ？')) return
      try{
        await api('/api/posts/delete', { method:'POST', body: JSON.stringify({ path: p }) })
        localStorage.removeItem('ndh-admin-post-draft::' + p)
        state._postActive = ''
        state._postLoaded = ''
        state._postDirty = false
        toast('ok','已删除', p)
        render()
      }catch(e){ toast('bad','删除失败', e.message || '') }
    }
    async function renamePost(){
      const p = String(state._postActive || '')
      if(!p){ toast('bad','未选择文章',''); return }
      const next = prompt('输入新路径（相对于 content/）', p)
      if(!next || next === p) return
      try{
        await api('/api/posts/rename', { method:'POST', body: JSON.stringify({ from: p, to: next }) })
        const draft = localStorage.getItem('ndh-admin-post-draft::' + p)
        if(draft){
          localStorage.setItem('ndh-admin-post-draft::' + next, draft)
          localStorage.removeItem('ndh-admin-post-draft::' + p)
        }
        state._postActive = next
        state._postLoaded = ''
        toast('ok','已重命名', next)
        render()
      }catch(e){ toast('bad','重命名失败', e.message || '') }
    }
    async function createPost(){
      const slug = prompt('输入文章文件名（不含扩展名），例如：my-post')
      if(!slug) return
      const title = prompt('输入文章标题（可留空）') || slug
      const p = 'posts/' + slug.replace(/\\.md$/i,'') + '.md'
      const tpl = defaultPostTemplate(title, slug)
      try{
        await api('/api/posts/save', { method:'POST', body: JSON.stringify({ path: p, content: tpl }) })
        state._postActive = p
        state._postLoaded = ''
        toast('ok','已创建', p)
        render()
      }catch(e){ toast('bad','创建失败', e.message || '') }
    }
    async function copyText(t){
      try{ await navigator.clipboard.writeText(t); toast('ok','已复制', t) }catch{ toast('bad','复制失败', t) }
    }
    function boolSelect(id, label, value){
      const v = value ? '1' : '0'
      return '<div><div class="muted" style="font-size:12px;margin-bottom:6px">' + esc(label) + '</div><select id="' + esc(id) + '" class="input"><option value="1"' + (v==='1'?' selected':'') + '>是</option><option value="0"' + (v==='0'?' selected':'') + '>否</option></select></div>'
    }
    function numField(id,label,value){
      const v = (value === null || value === undefined) ? '' : String(value)
      return '<div><div class="muted" style="font-size:12px;margin-bottom:6px">' + esc(label) + '</div><input class="input" inputmode="numeric" id="' + esc(id) + '" value="' + esc(v) + '" /></div>'
    }
    function textareaField(id,label,value){
      return '<div><div class="muted" style="font-size:12px;margin-bottom:6px">' + esc(label) + '</div><textarea class="input" id="' + esc(id) + '">' + esc(value || '') + '</textarea></div>'
    }
    function getNumberValue(id, fallback){
      const el = document.getElementById(id)
      const raw = el ? String(el.value||'').trim() : ''
      if(raw === '') return fallback
      const n = Number(raw)
      return Number.isFinite(n) ? n : fallback
    }
    function getBoolValue(id){
      const el = document.getElementById(id)
      return el ? String(el.value) === '1' : false
    }
    function listContainerHtml(id, title, hint){
      return '<div class="card" style="margin-top:12px"><div class="row"><div style="font-weight:800">' + esc(title) + '</div><div class="spacer"></div><button class="btn" onclick="addListItem(\\'' + esc(id) + '\\')">新增</button></div>' +
        (hint ? '<div class="muted" style="margin-top:6px">' + esc(hint) + '</div>' : '') +
        '<div id="' + esc(id) + '" style="margin-top:10px" class="grid"></div></div>'
    }
    function homeTabsContainerHtml(id, title, hint){
      return '<div class="card" style="margin-top:12px"><div class="row"><div style="font-weight:800">' + esc(title) + '</div><div class="spacer"></div><button class="btn" onclick="addHomeTabItem(\\'' + esc(id) + '\\')">新增</button></div>' +
        (hint ? '<div class="muted" style="margin-top:6px">' + esc(hint) + '</div>' : '') +
        '<div id="' + esc(id) + '" style="margin-top:10px" class="grid"></div></div>'
    }
    function setHomeTabType(containerId, idx, nextType){
      const iframeBox = document.getElementById(containerId + '__' + String(idx) + '__iframe')
      const htmlBox = document.getElementById(containerId + '__' + String(idx) + '__htmlwrap')
      const builtinHint = document.getElementById(containerId + '__' + String(idx) + '__builtinHint')
      if(iframeBox) iframeBox.style.display = nextType === 'iframe' ? 'grid' : 'none'
      if(htmlBox) htmlBox.style.display = nextType === 'html' ? 'block' : 'none'
      if(builtinHint) builtinHint.style.display = nextType === 'builtin' ? 'block' : 'none'
    }
    function renderHomeTabItems(containerId, items){
      const el = document.getElementById(containerId)
      if(!el) return
      el.innerHTML = ''
      ;(items||[]).forEach((it, idx)=>{
        const item = it && typeof it === 'object' ? it : {}
        const keyVal = item.key !== undefined && item.key !== null ? String(item.key) : ''
        const iconVal = item.icon !== undefined && item.icon !== null ? String(item.icon) : ''
        const labelVal = item.label !== undefined && item.label !== null ? String(item.label) : ''
        const iframeUrlVal = item.iframeUrl !== undefined && item.iframeUrl !== null ? String(item.iframeUrl) : ''
        const iframeWidthVal = item.iframeWidth !== undefined && item.iframeWidth !== null ? String(item.iframeWidth) : ''
        const iframeHeightVal = item.iframeHeight !== undefined && item.iframeHeight !== null ? String(item.iframeHeight) : ''
        const htmlVal = item.html !== undefined && item.html !== null ? String(item.html) : ''
        const hintedType = item.__type !== undefined && item.__type !== null ? String(item.__type) : ''
        const derivedType = htmlVal.trim() ? 'html' : (iframeUrlVal.trim() ? 'iframe' : 'builtin')
        const type = (hintedType === 'builtin' || hintedType === 'iframe' || hintedType === 'html') ? hintedType : derivedType
        const card = document.createElement('div')
        card.className = 'card'
        const typeId = containerId + '__' + String(idx) + '__type'
        const keyId = containerId + '__' + String(idx) + '__key'
        const iconId = containerId + '__' + String(idx) + '__icon'
        const labelId = containerId + '__' + String(idx) + '__label'
        const iframeUrlId = containerId + '__' + String(idx) + '__iframeUrl'
        const iframeWidthId = containerId + '__' + String(idx) + '__iframeWidth'
        const iframeHeightId = containerId + '__' + String(idx) + '__iframeHeight'
        const htmlId = containerId + '__' + String(idx) + '__html'
        const iframeBoxId = containerId + '__' + String(idx) + '__iframe'
        const htmlBoxId = containerId + '__' + String(idx) + '__htmlwrap'
        const builtinHintId = containerId + '__' + String(idx) + '__builtinHint'
        card.innerHTML =
          '<div class="row"><div class="pill">#' + (idx+1) + '</div><div class="spacer"></div><button class="btn danger" onclick="removeHomeTabItem(\\'' + esc(containerId) + '\\',' + idx + ')">删除</button></div>' +
          '<div class="grid cols-2" style="margin-top:10px">' +
            '<div><div class="muted" style="font-size:12px;margin-bottom:6px">键（key）</div><input class="input" id="' + esc(keyId) + '" value="' + esc(keyVal) + '" /></div>' +
            '<div><div class="muted" style="font-size:12px;margin-bottom:6px">标题</div><input class="input" id="' + esc(labelId) + '" value="' + esc(labelVal) + '" /></div>' +
          '</div>' +
          '<div class="grid cols-2" style="margin-top:10px">' +
            '<div><div class="muted" style="font-size:12px;margin-bottom:6px">图标</div><input class="input" id="' + esc(iconId) + '" value="' + esc(iconVal) + '" /></div>' +
            '<div><div class="muted" style="font-size:12px;margin-bottom:6px">内容类型</div>' +
              '<select class="input" id="' + esc(typeId) + '" onchange="setHomeTabType(\\'' + esc(containerId) + '\\',' + idx + ', this.value)">' +
                '<option value="builtin"' + (type==='builtin'?' selected':'') + '>内置组件</option>' +
                '<option value="iframe"' + (type==='iframe'?' selected':'') + '>iframe</option>' +
                '<option value="html"' + (type==='html'?' selected':'') + '>HTML</option>' +
              '</select>' +
            '</div>' +
          '</div>' +
          '<div id="' + esc(builtinHintId) + '" class="muted" style="margin-top:10px' + (type==='builtin'?'':';display:none') + '">内置组件仅需填写 key/标题/图标</div>' +
          '<div id="' + esc(iframeBoxId) + '" class="grid cols-2" style="margin-top:10px' + (type==='iframe'?'':';display:none') + '">' +
            '<div style="grid-column:1 / -1"><div class="muted" style="font-size:12px;margin-bottom:6px">iframe 地址</div><input class="input" id="' + esc(iframeUrlId) + '" value="' + esc(iframeUrlVal) + '" /></div>' +
            '<div><div class="muted" style="font-size:12px;margin-bottom:6px">iframe 宽度</div><input class="input" id="' + esc(iframeWidthId) + '" value="' + esc(iframeWidthVal) + '" /></div>' +
            '<div><div class="muted" style="font-size:12px;margin-bottom:6px">iframe 高度</div><input class="input" id="' + esc(iframeHeightId) + '" value="' + esc(iframeHeightVal) + '" /></div>' +
          '</div>' +
          '<div id="' + esc(htmlBoxId) + '" style="margin-top:10px' + (type==='html'?'':';display:none') + '">' +
            '<div class="muted" style="font-size:12px;margin-bottom:6px">HTML</div>' +
            '<textarea class="input" id="' + esc(htmlId) + '">' + esc(htmlVal) + '</textarea>' +
          '</div>'
        el.appendChild(card)
      })
      el.dataset.count = String((items||[]).length)
    }
    function readHomeTabItems(containerId){
      const el = document.getElementById(containerId)
      const count = el ? Number(el.dataset.count || '0') : 0
      const items = []
      for(let i=0;i<count;i++){
        const typeEl = document.getElementById(containerId + '__' + String(i) + '__type')
        const type = typeEl ? String(typeEl.value || '') : 'builtin'
        const keyEl = document.getElementById(containerId + '__' + String(i) + '__key')
        const iconEl = document.getElementById(containerId + '__' + String(i) + '__icon')
        const labelEl = document.getElementById(containerId + '__' + String(i) + '__label')
        const key = keyEl ? String(keyEl.value || '').trim() : ''
        const icon = iconEl ? String(iconEl.value || '').trim() : ''
        const label = labelEl ? String(labelEl.value || '').trim() : ''
        const obj = {}
        obj.__type = type
        if(key) obj.key = key
        if(icon) obj.icon = icon
        if(label) obj.label = label
        if(type === 'iframe'){
          const iframeUrlEl = document.getElementById(containerId + '__' + String(i) + '__iframeUrl')
          const iframeWidthEl = document.getElementById(containerId + '__' + String(i) + '__iframeWidth')
          const iframeHeightEl = document.getElementById(containerId + '__' + String(i) + '__iframeHeight')
          const iframeUrl = iframeUrlEl ? String(iframeUrlEl.value || '').trim() : ''
          const iframeWidth = iframeWidthEl ? String(iframeWidthEl.value || '').trim() : ''
          const iframeHeight = iframeHeightEl ? String(iframeHeightEl.value || '').trim() : ''
          if(iframeUrl) obj.iframeUrl = iframeUrl
          if(iframeWidth) obj.iframeWidth = iframeWidth
          if(iframeHeight) obj.iframeHeight = iframeHeight
        }
        if(type === 'html'){
          const htmlEl = document.getElementById(containerId + '__' + String(i) + '__html')
          const html = htmlEl ? String(htmlEl.value || '').trim() : ''
          if(html) obj.html = html
        }
        items.push(obj)
      }
      return items
    }
    function addHomeTabItem(containerId){
      const items = readHomeTabItems(containerId)
      items.push({ __type:'builtin', key:'', icon:'', label:'' })
      renderHomeTabItems(containerId, items)
      setTimeout(()=>{ try{ document.getElementById(containerId + '__' + String(items.length-1) + '__key').focus() }catch{} }, 0)
    }
    function removeHomeTabItem(containerId, idx){
      const items = readHomeTabItems(containerId)
      const next = items.filter((_,i)=>i!==idx)
      renderHomeTabItems(containerId, next)
    }
    function renderListItems(containerId, items, fields){
      const el = document.getElementById(containerId)
      if(!el) return
      el.innerHTML = ''
      ;(items||[]).forEach((it, idx)=>{
        const card = document.createElement('div')
        card.className = 'card'
        card.dataset.item = containerId
        card.dataset.index = String(idx)
        const inner = []
        inner.push('<div class="row"><div class="pill">#' + (idx+1) + '</div><div class="spacer"></div><button class="btn danger" onclick="removeListItem(\\'' + esc(containerId) + '\\',' + idx + ')">删除</button></div>')
        inner.push('<div class="grid cols-2" style="margin-top:10px">' + fields.map(f=>{
          const val = it && it[f.key] !== undefined && it[f.key] !== null ? String(it[f.key]) : ''
          const id = containerId + '__' + String(idx) + '__' + f.key
          return '<div><div class="muted" style="font-size:12px;margin-bottom:6px">' + esc(f.label) + '</div><input class="input" id="' + esc(id) + '" value="' + esc(val) + '" /></div>'
        }).join('') + '</div>')
        card.innerHTML = inner.join('')
        el.appendChild(card)
      })
      el.dataset.count = String((items||[]).length)
      el.dataset.fields = JSON.stringify(fields.map(f=>f.key))
    }
    function readListItems(containerId, fields){
      const el = document.getElementById(containerId)
      const count = el ? Number(el.dataset.count || '0') : 0
      const items = []
      for(let i=0;i<count;i++){
        const obj = {}
        fields.forEach(k=>{
          const id = containerId + '__' + String(i) + '__' + k
          const v = document.getElementById(id)
          const s = v ? String(v.value||'').trim() : ''
          if(s !== '') obj[k] = s
        })
        items.push(obj)
      }
      return items
    }
    function addListItem(containerId){
      const el = document.getElementById(containerId)
      if(!el) return
      const count = Number(el.dataset.count || '0')
      const fields = JSON.parse(el.dataset.fields || '[]')
      const items = readListItems(containerId, fields)
      items.push({})
      renderListItems(containerId, items, fields.map(k=>({ key:k, label:k })))
    }
    function removeListItem(containerId, idx){
      const el = document.getElementById(containerId)
      if(!el) return
      const fields = JSON.parse(el.dataset.fields || '[]')
      const items = readListItems(containerId, fields)
      const next = items.filter((_,i)=>i!==idx)
      renderListItems(containerId, next, fields.map(k=>({ key:k, label:k })))
    }
    function splitLines(s){
      return String(s || '').split('\\n').map(x=>x.trim()).filter(Boolean)
    }
    function joinLines(arr){
      return (Array.isArray(arr) ? arr : []).map(x=>String(x)).join('\\n')
    }
    async function renderHugoConfig(){
      const head = '<div class="top"><div><div style="font-size:18px;font-weight:800">站点配置</div><div class="muted" style="margin-top:4px">可视化管理 config.toml（保存只改对应键，尽量保留原文件结构）</div></div><div class="row"><button class="btn primary" onclick="saveHugoConfig()">保存</button><button class="btn" onclick="render()">刷新</button></div></div>'
      let cfg=null
      try{ cfg = await api('/api/hugo-config') }catch(e){ return layout('hugo', head + '<div class="card">加载失败：' + esc(e.message) + '</div>') }
      const c = cfg && cfg.config ? cfg.config : {}
      state._hugoMeta = c && c.meta && typeof c.meta === 'object' ? c.meta : {}
      const hasAi = Boolean(state._hugoMeta && state._hugoMeta.hasAi)
      const hasBilibili = Boolean(state._hugoMeta && state._hugoMeta.hasBilibili)
      const hasRedirect = Boolean(state._hugoMeta && state._hugoMeta.hasRedirect)
      const base = c.base || {}
      const build = c.build || {}
      const minify = build.minify || {}
      const buildOutputs = build.outputs || {}
      const fmt = (build.outputFormats && build.outputFormats.bookmarks) ? build.outputFormats.bookmarks : {}
      const markup = build.markup || {}
      const params = c.params || {}
      const ai = params.ai || {}
      const seo = params.seo || {}
      const images = params.images || {}
      const footer = params.footer || {}
      const header = params.header || {}
      const redirect = params.redirect || {}
      const cdn = params.cdn || {}
      const bilibili = params.bilibili || {}
      const hot = params.hot || {}
      const hotApi = params.hotApi || {}
      const bookmarks = params.bookmarks || {}

      const basic = '<div class="card" style="margin-top:12px"><div class="section-title"><span class="tag">基础</span><span class="muted">站点与构建</span></div>' +
        '<div class="grid cols-2" style="margin-top:12px">' +
          field('hc_baseURL','站点 URL', base.baseURL || '') +
          field('hc_title','站点标题', base.title || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_languageCode','语言代码', base.languageCode || '') +
          field('hc_theme','主题', base.theme || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_publishDir','输出目录', base.publishDir || '') +
          boolSelect('hc_preserveTaxonomyNames','保留分类名大小写', Boolean(base.preserveTaxonomyNames)) +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          boolSelect('hc_relativeURLs','相对链接模式', Boolean(base.relativeURLs)) +
          boolSelect('hc_disablePathToLower','禁用路径小写化', Boolean(base.disablePathToLower)) +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          boolSelect('hc_hasCJKLanguage','启用 CJK 分词', Boolean(base.hasCJKLanguage)) +
          numField('hc_cardListCollapseLimit','卡片折叠阈值', params.cardListCollapseLimit) +
        '</div>' +
      '</div>'

      const buildCard = '<div class="card" style="margin-top:12px"><div class="section-title"><span class="tag">构建</span><span class="muted">压缩/输出/书签</span></div>' +
        '<div class="grid cols-2" style="margin-top:12px">' +
          boolSelect('hc_minify_disableHTML','禁用 HTML 压缩', Boolean(minify.disableHTML)) +
          boolSelect('hc_minify_disableCSS','禁用 CSS 压缩', Boolean(minify.disableCSS)) +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          boolSelect('hc_minify_disableJS','禁用 JS 压缩', Boolean(minify.disableJS)) +
          boolSelect('hc_minify_minifyOutput','启用压缩输出', Boolean(minify.minifyOutput)) +
        '</div>' +
        '<div style="margin-top:10px">' +
          textareaField('hc_outputs_home','首页输出（每行一个）', joinLines(buildOutputs.home || [])) +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          boolSelect('hc_markup_unsafe','允许渲染原始 HTML', Boolean(markup.unsafe)) +
          field('hc_bookmarks_title','书签页标题', bookmarks.title || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_of_mediaType','书签输出：媒体类型', fmt.mediaType || '') +
          field('hc_of_baseName','书签输出：文件名', fmt.baseName || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          boolSelect('hc_of_isPlainText','书签输出：纯文本', Boolean(fmt.isPlainText)) +
          boolSelect('hc_of_notAlternative','书签输出：非备选格式', Boolean(fmt.notAlternative)) +
        '</div>' +
      '</div>'

      const paramsBasic = '<div class="card" style="margin-top:12px"><div class="section-title"><span class="tag">参数</span><span class="muted">作者/仓库/音乐/预加载</span></div>' +
        '<div class="grid cols-2" style="margin-top:12px">' +
          field('hc_author','作者', params.author || '') +
          field('hc_repository','仓库地址', params.repository || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_siteurl','站点地址', params.siteurl || '') +
          field('hc_about','关于页', params.about || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_musicServer','音乐服务', params.musicServer || '') +
          field('hc_musicId','音乐 ID', params.musicId || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          boolSelect('hc_enablePreLoad','启用预加载', Boolean(params.enablePreLoad)) +
          field('hc_textPreLoad','预加载文案', params.textPreLoad || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_logosPath','LOGO 目录', params.logosPath || '') +
          field('hc_defaultLogo','默认 LOGO', params.defaultLogo || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          boolSelect('hc_nightMode','默认暗黑模式', Boolean(params.nightMode)) +
          field('hc_cdn_fontawesome','FontAwesome CDN', cdn.fontawesome || '') +
        '</div>' +
      '</div>'

      const seoCard = '<div class="card" style="margin-top:12px"><div class="section-title"><span class="tag">SEO</span><span class="muted">站点信息/验证/OpenGraph</span></div>' +
        '<div class="grid cols-2" style="margin-top:12px">' +
          textareaField('hc_description','站点描述', params.description || '') +
          textareaField('hc_keywords','站点关键词', params.keywords || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_baiduhmid','百度统计 hmid', seo.baiduhmid || '') +
          field('hc_baiduSiteVer','百度站点验证', seo.baiduSiteVer || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          boolSelect('hc_enable51la','启用 51LA', Boolean(seo.enable51la)) +
          field('hc_tj51laid','51LA ID', seo.tj51laid || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_tj51lack','51LA Key', seo.tj51lack || '') +
          field('hc_og_url','OpenGraph URL', params.og_url || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_og_title','OpenGraph 标题', params.og_title || '') +
          textareaField('hc_og_description','OpenGraph 描述', params.og_description || '') +
        '</div>' +
        '<div style="margin-top:10px">' +
          field('hc_og_image','OpenGraph 图片', params.og_image || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_tw_title','Twitter 标题', params.twitter_title || '') +
          textareaField('hc_tw_description','Twitter 描述', params.twitter_description || '') +
        '</div>' +
        '<div style="margin-top:10px">' +
          field('hc_tw_image','Twitter 图片', params.twitter_image || '') +
        '</div>' +
      '</div>'

      const aiCard = '<div class="card" style="margin-top:12px"><div class="section-title"><span class="tag">AI</span><span class="muted">面板/模型/检索</span></div>' +
        '<div class="grid cols-2" style="margin-top:12px">' +
          boolSelect('hc_ai_enable','启用 AI 面板', Boolean(ai.enable)) +
          field('hc_ai_model','模型', ai.model || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_ai_apiUrl','API 地址', ai.apiUrl || '') +
          field('hc_ai_mcpUrl','MCP 地址', ai.mcpUrl || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_ai_mcpSearchUrl','MCP 搜索地址', ai.mcpSearchUrl || '') +
          field('hc_ai_searchMode','搜索模式', ai.searchMode || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          boolSelect('hc_ai_enableMcp','启用 MCP', Boolean(ai.enableMcp)) +
          boolSelect('hc_ai_enableLocalSearch','启用本地搜索', Boolean(ai.enableLocalSearch)) +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          boolSelect('hc_ai_enableThinking','启用思考', Boolean(ai.enableThinking)) +
          numField('hc_ai_maxTokens','最大 Token', ai.maxTokens) +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          numField('hc_ai_temperature','温度', ai.temperature) +
          field('hc_ai_placeholder','输入框占位文案', ai.placeholder || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_ai_iconUrl','AI 图标', ai.iconUrl || '') +
          field('hc_ai_panelHeaderTitle','面板标题', ai.panelHeaderTitle || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_ai_buttonIconUrl','按钮图标', ai.buttonIconUrl || '') +
          field('hc_ai_panelIconUrl','面板图标', ai.panelIconUrl || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_ai_assistantAvatarUrl','助手头像', ai.assistantAvatarUrl || '') +
          field('hc_ai_userAvatarUrl','用户头像', ai.userAvatarUrl || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_ai_assistantAvatarLabel','助手昵称', ai.assistantAvatarLabel || '') +
          field('hc_ai_userAvatarLabel','用户昵称', ai.userAvatarLabel || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_ai_welcomeTitle','欢迎标题', ai.welcomeTitle || '') +
          textareaField('hc_ai_welcomeText','欢迎内容', ai.welcomeText || '') +
        '</div>' +
        '<div style="margin-top:10px">' +
          textareaField('hc_ai_systemPrompt','系统提示词', ai.systemPrompt || '') +
        '</div>' +
        '<div class="row" style="margin-top:12px"><span class="muted">apiKey 为安全起见固定保持空值</span><div class="spacer"></div></div>' +
      '</div>'

      const assets = '<div class="card" style="margin-top:12px"><div class="section-title"><span class="tag">外观</span><span class="muted">图片/跳转</span></div>' +
        '<div class="grid cols-2" style="margin-top:12px">' +
          field('hc_images_favicon','网站图标', images.favicon || '') +
          field('hc_images_logoExpandLight','展开 LOGO（亮色）', images.logoExpandLight || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_images_logoExpandDark','展开 LOGO（暗色）', images.logoExpandDark || '') +
          field('hc_images_logoCollapseLight','折叠 LOGO（亮色）', images.logoCollapseLight || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_images_logoCollapseDark','折叠 LOGO（暗色）', images.logoCollapseDark || '') +
          (hasRedirect ? field('hc_redirect_logo','跳转页 LOGO', redirect.logo || '') : '<div></div>') +
        '</div>' +
        (hasRedirect ? (
          '<div class="grid cols-2" style="margin-top:10px">' +
            field('hc_redirect_favicon','跳转页图标', redirect.favicon || '') +
            field('hc_redirect_siteName','站点名称', redirect.siteName || '') +
          '</div>' +
          '<div class="grid cols-2" style="margin-top:10px">' +
            field('hc_redirect_siteTip','提示文案', redirect.siteTip || '') +
            field('hc_redirect_leaveTip','离开提示', redirect.leaveTip || '') +
          '</div>'
        ) : '') +
      '</div>'

      const footerCard = '<div class="card" style="margin-top:12px"><div class="section-title"><span class="tag">页脚</span><span class="muted">版权/统计/菜单</span></div>' +
        '<div class="grid cols-2" style="margin-top:12px">' +
          boolSelect('hc_footer_busuanzi','启用不蒜子', Boolean(footer.busuanzi)) +
          boolSelect('hc_footer_forceReload','启用强制刷新提示', Boolean(footer.enableForceReloadTip)) +
        '</div>' +
        '<div style="margin-top:10px">' +
          textareaField('hc_footer_copyright','版权信息', footer.copyright || '') +
        '</div>' +
      '</div>'

      const headerCard = '<div class="card" style="margin-top:12px"><div class="section-title"><span class="tag">头部</span><span class="muted">首页头图/标签页/接口</span></div>' +
        '<div class="grid cols-2" style="margin-top:12px">' +
          field('hc_heroBadge','角标文案', header.heroBadge || '') +
          field('hc_heroBackdropWord','背景大字', header.heroBackdropWord || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_heroTitle','主标题', header.heroTitle || '') +
          field('hc_heroSubtitle','副标题', header.heroSubtitle || '') +
        '</div>' +
        '<div style="margin-top:10px">' +
          field('hc_heroSubnote','补充说明', header.heroSubnote || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_heroCardLabel','卡片标签', header.heroCardLabel || '') +
          textareaField('hc_heroStickers','装饰文案（每行一个）', joinLines(header.heroStickers || [])) +
        '</div>' +
        '<div style="margin-top:10px">' +
          textareaField('hc_heroFloatingBadges','浮动徽标（每行一个）', joinLines(header.heroFloatingBadges || [])) +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_rssmergeUrl','RSS 合并地址', header.rssmergeUrl || '') +
          field('hc_talkUrl','对话地址', header.talkUrl || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_rssApiUrl','RSS API 地址', header.rssApiUrl || '') +
          field('hc_exportBookmarksUrl','导出书签地址', header.exportBookmarksUrl || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_recentSitesApi','最近收录 API', header.recentSitesApi || '') +
          field('hc_statisticsApi','统计 API', header.statisticsApi || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_serverUrl','后台服务地址', header.serverUrl || '') +
          field('hc_consoleUrl','后台入口地址', header.consoleUrl || '/admin') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_statisticsMode','统计模式', header.statisticsMode || '') +
          field('hc_searchPlaceholder','搜索框占位文案', header.searchPlaceholder || '') +
        '</div>' +
        '<div style="margin-top:10px">' +
          field('hc_recentSitesTitle','最近收录标题', header.recentSitesTitle || '') +
        '</div>' +
      '</div>'

      const hotCard = '<div class="card" style="margin-top:12px"><div class="section-title"><span class="tag">热榜</span><span class="muted">接口/条目</span></div>' +
        '<div style="margin-top:12px">' +
          textareaField('hc_hotApi_endpoints','热榜接口（每行一个）', joinLines(hotApi.endpoints || [])) +
        '</div>' +
      '</div>'

      const mediaCard = '<div class="card" style="margin-top:12px"><div class="section-title"><span class="tag">媒体</span><span class="muted">B站收藏</span></div>' +
        '<div class="grid cols-2" style="margin-top:12px">' +
          field('hc_bili_mediaId','B站媒体 ID', bilibili.mediaId || '') +
          field('hc_bili_iframeUrl','B站 iframe 地址', bilibili.iframeUrl || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_bili_width','B站宽度', bilibili.width || '') +
          field('hc_bili_height','B站高度', bilibili.height || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_bili_iframeWidth','B站 iframe 宽度', bilibili.iframeWidth || '') +
          field('hc_bili_iframeHeight','B站 iframe 高度', bilibili.iframeHeight || '') +
        '</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          field('hc_bili_iframeStyle','B站 iframe 样式', bilibili.iframeStyle || '') +
          field('hc_bili_iframeLoading','B站 iframe Loading', bilibili.iframeLoading || '') +
        '</div>' +
      '</div>'

      const body = basic + buildCard + paramsBasic + seoCard + (hasAi ? aiCard : '') + assets + footerCard + headerCard + hotCard + (hasBilibili ? mediaCard : '')

      setTimeout(()=>{
        if(hasAi) renderListItems('hc_welcomeTips', ai.welcomeTips || [], [{ key:'label', label:'按钮文案' }, { key:'q', label:'问题' }])
        renderListItems('hc_heroActions', header.heroActions || [], [{ key:'label', label:'文案' }, { key:'url', label:'链接' }, { key:'icon', label:'图标' }, { key:'target', label:'打开方式' }])
        renderListItems('hc_toggleMenu', footer.toggleMenu || [], [{ key:'url', label:'链接' }, { key:'key', label:'键' }, { key:'icon', label:'图标' }, { key:'title', label:'标题' }, { key:'target', label:'打开方式' }])
        renderListItems('hc_announcements', header.announcements || [], [{ key:'url', label:'链接' }, { key:'text', label:'文案' }])
        renderListItems('hc_adList', header.adList || [], [{ key:'img', label:'图片' }, { key:'url', label:'链接' }, { key:'desc', label:'描述' }])
        renderListItems('hc_hot_items', hot.items || [], [{ key:'id', label:'ID' }, { key:'title', label:'标题' }, { key:'icon', label:'图标' }, { key:'color', label:'颜色' }])
        renderListItems('hc_heroHighlights', header.heroHighlights || [], [{ key:'icon', label:'图标' }, { key:'text', label:'文本' }])
        renderListItems('hc_heroStats', header.heroStats || [], [{ key:'value', label:'数值' }, { key:'label', label:'文案' }])
        renderHomeTabItems('hc_tabs', header.tabs || [])
      }, 0)

      const lists = '<div style="height:12px"></div>' +
        (hasAi ? listContainerHtml('hc_welcomeTips','AI 欢迎提示','可配置按钮：文案 + 问题') : '') +
        listContainerHtml('hc_heroActions','首页主按钮','可配置按钮：文案/链接/图标/打开方式') +
        listContainerHtml('hc_heroHighlights','首页亮点','可配置图标 + 文本') +
        listContainerHtml('hc_heroStats','首页统计','可配置数值 + 文案') +
        homeTabsContainerHtml('hc_tabs','首页标签页','内置组件只需 key/标题/图标；自定义内容可选 iframe 或 HTML') +
        listContainerHtml('hc_toggleMenu','页脚菜单','可配置 URL/key/icon/标题/打开方式') +
        listContainerHtml('hc_announcements','公告列表','可配置链接 + 文案') +
        listContainerHtml('hc_adList','广告位','可配置图片/链接/描述') +
        listContainerHtml('hc_hot_items','热榜条目','可配置 ID/标题/图标/颜色')
      return layout('hugo', head + body + lists)
    }

    async function saveHugoConfig(){
      const meta = state._hugoMeta && typeof state._hugoMeta === 'object' ? state._hugoMeta : {}
      const hasAi = Boolean(meta.hasAi)
      const hasBilibili = Boolean(meta.hasBilibili)
      const hasRedirect = Boolean(meta.hasRedirect)
      const payload = {
        base: {
          baseURL: document.getElementById('hc_baseURL').value.trim(),
          title: document.getElementById('hc_title').value.trim(),
          languageCode: document.getElementById('hc_languageCode').value.trim(),
          theme: document.getElementById('hc_theme').value.trim(),
          publishDir: document.getElementById('hc_publishDir').value.trim(),
          preserveTaxonomyNames: getBoolValue('hc_preserveTaxonomyNames'),
          relativeURLs: getBoolValue('hc_relativeURLs'),
          disablePathToLower: getBoolValue('hc_disablePathToLower'),
          hasCJKLanguage: getBoolValue('hc_hasCJKLanguage')
        },
        build: {
          minify: {
            disableHTML: getBoolValue('hc_minify_disableHTML'),
            disableCSS: getBoolValue('hc_minify_disableCSS'),
            disableJS: getBoolValue('hc_minify_disableJS'),
            minifyOutput: getBoolValue('hc_minify_minifyOutput')
          },
          outputs: {
            home: splitLines(document.getElementById('hc_outputs_home').value)
          },
          outputFormats: {
            bookmarks: {
              mediaType: document.getElementById('hc_of_mediaType').value.trim(),
              baseName: document.getElementById('hc_of_baseName').value.trim(),
              isPlainText: getBoolValue('hc_of_isPlainText'),
              notAlternative: getBoolValue('hc_of_notAlternative')
            }
          },
          markup: { unsafe: getBoolValue('hc_markup_unsafe') }
        },
        params: {
          author: document.getElementById('hc_author').value.trim(),
          siteurl: document.getElementById('hc_siteurl').value.trim(),
          about: document.getElementById('hc_about').value.trim(),
          repository: document.getElementById('hc_repository').value.trim(),
          musicServer: document.getElementById('hc_musicServer').value.trim(),
          musicId: document.getElementById('hc_musicId').value.trim(),
          description: document.getElementById('hc_description').value,
          keywords: document.getElementById('hc_keywords').value,
          og_title: document.getElementById('hc_og_title').value.trim(),
          og_description: document.getElementById('hc_og_description').value,
          og_image: document.getElementById('hc_og_image').value.trim(),
          og_url: document.getElementById('hc_og_url').value.trim(),
          twitter_title: document.getElementById('hc_tw_title').value.trim(),
          twitter_description: document.getElementById('hc_tw_description').value,
          twitter_image: document.getElementById('hc_tw_image').value.trim(),
          enablePreLoad: getBoolValue('hc_enablePreLoad'),
          textPreLoad: document.getElementById('hc_textPreLoad').value,
          logosPath: document.getElementById('hc_logosPath').value.trim(),
          defaultLogo: document.getElementById('hc_defaultLogo').value.trim(),
          nightMode: getBoolValue('hc_nightMode'),
          cardListCollapseLimit: getNumberValue('hc_cardListCollapseLimit', 24),
          seo: {
            baiduhmid: document.getElementById('hc_baiduhmid').value.trim(),
            baiduSiteVer: document.getElementById('hc_baiduSiteVer').value.trim(),
            enable51la: getBoolValue('hc_enable51la'),
            tj51laid: document.getElementById('hc_tj51laid').value.trim(),
            tj51lack: document.getElementById('hc_tj51lack').value.trim()
          },
          ai: hasAi ? {
            enable: getBoolValue('hc_ai_enable'),
            iconUrl: document.getElementById('hc_ai_iconUrl').value.trim(),
            buttonIconUrl: document.getElementById('hc_ai_buttonIconUrl').value.trim(),
            panelIconUrl: document.getElementById('hc_ai_panelIconUrl').value.trim(),
            panelHeaderTitle: document.getElementById('hc_ai_panelHeaderTitle').value.trim(),
            assistantAvatarUrl: document.getElementById('hc_ai_assistantAvatarUrl').value.trim(),
            userAvatarUrl: document.getElementById('hc_ai_userAvatarUrl').value.trim(),
            assistantAvatarLabel: document.getElementById('hc_ai_assistantAvatarLabel').value.trim(),
            userAvatarLabel: document.getElementById('hc_ai_userAvatarLabel').value.trim(),
            apiUrl: document.getElementById('hc_ai_apiUrl').value.trim(),
            model: document.getElementById('hc_ai_model').value.trim(),
            mcpUrl: document.getElementById('hc_ai_mcpUrl').value.trim(),
            mcpSearchUrl: document.getElementById('hc_ai_mcpSearchUrl').value.trim(),
            enableMcp: getBoolValue('hc_ai_enableMcp'),
            enableLocalSearch: getBoolValue('hc_ai_enableLocalSearch'),
            searchMode: document.getElementById('hc_ai_searchMode').value.trim(),
            enableThinking: getBoolValue('hc_ai_enableThinking'),
            maxTokens: getNumberValue('hc_ai_maxTokens', 4096),
            temperature: getNumberValue('hc_ai_temperature', 0.7),
            systemPrompt: document.getElementById('hc_ai_systemPrompt').value,
            placeholder: document.getElementById('hc_ai_placeholder').value.trim(),
            welcomeTitle: document.getElementById('hc_ai_welcomeTitle').value.trim(),
            welcomeText: document.getElementById('hc_ai_welcomeText').value,
            welcomeTips: readListItems('hc_welcomeTips', ['label','q'])
          } : undefined,
          cdn: { fontawesome: document.getElementById('hc_cdn_fontawesome').value.trim() },
          images: {
            favicon: document.getElementById('hc_images_favicon').value.trim(),
            logoExpandLight: document.getElementById('hc_images_logoExpandLight').value.trim(),
            logoExpandDark: document.getElementById('hc_images_logoExpandDark').value.trim(),
            logoCollapseLight: document.getElementById('hc_images_logoCollapseLight').value.trim(),
            logoCollapseDark: document.getElementById('hc_images_logoCollapseDark').value.trim()
          },
          bookmarks: { title: document.getElementById('hc_bookmarks_title').value.trim() },
          redirect: hasRedirect ? {
            siteName: document.getElementById('hc_redirect_siteName').value.trim(),
            siteTip: document.getElementById('hc_redirect_siteTip').value.trim(),
            leaveTip: document.getElementById('hc_redirect_leaveTip').value,
            logo: document.getElementById('hc_redirect_logo').value.trim(),
            favicon: document.getElementById('hc_redirect_favicon').value.trim()
          } : undefined,
          footer: {
            copyright: document.getElementById('hc_footer_copyright').value,
            busuanzi: getBoolValue('hc_footer_busuanzi'),
            enableForceReloadTip: getBoolValue('hc_footer_forceReload'),
            toggleMenu: readListItems('hc_toggleMenu', ['url','key','icon','title','target'])
          },
          header: {
            heroBadge: document.getElementById('hc_heroBadge').value.trim(),
            heroBackdropWord: document.getElementById('hc_heroBackdropWord').value.trim(),
            heroTitle: document.getElementById('hc_heroTitle').value.trim(),
            heroSubtitle: document.getElementById('hc_heroSubtitle').value.trim(),
            heroSubnote: document.getElementById('hc_heroSubnote').value.trim(),
            heroCardLabel: document.getElementById('hc_heroCardLabel').value.trim(),
            heroStickers: splitLines(document.getElementById('hc_heroStickers').value),
            heroFloatingBadges: splitLines(document.getElementById('hc_heroFloatingBadges').value),
            heroActions: readListItems('hc_heroActions', ['label','url','icon','target']),
            heroHighlights: readListItems('hc_heroHighlights', ['icon','text']),
            heroStats: readListItems('hc_heroStats', ['value','label']),
            tabs: (()=>{
              const raw = readHomeTabItems('hc_tabs') || []
              return raw.map(t=>{
                const o = {}
                if(t && typeof t === 'object'){
                  ;['key','icon','label','iframeUrl','iframeWidth','iframeHeight','html'].forEach(k=>{
                    if(t[k] !== undefined && t[k] !== null){
                      const v = String(t[k] || '').trim()
                      if(v) o[k] = v
                    }
                  })
                }
                return o
              }).filter(o=>Object.keys(o).length)
            })(),
            rssmergeUrl: document.getElementById('hc_rssmergeUrl').value.trim(),
            talkUrl: document.getElementById('hc_talkUrl').value.trim(),
            rssApiUrl: document.getElementById('hc_rssApiUrl').value.trim(),
            exportBookmarksUrl: document.getElementById('hc_exportBookmarksUrl').value.trim(),
            recentSitesApi: document.getElementById('hc_recentSitesApi').value.trim(),
            statisticsApi: document.getElementById('hc_statisticsApi').value.trim(),
            serverUrl: document.getElementById('hc_serverUrl').value.trim(),
            consoleUrl: document.getElementById('hc_consoleUrl').value.trim(),
            statisticsMode: document.getElementById('hc_statisticsMode').value.trim(),
            searchPlaceholder: document.getElementById('hc_searchPlaceholder').value,
            recentSitesTitle: document.getElementById('hc_recentSitesTitle').value,
            announcements: readListItems('hc_announcements', ['url','text']),
            adList: readListItems('hc_adList', ['img','url','desc'])
          },
          hotApi: { endpoints: splitLines(document.getElementById('hc_hotApi_endpoints').value) },
          hot: { items: readListItems('hc_hot_items', ['id','title','icon','color']) },
          bilibili: hasBilibili ? {
            mediaId: document.getElementById('hc_bili_mediaId').value.trim(),
            iframeUrl: document.getElementById('hc_bili_iframeUrl').value.trim(),
            width: document.getElementById('hc_bili_width').value.trim(),
            height: document.getElementById('hc_bili_height').value.trim(),
            iframeWidth: document.getElementById('hc_bili_iframeWidth').value.trim(),
            iframeHeight: document.getElementById('hc_bili_iframeHeight').value.trim(),
            iframeStyle: document.getElementById('hc_bili_iframeStyle').value.trim(),
            iframeLoading: document.getElementById('hc_bili_iframeLoading').value.trim()
          } : undefined
        }
      }
      try{
        await api('/api/hugo-config', { method:'POST', body: JSON.stringify(payload) })
        toast('ok','已保存','')
      }catch(e){ toast('bad','保存失败', e.message || '') }
    }
    async function renderSettings(){
      const head = '<div class="top"><div><div style="font-size:18px;font-weight:800">设置</div><div class="muted" style="margin-top:4px">服务端配置</div></div><div class="row"><button class="btn" onclick="render()">刷新</button></div></div>'
      let s=null
      try{ s = await api('/api/server-settings') }catch(e){ return layout('set', head + '<div class="card">加载失败：' + esc(e.message) + '</div>') }
      const ymlOptions = (Array.isArray(state.dataFiles) ? state.dataFiles : [])
        .filter(n=>/\.ya?ml$/i.test(String(n||'')))
        .map(n=>'<option value="' + esc(n) + '"' + (String(n)===String(s.invalidCheckFilename || '') ? ' selected' : '') + '>' + esc(n) + '</option>')
        .join('')
      const autoRunMeta = (s.invalidCheckAutoLastRunAt || s.invalidCheckAutoLastError)
        ? ('<div class="muted" style="margin-top:8px">' +
            (s.invalidCheckAutoLastRunAt ? ('上次运行：<span class="mono">' + esc(s.invalidCheckAutoLastRunAt) + '</span>') : '') +
            (s.invalidCheckAutoLastError ? ('<div>上次错误：' + esc(s.invalidCheckAutoLastError) + '</div>') : '') +
          '</div>')
        : ''
      const form = '<div class="card"><div class="grid cols-2">' +
        field('webhookUrl','Webhook', s.webhookUrl || '') +
        field('telegramChatId','电报聊天号', s.telegramChatId || '') +
        fieldPassword('telegramBotToken','电报机器人密钥', '', (s && s.telegramBotTokenSet) ? ('已设置：' + String(s.telegramBotTokenMasked || '')) : '') +
      '</div><div class="grid cols-2" style="margin-top:10px">' +
        field('rssChannelTitle','订阅标题', s.rssChannelTitle || '') +
        field('rssChannelLink','订阅链接', s.rssChannelLink || '') +
      '</div><div class="card" style="margin-top:12px">' +
        '<div style="font-weight:800">自动失效检测</div>' +
        '<div class="muted" style="margin-top:6px">按周期自动调用失效检测，并将失效链接写入 invalidlinks.md；如开启 autoSync，将自动提交同步。</div>' +
        '<div class="grid cols-2" style="margin-top:10px">' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">启用</div><select class="input" id="invalidCheckAutoEnabled"><option value="0"' + (s.invalidCheckAutoEnabled ? '' : ' selected') + '>关闭</option><option value="1"' + (s.invalidCheckAutoEnabled ? ' selected' : '') + '>开启</option></select></div>' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">周期（分钟）</div><input class="input" id="invalidCheckIntervalMinutes" value="' + esc(String(s.invalidCheckIntervalMinutes || 1440)) + '" /></div>' +
        '</div>' +
        '<div style="margin-top:10px"><div class="muted" style="font-size:12px;margin-bottom:6px">检测文件</div><select class="input" id="invalidCheckFilename">' + ymlOptions + '</select></div>' +
        autoRunMeta +
      '</div><div style="margin-top:10px">' +
        '<div class="muted" style="font-size:12px;margin-bottom:6px">搜索目录 逗号分隔</div><input class="input" id="searchDataDirs" value="' + esc((s.searchDataDirs||[]).join(',')) + '" />' +
      '</div><div class="row" style="margin-top:12px"><button class="btn primary" onclick="saveSettings()">保存</button><div class="spacer"></div><span class="muted">密钥留空表示不修改</span></div></div>'
      return layout('set', head + form)
    }

    function ensureInvalidDefaults(){
      if (!state.invalid) state.invalid = {}
      if (!state.invalid.filename) state.invalid.filename = state.filename || ''
      if (!state.invalid.limit || !Number.isFinite(Number(state.invalid.limit))) state.invalid.limit = 200
    }

    async function fetchTextFromApi(url){
      const headers = {}
      if (state.token) headers['Authorization'] = 'Bearer ' + state.token
      const res = await fetch(url, { headers })
      const text = await res.text().catch(()=> '')
      if (!res.ok) throw new Error(text || ('HTTP ' + res.status))
      return String(text || '')
    }

    function invalidSetFilename(v){
      ensureInvalidDefaults()
      state.invalid.filename = String(v || '').trim()
      localStorage.setItem('ndh-invalid-filename', state.invalid.filename)
      render()
    }

    function invalidSetLimit(v){
      ensureInvalidDefaults()
      const n = Math.max(1, Math.min(200, Number(v) || 200))
      state.invalid.limit = n
      localStorage.setItem('ndh-invalid-limit', String(n))
      render()
    }

    function invalidStop(){
      ensureInvalidDefaults()
      state.invalid.running = false
      render()
    }

    async function invalidRun(){
      ensureInvalidDefaults()
      const filename = String(state.invalid.filename || '').trim()
      if (!filename) { toast('bad','请选择文件',''); return }
      const limit = Math.max(1, Math.min(200, Number(state.invalid.limit || 200) || 200))
      state.invalid.running = true
      state.invalid.offset = 0
      state.invalid.totalLinks = 0
      state.invalid.checkedCount = 0
      state.invalid.skippedCount = 0
      state.invalid.removedCount = 0
      state.invalid.removedItems = []
      state.invalid.lastError = ''
      state.invalid.reportPreview = ''
      render()
      try{
        let offset = 0
        while(state.invalid.running){
          const r = await api('/api/invalid-links/check', { method:'POST', body: JSON.stringify({ filename, limit, offset }) })
          state.invalid.totalLinks = Number(r.totalLinks || 0) || 0
          state.invalid.checkedCount += Number(r.checkedCount || 0) || 0
          state.invalid.skippedCount += Number(r.skippedCount || 0) || 0
          state.invalid.removedCount += Number(r.removedCount || 0) || 0
          const removed = Array.isArray(r.removedItems) ? r.removedItems : []
          if (removed.length) state.invalid.removedItems = state.invalid.removedItems.concat(removed)
          offset = Number(r.nextOffset || 0) || 0
          state.invalid.offset = offset
          render()
          if (!r.hasMore) break
        }
        if (state.invalid.running){
          try{
            state.invalid.reportPreview = await fetchTextFromApi('/api/invalid-links/report')
          }catch(e){
            state.invalid.reportPreview = ''
          }
          toast('ok','检测完成','已更新 invalidlinks.md 并触发同步（若开启 autoSync）')
        } else {
          toast('bad','已停止','')
        }
      }catch(e){
        state.invalid.lastError = e && e.message ? String(e.message) : String(e)
        toast('bad','检测失败', state.invalid.lastError)
      }finally{
        state.invalid.running = false
        render()
      }
    }

    async function invalidLoadReport(){
      ensureInvalidDefaults()
      try{
        state.invalid.reportPreview = await fetchTextFromApi('/api/invalid-links/report')
        render()
      }catch(e){
        toast('bad','读取报告失败', e.message || '')
      }
    }

    async function renderInvalidLinks(){
      ensureInvalidDefaults()
      await ensureDataFiles()
      const head = '<div class="top"><div><div style="font-size:18px;font-weight:800">失效检测</div><div class="muted" style="margin-top:4px">批量检测站点链接，达到阈值后自动从数据中移除，并写入 invalidlinks.md</div></div><div class="row"><button class="btn" onclick="render()">刷新</button></div></div>'
      const fileOptions = (Array.isArray(state.dataFiles) ? state.dataFiles : [])
        .map(n => '<option value="' + esc(n) + '"' + (String(n)===String(state.invalid.filename) ? ' selected' : '') + '>' + esc(n) + '</option>')
        .join('')
      const controls = '<div class="card">' +
        '<div class="grid cols-2">' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">文件</div><select class="input" onchange="invalidSetFilename(this.value)">' + fileOptions + '</select></div>' +
          '<div><div class="muted" style="font-size:12px;margin-bottom:6px">每批数量（1-200）</div><input class="input" value="' + esc(String(state.invalid.limit || 200)) + '" oninput="invalidSetLimit(this.value)" /></div>' +
        '</div>' +
        '<div class="row" style="margin-top:12px;flex-wrap:wrap">' +
          '<button class="btn primary" ' + (state.invalid.running ? 'disabled' : '') + ' onclick="invalidRun()">开始检测</button>' +
          '<button class="btn danger" ' + (!state.invalid.running ? 'disabled' : '') + ' onclick="invalidStop()">停止</button>' +
          '<button class="btn" onclick="invalidLoadReport()">查看报告</button>' +
          '<div class="spacer"></div>' +
          '<div class="muted">进度：' + esc(String(state.invalid.offset || 0)) + '/' + esc(String(state.invalid.totalLinks || 0)) +
            '；检查：' + esc(String(state.invalid.checkedCount || 0)) + '；跳过：' + esc(String(state.invalid.skippedCount || 0)) + '；移除：' + esc(String(state.invalid.removedCount || 0)) + '</div>' +
        '</div>' +
        (state.invalid.lastError ? ('<div class="muted" style="margin-top:10px">错误：' + esc(state.invalid.lastError) + '</div>') : '') +
      '</div>'

      const table = (() => {
        const list = Array.isArray(state.invalid.removedItems) ? state.invalid.removedItems : []
        if (!list.length) return '<div class="card" style="margin-top:12px"><div class="muted">暂无移除记录</div></div>'
        const rows = list.slice(0, 1000).map((it) => {
          const tax = it && it.taxonomy ? String(it.taxonomy) : ''
          const term = it && it.term ? String(it.term) : ''
          const title = it && it.title ? String(it.title) : ''
          const url = it && it.url ? String(it.url) : ''
          const c = it && it.count404 !== undefined ? String(it.count404) : ''
          return '<tr><td>' + esc(tax) + '</td><td>' + esc(term) + '</td><td>' + esc(title) + '</td><td class="mono" style="word-break:break-all">' + esc(url) + '</td><td class="mono">' + esc(c) + '</td></tr>'
        }).join('')
        return '<div class="card" style="margin-top:12px">' +
          '<div style="font-weight:800">本次移除的失效链接（最多展示 1000 条）</div>' +
          '<div style="overflow:auto;margin-top:10px"><table class="table"><thead><tr><th>分类</th><th>子类</th><th>标题</th><th>URL</th><th>404计数</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '</div>'
      })()

      const report = (() => {
        const t = String(state.invalid.reportPreview || '')
        if (!t) return ''
        return '<div class="card" style="margin-top:12px">' +
          '<div class="row"><div style="font-weight:800">invalidlinks.md</div><div class="spacer"></div><button class="btn" onclick="invalidLoadReport()">刷新报告</button></div>' +
          '<pre class="mono" style="margin-top:10px;white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto">' + esc(t) + '</pre>' +
        '</div>'
      })()

      return layout('inv', head + controls + table + report)
    }
    function field(id,label,value){
      return '<div><div class="muted" style="font-size:12px;margin-bottom:6px">' + esc(label) + '</div><input class="input" id="' + esc(id) + '" value="' + esc(value) + '" /></div>'
    }
    function fieldPassword(id,label,value,placeholder){
      const ph = placeholder ? String(placeholder || '') : ''
      return '<div><div class="muted" style="font-size:12px;margin-bottom:6px">' + esc(label) + '</div><input class="input" type="password" id="' + esc(id) + '" value="' + esc(value) + '" placeholder="' + esc(ph) + '" autocomplete="off" /></div>'
    }
    async function saveSettings(){
      const telegramBotTokenRaw = document.getElementById('telegramBotToken') ? document.getElementById('telegramBotToken').value : ''
      const telegramBotToken = String(telegramBotTokenRaw || '').trim()
      const autoEnabled = document.getElementById('invalidCheckAutoEnabled') ? (document.getElementById('invalidCheckAutoEnabled').value === '1') : false
      const intervalMinutes = document.getElementById('invalidCheckIntervalMinutes') ? Number(document.getElementById('invalidCheckIntervalMinutes').value) : 1440
      const invFile = document.getElementById('invalidCheckFilename') ? String(document.getElementById('invalidCheckFilename').value || '').trim() : ''
      const payload = {
        autoSync: undefined,
        webhookUrl: document.getElementById('webhookUrl').value.trim(),
        telegramChatId: document.getElementById('telegramChatId').value.trim(),
        telegramBotToken: telegramBotToken ? telegramBotToken : undefined,
        invalidCheckAutoEnabled: autoEnabled,
        invalidCheckIntervalMinutes: intervalMinutes,
        invalidCheckFilename: invFile,
        rssChannelTitle: document.getElementById('rssChannelTitle').value.trim(),
        rssChannelLink: document.getElementById('rssChannelLink').value.trim(),
        searchDataDirs: document.getElementById('searchDataDirs').value.trim()
      }
      try{
        await api('/api/server-settings', { method:'POST', body: JSON.stringify(payload) })
        toast('ok','已保存','')
      }catch(e){ toast('bad','保存失败', e.message || '') }
    }
    async function renderBackup(){
      const head = '<div class="top"><div><div style="font-size:18px;font-weight:800">导入导出</div><div class="muted" style="margin-top:4px">数据备份 / 设置备份</div></div><div class="row"><button class="btn" onclick="render()">刷新</button></div></div>'

      const dataCard =
        '<div class="card">' +
          '<div style="font-weight:800">数据文件（data/*.yml）</div>' +
          '<div class="row" style="margin-top:10px;flex-wrap:wrap">' +
            '<button class="btn" onclick="exportDataBundle()">导出数据文件</button>' +
            '<button class="btn" onclick="exportCurrentYml()">导出当前YML</button>' +
            '<button class="btn" onclick="exportCurrentHtml()">导出当前HTML</button>' +
            '<button class="btn" onclick="pickImportData()">导入数据文件</button>' +
            '<button class="btn" onclick="pickImportYml()">导入YML</button>' +
            '<button class="btn" onclick="pickImportHtml()">导入HTML</button>' +
            '<input type="file" id="import_data_file" accept=".json,application/json" class="hidden" />' +
            '<input type="file" id="import_yml_file" accept=".yml,.yaml,application/x-yaml,text/yaml" class="hidden" />' +
            '<input type="file" id="import_html_file" accept=".html,.htm,text/html" class="hidden" />' +
          '</div>' +
          '<div class="muted" style="margin-top:10px">导入时若与现有文件重名，会提示“合并/覆盖”；HTML 会导入为同名 .yml 文件。</div>' +
        '</div>'

      const settingsCard =
        '<div class="card" style="margin-top:12px">' +
          '<div style="font-weight:800">后台设置（server_settings.json / config.toml）</div>' +
          '<div class="row" style="margin-top:10px;flex-wrap:wrap">' +
            '<button class="btn" onclick="exportSettingsBundle()">导出设置</button>' +
            '<button class="btn" onclick="pickImportSettings()">导入设置</button>' +
            '<input type="file" id="import_settings_file" accept=".json,application/json" class="hidden" />' +
          '</div>' +
          '<div class="muted" style="margin-top:10px">注意：导入设置会覆盖当前服务端配置；包含登录用户/密钥等内容。</div>' +
        '</div>'

      return layout('backup', head + dataCard + settingsCard)
    }
    async function toggleAutoSync(next){
      try{
        await api('/api/server-settings', { method:'POST', body: JSON.stringify({ autoSync: Boolean(next) }) })
        toast('ok','已更新', 'autoSync=' + (next ? 'true' : 'false'))
        render()
      }catch(e){ toast('bad','更新失败', e.message || '') }
    }
    async function runSyncNow(){
      if(!confirm('确认立即同步/提交？')) return
      try{
        await api('/api/sync/run', { method:'POST', body: JSON.stringify({}) })
        toast('ok','已触发同步','')
        render()
      }catch(e){ toast('bad','同步失败', e.message || '') }
    }
    async function discardSyncChanges(){
      if(!confirm('确认放弃修改并恢复到未修改前的数据？')) return
      try{
        await api('/api/sync/discard', { method:'POST', body: JSON.stringify({}) })
        toast('ok','已恢复','')
        render()
      }catch(e){ toast('bad','恢复失败', e.message || '') }
    }
    async function renderSync(){
      const head = '<div class="top"><div><div style="font-size:18px;font-weight:800">同步</div><div class="muted" style="margin-top:4px">提交/构建 与 放弃修改</div></div><div class="row"><button class="btn" onclick="render()">刷新</button></div></div>'
      let sync=null
      try{ sync = await api('/api/sync/status') }catch(e){ return layout('sync', head + '<div class="card">加载失败：' + esc(e.message) + '</div>') }
      const autoSync = Boolean(sync && sync.autoSync)
      const dirty = Boolean(sync && sync.dirty)
      const running = Boolean(sync && sync.running)
      const backupsCount = sync && typeof sync.backupsCount === 'number' ? sync.backupsCount : 0
      const lastRunAt = sync && sync.lastRunAt ? String(sync.lastRunAt) : ''
      const lastError = sync && sync.lastError ? String(sync.lastError) : ''
      const pending = Array.isArray(sync && sync.pending) ? sync.pending : []

      const card =
        '<div class="card">' +
          '<div class="row" style="flex-wrap:wrap">' +
            '<div style="min-width:260px">' +
              '<div style="font-weight:800">状态</div>' +
              '<div class="muted" style="margin-top:6px">autoSync：' + esc(autoSync ? '开启' : '关闭') + '；待同步：' + esc(dirty ? '是' : '否') + '；备份：' + esc(String(backupsCount)) + '</div>' +
              (lastRunAt ? ('<div class="muted mono" style="margin-top:6px">lastRunAt：' + esc(lastRunAt) + '</div>') : '') +
              (lastError ? ('<div class="muted" style="margin-top:6px">lastError：' + esc(lastError) + '</div>') : '') +
            '</div>' +
            '<div class="spacer"></div>' +
            '<button class="btn" onclick="toggleAutoSync(' + (autoSync ? 'false' : 'true') + ')">' + esc(autoSync ? '关闭自动同步' : '开启自动同步') + '</button>' +
            '<button class="btn primary" ' + (running ? 'disabled' : '') + ' onclick="runSyncNow()">立即同步/提交</button>' +
            '<button class="btn danger" ' + (!dirty ? 'disabled' : '') + ' onclick="discardSyncChanges()">放弃修改</button>' +
          '</div>' +
          '<div class="muted" style="margin-top:10px">放弃修改会把已修改的文件恢复为“本次修改前”的版本（基于服务端自动备份）。</div>' +
        '</div>'

      const list = pending.slice(0, 80).map(x=>{
        return '<tr><td class="mono">' + esc(x.at || '') + '</td><td class="mono">' + esc(x.action || '') + '</td><td class="mono" style="word-break:break-all">' + esc(x.filename || '') + '</td><td class="mono" style="word-break:break-all">' + esc(x.title || '') + '</td></tr>'
      }).join('')
      const table =
        '<div class="card" style="margin-top:12px">' +
          '<div style="font-weight:800">待同步列表</div>' +
          '<div class="table-scroll" style="margin-top:10px"><table><thead><tr><th>时间</th><th>动作</th><th>文件</th><th>标题</th></tr></thead><tbody>' + (list || '') + '</tbody></table></div>' +
        '</div>'

      return layout('sync', head + card + table)
    }
    async function exportDataBundle(){
      try{
        const fn = 'yaml-server-data.json'
        await downloadJsonFromApi('/api/backup/export/data', fn)
        toast('ok','已导出数据文件', fn)
      }catch(e){ toast('bad','导出失败', e.message || '') }
    }
    async function exportCurrentYml(){
      try{
        const name = String(state.filename || '').trim()
        if(!name){ toast('bad','导出失败','未选择数据源'); return }
        await downloadJsonFromApi('/api/backup/export/yml?filename=' + encodeURIComponent(name), name)
        toast('ok','已导出', name)
      }catch(e){ toast('bad','导出失败', e.message || '') }
    }
    async function exportCurrentHtml(){
      try{
        const name = String(state.filename || '').trim()
        if(!name){ toast('bad','导出失败','未选择数据源'); return }
        const fn = name.replace(/\.ya?ml$/i, '') + '.html'
        await downloadJsonFromApi('/api/backup/export/html?filename=' + encodeURIComponent(name), fn)
        toast('ok','已导出', fn)
      }catch(e){ toast('bad','导出失败', e.message || '') }
    }
    async function exportSettingsBundle(){
      try{
        const fn = 'yaml-server-settings.json'
        await downloadJsonFromApi('/api/backup/export/settings', fn)
        toast('ok','已导出设置', fn)
      }catch(e){ toast('bad','导出失败', e.message || '') }
    }
    function pickImportData(){
      const el = document.getElementById('import_data_file')
      if(!el) return
      el.value = ''
      el.onchange = async ()=>{
        const f = el.files && el.files[0] ? el.files[0] : null
        if(!f) return
        try{
          const text = await f.text()
          const bundle = JSON.parse(text)
          const files = Array.isArray(bundle && bundle.files) ? bundle.files : []
          const names = files.map(x=>x && x.name ? String(x.name) : '').filter(Boolean)
          const exists = names.filter(n=>Array.isArray(state.dataFiles) && state.dataFiles.includes(n))
          const mode = exists.length ? (confirm('检测到已有同名数据文件：\\n' + exists.slice(0, 10).join('\\n') + (exists.length>10?'\\n...':'') + '\\n\\n选择“确定”=合并，选择“取消”=覆盖。') ? 'merge' : 'overwrite') : 'overwrite'
          await api('/api/backup/import/data', { method:'POST', body: JSON.stringify({ mode, bundle }) })
          toast('ok','导入成功', 'mode=' + mode)
          state.dataFilesLoaded = false
          await ensureDataFiles()
          render()
        }catch(e){ toast('bad','导入失败', e.message || '') }
      }
      el.click()
    }
    function pickImportYml(){
      const el = document.getElementById('import_yml_file')
      if(!el) return
      el.value = ''
      el.onchange = async ()=>{
        const f = el.files && el.files[0] ? el.files[0] : null
        if(!f) return
        try{
          const name = String(f.name || '').trim()
          if(!/\.ya?ml$/i.test(name)){ toast('bad','导入失败','请选择 .yml/.yaml 文件'); return }
          const text = await f.text()
          const exists = Array.isArray(state.dataFiles) && state.dataFiles.includes(name)
          const mode = exists ? (confirm('检测到已有同名数据文件：\\n' + name + '\\n\\n选择“确定”=合并，选择“取消”=覆盖。') ? 'merge' : 'overwrite') : 'overwrite'
          await api('/api/backup/import/yml', { method:'POST', body: JSON.stringify({ mode, name, content: text }) })
          toast('ok','导入成功', name)
          state.dataFilesLoaded = false
          await ensureDataFiles()
          if(!String(state.filename||'').trim()) state.filename = name
          render()
        }catch(e){ toast('bad','导入失败', e.message || '') }
      }
      el.click()
    }
    function pickImportHtml(){
      const el = document.getElementById('import_html_file')
      if(!el) return
      el.value = ''
      el.onchange = async ()=>{
        const f = el.files && el.files[0] ? el.files[0] : null
        if(!f) return
        try{
          const name = String(f.name || '').trim()
          if(!/\.html?$/i.test(name)){ toast('bad','导入失败','请选择 .html/.htm 文件'); return }
          const text = await f.text()
          const ymlName = name.replace(/\.html?$/i, '') + '.yml'
          const exists = Array.isArray(state.dataFiles) && state.dataFiles.includes(ymlName)
          const mode = exists ? (confirm('HTML 将导入为：\\n' + ymlName + '\\n\\n选择“确定”=合并，选择“取消”=覆盖。') ? 'merge' : 'overwrite') : 'overwrite'
          const r = await api('/api/backup/import/html', { method:'POST', body: JSON.stringify({ mode, name, html: text }) })
          toast('ok','导入成功', (r && r.name) ? String(r.name) : ymlName)
          state.dataFilesLoaded = false
          await ensureDataFiles()
          render()
        }catch(e){ toast('bad','导入失败', e.message || '') }
      }
      el.click()
    }
    function pickImportSettings(){
      const el = document.getElementById('import_settings_file')
      if(!el) return
      el.value = ''
      el.onchange = async ()=>{
        const f = el.files && el.files[0] ? el.files[0] : null
        if(!f) return
        if(!confirm('确认导入设置？这会覆盖当前 server_settings.json / config.toml。')) return
        try{
          const text = await f.text()
          const bundle = JSON.parse(text)
          await api('/api/backup/import/settings', { method:'POST', body: JSON.stringify({ bundle }) })
          toast('ok','设置已导入','建议刷新页面')
          render()
        }catch(e){ toast('bad','导入失败', e.message || '') }
      }
      el.click()
    }
    async function renderLogs(){
      const sp = new URLSearchParams(location.search || '')
      const q0 = String(sp.get('q') || '').trim()
      const page0 = Math.max(1, Number(sp.get('page') || 1) || 1)
      const pageSize0 = Math.max(20, Math.min(Number(sp.get('pageSize') || 80) || 80, 200))
      const head = '<div class="top"><div><div style="font-size:18px;font-weight:800">日志</div><div class="muted" style="margin-top:4px">后台操作与 webhook 记录（支持分页/搜索/清理）</div></div>' +
        '<div class="row" style="flex-wrap:wrap">' +
          '<input class="input" id="log_q" value="' + esc(q0) + '" placeholder="搜索类型/内容" style="width:220px" />' +
          '<select id="log_pageSize" class="input" style="width:120px"><option value="50"' + (pageSize0===50?' selected':'') + '>50/页</option><option value="80"' + (pageSize0===80?' selected':'') + '>80/页</option><option value="100"' + (pageSize0===100?' selected':'') + '>100/页</option><option value="200"' + (pageSize0===200?' selected':'') + '>200/页</option></select>' +
          '<button class="btn" onclick="applyLogQuery()">查询</button>' +
          '<button class="btn danger" onclick="clearLogs()">一键清理</button>' +
          '<button class="btn" onclick="render()">刷新</button>' +
        '</div></div>'
      let logs=null, noti=null
      try{
        ;[logs, noti] = await Promise.all([
          api('/api/webhook/logs?page=' + encodeURIComponent(String(page0)) + '&pageSize=' + encodeURIComponent(String(pageSize0)) + '&q=' + encodeURIComponent(q0)),
          fetch('/api/notifications').then(r=>r.json()).catch(()=>null)
        ])
      }catch(e){ return layout('log', head + '<div class="card">加载失败：' + esc(e.message) + '</div>') }
      const list = (logs && logs.logs ? logs.logs : []).map(x=>{
        return '<tr><td class="mono">' + esc(x.at || '') + '</td><td class="mono" style="word-break:break-all">' + esc(x.type || '') + '</td><td class="mono" style="word-break:break-all">' + esc(JSON.stringify(x).slice(0, 480)) + '</td></tr>'
      }).join('')
      const total = logs && typeof logs.total === 'number' ? logs.total : 0
      const maxKeep = logs && typeof logs.max === 'number' ? logs.max : 0
      const ttlDays = logs && typeof logs.ttlDays === 'number' ? logs.ttlDays : 0
      const pageCount = Math.max(1, Math.ceil(total / (pageSize0 || 1)))
      const pager = '<div class="row" style="margin-top:10px;flex-wrap:wrap">' +
        '<span class="pill">总数：' + esc(String(total)) + '</span>' +
        '<span class="pill">第 ' + esc(String(page0)) + ' / ' + esc(String(pageCount)) + ' 页</span>' +
        '<span class="pill">自动清理：' + esc(String(ttlDays)) + ' 天 / ' + esc(String(maxKeep)) + ' 条</span>' +
        '<div class="spacer"></div>' +
        '<button class="btn" ' + (page0<=1?'disabled':'') + ' onclick="gotoLogPage(' + (page0-1) + ')">上一页</button>' +
        '<button class="btn" ' + (page0>=pageCount?'disabled':'') + ' onclick="gotoLogPage(' + (page0+1) + ')">下一页</button>' +
      '</div>'
      const table = '<div class="card"><div class="table-scroll"><table><thead><tr><th>时间</th><th>类型</th><th>内容</th></tr></thead><tbody>' + list + '</tbody></table></div>' + pager + '</div>'
      const notiList = Array.isArray(noti) ? noti.slice(0, 20) : []
      const notiHtml = notiList.length ? ('<div class="card" style="margin-top:12px"><div style="font-weight:800">最新收录（notifications）</div><div style="margin-top:10px" class="grid">' + notiList.map(n=>'<div class="row"><div class="pill">' + esc(n.title||'') + '</div><a class="muted mono" href="' + esc(n.url||'#') + '" target="_blank" rel="noreferrer">' + esc(n.url||'') + '</a></div>').join('') + '</div></div>') : ''
      return layout('log', head + table + notiHtml)
    }
    function applyLogQuery(){
      const q = document.getElementById('log_q') ? document.getElementById('log_q').value.trim() : ''
      const ps = document.getElementById('log_pageSize') ? Number(document.getElementById('log_pageSize').value) : 80
      const sp = new URLSearchParams(location.search || '')
      if(q) sp.set('q', q); else sp.delete('q')
      sp.set('page', '1')
      sp.set('pageSize', String(ps || 80))
      navTo('/admin/logs?' + sp.toString())
    }
    function gotoLogPage(p){
      const sp = new URLSearchParams(location.search || '')
      sp.set('page', String(Math.max(1, Number(p||1)||1)))
      if(!sp.get('pageSize')) sp.set('pageSize', '80')
      navTo('/admin/logs?' + sp.toString())
    }
    async function clearLogs(){
      if(!confirm('确认清空日志？')) return
      try{
        await api('/api/webhook/logs/clear', { method:'POST' })
        toast('ok','已清空日志','')
        navTo('/admin/logs')
      }catch(e){ toast('bad','清理失败', e.message || '') }
    }
    function show(id){ document.getElementById(id).classList.remove('hidden') }
    function hide(id){ document.getElementById(id).classList.add('hidden') }
    function openSheet(html){
      if(!elSheet || !elSheetOverlay) return
      elSheet.innerHTML = html
      elSheet.classList.remove('hidden')
      elSheetOverlay.classList.remove('hidden')
      document.body.style.overflow = 'hidden'
    }
    function closeSheet(){
      if(!elSheet || !elSheetOverlay) return
      elSheet.classList.add('hidden')
      elSheetOverlay.classList.add('hidden')
      elSheet.innerHTML = ''
      document.body.style.overflow = ''
    }
    function sheetHeader(title){
      return '<div class="row"><div style="font-weight:900;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(title || '') + '</div><div class="spacer"></div><button class="btn icon" onclick="closeSheet()" aria-label="关闭"><span class="nav-icon" aria-hidden="true">' + icon('close') + '</span></button></div>'
    }
    function copyText(text){
      const v = String(text || '')
      if(!v) return
      try{
        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(v).then(()=> toast('ok','已复制', v.slice(0, 64))).catch(()=>{ try{ prompt('复制以下内容：', v) }catch{} })
          return
        }
      }catch{}
      try{ prompt('复制以下内容：', v) }catch{}
    }
    function onCatTap(id){
      if(!isMobile()) return
      openSheet(
        sheetHeader('分类操作') +
        '<div class="muted" style="margin-top:10px">点击“编辑”可查看/修改完整字段。</div>' +
        '<div class="row" style="margin-top:12px;flex-wrap:wrap">' +
          '<button class="btn primary" onclick="openCatEdit(' + id + ');closeSheet()">编辑</button>' +
          '<button class="btn danger" onclick="deleteCat(' + id + ');closeSheet()">删除</button>' +
        '</div>'
      )
    }
    async function onSiteTap(id){
      if(!isMobile()) return
      openSheet(sheetHeader('站点详情') + '<div class="muted" style="margin-top:10px">加载中...</div>')
      let site = null
      try{
        const cache = Array.isArray(state._sitesCache) ? state._sitesCache : []
        site = cache.find(x=> Number(x && x.id) === Number(id)) || null
        if(!site){
          const all = await api('/api/sites?filename=' + encodeURIComponent(state.filename))
          if(Array.isArray(all)) site = all.find(x=> Number(x && x.id) === Number(id)) || null
        }
      }catch(e){
        openSheet(sheetHeader('站点详情') + '<div class="muted" style="margin-top:10px">加载失败：' + esc(e.message || '') + '</div>')
        return
      }
      if(!site){
        openSheet(sheetHeader('站点详情') + '<div class="muted" style="margin-top:10px">未找到该站点</div>')
        return
      }
      const title = String(site.title || '') || '站点'
      const url = String(site.url || '')
      const desc = String(site.desc || '')
      const logo = String(site.logo || '')
      const meta = '<div class="meta" style="margin-top:10px">' +
        '<span class="pill">' + (site.is_visible ? '可见' : '隐藏') + '</span>' +
        '<span class="pill">' + (site.update_port_enabled ? '端口更新' : '不更新') + '</span>' +
      '</div>'
      const actions = '<div class="row" style="margin-top:14px;flex-wrap:wrap">' +
        (url ? ('<a class="btn" href="' + esc(url) + '" target="_blank" rel="noreferrer">打开</a>') : '') +
        (url ? ('<button class="btn" onclick="copyText(' + JSON.stringify(url) + ')">复制链接</button>') : '') +
        '<div class="spacer"></div>' +
        '<button class="btn primary" onclick="openSiteEdit(' + id + ');closeSheet()">编辑</button>' +
        '<button class="btn danger" onclick="deleteSite(' + id + ');closeSheet()">删除</button>' +
      '</div>'
      const html =
        sheetHeader(title) +
        (url ? ('<div class="muted mono" style="margin-top:10px;word-break:break-all">' + esc(url) + '</div>') : '') +
        (desc ? ('<div class="muted" style="margin-top:10px;white-space:pre-wrap;word-break:break-word">' + esc(desc) + '</div>') : '') +
        (logo ? ('<div class="muted mono" style="margin-top:10px;word-break:break-all">logo：' + esc(logo) + '</div>') : '') +
        meta +
        actions
      openSheet(html)
    }
    let _rendering = false
    let _renderAgain = false
    async function render(){
      if(_rendering){ _renderAgain = true; return }
      _rendering = true
      try{
        const path = location.pathname.replace(/\\/+$/,'') || '/admin'
        const me = await ensureMe(false)
        if (!me && path !== '/admin/login'){
          elRoot.innerHTML = renderLogin()
          navTo('/admin/login')
          return
        }
        if (!me){
          elRoot.innerHTML = renderLogin()
          return
        }
        ensureDataFiles().then(()=>{
          const sel = document.getElementById('data_file')
          if(sel) sel.innerHTML = dataFileOptionsHtml()
        }).catch(()=>{})
        if (path === '/admin' || path === '/admin/'){ elRoot.innerHTML = await renderDashboard(); syncAppClass(); syncThemeButtons(); syncSidebarToggleButton(); return }
        if (path.startsWith('/admin/categories')){ elRoot.innerHTML = await renderCategories(); syncAppClass(); syncThemeButtons(); syncSidebarToggleButton(); return }
        if (path.startsWith('/admin/sites')){ elRoot.innerHTML = await renderSites(); syncAppClass(); syncThemeButtons(); syncSidebarToggleButton(); return }
        if (path.startsWith('/admin/friendlinks')){ elRoot.innerHTML = await renderFriendlinks(); syncAppClass(); syncThemeButtons(); syncSidebarToggleButton(); return }
        if (path.startsWith('/admin/headers')){ elRoot.innerHTML = await renderHeaders(); syncAppClass(); syncThemeButtons(); syncSidebarToggleButton(); return }
        if (path.startsWith('/admin/hugo')){ elRoot.innerHTML = await renderHugoConfig(); syncAppClass(); syncThemeButtons(); syncSidebarToggleButton(); return }
        if (path.startsWith('/admin/posts')){ elRoot.innerHTML = await renderPosts(); syncAppClass(); syncThemeButtons(); syncSidebarToggleButton(); return }
        if (path.startsWith('/admin/register')){ elRoot.innerHTML = await renderRegister(); syncAppClass(); syncThemeButtons(); syncSidebarToggleButton(); return }
        if (path.startsWith('/admin/users')){ elRoot.innerHTML = await renderUsers(); syncAppClass(); syncThemeButtons(); syncSidebarToggleButton(); return }
        if (path.startsWith('/admin/settings')){ elRoot.innerHTML = await renderSettings(); syncAppClass(); syncThemeButtons(); syncSidebarToggleButton(); return }
        if (path.startsWith('/admin/invalid')){ elRoot.innerHTML = await renderInvalidLinks(); syncAppClass(); syncThemeButtons(); syncSidebarToggleButton(); return }
        if (path.startsWith('/admin/backup')){ elRoot.innerHTML = await renderBackup(); syncAppClass(); syncThemeButtons(); syncSidebarToggleButton(); return }
        if (path.startsWith('/admin/logs')){ elRoot.innerHTML = await renderLogs(); syncAppClass(); syncThemeButtons(); syncSidebarToggleButton(); return }
        elRoot.innerHTML = await renderDashboard()
        syncAppClass()
        syncThemeButtons()
        syncSidebarToggleButton()
      } finally {
        _rendering = false
        if(_renderAgain){ _renderAgain = false; render() }
      }
    }
    render()
  </script>
</body>
</html>`;
}

// 导出为书签格式的路由
app.get('/api/export-bookmarks', verifyApiTokenOrConsoleAdmin, async (req, res) => {
    const bookmarkTree = [];

    // 确保输出目录存在
    const outputPath = BOOKMARKS_OUTPUT_DIR;
    await ensureDirectoryExists(outputPath);

    const dataDir = path.resolve(baseDir, 'data');
    const yamlFiles = isGithubDataSource()
        ? await githubListYamlFiles()
        : await fs.promises.readdir(dataDir);

    for (const file of yamlFiles) {
        if (file.endsWith('.yaml') || file.endsWith('.yml')) {
            const yamlContent = isGithubDataSource()
                ? String((await githubGetFile(file)).content || '')
                : await fs.promises.readFile(path.join(dataDir, file), 'utf8');
            let yamlData = [];
            try { yamlData = yaml.load(yamlContent) || []; } catch { yamlData = []; }

            (Array.isArray(yamlData) ? yamlData : []).forEach(category => {
                const taxonomyTitle = category && category.taxonomy ? String(category.taxonomy) : '';
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
app.get('/data', async (req, res) => {
    try {
        if (isGithubDataSource()) {
            const files = await githubListYamlFiles();
            return res.json(files);
        }
        const dataDir = path.resolve(baseDir, 'data');
        fs.readdir(dataDir, (err, files) => {
            if (err) {
                console.error('读取文件夹时出错:', err);
                return res.status(500).send('读取文件夹失败');
            }
            const yamlFiles = (files || []).filter(file => file.endsWith('.yaml') || file.endsWith('.yml'));
            res.json(yamlFiles);
        });
    } catch (e) {
        console.error('读取文件夹时出错:', e && e.message ? e.message : e);
        return res.status(500).send('读取文件夹失败');
    }
});

// GET 路由，用于获取特定的数据内容
app.get('/data/:filename', async (req, res) => {
    try {
        const filename = req.params && req.params.filename ? String(req.params.filename) : '';
        const name = normalizeDataFilename(filename);
        if (!name) return res.status(400).send('无效的文件路径');

        if (isGithubDataSource()) {
            const got = await githubGetFile(name);
            if (!got || !got.exists) return res.status(404).send('文件未找到');
            res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
            return res.send(String(got.content || ''));
        }

        const dataDir = path.resolve(baseDir, 'data');
        const filePath = path.join(dataDir, name);
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                if (err.code === 'ENOENT') return res.status(404).send('文件未找到');
                console.error('读取文件时出错:', err);
                return res.status(500).send('读取文件失败');
            }
            res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
            res.send(data);
        });
    } catch (e) {
        console.error('读取文件时出错:', e && e.message ? e.message : e);
        return res.status(500).send('读取文件失败');
    }
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

app.get('/api/server-settings', verifyApiTokenOrConsoleAdmin, (req, res) => {
    const webhookUrl = getEffectiveWebhookUrl();
    const telegramChatId = getEffectiveTelegramChatId();
    const telegramBotToken = getEffectiveTelegramBotToken();
    const maskedToken = telegramBotToken ? `${telegramBotToken.slice(0, 3)}...${telegramBotToken.slice(-4)}` : '';
    const dataSource = getEffectiveDataSource();
    const githubToken = getEffectiveGithubToken();
    const githubTokenMasked = githubToken ? `${githubToken.slice(0, 3)}...${githubToken.slice(-4)}` : '';
    res.json({
        autoSync: isAutoSyncEnabled(),
        dataSource,
        githubUser: getEffectiveGithubUser(),
        githubRepo: getEffectiveGithubRepo(),
        githubBranch: getEffectiveGithubBranch(),
        githubPath: githubPathPrefix(),
        githubTokenMasked,
        githubTokenSet: Boolean(githubToken),
        webhookUrl,
        telegramChatId,
        telegramBotTokenMasked: maskedToken,
        telegramBotTokenSet: Boolean(telegramBotToken),
        invalidCheckAutoEnabled: getInvalidCheckAutoEnabled(),
        invalidCheckIntervalMinutes: getInvalidCheckIntervalMinutes(),
        invalidCheckFilename: getInvalidCheckAutoFilename(),
        invalidCheckAutoRunning: Boolean(invalidAutoState && invalidAutoState.running),
        invalidCheckAutoLastRunAt: invalidAutoState && invalidAutoState.lastRunAt ? String(invalidAutoState.lastRunAt) : '',
        invalidCheckAutoLastError: invalidAutoState && invalidAutoState.lastError ? String(invalidAutoState.lastError) : '',
        invalidCheckAutoLastResult: invalidAutoState && invalidAutoState.lastResult ? invalidAutoState.lastResult : null,
        invalidLinksMdFile: invalidLinksMdFilePath,
        invalidLinksMdRel: invalidLinksMdRelPath(),
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

app.post('/api/server-settings', verifyApiTokenOrConsoleAdmin, (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const autoSync = body.autoSync !== undefined ? Boolean(body.autoSync) : (serverSettings && serverSettings.autoSync !== undefined ? Boolean(serverSettings.autoSync) : AUTO_SYNC_ENV_DEFAULT);
        const dataSource = body.dataSource !== undefined
            ? (String(body.dataSource || '').trim().toLowerCase() === 'github' ? 'github' : 'local')
            : (serverSettings && serverSettings.dataSource ? (String(serverSettings.dataSource || '').trim().toLowerCase() === 'github' ? 'github' : 'local') : 'local');
        const githubUser = body.githubUser !== undefined ? String(body.githubUser || '').trim() : (serverSettings && serverSettings.githubUser ? String(serverSettings.githubUser || '').trim() : '');
        const githubRepo = body.githubRepo !== undefined ? String(body.githubRepo || '').trim() : (serverSettings && serverSettings.githubRepo ? String(serverSettings.githubRepo || '').trim() : '');
        const githubBranch = body.githubBranch !== undefined ? (String(body.githubBranch || '').trim() || 'main') : (serverSettings && serverSettings.githubBranch ? (String(serverSettings.githubBranch || '').trim() || 'main') : 'main');
        const githubPath = body.githubPath !== undefined ? (String(body.githubPath || '').trim() || 'data') : (serverSettings && serverSettings.githubPath ? (String(serverSettings.githubPath || '').trim() || 'data') : 'data');
        const githubToken = body.githubToken !== undefined ? String(body.githubToken || '').trim() : (serverSettings && serverSettings.githubToken ? String(serverSettings.githubToken || '').trim() : '');
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
        const invalidCheckAutoEnabled = body.invalidCheckAutoEnabled !== undefined
            ? Boolean(body.invalidCheckAutoEnabled)
            : (serverSettings && serverSettings.invalidCheckAutoEnabled !== undefined ? Boolean(serverSettings.invalidCheckAutoEnabled) : parseBooleanEnv('INVALID_CHECK_AUTO'));
        const invalidCheckIntervalMinutesRaw = body.invalidCheckIntervalMinutes !== undefined
            ? Number(body.invalidCheckIntervalMinutes)
            : (serverSettings && serverSettings.invalidCheckIntervalMinutes !== undefined ? Number(serverSettings.invalidCheckIntervalMinutes) : Number(process.env.INVALID_CHECK_INTERVAL_MINUTES || 1440));
        const invalidCheckIntervalMinutes = (Number.isFinite(invalidCheckIntervalMinutesRaw) && invalidCheckIntervalMinutesRaw > 0)
            ? Math.min(Math.max(1, Math.floor(invalidCheckIntervalMinutesRaw)), 365 * 24 * 60)
            : 1440;
        const invalidCheckFilenameRaw = body.invalidCheckFilename !== undefined
            ? String(body.invalidCheckFilename || '').trim()
            : (serverSettings && serverSettings.invalidCheckFilename ? String(serverSettings.invalidCheckFilename || '').trim() : '');
        const invalidCheckFilename = invalidCheckFilenameRaw ? (normalizeDataFilename(invalidCheckFilenameRaw) || '') : '';
        if (invalidCheckFilenameRaw && !invalidCheckFilename) {
            return res.status(400).json({ error: 'invalidCheckFilename 无效（仅支持 .yml/.yaml 文件名，且不能包含路径）' });
        }

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

        if (dataSource === 'github') {
            if (!githubUser || !githubRepo || !githubToken) return res.status(400).json({ error: 'GitHub 数据源需要填写 githubUser / githubRepo / githubToken' });
        }

        persistServerSettings({
            ...(serverSettings && typeof serverSettings === 'object' ? serverSettings : {}),
            autoSync,
            dataSource,
            githubUser,
            githubRepo,
            githubBranch,
            githubPath: String(githubPath || 'data').replace(/^\/+/, '').replace(/\/+$/, '') || 'data',
            githubToken,
            webhookUrl,
            telegramChatId,
            telegramBotToken,
            invalidCheckAutoEnabled,
            invalidCheckIntervalMinutes,
            invalidCheckFilename,
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
        refreshInvalidCheckAutoTimer();

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e && e.message ? e.message : '保存失败' });
    }
});

app.get('/api/sync/status', requireConsoleAdmin, (req, res) => {
    const backups = Array.isArray(_syncState.backups) ? _syncState.backups : [];
    res.json({
        autoSync: isAutoSyncEnabled(),
        autoSyncEnvDefault: AUTO_SYNC_ENV_DEFAULT,
        gitSyncEnabled: GIT_SYNC_ENABLED,
        dirty: _syncState.dirty,
        running: _syncState.running,
        lastRunAt: _syncState.lastRunAt,
        lastError: _syncState.lastError,
        lastResult: _syncState.lastResult,
        pending: _syncState.changes,
        backupsCount: backups.length
    });
});

app.post('/api/sync/run', requireConsoleAdmin, async (req, res) => {
    try {
        const result = await runSyncNow('manual');
        res.json({ ok: true, result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e && e.message ? e.message : '同步失败' });
    }
});

app.post('/api/sync/discard', requireConsoleAdmin, (req, res) => {
    try {
        const backups = Array.isArray(_syncState.backups) ? _syncState.backups : [];
        const restored = [];
        backups.forEach((b) => {
            if (!b || !b.absPath) return;
            const abs = String(b.absPath);
            const existed = Boolean(b.existed);
            if (!safeBackupPathTarget(abs)) return;
            try {
                const dir = path.dirname(abs);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            } catch {}
            try {
                if (!existed) {
                    if (fs.existsSync(abs)) fs.unlinkSync(abs);
                    restored.push({ absPath: abs, action: 'delete' });
                    return;
                }
                if (!b.backupFile || !fs.existsSync(b.backupFile)) return;
                const buf = fs.readFileSync(String(b.backupFile));
                const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
                fs.writeFileSync(tmp, buf);
                fs.renameSync(tmp, abs);
                restored.push({ absPath: abs, action: 'restore' });
            } catch {}
        });
        clearPendingChanges();
        clearSyncBackups();
        _syncState.lastError = '';
        _syncState.lastResult = { reason: 'discard', restoredCount: restored.length };
        res.json({ ok: true, restored });
    } catch (e) {
        res.status(500).json({ ok: false, error: e && e.message ? e.message : '放弃修改失败' });
    }
});

function mergeFriendlinks(existing, incoming) {
    const a = Array.isArray(existing) ? existing : [];
    const b = Array.isArray(incoming) ? incoming : [];
    const map = new Map();
    a.forEach((it) => {
        const url = it && it.url ? String(it.url) : '';
        if (url) map.set(url, { title: String(it.title || ''), url, description: String(it.description || '') });
    });
    b.forEach((it) => {
        const url = it && it.url ? String(it.url) : '';
        if (!url) return;
        map.set(url, { title: String(it.title || ''), url, description: String(it.description || '') });
    });
    return Array.from(map.values());
}

function mergeHeaders(existing, incoming) {
    const a = Array.isArray(existing) ? existing : [];
    const b = Array.isArray(incoming) ? incoming : [];
    const byItem = new Map();
    const normSub = (x) => ({ name: String(x && x.name ? x.name : ''), url: String(x && x.url ? x.url : '') });
    const mergeOne = (base, add) => {
        const item = String((add && add.item) || (base && base.item) || '');
        const out = { ...(base || {}), ...(add || {}) };
        out.item = item;
        const listA = Array.isArray(base && base.list) ? base.list : [];
        const listB = Array.isArray(add && add.list) ? add.list : [];
        if (listA.length || listB.length) {
            const subMap = new Map();
            listA.map(normSub).forEach((s) => { if (s.name) subMap.set(s.name, s); });
            listB.map(normSub).forEach((s) => { if (s.name) subMap.set(s.name, s); });
            out.list = Array.from(subMap.values()).filter((x) => x.name && x.url);
        } else {
            delete out.list;
        }
        return out;
    };
    a.forEach((it) => {
        const item = it && it.item ? String(it.item) : '';
        if (!item) return;
        byItem.set(item, mergeOne(null, it));
    });
    b.forEach((it) => {
        const item = it && it.item ? String(it.item) : '';
        if (!item) return;
        const cur = byItem.get(item) || null;
        byItem.set(item, mergeOne(cur, it));
    });
    return Array.from(byItem.values());
}

function mergeWebstack(existing, incoming) {
    const a = Array.isArray(existing) ? existing : [];
    const b = Array.isArray(incoming) ? incoming : [];

    const normLink = (x) => ({
        title: String(x && x.title ? x.title : ''),
        logo: String(x && x.logo ? x.logo : ''),
        url: String(x && x.url ? x.url : ''),
        description: String(x && x.description ? x.description : '')
    });
    const mergeLinks = (la, lb) => {
        const map = new Map();
        (Array.isArray(la) ? la : []).map(normLink).forEach((x) => { if (x.url) map.set(x.url, x); });
        (Array.isArray(lb) ? lb : []).map(normLink).forEach((x) => { if (x.url) map.set(x.url, x); });
        return Array.from(map.values());
    };

    const byTax = new Map();
    a.forEach((t) => {
        const tax = t && t.taxonomy ? String(t.taxonomy) : '';
        if (!tax) return;
        byTax.set(tax, JSON.parse(JSON.stringify(t)));
    });

    b.forEach((t) => {
        const tax = t && t.taxonomy ? String(t.taxonomy) : '';
        if (!tax) return;
        const cur = byTax.get(tax) || { taxonomy: tax, links: [], list: [] };
        if (t && t.icon) cur.icon = String(t.icon);
        if (t && t.en_name) cur.en_name = String(t.en_name);
        cur.links = mergeLinks(cur.links, t && t.links);

        const curTerms = Array.isArray(cur.list) ? cur.list : [];
        const inTerms = Array.isArray(t && t.list) ? t.list : [];
        const byTerm = new Map();
        curTerms.forEach((te) => {
            const term = te && te.term ? String(te.term) : '';
            if (!term) return;
            byTerm.set(term, JSON.parse(JSON.stringify(te)));
        });
        inTerms.forEach((te) => {
            const term = te && te.term ? String(te.term) : '';
            if (!term) return;
            const base = byTerm.get(term) || { term, links: [] };
            if (te && te.icon) base.icon = String(te.icon);
            if (te && te.en_name) base.en_name = String(te.en_name);
            base.links = mergeLinks(base.links, te && te.links);
            byTerm.set(term, base);
        });
        cur.list = Array.from(byTerm.values());
        byTax.set(tax, cur);
    });

    return Array.from(byTax.values());
}

app.get('/api/backup/export/data', requireConsoleAdmin, async (req, res) => {
    try {
        const files = [];
        if (isGithubDataSource()) {
            const names = await githubListYamlFiles();
            for (const name of names) {
                const safe = normalizeDataFilename(name);
                if (!safe) continue;
                const got = await githubGetFile(safe);
                if (!got || !got.exists) continue;
                const raw = String(got.content || '');
                let parsed = [];
                try { parsed = raw && raw.trim() ? (yaml.load(raw) || []) : []; } catch { parsed = []; }
                const kind = detectYamlKind(safe, parsed);
                files.push({ name: safe, kind, content: raw });
            }
        } else {
            const dataDir = path.resolve(baseDir, 'data');
            const entries = fs.existsSync(dataDir) ? fs.readdirSync(dataDir, { withFileTypes: true }) : [];
            for (const ent of entries) {
                if (!ent || !ent.isFile()) continue;
                const name = String(ent.name || '');
                if (!name) continue;
                const lower = name.toLowerCase();
                if (!lower.endsWith('.yml') && !lower.endsWith('.yaml')) continue;
                const abs = path.join(dataDir, name);
                const raw = fs.readFileSync(abs, 'utf8');
                let parsed = [];
                try {
                    parsed = raw && raw.trim() ? (yaml.load(raw) || []) : [];
                } catch {
                    parsed = [];
                }
                const kind = detectYamlKind(name, parsed);
                files.push({ name, kind, content: raw });
            }
        }

        files.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
        const bundle = { type: 'noisedh-yaml-server-data', version: 1, exportedAt: new Date().toISOString(), files };
        const fn = `yaml-server-data-${bundle.exportedAt.replace(/[:.]/g, '-')}.json`;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
        res.send(JSON.stringify(bundle, null, 2));
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '导出失败' });
    }
});

app.get('/api/backup/export/yml', requireConsoleAdmin, async (req, res) => {
    try {
        const filename = String(req.query.filename || '').trim();
        if (!filename) return res.status(400).json({ message: 'filename 不能为空' });
        const lower = filename.toLowerCase();
        if (!lower.endsWith('.yml') && !lower.endsWith('.yaml')) return res.status(400).json({ message: '仅支持 .yml/.yaml' });
        const safe = normalizeDataFilename(filename);
        if (!safe) return res.status(400).json({ message: 'filename 无效' });
        let raw = '';
        if (isGithubDataSource()) {
            const got = await githubGetFile(safe);
            if (!got || !got.exists) return res.status(404).json({ message: '文件不存在' });
            raw = String(got.content || '');
        } else {
            const dataDir = path.resolve(baseDir, 'data');
            const abs = safeResolveWithinDir(dataDir, safe);
            if (!abs) return res.status(400).json({ message: 'filename 无效' });
            if (!fs.existsSync(abs)) return res.status(404).json({ message: '文件不存在' });
            raw = fs.readFileSync(abs, 'utf8');
        }
        res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
        res.send(raw);
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '导出失败' });
    }
});

app.get('/api/backup/export/html', requireConsoleAdmin, async (req, res) => {
    try {
        const filename = String(req.query.filename || '').trim();
        if (!filename) return res.status(400).json({ message: 'filename 不能为空' });
        const lower = filename.toLowerCase();
        if (!lower.endsWith('.yml') && !lower.endsWith('.yaml')) return res.status(400).json({ message: '仅支持 .yml/.yaml' });
        const safe = normalizeDataFilename(filename);
        if (!safe) return res.status(400).json({ message: 'filename 无效' });
        let raw = '';
        if (isGithubDataSource()) {
            const got = await githubGetFile(safe);
            if (!got || !got.exists) return res.status(404).json({ message: '文件不存在' });
            raw = String(got.content || '');
        } else {
            const dataDir = path.resolve(baseDir, 'data');
            const abs = safeResolveWithinDir(dataDir, safe);
            if (!abs) return res.status(400).json({ message: 'filename 无效' });
            if (!fs.existsSync(abs)) return res.status(404).json({ message: '文件不存在' });
            raw = fs.readFileSync(abs, 'utf8');
        }
        const yamlData = raw && raw.trim() ? (yaml.load(raw) || []) : [];
        if (!Array.isArray(yamlData)) return res.status(400).json({ message: 'YML 内容格式不正确' });
        const kind = detectYamlKind(safe, yamlData);

        const nowTs = Math.floor(Date.now() / 1000);
        const renderLink = (link) => {
            const title = escapeHtml(link && link.title ? link.title : '');
            const url = escapeHtml(link && link.url ? link.url : '');
            const logo = escapeHtml(link && link.logo ? link.logo : '');
            const description = escapeHtml(link && link.description ? link.description : '');
            if (!url) return '';
            const iconAttr = logo ? ` ICON_URI="${logo}"` : '';
            let html = `    <DT><A HREF="${url}" ADD_DATE="${nowTs}"${iconAttr}>${title || url}</A>\n`;
            if (description) html += `    <DD>${description}</DD>\n`;
            return html;
        };

        const bookmarkTree = [];
        if (kind === 'friendlinks') {
            const links = (Array.isArray(yamlData) ? yamlData : []).map((it) => ({
                title: String(it && it.title ? it.title : ''),
                url: String(it && it.url ? it.url : ''),
                logo: '',
                description: String(it && it.description ? it.description : '')
            })).filter((x) => x.url);
            bookmarkTree.push({ title: '友链', links, terms: [] });
        } else if (kind === 'headers') {
            const terms = [];
            (Array.isArray(yamlData) ? yamlData : []).forEach((it) => {
                if (!it) return;
                const termTitle = String(it.item || '').trim();
                const termLinks = [];
                const topUrl = String(it.link || '').trim();
                if (topUrl) termLinks.push({ title: termTitle || topUrl, url: topUrl, logo: String(it.icon || '').trim(), description: '' });
                const list = Array.isArray(it.list) ? it.list : [];
                list.forEach((s) => {
                    const name = String(s && s.name ? s.name : '').trim();
                    const url = String(s && s.url ? s.url : '').trim();
                    if (!url) return;
                    termLinks.push({ title: name || url, url, logo: '', description: '' });
                });
                if (termTitle && termLinks.length) terms.push({ term: termTitle, links: termLinks });
            });
            bookmarkTree.push({ title: '导航', links: [], terms });
        } else {
            (Array.isArray(yamlData) ? yamlData : []).forEach((category) => {
                const taxonomyTitle = category && category.taxonomy ? String(category.taxonomy) : '';
                if (!taxonomyTitle) return;
                bookmarkTree.push({
                    title: taxonomyTitle,
                    links: Array.isArray(category.links) ? category.links : [],
                    terms: Array.isArray(category.list) ? category.list : []
                });
            });
        }

        const pageTitle = `${String(safe).replace(/\.ya?ml$/i, '')}-Bookmarks`;
        let bookmarkHtml = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n';
        bookmarkHtml += '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n';
        bookmarkHtml += `<TITLE>${escapeHtml(pageTitle)}</TITLE>\n<H1>${escapeHtml(pageTitle)}</H1>\n<DL><p>\n`;

        bookmarkTree.forEach((taxonomy) => {
            bookmarkHtml += `    <DT><H3 ADD_DATE="${nowTs}">${escapeHtml(taxonomy.title)}</H3>\n`;
            bookmarkHtml += '    <DL><p>\n';
            (taxonomy.links || []).forEach((link) => { bookmarkHtml += renderLink(link); });
            (taxonomy.terms || []).forEach((termNode) => {
                const termTitle = termNode && termNode.term ? String(termNode.term) : '';
                const termLinks = Array.isArray(termNode && termNode.links) ? termNode.links : [];
                const validLinks = termLinks.filter((l) => l && l.url);
                if (!termTitle || validLinks.length === 0) return;
                bookmarkHtml += `        <DT><H3 ADD_DATE="${nowTs}">${escapeHtml(termTitle)}</H3>\n`;
                bookmarkHtml += '        <DL><p>\n';
                validLinks.forEach((link) => { bookmarkHtml += renderLink(link); });
                bookmarkHtml += '        </DL><p>\n';
            });
            bookmarkHtml += '    </DL><p>\n';
        });
        bookmarkHtml += '</DL><p>';

        const outName = safe.replace(/\.ya?ml$/i, '') + '.html';
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
        res.send(bookmarkHtml);
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '导出失败' });
    }
});

app.get('/api/backup/export/settings', requireConsoleAdmin, (req, res) => {
    try {
        const configPath = path.resolve(baseDir, 'config.toml');
        const rawToml = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
        const bundle = { type: 'noisedh-yaml-server-settings', version: 1, exportedAt: new Date().toISOString(), serverSettings: serverSettings && typeof serverSettings === 'object' ? serverSettings : {}, hugoConfigToml: rawToml };
        const fn = `yaml-server-settings-${bundle.exportedAt.replace(/[:.]/g, '-')}.json`;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
        res.send(JSON.stringify(bundle, null, 2));
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '导出失败' });
    }
});

app.post('/api/backup/import/data', requireConsoleAdmin, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const mode = String(body.mode || '').trim().toLowerCase();
        const bundle = body.bundle && typeof body.bundle === 'object' ? body.bundle : (body && body.type ? body : null);
        if (!bundle || String(bundle.type || '') !== 'noisedh-yaml-server-data') return res.status(400).json({ message: '数据文件格式不正确' });
        const files = Array.isArray(bundle.files) ? bundle.files : [];
        if (!files.length) return res.status(400).json({ message: '数据文件为空' });
        if (mode !== 'merge' && mode !== 'overwrite') return res.status(400).json({ message: 'mode 必须为 merge 或 overwrite' });

        const imported = [];

        for (const f of files) {
            const name = f && f.name ? String(f.name) : '';
            const safeName = normalizeDataFilename(name);
            if (!safeName) continue;

            const raw = f && f.content ? String(f.content) : '';
            const incomingParsed = raw && raw.trim() ? (yaml.load(raw) || []) : [];
            if (!Array.isArray(incomingParsed)) continue;

            const existing = await loadYamlArrayFromDataFile(safeName);
            const existingParsed = Array.isArray(existing && existing.data) ? existing.data : [];
            const kind = detectYamlKind(safeName, existingParsed.length ? existingParsed : incomingParsed);

            let next = incomingParsed;
            if (mode === 'merge' && existingParsed.length) {
                if (kind === 'friendlinks') next = mergeFriendlinks(existingParsed, incomingParsed);
                else if (kind === 'headers') next = mergeHeaders(existingParsed, incomingParsed);
                else next = mergeWebstack(existingParsed, incomingParsed);
            }

            ensureBackupsForChange({ filename: safeName });
            await writeYamlArrayToFile(existing.absolutePath, next, `Import ${safeName}`);
            imported.push({ name: safeName, kind, mode });
        }

        recordAndMaybeAutoSync({ action: 'update', filename: 'data/*', title: 'import', by: req.consoleUser ? req.consoleUser.username : '' });
        res.json({ ok: true, imported });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '导入失败' });
    }
});

app.post('/api/backup/import/yml', requireConsoleAdmin, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const mode = String(body.mode || '').trim().toLowerCase();
        const name = String(body.name || '').trim();
        const content = body.content !== undefined ? String(body.content || '') : '';
        if (!name) return res.status(400).json({ message: 'name 不能为空' });
        const lower = name.toLowerCase();
        if (!lower.endsWith('.yml') && !lower.endsWith('.yaml')) return res.status(400).json({ message: '仅支持 .yml/.yaml' });
        if (mode !== 'merge' && mode !== 'overwrite') return res.status(400).json({ message: 'mode 必须为 merge 或 overwrite' });

        let incomingParsed = [];
        try {
            incomingParsed = content && content.trim() ? (yaml.load(content) || []) : [];
        } catch (e) {
            return res.status(400).json({ message: 'YML 解析失败' });
        }
        if (!Array.isArray(incomingParsed)) return res.status(400).json({ message: 'YML 内容格式不正确' });

        const safeName = normalizeDataFilename(name);
        if (!safeName) return res.status(400).json({ message: 'name 无效' });
        const existing = await loadYamlArrayFromDataFile(safeName);
        const existingParsed = Array.isArray(existing && existing.data) ? existing.data : [];
        const kind = detectYamlKind(safeName, existingParsed.length ? existingParsed : incomingParsed);

        let next = incomingParsed;
        if (mode === 'merge' && existingParsed.length) {
            if (kind === 'friendlinks') next = mergeFriendlinks(existingParsed, incomingParsed);
            else if (kind === 'headers') next = mergeHeaders(existingParsed, incomingParsed);
            else next = mergeWebstack(existingParsed, incomingParsed);
        }

        ensureBackupsForChange({ filename: safeName });
        await writeYamlArrayToFile(existing.absolutePath, next, `Import ${safeName}`);
        recordAndMaybeAutoSync({ action: 'update', filename: safeName, title: 'import:yml', by: req.consoleUser ? req.consoleUser.username : '' });
        res.json({ ok: true, name: safeName, kind, mode });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '导入失败' });
    }
});

app.post('/api/backup/import/html', requireConsoleAdmin, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const mode = String(body.mode || '').trim().toLowerCase();
        const name = String(body.name || '').trim();
        const html = body.html !== undefined ? String(body.html || '') : '';
        if (!name) return res.status(400).json({ message: 'name 不能为空' });
        if (!/\.html?$/i.test(name)) return res.status(400).json({ message: '仅支持 .html/.htm' });
        if (mode !== 'merge' && mode !== 'overwrite') return res.status(400).json({ message: 'mode 必须为 merge 或 overwrite' });
        if (!String(html || '').trim()) return res.status(400).json({ message: 'HTML 为空' });

        const outName = name.replace(/\.html?$/i, '') + '.yml';
        const safeOutName = normalizeDataFilename(outName);
        if (!safeOutName) return res.status(400).json({ message: 'name 无效' });

        const incomingParsed = parseBookmarksHtmlToWebstackArray(html);
        if (!Array.isArray(incomingParsed)) return res.status(400).json({ message: 'HTML 解析失败' });

        let next = incomingParsed;
        const existing = await loadYamlArrayFromDataFile(safeOutName);
        const existingParsed = Array.isArray(existing && existing.data) ? existing.data : [];
        if (mode === 'merge' && existingParsed.length) next = mergeWebstack(existingParsed, incomingParsed);

        ensureBackupsForChange({ filename: safeOutName });
        await writeYamlArrayToFile(existing.absolutePath, next, `Import ${safeOutName} from HTML`);
        recordAndMaybeAutoSync({ action: 'update', filename: safeOutName, title: 'import:html', by: req.consoleUser ? req.consoleUser.username : '' });
        res.json({ ok: true, name: safeOutName, mode });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '导入失败' });
    }
});

app.post('/api/backup/import/settings', requireConsoleAdmin, (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const bundle = body.bundle && typeof body.bundle === 'object' ? body.bundle : (body && body.type ? body : null);
        if (!bundle || String(bundle.type || '') !== 'noisedh-yaml-server-settings') return res.status(400).json({ message: '设置文件格式不正确' });

        const nextSettings = bundle.serverSettings && typeof bundle.serverSettings === 'object' ? bundle.serverSettings : {};
        persistServerSettings(nextSettings);
        try { getConsoleJwtSecret(); } catch {}

        const tomlRaw = bundle.hugoConfigToml !== undefined ? String(bundle.hugoConfigToml || '') : '';
        if (tomlRaw) {
            const configPath = path.resolve(baseDir, 'config.toml');
            writeTextFileAtomic(configPath, tomlRaw);
        }

        recordAndMaybeAutoSync({ action: 'update', filename: 'config.toml', title: 'settings import', by: req.consoleUser ? req.consoleUser.username : '' });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '导入失败' });
    }
});

app.get('/api/hugo-config', requireConsoleAdmin, (req, res) => {
    try {
        const p = path.resolve(baseDir, 'config.toml');
        if (!fs.existsSync(p)) return res.status(404).json({ message: 'config.toml 不存在' });
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = TOML.parse(String(raw || ''));
        const dto = buildHugoConfigDto(parsed);
        res.json({ path: 'config.toml', config: dto });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '读取失败' });
    }
});

app.post('/api/hugo-config', requireConsoleAdmin, (req, res) => {
    try {
        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        const p = path.resolve(baseDir, 'config.toml');
        if (!fs.existsSync(p)) return res.status(404).json({ message: 'config.toml 不存在' });
        const raw = fs.readFileSync(p, 'utf8');
        const next = applyHugoConfigPatch(raw, payload);
        writeTextFileAtomic(p, next);
        appendWebhookLog({ type: 'hugo-config.update', user: req.consoleUser ? req.consoleUser.username : '' });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ message: e && e.message ? e.message : '保存失败' });
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

function addRecentNotification(notification, options) {
    const n = notification && typeof notification === 'object' ? notification : {};
    const max = options && options.max !== undefined ? Number(options.max) : 40;
    const dedupe = options && options.dedupe !== undefined ? Boolean(options.dedupe) : true;
    try {
        ensureBackupForFile(path.join(storagePath, 'notifications.json'));
        ensureBackupForFile(path.join(storagePath, 'rss.xml'));
    } catch {}
    const urlKey = n && n.url ? String(n.url) : '';
    let notifications = readNotifications();
    if (dedupe && urlKey) {
        notifications = (Array.isArray(notifications) ? notifications : []).filter((x) => !(x && String(x.url || '') === urlKey));
    }
    notifications.unshift(n);
    if (notifications.length > max) notifications = notifications.slice(0, max);
    writeNotifications(notifications);
    const rssXml = generateRSS(notifications);
    const rssPath = path.join(storagePath, 'rss.xml');
    fs.writeFileSync(rssPath, rssXml, 'utf8');
    return notifications;
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
app.post('/api/yaml', verifyApiTokenOrConsoleAdmin, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const filenameRaw = body.filename !== undefined ? String(body.filename || '') : '';
        const newDataEntry = body.newDataEntry && typeof body.newDataEntry === 'object' ? body.newDataEntry : {};
        const kind = body.kind || newDataEntry.kind || 'webstack';
        const allowCreateCategory = !(body.allowCreateCategory === false);

        const filename = normalizeDataFilename(filenameRaw);
        if (!filename) return res.status(400).send('无效的文件路径');

        const loaded = await loadYamlArrayFromDataFile(filename);
        let yamlData = Array.isArray(loaded && loaded.data) ? loaded.data : [];

        if (!Array.isArray(yamlData)) return res.status(400).send('数据顶层结构必须为数组');

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

            ensureBackupsForChange({ filename });
            await writeYamlArrayToFile(loaded.absolutePath, yamlData, `Add ${String(newDataEntry.title || '').trim()} to ${filename}`);
            recordAndMaybeAutoSync({ action: 'update', filename, title: newDataEntry.title, by: req.consoleUser ? req.consoleUser.username : '' });
            return res.send('数据添加成功！');
        }

        if (effectiveKind === 'headers') {
            if (!newDataEntry || !newDataEntry.title || !newDataEntry.url) {
                return res.status(400).send('所有字段（导航名称、链接）都必须填写！');
            }
            const headersType = newDataEntry && newDataEntry.headersType ? String(newDataEntry.headersType) : 'top';
            let recordTitle = String(newDataEntry.title || '');

            if (headersType === 'sub') {
                const parentItem = newDataEntry && newDataEntry.parentItem ? String(newDataEntry.parentItem) : '';
                if (!parentItem) return res.status(400).send('未提供父级菜单（item）');
                const name = String(newDataEntry.title);
                const url = String(newDataEntry.url);
                recordTitle = name || parentItem;

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
                recordTitle = item;

                const existing = Array.isArray(yamlData) ? yamlData.find((x) => x && x.item === item) : null;
                if (existing) {
                    existing.link = link;
                    if (icon) existing.icon = icon;
                } else {
                    yamlData.push({ item, icon, link });
                }
            }

            ensureBackupsForChange({ filename });
            await writeYamlArrayToFile(loaded.absolutePath, yamlData, `Update ${filename}`);
            recordAndMaybeAutoSync({ action: 'update', filename, title: recordTitle, by: req.consoleUser ? req.consoleUser.username : '' });
            return res.send('数据添加成功！');
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

        ensureBackupsForChange({ filename });
        await writeYamlArrayToFile(loaded.absolutePath, yamlData, `Add ${String(newDataEntry.title || '').trim()} to ${filename}`);

        const notification = {
            title: newDataEntry.title,
            logo: newDataEntry.logo,
            url: newDataEntry.url,
            description: newDataEntry.description,
            date: new Date()
        };

        let notifications = readNotifications();
        notifications.unshift(notification);
        if (notifications.length > 40) {
            notifications = notifications.slice(0, 40);
        }
        writeNotifications(notifications);

        const rssXml = generateRSS(notifications);
        const rssPath = path.join(storagePath, 'rss.xml');
        fs.writeFileSync(rssPath, rssXml, 'utf8');

        await sendTelegramNotification(notification, newDataEntry.term, newDataEntry.taxonomy);
        await sendWebhookNotification(notification);

        recordAndMaybeAutoSync({ action: 'update', filename, title: newDataEntry.title, by: req.consoleUser ? req.consoleUser.username : '' });
        return res.send('数据添加成功！');
    } catch (e) {
        console.error('写入数据失败:', e && e.message ? e.message : e);
        return res.status(500).send('写入数据失败');
    }
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

    if (isGithubDataSource()) {
        try {
            const name = normalizeDataFilename(rawFilePath);
            if (!name) return res.status(400).send('文件路径无效');
            const got = await githubGetFile(name);
            if (!got || !got.exists) return res.status(404).send('文件未找到');

            let yamlData = [];
            try { yamlData = String(got.content || '').trim() ? (yaml.load(String(got.content || '')) || []) : []; } catch { yamlData = []; }
            const kind = detectYamlKind(name, yamlData);

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
                        const t = s && s.name ? String(s.name) : '';
                        const u = s && s.url ? String(s.url) : '';
                        if (!u) return;
                        items.push({ title: t, url: u, description: item, kind: 'headers', taxonomy: 'headers', term: item });
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

            const kw = String(keyword || '').trim().toLowerCase();
            const results = [];
            const matches = (text) => {
                if (!kw) return true;
                return String(text || '').toLowerCase().includes(kw);
            };

            for (let i = 0; i < items.length; i++) {
                const it = items[i] || {};
                if (
                    matches(it.title) ||
                    matches(it.url) ||
                    matches(it.description) ||
                    (kind === 'webstack' && (matches(it.taxonomy) || matches(it.term)))
                ) {
                    results.push({
                        title: it.title || '',
                        url: it.url || '',
                        description: it.description || '',
                        kind: it.kind || kind || 'webstack',
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

app.post('/api/invalid-links/check', verifyApiTokenOrConsoleAdmin, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const filename = body.filename !== undefined ? String(body.filename || '') : '';
        if (!filename) return res.status(400).json({ error: '未提供文件名' });
        const result = await runInvalidLinksCheckBatch({
            filename,
            limit: body.limit !== undefined ? body.limit : undefined,
            offset: body.offset !== undefined ? body.offset : undefined,
            by: req.consoleUser && req.consoleUser.username ? String(req.consoleUser.username) : ''
        });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e && e.message ? e.message : '失效链接检测失败' });
    }
});

app.get('/api/invalid-links/report', verifyApiTokenOrConsoleAdmin, async (req, res) => {
    try {
        ensureInvalidLinksMdFile();
        const raw = fs.existsSync(invalidLinksMdFilePath) ? fs.readFileSync(invalidLinksMdFilePath, 'utf8') : '';
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.send(String(raw || ''));
    } catch (e) {
        res.status(500).json({ error: e && e.message ? e.message : '读取报告失败' });
    }
});
// 删除路由
app.delete('/api/delete', verifyApiTokenOrConsoleAdmin, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const filenameRaw = body.filename !== undefined ? String(body.filename || '') : '';
        const title = body.title !== undefined ? String(body.title || '') : '';
        const kind = body.kind !== undefined ? String(body.kind || '') : '';

        const filename = normalizeDataFilename(filenameRaw);
        if (!filename) return res.status(400).send('未提供文件路径');

        const loaded = await loadYamlArrayFromDataFile(filename);
        let yamlData = Array.isArray(loaded && loaded.data) ? loaded.data : [];

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
                if (entry && entry.links) {
                    entry.links = entry.links.filter(link => {
                        if (link && link.title === title) {
                            deleted = true;
                            return false;
                        }
                        return true;
                    });
                }
                if (entry && entry.list) {
                    entry.list.forEach(termEntry => {
                        if (termEntry && termEntry.links) {
                            termEntry.links = termEntry.links.filter(link => {
                                if (link && link.title === title) {
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

        if (!deleted) {
            return res.status(404).send('未找到匹配的条目');
        }

        ensureBackupsForChange({ filename });
        await writeYamlArrayToFile(loaded.absolutePath, yamlData, `Delete ${title} from ${filename}`);
        recordAndMaybeAutoSync({ action: 'delete', filename, title, by: req.consoleUser ? req.consoleUser.username : '' });
        return res.send('条目删除成功！');
    } catch (e) {
        console.error('写入数据失败:', e && e.message ? e.message : e);
        return res.status(500).send('写入数据失败');
    }
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
