(function (global) {
  'use strict';

  const temporaryFolderName = '临时收藏';
  const archiveDirectory = 'Bookmark-Organizer-Archives';
  const archivePrefix = 'bookmark-archive-';
  const maxArchives = 30;
  const trackingKeys = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi']);

  function decodedQueryPart(value) {
    try { return decodeURIComponent(value.replace(/\+/g, ' ')); }
    catch { return value; }
  }

  function normalizedQuery(value) {
    if (!value) return '';
    const fields = [];
    for (const rawField of value.split('&')) {
      const separator = rawField.includes('=');
      const index = rawField.indexOf('=');
      const rawKey = separator ? rawField.slice(0, index) : rawField;
      const rawValue = separator ? rawField.slice(index + 1) : '';
      const key = decodedQueryPart(rawKey);
      const queryValue = decodedQueryPart(rawValue);
      const loweredKey = key.toLowerCase();
      if (trackingKeys.has(loweredKey) || loweredKey.startsWith('utm_')) continue;
      const rendered = `${encodeURIComponent(key)}${separator ? `=${encodeURIComponent(queryValue)}` : ''}`;
      fields.push({ loweredKey, queryValue, separator, rendered });
    }
    fields.sort((left, right) =>
      left.loweredKey.localeCompare(right.loweredKey) ||
      left.queryValue.localeCompare(right.queryValue) ||
      Number(left.separator) - Number(right.separator) ||
      left.rendered.localeCompare(right.rendered)
    );
    return fields.map(field => field.rendered).join('&');
  }

  function canonicalUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.protocol = parsed.protocol.toLowerCase();
      parsed.hostname = parsed.hostname.toLowerCase();
      if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) parsed.port = '';
      if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) parsed.pathname = parsed.pathname.slice(0, -1);
      const query = normalizedQuery(parsed.search.slice(1));
      parsed.search = query ? `?${query}` : '';
      return parsed.toString();
    } catch {
      return String(url || '').trim();
    }
  }

  function normalizePath(path) {
    return String(path || '').split('/').map(part => part.trim()).filter(Boolean);
  }

  function planSignature(plan) {
    return JSON.stringify(plan.map(item => ({
      id: item.id,
      folderPath: item.folderPath,
      title: item.title,
      url: item.url,
      fromParentId: item.fromParentId,
      fromIndex: item.fromIndex,
      fromPath: item.fromPath
    })));
  }

  function temporaryBookmarks(folder, folderPath) {
    const found = [];
    if (!folder) return found;
    walk(folder, folderPath.slice(0, -1), (node, path) => {
      if (!node.url) return;
      found.push({
        id: node.id,
        parentId: node.parentId,
        index: node.index,
        title: node.title,
        url: node.url,
        canonical: canonicalUrl(node.url),
        path
      });
    });
    return found;
  }

  function missingFolderPaths(existingPaths, plan) {
    const existing = new Set(existingPaths);
    const missing = new Set();
    for (const item of plan) {
      for (let length = 2; length <= item.folderPath.length; length += 1) {
        const path = item.folderPath.slice(0, length).join('/');
        if (!existing.has(path)) missing.add(path);
      }
    }
    return [...missing];
  }

  function walk(node, ancestors, visit) {
    const path = node.title ? [...ancestors, node.title] : ancestors;
    visit(node, path);
    for (const child of node.children || []) walk(child, path, visit);
  }

  function collectBookmarks(roots) {
    const folders = [];
    const bookmarks = [];
    for (const root of roots) {
      walk(root, [], (node, path) => {
        if (node.url) {
          bookmarks.push({
            id: node.id,
            parentId: node.parentId,
            index: node.index,
            title: node.title,
            url: node.url,
            canonical: canonicalUrl(node.url),
            path
          });
        } else if (String(node.id || '') !== '0') {
          folders.push({ id: node.id, parentId: node.parentId, title: node.title, path });
        }
      });
    }
    return { folders, bookmarks };
  }

  function findBookmarkBar(roots) {
    const topFolders = roots.flatMap(root => (root.children || []).filter(node => !node.url));
    return topFolders.find(node => node.folderType === 'bookmarks-bar') ||
      topFolders.find(node => String(node.id) === '1') ||
      topFolders[0] || null;
  }

  function findTemporaryFolder(roots) {
    const bar = findBookmarkBar(roots);
    const underBar = (bar?.children || []).find(node => !node.url && node.title === temporaryFolderName);
    if (underBar) return underBar;
    let found = null;
    for (const root of roots) {
      walk(root, [], node => {
        if (!found && !node.url && node.title === temporaryFolderName) found = node;
      });
    }
    return found;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function netscapeTimestamp(value) {
    const milliseconds = Number(value);
    return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.floor(milliseconds / 1000) : null;
  }

  function dateAttribute(name, value) {
    const timestamp = netscapeTimestamp(value);
    return timestamp === null ? '' : ` ${name}="${timestamp}"`;
  }

  function rootFolderAttribute(node, index) {
    const id = String(node.id || '');
    if (id === '1' || index === 0) return ' PERSONAL_TOOLBAR_FOLDER="true"';
    if (id === '2' || index === 1) return ' UNFILED_BOOKMARKS_FOLDER="true"';
    if (id === '3' || index === 2) return ' MOBILE_BOOKMARKS_FOLDER="true"';
    return '';
  }

  function bookmarkNodeToHtml(node, depth = 1, folderAttribute = '') {
    const indent = '  '.repeat(depth);
    if (node.url) {
      return `${indent}<DT><A HREF="${escapeHtml(node.url)}"${dateAttribute('ADD_DATE', node.dateAdded)}>${escapeHtml(node.title)}</A>\n`;
    }
    const title = escapeHtml(node.title || '未命名文件夹');
    const children = (node.children || []).map(child => bookmarkNodeToHtml(child, depth + 1)).join('');
    return `${indent}<DT><H3${dateAttribute('ADD_DATE', node.dateAdded)}${dateAttribute('LAST_MODIFIED', node.dateGroupModified)}${folderAttribute}>${title}</H3>\n${indent}<DL><p>\n${children}${indent}</DL><p>\n`;
  }

  function bookmarksToNetscapeHtml(roots) {
    const rootFolders = roots.flatMap(root => root.children || []);
    const body = rootFolders.map((node, index) => bookmarkNodeToHtml(node, 1, rootFolderAttribute(node, index))).join('');
    return [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<!-- This is an automatically generated file. It will be read and overwritten. -->',
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      '<TITLE>Bookmarks</TITLE>',
      '<H1>Bookmarks</H1>',
      '<DL><p>',
      body,
      '</DL><p>'
    ].join('\n');
  }

  function bookmarkTreeStats(roots) {
    const collected = collectBookmarks(roots);
    return { bookmarks: collected.bookmarks.length, folders: collected.folders.length };
  }

  function archiveFileName() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${archiveDirectory}/${archivePrefix}${timestamp}.html`;
  }

  async function waitForDownload(downloadId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        callback(value);
      };
      const inspect = item => {
        if (item?.state === 'complete') finish(resolve, item);
        if (item?.state === 'interrupted') finish(reject, new Error(`备份下载中断：${item.error || '未知原因'}`));
      };
      const listener = delta => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === 'complete') {
          chrome.downloads.search({ id: downloadId }).then(found => inspect(found[0])).catch(error => finish(reject, error));
        }
        if (delta.state.current === 'interrupted') finish(reject, new Error(`备份下载中断：${delta.error?.current || '未知原因'}`));
      };
      chrome.downloads.onChanged.addListener(listener);
      timer = setTimeout(() => finish(reject, new Error('备份下载等待超时。')), timeoutMs);
      chrome.downloads.search({ id: downloadId }).then(found => inspect(found[0])).catch(error => finish(reject, error));
    });
  }

  function supportsArchiveObjectUrl() {
    return typeof URL !== 'undefined'
      && typeof URL.createObjectURL === 'function'
      && typeof URL.revokeObjectURL === 'function'
      && typeof Blob !== 'undefined';
  }

  function utf8ToBase64(text) {
    if (typeof TextEncoder !== 'function' || typeof btoa !== 'function') {
      throw new Error('当前扩展后台无法编码收藏夹归档。');
    }
    const bytes = new TextEncoder().encode(text);
    const chunkSize = 0x2000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function createArchiveUrl(content) {
    if (supportsArchiveObjectUrl()) {
      return URL.createObjectURL(new Blob([content], { type: 'text/html;charset=utf-8' }));
    }
    return `data:text/html;charset=utf-8;base64,${utf8ToBase64(content)}`;
  }

  function releaseArchiveUrl(url) {
    if (supportsArchiveObjectUrl() && url.startsWith('blob:')) URL.revokeObjectURL(url);
  }

  async function archiveCurrentBookmarks() {
    const roots = await chrome.bookmarks.getTree();
    const content = bookmarksToNetscapeHtml(roots);
    const stats = bookmarkTreeStats(roots);
    const createdAt = new Date().toISOString();
    const archiveUrl = createArchiveUrl(content);
    try {
      const downloadId = await chrome.downloads.download({
        url: archiveUrl,
        filename: archiveFileName(),
        saveAs: false,
        conflictAction: 'uniquify'
      });
      const item = await waitForDownload(downloadId);
      return { downloadId, filename: item.filename, createdAt, ...stats };
    } finally {
      releaseArchiveUrl(archiveUrl);
    }
  }

  function isManagedArchive(item) {
    const escapedDirectory = archiveDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedPrefix = archivePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filenamePattern = new RegExp(`[\\\\/]${escapedDirectory}[\\\\/]${escapedPrefix}.+\\.html$`, 'i');
    return item.state === 'complete' && filenamePattern.test(item.filename || '');
  }

  async function listManagedArchives() {
    const downloads = await chrome.downloads.search({
      query: [archiveDirectory, archivePrefix],
      orderBy: ['-startTime'],
      limit: 0
    });
    return downloads.filter(item => isManagedArchive(item) && item.exists !== false).slice(0, maxArchives);
  }

  async function trimArchives() {
    const downloads = await chrome.downloads.search({
      query: [archiveDirectory, archivePrefix],
      orderBy: ['-startTime'],
      limit: 0
    });
    const oldArchives = downloads.filter(item => isManagedArchive(item) && item.exists !== false).slice(maxArchives);
    const removed = [];
    const warnings = [];
    for (const item of oldArchives) {
      try {
        await chrome.downloads.removeFile(item.id);
        await chrome.downloads.erase({ id: item.id });
        removed.push(item.filename);
      } catch (error) {
        warnings.push(`${item.filename}：${error.message}`);
      }
    }
    return { removed, warnings };
  }

  function archiveCleanupMessage(cleanup) {
    const removed = cleanup.removed.length ? `\n已清理 ${cleanup.removed.length} 份最早备份。` : '';
    const warnings = cleanup.warnings.length ? `\n备份保留清理提示：${cleanup.warnings.join('；')}` : '';
    return `${removed}${warnings}`;
  }

  function formatDate(value) {
    if (!value) return '时间未知';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '时间未知';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(date);
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '大小未知';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  /**
   * chrome.bookmarks.get 对不存在的 id 会报错，而不是返回空数组。
   * 撤销和预检都需要把“书签已被用户删除”当作可跳过的正常情况处理。
   */
  async function bookmarkExists(id) {
    try {
      await chrome.bookmarks.get(id);
      return true;
    } catch {
      return false;
    }
  }

  function createOperationStore(storageKey, maxHistory) {
    async function load() {
      const stored = await chrome.storage.local.get({ [storageKey]: [] });
      return Array.isArray(stored[storageKey]) ? stored[storageKey] : [];
    }

    async function save(operations) {
      await chrome.storage.local.set({ [storageKey]: operations.slice(0, maxHistory) });
    }

    async function add(operation) {
      const operations = await load();
      operations.unshift(operation);
      await save(operations);
    }

    return { load, save, add };
  }

  global.BookmarkOrganizerCore = {
    temporaryFolderName,
    archiveDirectory,
    archivePrefix,
    maxArchives,
    normalizedQuery,
    canonicalUrl,
    normalizePath,
    planSignature,
    temporaryBookmarks,
    missingFolderPaths,
    walk,
    collectBookmarks,
    findBookmarkBar,
    findTemporaryFolder,
    bookmarksToNetscapeHtml,
    bookmarkTreeStats,
    archiveCurrentBookmarks,
    isManagedArchive,
    listManagedArchives,
    trimArchives,
    archiveCleanupMessage,
    formatDate,
    formatBytes,
    bookmarkExists,
    createOperationStore
  };
})(globalThis);
