(() => {
  const els = {
    fileName: document.getElementById('fileName'),
    progressText: document.getElementById('progressText'),
    barInner: document.getElementById('barInner'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    status: document.getElementById('status'),
    resultList: document.getElementById('resultList'),
    closeBtn: document.getElementById('closeBtn')
  };

  let stopped = false;

  function setStatus(text, kind) {
    els.status.textContent = text || '';
    els.status.style.color = kind === 'error' ? 'var(--danger)' : kind === 'success' ? 'var(--ok)' : 'var(--muted)';
  }

  function setProgress(checked, total) {
    const t = total > 0 ? total : 0;
    const c = checked > 0 ? checked : 0;
    els.progressText.textContent = t ? `${c}/${t}` : `${c}`;
    const p = t ? Math.min(100, Math.round((c / t) * 100)) : 0;
    els.barInner.style.width = `${p}%`;
  }

  function renderItems(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
      els.resultList.innerHTML = '<div class="item"><div class="item-meta">无</div></div>';
      return;
    }
    els.resultList.innerHTML = '';
    list.forEach((it) => {
      const div = document.createElement('div');
      div.className = 'item';
      const title = it && it.title ? String(it.title) : '';
      const url = it && it.url ? String(it.url) : '';
      const where = it && (it.taxonomy || it.term) ? `${it.taxonomy || ''}${it.term ? ' > ' + it.term : ''}` : '';
      const c404 = typeof it.count404 === 'number' ? it.count404 : '';
      div.innerHTML = `
        <div class="item-title">${title || '(无标题)'}</div>
        ${where ? `<div class="item-meta">${where}</div>` : ''}
        ${url ? `<div class="item-meta">${url}</div>` : ''}
        ${c404 ? `<div class="item-meta">连续404：${c404}</div>` : ''}
      `;
      els.resultList.appendChild(div);
    });
  }

  async function getConfig() {
    return await new Promise((resolve) => {
      chrome.storage.sync.get(['serverUrl', 'serverToken', 'token'], (r) => resolve(r || {}));
    });
  }

  async function getState() {
    return await new Promise((resolve) => {
      chrome.storage.local.get(['navManageInvalidCheckState', 'dataSourcePath'], (r) => resolve(r || {}));
    });
  }

  function normalizeServerUrl(url) {
    if (!url) return '';
    url = String(url).trim();
    if (url.endsWith('/')) url = url.slice(0, -1);
    return url;
  }

  function authHeaders(config) {
    const headers = { 'Content-Type': 'application/json' };
    const token = String(config.serverToken || config.token || '').trim();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  async function run() {
    stopped = false;
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    setStatus('准备中...', 'info');
    renderItems([]);
    setProgress(0, 0);

    const s = await getState();
    const filename =
      (s && s.navManageInvalidCheckState && s.navManageInvalidCheckState.currentFilePath) ?
        String(s.navManageInvalidCheckState.currentFilePath) :
        (s && s.dataSourcePath ? String(s.dataSourcePath) : '');
    els.fileName.textContent = filename || '-';
    if (!filename) {
      setStatus('请先在扩展主界面选择数据库文件', 'error');
      els.startBtn.disabled = false;
      els.stopBtn.disabled = true;
      return;
    }

    const config = await getConfig();
    const serverUrl = normalizeServerUrl(config.serverUrl);
    if (!serverUrl) {
      setStatus('未配置云服务器地址', 'error');
      els.startBtn.disabled = false;
      els.stopBtn.disabled = true;
      return;
    }

    const token = String(config.serverToken || config.token || '').trim();
    if (!token) {
      setStatus('未配置管理员 Token（无法执行失效检测）', 'error');
      els.startBtn.disabled = false;
      els.stopBtn.disabled = true;
      return;
    }

    let offset = 0;
    const limit = 40;
    let total = 0;
    let checked = 0;
    let removed = 0;
    const removedItems = [];

    setStatus('检测中...', 'info');
    while (!stopped) {
      const res = await fetch(`${serverUrl}/api/invalid-links/check`, {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({ filename, limit, offset })
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || '请求失败');
      }
      const data = await res.json();
      total = Number(data.totalLinks || total || 0);
      checked += Number(data.checkedCount || 0);
      removed += Number(data.removedCount || 0);
      setProgress(checked, total);

      const items = Array.isArray(data.removedItems) ? data.removedItems : [];
      items.forEach((x) => removedItems.push(x));
      renderItems(removedItems);

      if (!data.hasMore) {
        setStatus(removed > 0 ? `完成，已清理 ${removed} 个失效链接` : '完成，未发现失效链接', 'success');
        break;
      }
      offset = Number(data.nextOffset || (offset + limit));
      els.progressText.textContent = `${checked}/${total}（继续...）`;
      await new Promise((r) => setTimeout(r, 600));
    }

    if (stopped) {
      setStatus('已停止', 'error');
    }
  }

  els.startBtn.addEventListener('click', async () => {
    try {
      await run();
    } catch (e) {
      setStatus(e && e.message ? e.message : '检测失败', 'error');
      els.startBtn.disabled = false;
      els.stopBtn.disabled = true;
    } finally {
      if (!stopped) {
        els.startBtn.disabled = false;
        els.stopBtn.disabled = true;
      }
    }
  });

  els.stopBtn.addEventListener('click', () => {
    stopped = true;
    els.stopBtn.disabled = true;
    els.startBtn.disabled = false;
  });

  els.closeBtn.addEventListener('click', () => {
    try { window.close(); } catch (e) {}
  });

  (async () => {
    const s = await getState();
    const filename =
      (s && s.navManageInvalidCheckState && s.navManageInvalidCheckState.currentFilePath) ?
        String(s.navManageInvalidCheckState.currentFilePath) :
        (s && s.dataSourcePath ? String(s.dataSourcePath) : '');
    els.fileName.textContent = filename || '-';
    renderItems([]);
  })();
})();

