(() => {
  const modeSelect = document.getElementById('mode');
  const serverUrlInput = document.getElementById('serverUrl');
  const serverTokenInput = document.getElementById('serverToken');
  const githubUserInput = document.getElementById('githubUser');
  const githubRepoInput = document.getElementById('githubRepo');
  const githubBranchInput = document.getElementById('githubBranch');
  const githubPathInput = document.getElementById('githubPath');
  const githubTokenInput = document.getElementById('githubToken');

  const webhookUrlInput = document.getElementById('webhookUrl');
  const telegramChatIdInput = document.getElementById('telegramChatId');
  const telegramBotTokenInput = document.getElementById('telegramBotToken');
  const rssChannelTitleInput = document.getElementById('rssChannelTitle');
  const rssChannelLinkInput = document.getElementById('rssChannelLink');
  const rssChannelDescriptionInput = document.getElementById('rssChannelDescription');
  const rssImageUrlInput = document.getElementById('rssImageUrl');
  const rssImageTitleInput = document.getElementById('rssImageTitle');
  const rssImageLinkInput = document.getElementById('rssImageLink');
  const telegramMessageTitleInput = document.getElementById('telegramMessageTitle');
  const telegramNavTextInput = document.getElementById('telegramNavText');

  const writeToCloudInput = document.getElementById('writeToCloud');
  const writeToGithubInput = document.getElementById('writeToGithub');
  const allowCreateCategoryInput = document.getElementById('allowCreateCategory');

  const aiProviderSelect = document.getElementById('aiProvider');
  const aiProviderHint = document.getElementById('aiProviderHint');
  const aiModelNameInput = document.getElementById('aiModelName');
  const aiModelNameHint = document.getElementById('aiModelNameHint');
  const aiApiKeyField = document.getElementById('aiApiKeyField');
  const aiApiKeyInput = document.getElementById('aiApiKey');
  const aiEndpointInput = document.getElementById('aiEndpoint');
  const aiTranslateToZhInput = document.getElementById('aiTranslateToZh');

  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');

  function setStatus(text) {
    statusEl.textContent = text || '';
  }

  function normalizeServerUrl(url) {
    const u = String(url || '').trim();
    if (!u) return '';
    return u.endsWith('/') ? u.slice(0, -1) : u;
  }

  function authHeaders(serverToken) {
    const token = String(serverToken || '').trim();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  async function syncPushSettingsToServer(serverUrl, serverToken, push) {
    const url = normalizeServerUrl(serverUrl);
    const token = String(serverToken || '').trim();
    if (!url || !token) return { skipped: true };
    const res = await fetch(`${url}/api/server-settings`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        webhookUrl: push.webhookUrl,
        telegramChatId: push.telegramChatId,
        telegramBotToken: push.telegramBotToken,
        rssChannelTitle: push.rssChannelTitle,
        rssChannelLink: push.rssChannelLink,
        rssChannelDescription: push.rssChannelDescription,
        rssImageUrl: push.rssImageUrl,
        rssImageTitle: push.rssImageTitle,
        rssImageLink: push.rssImageLink,
        telegramMessageTitle: push.telegramMessageTitle,
        telegramNavText: push.telegramNavText
      })
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || '同步到后端失败');
    }
    return { ok: true };
  }

  function applyAiProviderUi(provider) {
    const p = provider || 'none';
    const isDisabled = p === 'none';
    const isOllama = p === 'ollama';
    aiApiKeyField.style.display = isOllama || isDisabled ? 'none' : 'block';
    aiModelNameInput.disabled = isDisabled;
    aiEndpointInput.disabled = isDisabled;

    if (isDisabled) {
      aiProviderHint.textContent = '已禁用 AI 分析';
      aiModelNameHint.textContent = '启用后可自定义模型名称';
      aiEndpointInput.placeholder = '例如：https://api.openai.com/v1 或 http://127.0.0.1:11434';
      return;
    }

    if (isOllama) {
      aiProviderHint.textContent = '本地 Ollama：无需 API Key；Endpoint 例如 http://127.0.0.1:11434';
      aiModelNameHint.textContent = '示例：qwen2.5:7b / llama3.1';
      aiEndpointInput.placeholder = 'http://127.0.0.1:11434';
      return;
    }

    if (p === 'gemini') {
      aiProviderHint.textContent = 'Gemini：API Key 必填；Endpoint 可留空使用默认官方地址';
      aiModelNameHint.textContent = '示例：gemini-1.5-flash / gemini-2.0-flash';
      aiEndpointInput.placeholder = '留空使用默认；或填 https://generativelanguage.googleapis.com/v1beta';
      return;
    }

    aiProviderHint.textContent = 'OpenAI 兼容：API Key 必填；Endpoint 建议填写到 /v1 或 /api/v1';
    aiModelNameHint.textContent = '示例：gpt-4o-mini / deepseek-chat / qwen-plus';
    if (p === 'openrouter') aiEndpointInput.placeholder = 'https://openrouter.ai/api/v1';
    else if (p === 'siliconflow') aiEndpointInput.placeholder = 'https://api.siliconflow.cn/v1';
    else if (p === 'zhipu') aiEndpointInput.placeholder = 'https://open.bigmodel.cn/api/paas/v4';
    else if (p === 'doubao' || p === 'bytedance') aiEndpointInput.placeholder = 'https://ark.cn-beijing.volces.com/api/v3';
    else if (p === 'hunyuan') aiEndpointInput.placeholder = 'https://api.hunyuan.cloud.tencent.com/v1';
    else if (p === 'openai') aiEndpointInput.placeholder = 'https://api.openai.com/v1';
    else if (p === 'gitee' || p === 'custom') aiEndpointInput.placeholder = '请填写服务商 Endpoint（到 /v1 或 /api/v1）';
  }

  aiProviderSelect.addEventListener('change', () => {
    applyAiProviderUi(aiProviderSelect.value);
  });

  chrome.storage.sync.get(
    [
      'mode',
      'serverUrl',
      'serverToken',
      'githubUser',
      'githubRepo',
      'githubBranch',
      'githubPath',
      'githubToken',
      'token',
      'writeToCloud',
      'writeToGithub',
      'allowCreateCategory',
      'webhookUrl',
      'telegramChatId',
      'telegramBotToken',
      'rssChannelTitle',
      'rssChannelLink',
      'rssChannelDescription',
      'rssImageUrl',
      'rssImageTitle',
      'rssImageLink',
      'telegramMessageTitle',
      'telegramNavText',
      'aiProvider',
      'aiModelName',
      'aiApiKey',
      'aiEndpoint',
      'aiModel',
      'aiTranslateToZh'
    ],
    (items) => {
      const mode = items.mode || 'cloud';
      if (modeSelect) modeSelect.value = mode;
      serverUrlInput.value = items.serverUrl || '';
      serverTokenInput.value = items.serverToken || items.token || '';
      githubUserInput.value = items.githubUser || '';
      githubRepoInput.value = items.githubRepo || '';
      githubBranchInput.value = items.githubBranch || 'main';
      githubPathInput.value = items.githubPath || 'data';
      githubTokenInput.value = items.githubToken || '';

      if (webhookUrlInput) webhookUrlInput.value = items.webhookUrl || '';
      if (telegramChatIdInput) telegramChatIdInput.value = items.telegramChatId || '';
      if (telegramBotTokenInput) telegramBotTokenInput.value = items.telegramBotToken || '';
      if (rssChannelTitleInput) rssChannelTitleInput.value = items.rssChannelTitle || 'NOISE导航收录更新';
      if (rssChannelLinkInput) rssChannelLinkInput.value = items.rssChannelLink || 'http://www.noisedh.cn';
      if (rssChannelDescriptionInput) rssChannelDescriptionInput.value = items.rssChannelDescription || '最新更新通知';
      if (rssImageUrlInput) rssImageUrlInput.value = items.rssImageUrl || 'https://s2.loli.net/2025/02/26/a6yMIxOUZjHDghp.png';
      if (rssImageTitleInput) rssImageTitleInput.value = items.rssImageTitle || 'NOISE导航';
      if (rssImageLinkInput) rssImageLinkInput.value = items.rssImageLink || 'http://www.noisedh.cn';
      if (telegramMessageTitleInput) telegramMessageTitleInput.value = items.telegramMessageTitle || '📢导航站收录更新通知！';
      if (telegramNavTextInput) telegramNavTextInput.value = items.telegramNavText || 'www.noisedh.cn 或 www.noisedh.link';

      writeToCloudInput.checked = typeof items.writeToCloud === 'boolean' ? items.writeToCloud : (mode !== 'github');
      writeToGithubInput.checked = typeof items.writeToGithub === 'boolean' ? items.writeToGithub : (mode === 'github');
      allowCreateCategoryInput.checked = items.allowCreateCategory !== false;

      const legacyProvider = items.aiModel === 'gemini' ? 'gemini' : (items.aiModel === 'openai' ? 'openai' : (items.aiModel === 'none' ? 'none' : ''));
      const provider = items.aiProvider || legacyProvider || 'none';
      aiProviderSelect.value = provider;
      aiModelNameInput.value = items.aiModelName || '';
      aiApiKeyInput.value = items.aiApiKey || '';
      aiEndpointInput.value = items.aiEndpoint || '';
      if (aiTranslateToZhInput) aiTranslateToZhInput.checked = items.aiTranslateToZh !== false;
      applyAiProviderUi(provider);
    }
  );

  saveBtn.addEventListener('click', () => {
    const config = {
      mode: modeSelect ? modeSelect.value : 'cloud',
      serverUrl: (serverUrlInput.value || '').trim(),
      serverToken: (serverTokenInput.value || '').trim(),
      githubUser: (githubUserInput.value || '').trim(),
      githubRepo: (githubRepoInput.value || '').trim(),
      githubBranch: (githubBranchInput.value || '').trim() || 'main',
      githubPath: (githubPathInput.value || '').trim() || 'data',
      githubToken: (githubTokenInput.value || '').trim(),
      writeToCloud: writeToCloudInput.checked,
      writeToGithub: writeToGithubInput.checked,
      allowCreateCategory: allowCreateCategoryInput.checked,
      webhookUrl: webhookUrlInput ? (webhookUrlInput.value || '').trim() : '',
      telegramChatId: telegramChatIdInput ? (telegramChatIdInput.value || '').trim() : '',
      telegramBotToken: telegramBotTokenInput ? (telegramBotTokenInput.value || '').trim() : '',
      rssChannelTitle: rssChannelTitleInput ? (rssChannelTitleInput.value || '').trim() : 'NOISE导航收录更新',
      rssChannelLink: rssChannelLinkInput ? (rssChannelLinkInput.value || '').trim() : 'http://www.noisedh.cn',
      rssChannelDescription: rssChannelDescriptionInput ? (rssChannelDescriptionInput.value || '').trim() : '最新更新通知',
      rssImageUrl: rssImageUrlInput ? (rssImageUrlInput.value || '').trim() : 'https://s2.loli.net/2025/02/26/a6yMIxOUZjHDghp.png',
      rssImageTitle: rssImageTitleInput ? (rssImageTitleInput.value || '').trim() : 'NOISE导航',
      rssImageLink: rssImageLinkInput ? (rssImageLinkInput.value || '').trim() : 'http://www.noisedh.cn',
      telegramMessageTitle: telegramMessageTitleInput ? (telegramMessageTitleInput.value || '').trim() : '📢导航站收录更新通知！',
      telegramNavText: telegramNavTextInput ? (telegramNavTextInput.value || '').trim() : 'www.noisedh.cn 或 www.noisedh.link',
      aiProvider: aiProviderSelect.value,
      aiModelName: (aiModelNameInput.value || '').trim(),
      aiApiKey: (aiApiKeyInput.value || '').trim(),
      aiEndpoint: (aiEndpointInput.value || '').trim(),
      aiTranslateToZh: aiTranslateToZhInput ? aiTranslateToZhInput.checked : true
    };

    chrome.storage.sync.set(config, async () => {
      try {
        await syncPushSettingsToServer(config.serverUrl, config.serverToken, {
          webhookUrl: config.webhookUrl,
          telegramChatId: config.telegramChatId,
          telegramBotToken: config.telegramBotToken,
          rssChannelTitle: config.rssChannelTitle,
          rssChannelLink: config.rssChannelLink,
          rssChannelDescription: config.rssChannelDescription,
          rssImageUrl: config.rssImageUrl,
          rssImageTitle: config.rssImageTitle,
          rssImageLink: config.rssImageLink,
          telegramMessageTitle: config.telegramMessageTitle,
          telegramNavText: config.telegramNavText
        });
        setStatus('已保存并同步到后端');
      } catch (e) {
        setStatus(`已保存（后端同步失败${e && e.message ? '：' + e.message : ''}）`);
      } finally {
        setTimeout(() => setStatus(''), 1800);
      }
    });
  });
})();
