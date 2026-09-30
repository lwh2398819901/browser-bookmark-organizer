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
  const duplicateMetric = document.querySelector('#duplicate-metric');
  const duplicateList = document.querySelector('#duplicate-list');
  const backupButton = document.querySelector('#backup');
  const backupStatus = document.querySelector('#backup-status');
  const latestBackup = document.querySelector('#latest-backup');
  const openManagerButton = document.querySelector('#open-manager');
  const closePopupButton = document.querySelector('#close-popup');
  let currentTab = null;
  let buttonMode = 'add';
  let sitePages = [];
  let duplicateItems = [];
  let duplicatesOpen = false;

  function setState(element, text, kind = '') {
    element.textContent = text;
    element.className = `state${kind ? ` ${kind}` : ''}`;
  }

  function folderPath(bookmark) {
    const folders = (bookmark.path || []).slice(0, -1);
    return folders.length ? folders.join(' / ') : '收藏夹栏';
  }

  function duplicateGroups(bookmarks) {
    const groups = new Map();
    for (const bookmark of bookmarks) {
      const copies = groups.get(bookmark.canonical) || [];
      copies.push(bookmark);
      groups.set(bookmark.canonical, copies);
    }
    return [...groups.values()].filter(copies => copies.length > 1).map(copies => ({
      title: copies.find(item => item.title)?.title || copies[0].url,
      url: copies[0].url,
      folders: copies.map(folderPath)
    }));
  }

  async function openBookmark(url) {
    await chrome.tabs.create({ url });
    window.close();
  }

  function bookmarkLink(title, url) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'bookmark-link';
    link.textContent = title;
    link.setAttribute('aria-label', `打开 ${title}`);
    link.addEventListener('click', () => openBookmark(url));
    return link;
  }

  async function removeDuplicateGroup(group, button) {
    button.disabled = true;
    try {
      const roots = await chrome.bookmarks.getTree();
      const matches = matchingBookmarks(core.collectBookmarks(roots).bookmarks, group.url);
      for (const item of matches) await chrome.bookmarks.remove(item.id);
      const refreshed = await refreshSummary();
      if (currentTab?.url && /^https?:/i.test(currentTab.url)) paintPage(refreshed.collected.bookmarks);
    } catch (error) {
      button.disabled = false;
      button.textContent = '取消失败';
    }
  }

  function paintDuplicateList() {
    duplicateList.replaceChildren(...duplicateItems.map(group => {
      const item = document.createElement('li');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'inline-danger';
      remove.textContent = '取消收藏';
      remove.addEventListener('click', () => removeDuplicateGroup(group, remove));
      item.append(bookmarkLink(group.title, group.url), ...group.folders.map(path => {
        const line = document.createElement('p');
        line.className = 'muted';
        line.textContent = path;
        return line;
      }), remove);
      return item;
    }));
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
    sitePages = footprint.pages;
    siteLine.hidden = false;
    siteLine.disabled = sitePages.length < 2;
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
    duplicateItems = duplicateGroups(collected.bookmarks);
    duplicateCount.textContent = String(duplicateItems.length);
    duplicateMetric.disabled = duplicateItems.length === 0;
    if (!duplicateItems.length) duplicatesOpen = false;
    duplicateList.hidden = !duplicatesOpen;
    duplicateMetric.setAttribute('aria-expanded', duplicatesOpen ? 'true' : 'false');
    if (duplicatesOpen) paintDuplicateList();
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
      setState(backupStatus, '请确认这次备份的名称…');
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

  duplicateMetric.addEventListener('click', () => {
    if (!duplicateItems.length) return;
    duplicatesOpen = !duplicatesOpen;
    duplicateList.hidden = !duplicatesOpen;
    duplicateMetric.setAttribute('aria-expanded', duplicatesOpen ? 'true' : 'false');
    if (duplicatesOpen) paintDuplicateList();
  });

  siteLine.addEventListener('click', () => {
    if (sitePages.length < 2) return;
    const willOpen = siteSamples.hidden;
    siteLine.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (!willOpen) {
      siteSamples.hidden = true;
      return;
    }
    siteSamples.replaceChildren(...sitePages.map(page => {
      const item = document.createElement('li');
      const path = document.createElement('p');
      path.className = 'muted';
      path.textContent = page.path;
      item.append(bookmarkLink(page.title, page.url), path);
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
