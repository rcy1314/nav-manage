chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "nav-manage-save",
    title: "收录此网站到 Nav Manage",
    contexts: ["page"]
  });
});

async function getLocal(keys) {
  return await new Promise((resolve) => chrome.storage.local.get(keys, (r) => resolve(r || {})));
}

async function setLocal(obj) {
  return await new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
}

async function getPinnedOverlayState() {
  const r = await getLocal(['navManageOverlayPinned', 'navManageOverlayTabs']);
  const pinned = Boolean(r && r.navManageOverlayPinned);
  const tabs = Array.isArray(r && r.navManageOverlayTabs) ? r.navManageOverlayTabs.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0) : [];
  return { pinned, tabs };
}

function canInjectToTab(tab) {
  const url = tab && tab.url ? String(tab.url) : '';
  if (!url) return false;
  if (url.startsWith('chrome://')) return false;
  if (url.startsWith('edge://')) return false;
  if (url.startsWith('about:')) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

async function ensureOverlay(tabId) {
  const src = chrome.runtime.getURL(`popup.html?floating=1&ts=${Date.now()}`);
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [src],
    func: (iframeSrc) => {
      const id = 'nav-manage-overlay-root';
      let root = document.getElementById(id);
      if (root) {
        const iframe = root.querySelector('iframe');
        if (iframe && iframe.getAttribute('src') !== iframeSrc) iframe.setAttribute('src', iframeSrc);
        return;
      }
      root = document.createElement('div');
      root.id = id;
      root.style.position = 'fixed';
      root.style.top = '12px';
      root.style.right = '12px';
      root.style.width = '380px';
      root.style.height = '560px';
      root.style.zIndex = '2147483647';
      root.style.borderRadius = '12px';
      root.style.overflow = 'hidden';
      root.style.boxShadow = '0 14px 40px rgba(0,0,0,0.25)';
      root.style.background = '#fff';
      root.style.display = 'block';
      root.style.pointerEvents = 'auto';
      root.style.backdropFilter = 'none';

      const iframe = document.createElement('iframe');
      iframe.setAttribute('src', iframeSrc);
      iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.border = '0';
      iframe.style.display = 'block';

      root.appendChild(iframe);
      document.documentElement.appendChild(root);
    }
  });
}

async function removeOverlay(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const root = document.getElementById('nav-manage-overlay-root');
      if (root) root.remove();
    }
  });
}

async function applyOverlayToActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0] ? tabs[0] : null;
  if (!tab || !tab.id) return;
  if (!canInjectToTab(tab)) return;
  const tabId = Number(tab.id);

  await ensureOverlay(tabId);
  const s = await getPinnedOverlayState();
  const nextTabs = Array.from(new Set([...(s.tabs || []), tabId]));
  await setLocal({ navManageOverlayTabs: nextTabs });
}

async function removeOverlayFromAll() {
  const s = await getPinnedOverlayState();
  const tabs = s.tabs || [];
  for (let i = 0; i < tabs.length; i++) {
    const tabId = tabs[i];
    try {
      await removeOverlay(tabId);
    } catch (e) {}
  }
  await setLocal({ navManageOverlayTabs: [] });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || msg.type !== 'navManageToggleOverlay') return;
    const s = await getPinnedOverlayState();
    const nextPinned = !s.pinned;
    await setLocal({ navManageOverlayPinned: nextPinned });
    if (nextPinned) {
      await applyOverlayToActiveTab();
    } else {
      await removeOverlayFromAll();
    }
    sendResponse({ ok: true, pinned: nextPinned });
  })();
  return true;
});

chrome.tabs.onActivated.addListener(() => {
  (async () => {
    const s = await getPinnedOverlayState();
    if (!s.pinned) return;
    await applyOverlayToActiveTab();
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  (async () => {
    if (!changeInfo || (!changeInfo.url && changeInfo.status !== 'complete')) return;
    const s = await getPinnedOverlayState();
    if (!s.pinned) return;
    if (!tab || !tab.active) return;
    if (!canInjectToTab(tab)) return;
    try {
      await ensureOverlay(Number(tabId));
      const nextTabs = Array.from(new Set([...(s.tabs || []), Number(tabId)]));
      await setLocal({ navManageOverlayTabs: nextTabs });
    } catch (e) {}
  })();
});

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
        'githubToken'
      ],
      (items) => resolve(items || {})
    );
  });
}

function normalizeServerUrl(url) {
  if (!url) return '';
  url = url.trim();
  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  return url;
}

function authHeaders(config) {
  const headers = { 'Content-Type': 'application/json' };
  const token = (config.serverToken || config.token || '').trim();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

function dumpYamlArray(data) {
  // 简易的将对象转换为 YAML 字符串，实际后端或Github API会再处理
  // 背景脚本里没加载 js-yaml，所以这里仅用于在不支持云端时拼装
  // 推荐云端写入
  return '';
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "nav-manage-save") {
    if (!tab || !tab.url || tab.url.startsWith('chrome://')) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'Nav Manage',
        message: '无法收录该页面'
      });
      return;
    }

    try {
      const config = await getConfig();
      const serverUrl = normalizeServerUrl(config.serverUrl);
      const writeToCloud = config.writeToCloud === true;
      
      if (!writeToCloud || !serverUrl) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon.png',
          title: 'Nav Manage',
          message: '请先在扩展设置中配置云服务器并开启写入同步'
        });
        return;
      }

      // 获取当前选择的文件
      const localResult = await new Promise(res => chrome.storage.local.get(['dataSourcePath'], res));
      const filename = localResult.dataSourcePath;
      if (!filename) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon.png',
          title: 'Nav Manage',
          message: '请先打开扩展主界面选择一个数据库文件'
        });
        return;
      }

      // 获取 favicon
      let logo = tab.favIconUrl || '';
      
      const newDataEntry = {
        title: tab.title || '',
        url: tab.url,
        logo: logo,
        description: tab.title || '', // 默认用标题作为描述，若需要更精确的描述可通过 scripting 注入提取
        taxonomy: '默认分类'
      };

      const res = await fetch(`${serverUrl}/api/yaml`, {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({ 
          filename, 
          newDataEntry, 
          allowCreateCategory: true 
        })
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || '云服务器保存失败');
      }

      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: '收录成功',
        message: `已成功将 ${tab.title} 收录到 ${filename}`
      });

    } catch (e) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: '收录失败',
        message: e && e.message ? e.message : '未知错误'
      });
    }
  }
});
