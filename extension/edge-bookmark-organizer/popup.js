(function () {
  'use strict';

  const core = globalThis.BookmarkOrganizerCore;
  const pageTitle = document.querySelector('#page-title');
  const currentCard = document.querySelector('#current-card');
  const pageUrl = document.querySelector('#page-url');
  const pageState = document.querySelector('#page-state');
  const addButton = document.querySelector('#add-temporary');
  const temporaryCount = document.querySelector('#temporary-count');
  const duplicateCount = document.querySelector('#duplicate-count');
  const backupButton = document.querySelector('#backup');
  const backupStatus = document.querySelector('#backup-status');
  const latestBackup = document.querySelector('#latest-backup');
  const openManagerButton = document.querySelector('#open-manager');
  const closePopupButton = document.querySelector('#close-popup');
  let currentTab = null;

  function setState(element, text, kind = '') {
    element.textContent = text;
    element.className = `state${kind ? ` ${kind}` : ''}`;
  }

  function duplicateGroups(bookmarks) {
    const counts = new Map();
    for (const bookmark of bookmarks) counts.set(bookmark.canonical, (counts.get(bookmark.canonical) || 0) + 1);
    return [...counts.values()].filter(count => count > 1).length;
  }

  function bookmarksInside(node) {
    const found = [];
    if (!node) return found;
    core.walk(node, [], child => { if (child.url) found.push(child); });
    return found;
  }

  async function refreshSummary() {
    const roots = await chrome.bookmarks.getTree();
    const collected = core.collectBookmarks(roots);
    const temporary = core.findTemporaryFolder(roots);
    temporaryCount.textContent = String(bookmarksInside(temporary).length);
    duplicateCount.textContent = String(duplicateGroups(collected.bookmarks));
    return { roots, collected, temporary };
  }

  async function inspectCurrentPage() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs[0] || null;
    if (currentTab?.url?.startsWith(chrome.runtime.getURL(''))) {
      currentCard.hidden = true;
      await refreshSummary();
      return;
    }
    pageTitle.textContent = currentTab?.title || '无法读取当前网页';
    pageUrl.textContent = currentTab?.url || '';
    if (!currentTab?.url || !/^https?:/i.test(currentTab.url)) {
      setState(pageState, '当前页面不能加入收藏夹。', 'error');
      addButton.disabled = true;
      return;
    }
    const { collected } = await refreshSummary();
    const canonical = core.canonicalUrl(currentTab.url);
    const existing = collected.bookmarks.filter(item => item.canonical === canonical);
    if (existing.length) {
      const paths = existing.slice(0, 2).map(item => item.path.slice(0, -1).join(' / ')).join('；');
      setState(pageState, `已经收藏：${paths}`, 'success');
      addButton.disabled = true;
      return;
    }
    setState(pageState, '尚未收藏。');
    addButton.disabled = false;
  }

  async function ensureTemporaryFolder(roots) {
    const existing = core.findTemporaryFolder(roots);
    if (existing) return existing;
    const bar = core.findBookmarkBar(roots);
    if (!bar) throw new Error('没有找到收藏夹栏。');
    return chrome.bookmarks.create({ parentId: bar.id, title: core.temporaryFolderName });
  }

  addButton.addEventListener('click', async () => {
    try {
      addButton.disabled = true;
      setState(pageState, '正在检查并收藏…');
      const roots = await chrome.bookmarks.getTree();
      const collected = core.collectBookmarks(roots);
      const canonical = core.canonicalUrl(currentTab.url);
      const existing = collected.bookmarks.find(item => item.canonical === canonical);
      if (existing) {
        setState(pageState, `已经收藏：${existing.path.slice(0, -1).join(' / ')}`, 'success');
        return;
      }
      const temporary = await ensureTemporaryFolder(roots);
      await chrome.bookmarks.create({
        parentId: temporary.id,
        title: currentTab.title || currentTab.url,
        url: currentTab.url
      });
      setState(pageState, '已加入“临时收藏”。', 'success');
      await refreshSummary();
      window.close();
    } catch (error) {
      setState(pageState, `收藏失败：${error.message}`, 'error');
      addButton.disabled = false;
    }
  });

  backupButton.addEventListener('click', async () => {
    try {
      backupButton.disabled = true;
      setState(backupStatus, '正在备份全部收藏夹…');
      const response = await chrome.runtime.sendMessage({
        channel: 'bookmark-organizer-popup',
        request: { command: 'backup' }
      });
      if (!response?.ok) throw new Error(response?.error || '扩展后台没有返回备份结果。');
      setState(backupStatus, '备份完成。', 'success');
      window.close();
    } catch (error) {
      setState(backupStatus, `备份失败：${error.message}`, 'error');
      backupButton.disabled = false;
    }
  });

  async function refreshLatestBackup() {
    const archives = await core.listManagedArchives();
    latestBackup.textContent = archives.length ? `最近：${core.formatDate(archives[0].startTime)}` : '尚无本扩展创建的备份';
  }

  openManagerButton.addEventListener('click', async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
    window.close();
  });

  closePopupButton.addEventListener('click', () => window.close());

  async function initializePopup() {
    try {
      await Promise.all([inspectCurrentPage(), refreshLatestBackup()]);
    } catch (error) {
      setState(pageState, `读取失败：${error.message}`, 'error');
    }
  }

  initializePopup();
})();
