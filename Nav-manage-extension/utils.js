(() => {
  async function getConfig(keys) {
    const list = Array.isArray(keys) ? keys : [];
    return await new Promise((resolve) => chrome.storage.sync.get(list, (items) => resolve(items || {})));
  }

  window.NavManageUtils = { getConfig };
})();

