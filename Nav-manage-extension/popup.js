(() => {
  const isFloating = (() => {
    try {
      return new URLSearchParams(location.search).get('floating') === '1';
    } catch (e) {
      return false;
    }
  })();

  if (isFloating) {
    try { document.documentElement.classList.add('floating'); } catch (e) {}
  }

  const elements = {
    themeToggle: document.getElementById('themeToggle'),
    tabAdd: document.getElementById('tabAdd'),
    tabSearch: document.getElementById('tabSearch'),
    tabAi: document.getElementById('tabAi'),
    tabTheme: document.getElementById('tabTheme'),
    panelAdd: document.getElementById('panelAdd'),
    panelSearch: document.getElementById('panelSearch'),
    closeBtn: document.getElementById('closeBtn'),
    invalidCheckBtn: document.getElementById('invalidCheckBtn'),
    pinBtn: document.getElementById('pinBtn'),
    dataSource: document.getElementById('dataSource'),
    filePathText: document.getElementById('filePathText'),
    taxonomy: document.getElementById('taxonomy'),
    taxonomyCard: document.getElementById('taxonomyCard'),
    term: document.getElementById('term'),
    termLabel: document.getElementById('termLabel'),
    addTaxonomyBtn: document.getElementById('addTaxonomyBtn'),
    addTermBtn: document.getElementById('addTermBtn'),
    title: document.getElementById('title'),
    url: document.getElementById('url'),
    logo: document.getElementById('logo'),
    description: document.getElementById('description'),
    titleLabelText: document.getElementById('titleLabelText'),
    descriptionGroup: document.getElementById('descriptionGroup'),
    descriptionLabelText: document.getElementById('descriptionLabelText'),
    urlLabelText: document.getElementById('urlLabelText'),
    logoGroup: document.getElementById('logoGroup'),
    logoLabelText: document.getElementById('logoLabelText'),
    headersExtra: document.getElementById('headersExtra'),
    headersEntryType: document.getElementById('headersEntryType'),
    headersParentGroup: document.getElementById('headersParentGroup'),
    headersParent: document.getElementById('headersParent'),
    send: document.getElementById('send'),
    status: document.getElementById('status'),
    aiStatus: document.getElementById('aiStatus'),
    aiRecommendation: document.getElementById('aiRecommendation'),
    aiRecText: document.getElementById('aiRecText'),
    applyAiRec: document.getElementById('applyAiRec'),
    rerunAi: document.getElementById('rerunAi'),
    searchInput: document.getElementById('searchInput'),
    executeSearch: document.getElementById('executeSearch'),
    searchResults: document.getElementById('searchResults'),
    searchHint: document.getElementById('searchHint')
  };

  const state = {
    currentFilePath: null,
    fileKind: 'webstack',
    taxonomies: [],
    termsByTaxonomy: {},
    yamlData: null,
    githubSha: null,
    pageContent: '',
    aiResult: null,
    invalidCheckTimer: null,
    autoFillTimer: null
  };

  function simpleHash(str) {
    const s = String(str || '');
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) + s.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }

  function buildAiCacheKey() {
    const url = String(elements.url && elements.url.value ? elements.url.value : '').trim();
    const title = String(elements.title && elements.title.value ? elements.title.value : '').trim();
    const description = String(elements.description && elements.description.value ? elements.description.value : '').trim();
    const file = String(state.currentFilePath || '').trim();
    const taxHash = simpleHash((state.taxonomies || []).join('|'));
    return `${url}|${title}|${description}|${file}|${taxHash}`;
  }

  function containsCjk(text) {
    const s = String(text || '');
    return /[\u4e00-\u9fff]/.test(s);
  }

  function looksEnglish(text) {
    const s = String(text || '').trim();
    if (!s) return false;
    if (containsCjk(s)) return false;
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    const spaces = (s.match(/\s/g) || []).length;
    return letters >= 8 && (letters + spaces) >= Math.min(40, s.length);
  }

  let pinInFlight = false;
  let invalidWinInFlight = false;

  async function getLocal(keys) {
    return await new Promise((resolve) => chrome.storage.local.get(keys, (r) => resolve(r || {})));
  }

  async function setLocal(obj) {
    return await new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
  }

  function setElementVisible(el, visible) {
    if (!el) return;
    if (visible) el.classList.remove('hidden');
    else el.classList.add('hidden');
  }

  function showStatus(text, kind) {
    if (!elements.status) return;
    const t = text || '';
    elements.status.textContent = t;
    if (!t) return;
    elements.status.style.color = kind === 'error' ? 'var(--danger)' : kind === 'success' ? 'var(--ok)' : 'var(--text-muted)';
  }

  function setAiBadge(html) {
    elements.aiStatus.innerHTML = html || '';
  }

  async function getConfig() {
    return await new Promise((resolve) => {
      chrome.storage.sync.get(
        [
          'mode',
          'serverUrl',
          'serverToken',
          'token',
          'writeToCloud',
          'writeToGithub',
          'allowCreateCategory',
          'githubUser',
          'githubRepo',
          'githubBranch',
          'githubPath',
          'githubToken',
          'aiProvider',
          'aiModelName',
          'aiApiKey',
          'aiEndpoint',
          'aiModel',
          'aiTranslateToZh'
        ],
        (items) => resolve(items || {})
      );
    });
  }

  function normalizeServerUrl(u) {
    const s = String(u || '').trim();
    return s.replace(/\/+$/, '');
  }

  function authHeaders(config) {
    const headers = { 'Content-Type': 'application/json' };
    const token = (config.serverToken || config.token || '').trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  function detectKind(filename) {
    const f = String(filename || '').toLowerCase();
    if (f.indexOf('friendlinks') !== -1) return 'friendlinks';
    if (f.indexOf('headers') !== -1) return 'headers';
    return 'webstack';
  }

  function applyFileKindUi(kind) {
    const k = String(kind || 'webstack');
    if (elements.titleLabelText) elements.titleLabelText.textContent = k === 'headers' ? '导航名称' : '标题';
    if (elements.urlLabelText) elements.urlLabelText.textContent = k === 'headers' ? '链接' : '地址';
    if (elements.logoLabelText) elements.logoLabelText.textContent = k === 'headers' ? '图标' : 'Logo';
    if (elements.descriptionLabelText) elements.descriptionLabelText.textContent = '摘要';

    if (elements.headersExtra) setElementVisible(elements.headersExtra, k === 'headers');

    if (elements.descriptionGroup) setElementVisible(elements.descriptionGroup, k !== 'headers');
    if (elements.logoGroup) setElementVisible(elements.logoGroup, k !== 'friendlinks' && k !== 'headers');
    if (k === 'headers') {
      if (elements.logoGroup) setElementVisible(elements.logoGroup, true);
      if (elements.descriptionGroup) setElementVisible(elements.descriptionGroup, false);
      if (elements.title) elements.title.placeholder = '例如：首页';
      if (elements.url) elements.url.placeholder = '例如：./ 或 https://...';
      if (elements.logo) elements.logo.placeholder = '例如：fa fa-home';
    } else if (k === 'friendlinks') {
      if (elements.title) elements.title.placeholder = '例如：NOISE宝藏阁';
      if (elements.url) elements.url.placeholder = '例如：https://example.com';
      if (elements.description) elements.description.placeholder = '例如：综合资源收录站';
    } else {
      if (elements.title) elements.title.placeholder = '自动读取当前网页标题';
      if (elements.url) elements.url.placeholder = '自动读取当前网页 URL';
      if (elements.logo) elements.logo.placeholder = '自动提取 favicon（可编辑）';
      if (elements.description) elements.description.placeholder = '自动提取 description（可编辑）';
    }

    if (k !== 'webstack') {
      setAiBadge('');
      setElementVisible(elements.aiRecommendation, false);
      if (elements.aiRecText) elements.aiRecText.textContent = '';
    }
  }

  function githubEnabled(config) {
    return Boolean(config.githubUser && config.githubRepo && config.githubToken);
  }

  function githubApiHeaders(config) {
    return {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `token ${String(config.githubToken).trim()}`
    };
  }

  function githubPathPrefix(config) {
    const p = String(config.githubPath || 'data').replace(/^\/+/, '').replace(/\/+$/, '');
    return p ? p : 'data';
  }

  async function githubListYamlFiles(config) {
    const branch = String(config.githubBranch || 'main').trim() || 'main';
    const p = githubPathPrefix(config);
    const url = `https://api.github.com/repos/${config.githubUser}/${config.githubRepo}/contents/${p}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, { headers: githubApiHeaders(config) });
    if (!res.ok) throw new Error('获取 GitHub 文件列表失败');
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((x) => x && x.type === 'file' && x.name && /\.ya?ml$/i.test(x.name))
      .map((x) => x.name);
  }

  async function githubGetFile(config, filename) {
    const branch = String(config.githubBranch || 'main').trim() || 'main';
    const p = githubPathPrefix(config);
    const url = `https://api.github.com/repos/${config.githubUser}/${config.githubRepo}/contents/${p}/${encodeURIComponent(filename)}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, { headers: githubApiHeaders(config) });
    if (!res.ok) throw new Error('获取 GitHub 文件内容失败');
    const data = await res.json();
    const contentBase64 = data && data.content ? String(data.content) : '';
    const content = contentBase64 ? atob(contentBase64.replace(/\n/g, '')) : '';
    return { content, sha: data && data.sha ? String(data.sha) : null };
  }

  async function githubPutFile(config, filename, content, sha, message) {
    const branch = String(config.githubBranch || 'main').trim() || 'main';
    const p = githubPathPrefix(config);
    const url = `https://api.github.com/repos/${config.githubUser}/${config.githubRepo}/contents/${p}/${encodeURIComponent(filename)}`;
    const body = {
      message: message || `Update ${filename}`,
      content: base64EncodeUtf8(content),
      branch
    };
    if (sha) body.sha = sha;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...githubApiHeaders(config), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('写入 GitHub 失败');
    const data = await res.json();
    return { sha: data && data.content && data.content.sha ? String(data.content.sha) : null };
  }

  function base64EncodeUtf8(str) {
    const bytes = new TextEncoder().encode(String(str || ''));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function parseYamlArray(content) {
    if (!window.jsyaml) throw new Error('YAML 解析器未加载');
    const raw = String(content == null ? '' : content).replace(/^\uFEFF/, '');
    if (!raw.trim()) return [];
    let parsed;
    try {
      parsed = window.jsyaml.load(raw);
    } catch (e) {
      throw new Error('YAML 解析失败，已阻止覆盖原文件');
    }
    if (parsed == null) return [];
    if (!Array.isArray(parsed)) throw new Error('YAML 顶层结构不是数组，已阻止覆盖原文件');
    return parsed;
  }

  function dumpYamlArray(arr) {
    const y = window.jsyaml ? window.jsyaml.dump(arr, { noRefs: true, lineWidth: -1 }) : '';
    return '---\n' + y;
  }

  function computeTaxonomyFromYaml(yamlData) {
    const taxonomies = [];
    const termsByTaxonomy = {};
    (yamlData || []).forEach((entry) => {
      if (!entry || !entry.taxonomy) return;
      const tax = String(entry.taxonomy);
      if (taxonomies.indexOf(tax) === -1) taxonomies.push(tax);
      const terms = [];
      const list = Array.isArray(entry.list) ? entry.list : [];
      list.forEach((t) => {
        if (t && t.term) {
          const term = String(t.term);
          if (terms.indexOf(term) === -1) terms.push(term);
        }
      });
      termsByTaxonomy[tax] = terms;
    });
    return { taxonomies, termsByTaxonomy };
  }

  function applyEntryToYamlData(yamlData, entry, allowCreateCategory) {
    const canCreate = allowCreateCategory !== false;
    const kind = entry && entry.kind ? String(entry.kind) : 'webstack';
    if (!Array.isArray(yamlData)) yamlData = [];

    if (kind === 'friendlinks') {
      const exists = yamlData.some((x) => x && x.url === entry.url);
      if (!exists) yamlData.push({ title: entry.title, url: entry.url, description: entry.description || '' });
      return yamlData;
    }

    if (kind === 'headers') {
      const entryType = entry && entry.headersType ? String(entry.headersType) : 'top';
      if (entryType === 'sub') {
        const parentItem = String(entry.parentItem || '').trim();
        const name = String(entry.title || '').trim();
        const url = String(entry.url || '').trim();
        if (!parentItem || !name || !url) return yamlData;
        let parent = null;
        for (let i = 0; i < yamlData.length; i++) {
          if (yamlData[i] && String(yamlData[i].item || '').trim() === parentItem) {
            parent = yamlData[i];
            break;
          }
        }
        if (!parent) {
          parent = { item: parentItem, icon: '', link: '', list: [] };
          yamlData.push(parent);
        }
        parent.list = Array.isArray(parent.list) ? parent.list : [];
        for (let j = 0; j < parent.list.length; j++) {
          if (parent.list[j] && String(parent.list[j].name || '').trim() === name) {
            parent.list[j].url = url;
            return yamlData;
          }
        }
        parent.list.push({ name, url });
        return yamlData;
      }

      const item = String(entry.title || '').trim();
      const link = String(entry.url || '').trim();
      if (!item || !link) return yamlData;
      const icon = String(entry.logo || '').trim();
      for (let i = 0; i < yamlData.length; i++) {
        if (yamlData[i] && String(yamlData[i].item || '').trim() === item) {
          yamlData[i].link = link;
          if (icon) yamlData[i].icon = icon;
          return yamlData;
        }
      }
      yamlData.push({ item, icon, link });
      return yamlData;
    }

    const taxonomy = String(entry.taxonomy || '').trim();
    const term = String(entry.term || '').trim();
    if (!taxonomy) return yamlData;

    let taxonomyEntry = null;
    for (let i = 0; i < yamlData.length; i++) {
      if (yamlData[i] && yamlData[i].taxonomy === taxonomy) {
        taxonomyEntry = yamlData[i];
        break;
      }
    }
    if (!taxonomyEntry) {
      if (!canCreate) return yamlData;
      taxonomyEntry = { taxonomy, icon: entry.icon || '', links: [], list: [] };
      yamlData.push(taxonomyEntry);
    }

    const linkObj = { title: entry.title, logo: entry.logo || '', url: entry.url, description: entry.description || '' };
    if (term) {
      taxonomyEntry.list = Array.isArray(taxonomyEntry.list) ? taxonomyEntry.list : [];
      let termEntry = null;
      for (let j = 0; j < taxonomyEntry.list.length; j++) {
        if (taxonomyEntry.list[j] && taxonomyEntry.list[j].term === term) {
          termEntry = taxonomyEntry.list[j];
          break;
        }
      }
      if (!termEntry) {
        if (!canCreate) return yamlData;
        termEntry = { term, links: [] };
        taxonomyEntry.list.push(termEntry);
      }
      termEntry.links = Array.isArray(termEntry.links) ? termEntry.links : [];
      termEntry.links.push(linkObj);
    } else {
      taxonomyEntry.links = Array.isArray(taxonomyEntry.links) ? taxonomyEntry.links : [];
      taxonomyEntry.links.push(linkObj);
    }
    return yamlData;
  }

  function deleteByTitleFromYamlData(yamlData, kind, title) {
    if (!Array.isArray(yamlData)) return { yamlData, deleted: false };
    const k = String(kind || 'webstack');
    let deleted = false;

    if (k === 'friendlinks') {
      const before = yamlData.length;
      yamlData = yamlData.filter((x) => !(x && String(x.title || '') === title));
      return { yamlData, deleted: yamlData.length !== before };
    }

    if (k === 'headers') {
      const before = yamlData.length;
      yamlData = yamlData
        .map((x) => {
          if (!x) return x;
          if (Array.isArray(x.list)) {
            const b = x.list.length;
            x.list = x.list.filter((it) => !(it && String(it.name || '') === title));
            if (x.list.length !== b) deleted = true;
          }
          return x;
        })
        .filter((x) => !(x && String(x.item || '') === title));
      if (yamlData.length !== before) deleted = true;
      return { yamlData, deleted };
    }

    for (let i = 0; i < yamlData.length; i++) {
      const entry = yamlData[i] || {};
      if (Array.isArray(entry.links)) {
        const beforeLinks = entry.links.length;
        entry.links = entry.links.filter((l) => !(l && l.title === title));
        if (entry.links.length !== beforeLinks) deleted = true;
      }
      if (Array.isArray(entry.list)) {
        for (let j = 0; j < entry.list.length; j++) {
          const term = entry.list[j] || {};
          if (Array.isArray(term.links)) {
            const beforeLinks = term.links.length;
            term.links = term.links.filter((l) => !(l && l.title === title));
            if (term.links.length !== beforeLinks) deleted = true;
          }
        }
      }
    }
    return { yamlData, deleted };
  }

  function searchInYamlData(yamlData, kind, keyword) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw || !Array.isArray(yamlData)) return [];
    const k = String(kind || 'webstack');
    const results = [];

    if (k === 'friendlinks') {
      for (let i = 0; i < yamlData.length; i++) {
        const it = yamlData[i] || {};
        const t = String(it.title || '').toLowerCase();
        const u = String(it.url || '').toLowerCase();
        const d = String(it.description || '').toLowerCase();
        if (t.indexOf(kw) !== -1 || u.indexOf(kw) !== -1 || d.indexOf(kw) !== -1) {
          results.push({ title: it.title || '', url: it.url || '', description: it.description || '', kind: 'friendlinks' });
        }
      }
      return results;
    }

    if (k === 'headers') {
      for (let i = 0; i < yamlData.length; i++) {
        const it = yamlData[i] || {};
        const item = String(it.item || '');
        const icon = String(it.icon || '');
        const link = String(it.link || '');
        const t = item.toLowerCase();
        const u = link.toLowerCase();
        const d = icon.toLowerCase();
        if (t.indexOf(kw) !== -1 || u.indexOf(kw) !== -1 || d.indexOf(kw) !== -1) {
          results.push({ title: item, url: link, description: icon, kind: 'headers' });
        }
        if (Array.isArray(it.list)) {
          for (let j = 0; j < it.list.length; j++) {
            const s = it.list[j] || {};
            const name = String(s.name || '');
            const url = String(s.url || '');
            const t2 = name.toLowerCase();
            const u2 = url.toLowerCase();
            if (t2.indexOf(kw) !== -1 || u2.indexOf(kw) !== -1) {
              results.push({ title: name, url: url, description: item, kind: 'headers' });
            }
          }
        }
      }
      return results;
    }

    for (let i = 0; i < yamlData.length; i++) {
      const entry = yamlData[i] || {};
      const tax = entry.taxonomy ? String(entry.taxonomy) : '';
      const links = Array.isArray(entry.links) ? entry.links : [];
      for (let j = 0; j < links.length; j++) {
        const l = links[j] || {};
        const t = String(l.title || '').toLowerCase();
        const u = String(l.url || '').toLowerCase();
        const d = String(l.description || '').toLowerCase();
        if (t.indexOf(kw) !== -1 || u.indexOf(kw) !== -1 || d.indexOf(kw) !== -1) {
          results.push({ title: l.title || '', url: l.url || '', description: l.description || '', taxonomy: tax, term: '', kind: 'webstack' });
        }
      }
      const list = Array.isArray(entry.list) ? entry.list : [];
      for (let k2 = 0; k2 < list.length; k2++) {
        const termNode = list[k2] || {};
        const term = termNode.term ? String(termNode.term) : '';
        const tlinks = Array.isArray(termNode.links) ? termNode.links : [];
        for (let j2 = 0; j2 < tlinks.length; j2++) {
          const l2 = tlinks[j2] || {};
          const t2 = String(l2.title || '').toLowerCase();
          const u2 = String(l2.url || '').toLowerCase();
          const d2 = String(l2.description || '').toLowerCase();
          if (t2.indexOf(kw) !== -1 || u2.indexOf(kw) !== -1 || d2.indexOf(kw) !== -1) {
            results.push({ title: l2.title || '', url: l2.url || '', description: l2.description || '', taxonomy: tax, term, kind: 'webstack' });
          }
        }
      }
    }
    return results;
  }

  async function fetchFileList() {
    const config = await getConfig();
    const serverUrl = normalizeServerUrl(config.serverUrl);
    if (!serverUrl) throw new Error('未配置云服务器地址');
    const res = await fetch(`${serverUrl}/data`);
    if (!res.ok) throw new Error('获取文件列表失败');
    return await res.json();
  }

  async function fetchFileContent(filename) {
    const config = await getConfig();
    const serverUrl = normalizeServerUrl(config.serverUrl);
    const res = await fetch(`${serverUrl}/data/${encodeURIComponent(filename)}`);
    if (!res.ok) throw new Error('获取文件内容失败');
    return await res.text();
  }

  function updateFilePathUI(filename) {
    if (!elements.filePathText) return;
    elements.filePathText.textContent = filename ? String(filename) : '';
  }

  function populateTaxonomySelect() {
    const sel = elements.taxonomy;
    sel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '选择分类...';
    sel.appendChild(opt0);
    for (let i = 0; i < state.taxonomies.length; i++) {
      const t = state.taxonomies[i];
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    }
  }

  function populateTermSelect(taxonomy) {
    const sel = elements.term;
    sel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '（可选）选择子分类...';
    sel.appendChild(opt0);
    const terms = state.termsByTaxonomy[taxonomy] || [];
    for (let i = 0; i < terms.length; i++) {
      const t = terms[i];
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    }
    sel.disabled = !taxonomy;
  }

  async function loadYamlFile(filename) {
    showStatus('正在加载数据...', 'info');
    state.currentFilePath = filename;
    updateFilePathUI(filename);
    const config = await getConfig();
    const serverUrl = normalizeServerUrl(config.serverUrl);
    const canGithub = githubEnabled(config);
    const mode = config.mode || 'cloud';

    let content = '';
    state.githubSha = null;

    if (mode === 'cloud' && serverUrl) {
      content = await fetchFileContent(filename);
    } else if (mode === 'github' && canGithub) {
      const r = await githubGetFile(config, filename);
      content = r.content || '';
      state.githubSha = r.sha || null;
    } else {
      throw new Error('未配置对应的数据源（云服务器或 GitHub）');
    }

    state.fileKind = detectKind(filename);
    applyFileKindUi(state.fileKind);
    state.yamlData = parseYamlArray(content);

    if (state.fileKind === 'headers') {
      const hasMore = (state.yamlData || []).some((x) => x && String(x.item || '').trim() === '更多');
      if (elements.headersEntryType) elements.headersEntryType.value = hasMore ? 'sub' : 'top';
      if (elements.headersParent) {
        if (!elements.headersParent.value) elements.headersParent.value = hasMore ? '更多' : '';
      }
      if (elements.headersParentGroup) setElementVisible(elements.headersParentGroup, elements.headersEntryType && elements.headersEntryType.value === 'sub');
      if (elements.logoGroup) setElementVisible(elements.logoGroup, elements.headersEntryType && elements.headersEntryType.value === 'top');
      if (elements.titleLabelText) elements.titleLabelText.textContent = (elements.headersEntryType && elements.headersEntryType.value === 'sub') ? '子项名称' : '导航名称';
      if (elements.urlLabelText) elements.urlLabelText.textContent = (elements.headersEntryType && elements.headersEntryType.value === 'sub') ? '子项链接' : '链接';
      if (elements.logoLabelText) elements.logoLabelText.textContent = '图标';
      if (elements.title) elements.title.placeholder = (elements.headersEntryType && elements.headersEntryType.value === 'sub') ? '例如：😀Emoji' : '例如：首页';
      if (elements.url) elements.url.placeholder = (elements.headersEntryType && elements.headersEntryType.value === 'sub') ? '例如：./assets/emoji/' : '例如：./ 或 https://...';
      if (elements.logo) elements.logo.placeholder = '例如：fa fa-home';
    }

    if (state.fileKind === 'webstack') {
      const { taxonomies, termsByTaxonomy } = computeTaxonomyFromYaml(state.yamlData);
      state.taxonomies = taxonomies;
      state.termsByTaxonomy = termsByTaxonomy;
    } else {
      state.taxonomies = [];
      state.termsByTaxonomy = {};
    }

    setElementVisible(elements.aiRecommendation, false);
    setElementVisible(elements.taxonomyCard, state.fileKind === 'webstack');
    setElementVisible(elements.termLabel, state.fileKind === 'webstack');
    setElementVisible(elements.taxonomy, state.fileKind === 'webstack');
    setElementVisible(elements.term, state.fileKind === 'webstack');
    setElementVisible(elements.addTaxonomyBtn, state.fileKind === 'webstack');
    setElementVisible(elements.addTermBtn, state.fileKind === 'webstack');

    if (state.fileKind === 'webstack') {
      populateTaxonomySelect();
      populateTermSelect('');
      setAiBadge('AI 未分析');
      if (elements.aiRecText) elements.aiRecText.textContent = '';
    } else {
      setAiBadge('');
    }

    showStatus('就绪', 'success');
  }

  async function initApp() {
    const config = await getConfig();
    const serverUrl = normalizeServerUrl(config.serverUrl);
    const canGithub = githubEnabled(config);
    const mode = config.mode || 'cloud';

    let files = [];
    if (mode === 'cloud' && serverUrl) {
      files = await fetchFileList();
    } else if (mode === 'github' && canGithub) {
      files = await githubListYamlFiles(config);
    } else {
      // 不抛出异常，让下拉框能显示“选择文件...”以便不打破UI
      showStatus('请先在设置页配置对应的数据源并确保有权限', 'error');
    }

    elements.dataSource.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '选择文件...';
    elements.dataSource.appendChild(opt0);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      elements.dataSource.appendChild(opt);
    }

    if (state.currentFilePath && files.indexOf(state.currentFilePath) !== -1) {
      elements.dataSource.value = state.currentFilePath;
      await loadYamlFile(state.currentFilePath);
    }

    elements.dataSource.addEventListener('change', async (e) => {
      const selected = e.target.value;
      if (!selected) {
        state.currentFilePath = null;
        chrome.storage.local.remove('dataSourcePath');
        updateFilePathUI(null);
        return;
      }
      chrome.storage.local.set({ dataSourcePath: selected });
      await loadYamlFile(selected);
    });
  }

  async function autoFillCurrentTab(force) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || !tabs[0]) return;
      const tab = tabs[0];
      const shouldForce = force === true;
      if (tab.title && (shouldForce || !elements.title.value)) elements.title.value = tab.title;
      if (tab.url && (shouldForce || !elements.url.value)) elements.url.value = tab.url;

      if (!tab.id) return;
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const title = document.title || '';
          const metaDesc =
            (document.querySelector('meta[name="description"]') && document.querySelector('meta[name="description"]').getAttribute('content')) ||
            (document.querySelector('meta[property="og:description"]') && document.querySelector('meta[property="og:description"]').getAttribute('content')) ||
            '';
          const iconEl = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
          const iconHref = iconEl ? iconEl.getAttribute('href') : '';
          const urlObj = new URL(location.href);
          const favicon = iconHref ? new URL(iconHref, urlObj.origin).href : `https://www.google.com/s2/favicons?domain=${urlObj.hostname}`;
          const text = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 4000) : '';
          return { title, metaDesc, favicon, text };
        }
      });
      const r = results && results[0] ? results[0].result : null;
      if (!r) return;
      if (r.title && (shouldForce || !elements.title.value)) elements.title.value = r.title;
      if (shouldForce) {
        if (typeof r.metaDesc === 'string') elements.description.value = r.metaDesc;
      } else {
        if (r.metaDesc && !elements.description.value) elements.description.value = r.metaDesc;
      }
      if (r.favicon && (shouldForce || !elements.logo.value)) elements.logo.value = r.favicon;
      state.pageContent = r.text || '';

      if (shouldForce) {
        state.aiResult = null;
        setAiBadge('AI 未分析');
        setElementVisible(elements.aiRecommendation, false);
        if (elements.aiRecText) elements.aiRecText.textContent = '';
      }
    } catch (e) {}
  }

  async function restoreFloatingState() {
    const r = await getLocal(['navManageFloatingState']);
    const snap = r && r.navManageFloatingState ? r.navManageFloatingState : null;
    if (!snap) return;

    const file = snap.currentFilePath ? String(snap.currentFilePath) : '';
    if (file && elements.dataSource) {
      if (elements.dataSource.value !== file) {
        const options = Array.from(elements.dataSource.options || []);
        const exists = options.some((o) => o && o.value === file);
        if (exists) {
          elements.dataSource.value = file;
          state.currentFilePath = file;
          await loadYamlFile(file);
        }
      }
    }

    const tab = snap.activeTab === 'search' ? 'search' : 'add';
    switchTab(tab);

    const inputs = snap.inputs && typeof snap.inputs === 'object' ? snap.inputs : {};
    if (typeof inputs.title === 'string') elements.title.value = inputs.title;
    if (typeof inputs.url === 'string') elements.url.value = inputs.url;
    if (typeof inputs.logo === 'string') elements.logo.value = inputs.logo;
    if (typeof inputs.description === 'string') elements.description.value = inputs.description;

    if (state.fileKind === 'webstack') {
      if (inputs.taxonomy) {
        elements.taxonomy.value = String(inputs.taxonomy);
        populateTermSelect(String(inputs.taxonomy));
      }
      if (inputs.term) {
        elements.term.value = String(inputs.term);
      }
    }
  }

  let isAiAnalyzing = false;
  async function startAiAnalysis() {
    if (isAiAnalyzing) return;
    if (state.fileKind !== 'webstack') return;
    if (!state.pageContent) return;
    if (!state.taxonomies || state.taxonomies.length === 0) return;

    try {
      const cacheKey = buildAiCacheKey();
      const r = await getLocal(['navManageAiCache']);
      const cache = r && r.navManageAiCache ? r.navManageAiCache : null;
      const ts = cache && cache.ts ? Number(cache.ts) : 0;
      const cachedResult = cache && cache.result ? cache.result : null;
      const maxAgeMs = 12 * 60 * 60 * 1000;
      if (cache && cache.key === cacheKey && cachedResult && ts && (Date.now() - ts) < maxAgeMs) {
        const recTaxonomy = typeof cachedResult.taxonomy === 'string' ? cachedResult.taxonomy.trim() : '';
        const recTerm = typeof cachedResult.term === 'string' ? cachedResult.term.trim() : '';
        const taxonomyOk = recTaxonomy && state.taxonomies.indexOf(recTaxonomy) !== -1;
        const termOk = taxonomyOk && recTerm && (state.termsByTaxonomy[recTaxonomy] || []).indexOf(recTerm) !== -1;

        state.aiResult = {
          title: typeof cachedResult.title === 'string' ? cachedResult.title : '',
          summary: typeof cachedResult.summary === 'string' ? cachedResult.summary : '',
          taxonomy: taxonomyOk ? recTaxonomy : '',
          term: termOk ? recTerm : ''
        };

        if (state.aiResult.title) elements.title.value = state.aiResult.title;
        if (state.aiResult.summary) elements.description.value = state.aiResult.summary;

        const recText = state.aiResult.taxonomy ? `${state.aiResult.taxonomy}${state.aiResult.term ? ' > ' + state.aiResult.term : ''}` : '未匹配到现有分类';
        setElementVisible(elements.aiRecommendation, true);
        elements.aiRecText.textContent = recText;
        setAiBadge('AI 已分析');
        return;
      }
    } catch (e) {}

    setElementVisible(elements.aiRecommendation, false);
    if (elements.aiRecText) elements.aiRecText.textContent = '';

    const config = await getConfig();
    const provider = config.aiProvider || (config.aiModel === 'gemini' ? 'gemini' : (config.aiModel === 'openai' ? 'openai' : 'none'));
    const endpointRaw = String(config.aiEndpoint || '').trim();
    const apiKeyRaw = String(config.aiApiKey || '').trim();
    const modelRaw = String(config.aiModelName || '').trim();
    const translateToZh = config.aiTranslateToZh !== false;

    if (provider === 'none' || (!apiKeyRaw && provider !== 'ollama')) {
      setAiBadge('AI 分析未启用');
      setElementVisible(elements.aiRecommendation, false);
      return;
    }

    isAiAnalyzing = true;
    setAiBadge('AI 分析中...');
    setElementVisible(elements.aiRecommendation, true);
    elements.aiRecText.textContent = '正在分析...';

    const defaults = {
      openai: { endpoint: 'https://api.openai.com/v1', model: 'gpt-3.5-turbo' },
      openrouter: { endpoint: 'https://openrouter.ai/api/v1', model: 'gpt-3.5-turbo' },
      doubao: { endpoint: 'https://ark.cn-beijing.volces.com/api/v3', model: 'gpt-3.5-turbo' },
      bytedance: { endpoint: 'https://ark.cn-beijing.volces.com/api/v3', model: 'gpt-3.5-turbo' },
      zhipu: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
      siliconflow: { endpoint: 'https://api.siliconflow.cn/v1', model: 'gpt-3.5-turbo' },
      hunyuan: { endpoint: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'gpt-3.5-turbo' },
      gitee: { endpoint: '', model: 'gpt-3.5-turbo' },
      custom: { endpoint: '', model: 'gpt-3.5-turbo' },
      ollama: { endpoint: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' },
      gemini: { endpoint: '', model: 'gemini-1.5-flash' }
    };

    const providerDefaults = defaults[provider] || defaults.custom;
    const model = modelRaw || providerDefaults.model;
    const endpoint = endpointRaw || providerDefaults.endpoint;

    const prompt =
      `你是一个导航站收录助手。分类必须严格匹配现有分类，不允许输出不存在的分类或子分类。\n\n` +
      `可选分类列表:\n${JSON.stringify(state.taxonomies)}\n\n` +
      `可选子分类(按分类分组):\n${JSON.stringify(state.termsByTaxonomy)}\n\n` +
      `网页标题: ${elements.title.value}\n` +
      `网页地址: ${elements.url.value}\n` +
      `网页内容片段: ${String(state.pageContent).slice(0, 1500)}\n\n` +
      (translateToZh ? `要求：summary 必须是中文；如果来源是英文，请先翻译成中文再总结。\n\n` : '') +
      `请直接返回 JSON(不要包含markdown)，格式:\n{\n  "title": "精简后的标题",\n  "summary": "一句话摘要",\n  "taxonomy": "必须是可选分类之一，或空字符串",\n  "term": "必须是该分类下的可选子分类之一，或空字符串"\n}`;

    try {
      let result = null;
      if (provider === 'ollama') {
        const url = `${endpoint.replace(/\/+$/, '')}/api/chat`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: model, messages: [{ role: 'user', content: prompt }], stream: false })
        });
        const data = await response.json();
        const text = (data && data.message && data.message.content) ? data.message.content : '';
        result = JSON.parse(String(text).replace(/```json|```/g, '').trim());
      } else if (provider === 'gemini') {
        let url = endpoint;
        if (!url) {
          url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        } else if (url.indexOf(':generateContent') === -1) {
          url = `${url.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
        }
        if (url.indexOf('key=') === -1) {
          url += (url.indexOf('?') !== -1 ? '&' : '?') + `key=${encodeURIComponent(apiKeyRaw)}`;
        }
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();
        const text =
          data && data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts && data.candidates[0].content.parts[0]
            ? data.candidates[0].content.parts[0].text
            : '';
        result = JSON.parse(String(text).replace(/```json|```/g, '').trim());
      } else {
        const base = endpoint || providerDefaults.endpoint;
        if (!base) throw new Error('AI Endpoint 未配置');
        const url = base.endsWith('/chat/completions') ? base : `${base.replace(/\/+$/, '')}/chat/completions`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKeyRaw}` },
          body: JSON.stringify({ model: model, messages: [{ role: 'user', content: prompt }] })
        });
        const data = await response.json();
        const text = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
        result = JSON.parse(String(text).replace(/```json|```/g, '').trim());
      }

      if (!result) throw new Error('无结果');
      const recTaxonomy = typeof result.taxonomy === 'string' ? result.taxonomy.trim() : '';
      const recTerm = typeof result.term === 'string' ? result.term.trim() : '';
      const taxonomyOk = recTaxonomy && state.taxonomies.indexOf(recTaxonomy) !== -1;
      const termOk = taxonomyOk && recTerm && (state.termsByTaxonomy[recTaxonomy] || []).indexOf(recTerm) !== -1;

      state.aiResult = {
        title: typeof result.title === 'string' ? result.title : '',
        summary: typeof result.summary === 'string' ? result.summary : '',
        taxonomy: taxonomyOk ? recTaxonomy : '',
        term: termOk ? recTerm : ''
      };

      if (state.aiResult.title) elements.title.value = state.aiResult.title;
      if (state.aiResult.summary) elements.description.value = state.aiResult.summary;

      if (translateToZh && looksEnglish(state.aiResult.summary)) {
        const translatePrompt =
          `将下面这段内容翻译成中文，要求：\n` +
          `1) 只输出译文，不要解释\n` +
          `2) 保持一句话摘要风格，尽量精炼\n\n` +
          `内容：\n${state.aiResult.summary}`;

        let translated = '';
        try {
          if (provider === 'ollama') {
            const url = `${endpoint.replace(/\/+$/, '')}/api/chat`;
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: model, messages: [{ role: 'user', content: translatePrompt }], stream: false })
            });
            const data = await response.json();
            translated = (data && data.message && data.message.content) ? String(data.message.content).trim() : '';
          } else if (provider === 'gemini') {
            let url = endpoint;
            if (!url) {
              url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
            } else if (url.indexOf(':generateContent') === -1) {
              url = `${url.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
            }
            if (url.indexOf('key=') === -1) {
              url += (url.indexOf('?') !== -1 ? '&' : '?') + `key=${encodeURIComponent(apiKeyRaw)}`;
            }
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents: [{ parts: [{ text: translatePrompt }] }] })
            });
            const data = await response.json();
            translated =
              data && data.candidates && data.candidates[0] && data.candidates[0].content &&
              data.candidates[0].content.parts && data.candidates[0].content.parts[0]
                ? String(data.candidates[0].content.parts[0].text).trim()
                : '';
          } else {
            const base = endpoint || providerDefaults.endpoint;
            const url = base.endsWith('/chat/completions') ? base : `${base.replace(/\/+$/, '')}/chat/completions`;
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKeyRaw}` },
              body: JSON.stringify({ model: model, messages: [{ role: 'user', content: translatePrompt }] })
            });
            const data = await response.json();
            translated = data && data.choices && data.choices[0] && data.choices[0].message ? String(data.choices[0].message.content).trim() : '';
          }
        } catch (e) {}

        if (translated) {
          translated = translated.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, '')).trim();
          state.aiResult.summary = translated;
          elements.description.value = translated;
        }
      }

      const recText = state.aiResult.taxonomy ? `${state.aiResult.taxonomy}${state.aiResult.term ? ' > ' + state.aiResult.term : ''}` : '未匹配到现有分类';
      elements.aiRecText.textContent = recText;
      setAiBadge('AI 分析完成');
      try {
        await setLocal({ navManageAiCache: { key: buildAiCacheKey(), ts: Date.now(), result: state.aiResult } });
      } catch (e) {}
    } catch (e) {
      setAiBadge(`AI 分析失败${e && e.message ? '：' + e.message : ''}`);
    } finally {
      isAiAnalyzing = false;
    }
  }

  elements.applyAiRec.addEventListener('click', async () => {
    if (!state.aiResult) return;
    if (!state.aiResult.taxonomy) return;
    if (state.taxonomies.indexOf(state.aiResult.taxonomy) === -1) return;
    elements.taxonomy.value = state.aiResult.taxonomy;
    populateTermSelect(state.aiResult.taxonomy);
    if (state.aiResult.term && (state.termsByTaxonomy[state.aiResult.taxonomy] || []).indexOf(state.aiResult.term) !== -1) {
      elements.term.value = state.aiResult.term;
    }
  });

  if (elements.rerunAi) {
    elements.rerunAi.addEventListener('click', async () => {
      try {
        if (isAiAnalyzing) return;
        await setLocal({ navManageAiCache: null });
        await autoFillCurrentTab();
        await startAiAnalysis();
      } catch (e) {}
    });
  }

  elements.taxonomy.addEventListener('change', () => {
    populateTermSelect(elements.taxonomy.value);
  });

  elements.addTaxonomyBtn.addEventListener('click', async () => {
    const name = prompt('请输入新增分类名称');
    if (!name) return;
    const t = String(name).trim();
    if (!t) return;
    if (state.taxonomies.indexOf(t) !== -1) {
      elements.taxonomy.value = t;
      populateTermSelect(t);
      return;
    }
    state.taxonomies.push(t);
    state.termsByTaxonomy[t] = state.termsByTaxonomy[t] || [];
    populateTaxonomySelect();
    elements.taxonomy.value = t;
    populateTermSelect(t);
  });

  elements.addTermBtn.addEventListener('click', async () => {
    const tax = elements.taxonomy.value;
    if (!tax) return showStatus('请先选择分类', 'error');
    const name = prompt('请输入新增子分类名称');
    if (!name) return;
    const term = String(name).trim();
    if (!term) return;
    const list = state.termsByTaxonomy[tax] || [];
    if (list.indexOf(term) === -1) list.push(term);
    state.termsByTaxonomy[tax] = list;
    populateTermSelect(tax);
    elements.term.value = term;
  });

  elements.send.addEventListener('click', async () => {
    try {
      const config = await getConfig();
      const serverUrl = normalizeServerUrl(config.serverUrl);
      const writeToCloud = config.writeToCloud === true;
      const writeToGithub = config.writeToGithub === true;
      const canCloud = writeToCloud && Boolean(serverUrl);
      const canGithub = writeToGithub && githubEnabled(config);
      if (!canCloud && !canGithub) return showStatus('请在设置页启用云服务器或 GitHub 写入', 'error');
      if (!state.currentFilePath) return showStatus('请先选择文件', 'error');

      const title = String(elements.title.value || '').trim();
      const url = String(elements.url.value || '').trim();
      const logo = String(elements.logo.value || '').trim();
      const description = String(elements.description.value || '').trim();
      if (!title || !url) {
        if (state.fileKind === 'headers') return showStatus('导航名称与链接不能为空', 'error');
        if (state.fileKind === 'friendlinks') return showStatus('站点名称与链接不能为空', 'error');
        return showStatus('标题与地址不能为空', 'error');
      }

      const allowCreateCategory = config.allowCreateCategory !== false;
      const newDataEntry = { title: title, url: url, logo: logo, description: description, kind: state.fileKind };

      if (state.fileKind === 'webstack') {
        const taxonomy = String(elements.taxonomy.value || '').trim();
        const term = String(elements.term.value || '').trim();
        if (!taxonomy) return showStatus('请选择分类', 'error');
        newDataEntry.taxonomy = taxonomy;
        if (term) newDataEntry.term = term;
      }
      if (state.fileKind === 'headers') {
        const entryType = elements.headersEntryType && elements.headersEntryType.value ? String(elements.headersEntryType.value) : 'top';
        if (entryType === 'sub') {
          const parentItem = elements.headersParent ? String(elements.headersParent.value || '').trim() : '';
          if (!parentItem) return showStatus('请选择父级菜单（item）', 'error');
          newDataEntry.headersType = 'sub';
          newDataEntry.parentItem = parentItem;
          newDataEntry.logo = '';
          newDataEntry.description = '';
        } else {
          newDataEntry.headersType = 'top';
          newDataEntry.description = '';
        }
      }

      showStatus('正在收录...', 'info');
      if (state.yamlData) {
        state.yamlData = applyEntryToYamlData(state.yamlData, newDataEntry, allowCreateCategory);
      }

      let cloudOk = false;
      let githubOk = false;
      let cloudErr = '';
      let githubErr = '';

      if (canCloud) {
        try {
          const res = await fetch(`${serverUrl}/api/yaml`, {
            method: 'POST',
            headers: authHeaders(config),
            body: JSON.stringify({ filename: state.currentFilePath, newDataEntry: newDataEntry, allowCreateCategory: allowCreateCategory })
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(text || '云服务器保存失败');
          }
          cloudOk = true;
        } catch (e) {
          cloudErr = e && e.message ? String(e.message) : '云服务器保存失败';
        }
      }

      if (canGithub) {
        try {
          const { content, sha } = await githubGetFile(config, state.currentFilePath);
          const data = applyEntryToYamlData(parseYamlArray(content), newDataEntry, allowCreateCategory);
          const newContent = dumpYamlArray(data);
          const putRes = await githubPutFile(
            config,
            state.currentFilePath,
            newContent,
            sha,
            `Add/Update ${title} in ${state.currentFilePath}`
          );
          state.githubSha = putRes && putRes.sha ? putRes.sha : sha;
          state.yamlData = data;
          githubOk = true;
        } catch (e) {
          githubErr = e && e.message ? String(e.message) : 'GitHub 同步失败';
        }
      }

      if ((canCloud && cloudOk) || (canGithub && githubOk)) {
        if (canCloud && canGithub) {
          if (cloudOk && githubOk) showStatus('收录成功（云端 + GitHub 已同步）', 'success');
          else if (cloudOk && !githubOk) showStatus(`云端已收录，GitHub 同步失败：${githubErr || '未知错误'}`, 'error');
          else if (!cloudOk && githubOk) showStatus(`GitHub 已收录，云端同步失败：${cloudErr || '未知错误'}`, 'error');
          else showStatus('收录失败', 'error');
        } else if (cloudOk) {
          showStatus('收录成功（云端）', 'success');
        } else if (githubOk) {
          showStatus('收录成功（GitHub）', 'success');
        } else {
          showStatus('收录失败', 'error');
        }
      } else {
        showStatus(cloudErr || githubErr || '收录失败', 'error');
      }
    } catch (e) {
      showStatus(e && e.message ? e.message : '收录失败', 'error');
    }
  });

  function switchTab(tab) {
    const isSearch = tab === 'search';
    elements.tabAdd.classList.toggle('active', !isSearch);
    elements.tabSearch.classList.toggle('active', isSearch);
    setElementVisible(elements.panelAdd, !isSearch);
    setElementVisible(elements.panelSearch, isSearch);
  }

  function renderSearchResults(items) {
    elements.searchResults.innerHTML = '';
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
      elements.searchResults.innerHTML = '<div class="status">没有找到匹配结果</div>';
      return;
    }
    list.forEach((it) => {
      const div = document.createElement('div');
      div.className = 'result-item';
      const kind = it && it.kind ? String(it.kind) : state.fileKind;
      const title = it && it.title ? String(it.title) : '';
      const url = it && it.url ? String(it.url) : '';
      const desc = it && it.description ? String(it.description) : '';
      const tax = kind === 'webstack' && it && it.taxonomy ? String(it.taxonomy) : '';
      const term = kind === 'webstack' && it && it.term ? String(it.term) : '';
      const where = tax ? `${tax}${term ? ' > ' + term : ''}` : '';

      div.innerHTML = `
        <div class="result-title">${title}</div>
        ${where ? `<div class="result-meta">${where}</div>` : ''}
        ${url ? `<div class="result-meta">${url}</div>` : ''}
        ${desc ? `<div class="result-meta">${desc}</div>` : ''}
        <div class="result-actions"><button class="danger-btn" type="button">删除</button></div>
      `;
      div.querySelector('.danger-btn').addEventListener('click', async () => {
        await deleteEntryByTitle(title, kind);
        await performSearch();
      });
      elements.searchResults.appendChild(div);
    });
  }

  async function performSearch() {
    const kw = String(elements.searchInput.value || '').trim();
    if (!kw) {
      elements.searchResults.innerHTML = '<div class="status">输入关键词进行搜索</div>';
      return;
    }
    if (!state.currentFilePath) {
      elements.searchResults.innerHTML = '<div class="status">请先在“收录”页选择文件</div>';
      return;
    }

    const config = await getConfig();
    const serverUrl = normalizeServerUrl(config.serverUrl);
    const canCloudRead = Boolean(serverUrl);
    const canGithubRead = githubEnabled(config);

    try {
      if (canCloudRead) {
        const res = await fetch(
          `${serverUrl}/api/search?keyword=${encodeURIComponent(kw)}&filePath=${encodeURIComponent(state.currentFilePath)}`
        );
        if (!res.ok) throw new Error('搜索失败');
        const data = await res.json();
        renderSearchResults(data);
        return;
      }
      if (canGithubRead) {
        if (!state.yamlData) {
          await loadYamlFile(state.currentFilePath);
        }
        renderSearchResults(searchInYamlData(state.yamlData, state.fileKind, kw));
        return;
      }
      elements.searchResults.innerHTML = '<div class="status">未配置云服务器或 GitHub</div>';
    } catch (e) {
      elements.searchResults.innerHTML = `<div class="status">搜索失败${e && e.message ? '：' + e.message : ''}</div>`;
    }
  }

  async function deleteEntryByTitle(title, kind) {
    if (!title) return;
    const config = await getConfig();
    const serverUrl = normalizeServerUrl(config.serverUrl);
    const k = String(kind || state.fileKind || 'webstack');
    const writeToCloud = config.writeToCloud === true;
    const writeToGithub = config.writeToGithub === true;
    const canCloud = writeToCloud && Boolean(serverUrl);
    const canGithub = writeToGithub && githubEnabled(config);
    if (!canCloud && !canGithub) return;

    if (canCloud) {
      const res = await fetch(`${serverUrl}/api/delete`, {
        method: 'DELETE',
        headers: authHeaders(config),
        body: JSON.stringify({ filename: state.currentFilePath, title, kind: k })
      });
      if (!res.ok) {
        const text = await res.text();
        showStatus(text || '云服务器删除失败', 'error');
        return;
      }
    }

    if (canGithub) {
      try {
        const { content, sha } = await githubGetFile(config, state.currentFilePath);
        const parsed = parseYamlArray(content);
        const del = deleteByTitleFromYamlData(parsed, k, title);
        if (!del.deleted) return;
        const newContent = dumpYamlArray(del.yamlData);
        const putRes = await githubPutFile(config, state.currentFilePath, newContent, sha, `Delete ${title} from ${state.currentFilePath}`);
        state.githubSha = putRes && putRes.sha ? putRes.sha : sha;
        state.yamlData = del.yamlData;
      } catch (e) {
        showStatus(e && e.message ? e.message : 'GitHub 删除失败', 'error');
        return;
      }
    } else if (state.yamlData) {
      const del = deleteByTitleFromYamlData(state.yamlData, k, title);
      state.yamlData = del.yamlData;
    }
  }

  elements.themeToggle.addEventListener('click', () => {
    try {
      const root = document.documentElement;
      const isDark = root.classList.contains('dark-mode');
      if (isDark) {
        root.classList.remove('dark-mode');
        localStorage.setItem('theme_preference', 'light');
      } else {
        root.classList.add('dark-mode');
        localStorage.setItem('theme_preference', 'dark');
      }
    } catch (e) {}
  });

  elements.tabAdd.addEventListener('click', () => switchTab('add'));
  elements.tabSearch.addEventListener('click', () => switchTab('search'));
  if (elements.tabAi) {
    elements.tabAi.addEventListener('click', () => {
      startAiAnalysis();
    });
  }
  if (elements.headersEntryType) {
    elements.headersEntryType.addEventListener('change', () => {
      if (state.fileKind !== 'headers') return;
      const t = String(elements.headersEntryType.value || 'top');
      if (elements.headersParentGroup) setElementVisible(elements.headersParentGroup, t === 'sub');
      if (elements.logoGroup) setElementVisible(elements.logoGroup, t === 'top');
      if (elements.titleLabelText) elements.titleLabelText.textContent = t === 'sub' ? '子项名称' : '导航名称';
      if (elements.urlLabelText) elements.urlLabelText.textContent = t === 'sub' ? '子项链接' : '链接';
      if (t === 'sub') {
        if (elements.title) elements.title.placeholder = '例如：😀Emoji';
        if (elements.url) elements.url.placeholder = '例如：./assets/emoji/';
      } else {
        if (elements.title) elements.title.placeholder = '例如：首页';
        if (elements.url) elements.url.placeholder = '例如：./ 或 https://...';
      }
    });
  }
  if (elements.tabTheme) {
    elements.tabTheme.addEventListener('click', () => {
      try {
        elements.themeToggle && elements.themeToggle.click();
      } catch (e) {}
    });
  }
  if (elements.closeBtn) {
    elements.closeBtn.addEventListener('click', () => {
      try { window.close(); } catch (e) {}
    });
  }
  if (elements.pinBtn) {
    elements.pinBtn.addEventListener('click', () => {
      try {
        if (pinInFlight) return;
        pinInFlight = true;
        setTimeout(() => { pinInFlight = false; }, 1200);
        const snap = {
          ts: Date.now(),
          activeTab: elements.tabSearch && elements.tabSearch.classList.contains('active') ? 'search' : 'add',
          currentFilePath: state.currentFilePath || (elements.dataSource ? elements.dataSource.value : ''),
          inputs: {
            title: String(elements.title.value || ''),
            url: String(elements.url.value || ''),
            logo: String(elements.logo.value || ''),
            description: String(elements.description.value || ''),
            taxonomy: elements.taxonomy ? String(elements.taxonomy.value || '') : '',
            term: elements.term ? String(elements.term.value || '') : ''
          }
        };

        chrome.storage.local.set({ navManageFloatingState: snap, dataSourcePath: snap.currentFilePath || null }, async () => {
          chrome.runtime.sendMessage({ type: 'navManageToggleOverlay' }, () => {
            try { window.close(); } catch (e) {}
          });
        });
      } catch (e) {}
    });
  }

  if (elements.invalidCheckBtn) {
    elements.invalidCheckBtn.addEventListener('click', async () => {
      try {
        if (invalidWinInFlight) return;
        invalidWinInFlight = true;
        setTimeout(() => { invalidWinInFlight = false; }, 1200);

        const snap = {
          ts: Date.now(),
          currentFilePath: state.currentFilePath || (elements.dataSource ? elements.dataSource.value : '')
        };
        await setLocal({ navManageInvalidCheckState: snap, dataSourcePath: snap.currentFilePath || null });

        chrome.storage.local.get(['navManageInvalidCheckWindowId', 'navManageInvalidCheckTabId'], (r) => {
          const winId = r && r.navManageInvalidCheckWindowId ? Number(r.navManageInvalidCheckWindowId) : 0;
          const tabId = r && r.navManageInvalidCheckTabId ? Number(r.navManageInvalidCheckTabId) : 0;
          const nextUrl = chrome.runtime.getURL(`invalid-check.html?ts=${Date.now()}`);

          const createWin = () => {
            chrome.windows.create(
              { url: nextUrl, type: 'popup', width: 520, height: 720, focused: true },
              (w) => {
                const wid = w && w.id ? Number(w.id) : 0;
                const tid = w && w.tabs && w.tabs[0] && w.tabs[0].id ? Number(w.tabs[0].id) : 0;
                chrome.storage.local.set({
                  navManageInvalidCheckWindowId: wid || null,
                  navManageInvalidCheckTabId: tid || null
                });
              }
            );
          };

          if (winId && tabId) {
            chrome.windows.get(winId, {}, () => {
              if (chrome.runtime.lastError) {
                chrome.storage.local.remove(['navManageInvalidCheckWindowId', 'navManageInvalidCheckTabId'], createWin);
                return;
              }
              chrome.tabs.update(tabId, { url: nextUrl, active: true }, () => {
                if (chrome.runtime.lastError) {
                  chrome.storage.local.remove(['navManageInvalidCheckWindowId', 'navManageInvalidCheckTabId'], createWin);
                  return;
                }
                chrome.windows.update(winId, { focused: true }, () => {});
              });
            });
            return;
          }

          if (winId && !tabId) {
            chrome.windows.get(winId, { populate: true }, (w) => {
              if (chrome.runtime.lastError || !w) {
                chrome.storage.local.remove(['navManageInvalidCheckWindowId', 'navManageInvalidCheckTabId'], createWin);
                return;
              }
              const t = w.tabs && w.tabs[0] ? w.tabs[0] : null;
              if (t && t.id) {
                chrome.storage.local.set({ navManageInvalidCheckTabId: Number(t.id) }, () => {
                  chrome.tabs.update(Number(t.id), { url: nextUrl, active: true }, () => {
                    chrome.windows.update(winId, { focused: true }, () => {});
                  });
                });
              } else {
                chrome.storage.local.remove(['navManageInvalidCheckWindowId', 'navManageInvalidCheckTabId'], createWin);
              }
            });
            return;
          }

          createWin();
        });
      } catch (e) {}
    });
  }
  elements.executeSearch.addEventListener('click', performSearch);
  elements.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') performSearch();
  });

  chrome.storage.local.get(['dataSourcePath'], async (result) => {
    state.currentFilePath = (result && result.dataSourcePath) ? result.dataSourcePath : null;
    if (isFloating) {
      if (state.autoFillTimer) clearTimeout(state.autoFillTimer);
      state.autoFillTimer = setTimeout(() => autoFillCurrentTab(true), 120);

      const scheduleAutoFill = () => {
        if (state.autoFillTimer) clearTimeout(state.autoFillTimer);
        state.autoFillTimer = setTimeout(() => autoFillCurrentTab(true), 180);
      };

      try {
        chrome.tabs.onActivated.addListener(() => scheduleAutoFill());
        chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
          if (!tab || !tab.active) return;
          if (changeInfo && (changeInfo.url || changeInfo.status === 'complete')) scheduleAutoFill();
        });
      } catch (e) {}
    } else {
      autoFillCurrentTab(false);
    }
    try {
      await initApp();
      if (isFloating) {
        await restoreFloatingState();
      }
    } catch (e) {
      showStatus(e && e.message ? e.message : '初始化失败', 'error');
    }
  });
})();
