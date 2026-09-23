(function () {
  'use strict';

  const core = globalThis.BookmarkOrganizerCore;
  const pageTitle = document.querySelector('#page-title');
  const currentCard = document.querySelector('#current-card');
  const pageUrl = document.querySelector('#page-url');
  const pageState = document.querySelector('#page-state');
  const siteLine = document.querySelector('#site-footprint');
  const siteSamples = document.querySelector('#site-samples');
  const addButton = document.querySelector('#add-temporary');
  const temporaryCount = document.querySelector('#temporary-count');
  const duplicateCount = document.querySelector('#duplicate-count');
  const backupButton = document.querySelector('#backup');
  const backupStatus = document.querySelector('#backup-status');
  const latestBackup = document.querySelector('#latest-backup');
  const openManagerButton = document.querySelector('#open-manager');
  const closePopupButton = document.querySelector('#close-popup');
  let currentTab = null;
  let buttonMode = 'add';
  let siteSampleItems = [];

  function setState(element, text, kind = '') {
    element.textContent = text;
    element.className = `state${kind ? ` ${kind}` : ''}`;
  }

  function duplicateGroups(bookmarks) {
    const counts = new Map();
    for (const bookmark of bookmarks) counts.set(bookmark.canonical, (counts.get(bookmark.canonical) || 0) + 1);
    return [...counts.values()].filter(count => count > 1).length;
  }

  function matchingBookmarks(bookmarks, url) {
    const canonical = core.canonicalUrl(url);
    return bookmarks.filter(item => item.canonical === canonical);
  }

  function pageSentence(existing) {
    if (!existing.length) return '这一页还没收藏。';
    const folders = existing[0].path.slice(0, -1);
    const folder = folders[folders.length - 1] || '收藏夹栏';
    return existing.length > 1
      ? `这一页已收藏 ${existing.length} 处，其中一处在「${folder}」。`
      : `这一页已收藏，在「${folder}」。`;
  }

  function siteSentence(footprint, pageSaved) {
    if (!footprint.count) return '这个网站还没有收过。';
    if (pageSaved && !footprint.otherCount) return '同站只有这一页。';
    const count = pageSaved ? footprint.otherCount : footprint.count;
    const lead = pageSaved ? `同站另外还有 ${count} 条` : `同站已有 ${count} 条`;
    const pages = !pageSaved && footprint.uniquePages !== footprint.count ? `（${footprint.uniquePages} 个不同页面）` : '';
    const place = footprint.home
      ? `，大多在「${footprint.home}」`
      : footprint.folderCount > 1 ? `，散在 ${footprint.folderCount} 个目录` : '';
    return `${lead}${pages}${place}。`;
  }

  function renderSite(bookmarks, url, pageSaved) {
    const footprint = core.siteFootprint(bookmarks, url);
    siteSampleItems = footprint.samples;
    siteLine.hidden = false;
    siteLine.disabled = siteSampleItems.length === 0;
    siteLine.textContent = siteSentence(footprint, pageSaved);
    siteLine.setAttribute('aria-expanded', 'false');
    siteSamples.hidden = true;
    siteSamples.replaceChildren();
  }

  function setBookmarkButton(mode) {
    buttonMode = mode;
    addButton.textContent = mode === 'remove' ? '取消收藏' : '加入“临时收藏”';
    addButton.className = mode === 'remove' ? 'primary danger' : 'primary';
    addButton.disabled = false;
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
      siteLine.hidden = true;
      siteSamples.hidden = true;
      setBookmarkButton('add');
      addButton.disabled = true;
      return;
    }
    const { collected } = await refreshSummary();
    paintPage(collected.bookmarks);
  }

  function paintPage(bookmarks) {
    const existing = matchingBookmarks(bookmarks, currentTab.url);
    setState(pageState, pageSentence(existing), existing.length ? 'success' : '');
    setBookmarkButton(existing.length ? 'remove' : 'add');
    renderSite(bookmarks, currentTab.url, existing.length > 0);
  }

  async function removeCurrentBookmarks() {
    addButton.disabled = true;
    setState(pageState, '正在取消收藏…');
    const roots = await chrome.bookmarks.getTree();
    const matches = matchingBookmarks(core.collectBookmarks(roots).bookmarks, currentTab.url);
    if (!matches.length) {
      setState(pageState, '尚未收藏。');
      setBookmarkButton('add');
      return;
    }
    for (const item of matches) await chrome.bookmarks.remove(item.id);
    const refreshed = await refreshSummary();
    paintPage(refreshed.collected.bookmarks);
    setState(pageState, matches.length > 1 ? `已取消 ${matches.length} 处收藏。` : '已取消收藏。', 'success');
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
      if (buttonMode === 'remove') {
        await removeCurrentBookmarks();
        return;
      }
      addButton.disabled = true;
      setState(pageState, '正在检查并收藏…');
      const roots = await chrome.bookmarks.getTree();
      const collected = core.collectBookmarks(roots);
      const existing = matchingBookmarks(collected.bookmarks, currentTab.url);
      if (existing.length) {
        paintPage(collected.bookmarks);
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
      setState(pageState, `${buttonMode === 'remove' ? '取消收藏失败' : '收藏失败'}：${error.message}`, 'error');
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

  siteLine.addEventListener('click', () => {
    if (!siteSampleItems.length) return;
    const willOpen = siteSamples.hidden;
    siteLine.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (!willOpen) {
      siteSamples.hidden = true;
      return;
    }
    siteSamples.replaceChildren(...siteSampleItems.map(sample => {
      const item = document.createElement('li');
      item.textContent = `${sample.title} · ${sample.folder}`;
      return item;
    }));
    siteSamples.hidden = false;
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
