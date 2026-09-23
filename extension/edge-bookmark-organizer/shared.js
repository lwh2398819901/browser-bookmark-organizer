(function (global) {
  'use strict';

  const temporaryFolderName = '临时收藏';
  const recycleFolderName = '回收站';
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

  const multiPartSuffixes = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.cn', 'net.cn', 'org.cn', 'com.au', 'net.au', 'co.jp', 'com.hk', 'com.tw', 'com.br']);

  function siteKey(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      const labels = hostname.split('.').filter(Boolean);
      if (labels.length <= 2) return labels.join('.');
      const tail = labels.slice(-2).join('.');
      return (multiPartSuffixes.has(tail) ? labels.slice(-3) : labels.slice(-2)).join('.');
    } catch {
      return '';
    }
  }

  function bookmarkFolderName(bookmark) {
    const folders = (bookmark.path || []).slice(0, -1);
    return folders[folders.length - 1] || '收藏夹栏';
  }

  function siteFootprint(bookmarks, url) {
    const site = siteKey(url);
    const pageCanonical = canonicalUrl(url);
    const onSite = site ? bookmarks.filter(item => siteKey(item.url) === site) : [];
    const folderCounts = new Map();
    for (const item of onSite) {
      const name = bookmarkFolderName(item);
      folderCounts.set(name, (folderCounts.get(name) || 0) + 1);
    }
    let home = null;
    let homeCount = 0;
    for (const [name, count] of folderCounts) {
      if (count > homeCount) {
        home = name;
        homeCount = count;
      }
    }
    const concentrated = onSite.length > 0 && homeCount * 2 > onSite.length;
    const currentFolders = new Set(onSite.filter(item => item.canonical === pageCanonical).map(bookmarkFolderName));
    const seen = new Set();
    const samples = [];
    const ranked = [...onSite].sort((left, right) => {
      const leftNear = currentFolders.has(bookmarkFolderName(left)) ? 0 : 1;
      const rightNear = currentFolders.has(bookmarkFolderName(right)) ? 0 : 1;
      if (leftNear !== rightNear) return leftNear - rightNear;
      return Number(left.canonical === pageCanonical) - Number(right.canonical === pageCanonical);
    });
    for (const item of ranked) {
      if (item.canonical === pageCanonical || seen.has(item.canonical)) continue;
      seen.add(item.canonical);
      samples.push({ title: item.title || item.url, folder: bookmarkFolderName(item) });
      if (samples.length === 3) break;
    }
    return {
      count: onSite.length,
      otherCount: onSite.filter(item => item.canonical !== pageCanonical).length,
      uniquePages: new Set(onSite.map(item => item.canonical)).size,
      folderCount: folderCounts.size,
      home: concentrated ? home : null,
      samples
    };
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
      action: item.action || 'move',
      id: item.id,
      folderPath: item.folderPath || null,
      title: item.title,
      url: item.url || null,
      fromParentId: item.fromParentId,
      fromIndex: item.fromIndex,
      fromPath: item.fromPath,
      name: item.name || null,
      toParentPath: item.toParentPath || null,
      toIndex: Number.isInteger(item.toIndex) ? item.toIndex : null,
      snapshot: item.snapshot || null
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
      const targets = [item.folderPath, item.toParentPath].filter(path => Array.isArray(path));
      for (const target of targets) {
        for (let length = 2; length <= target.length; length += 1) {
          const path = target.slice(0, length).join('/');
          if (!existing.has(path)) missing.add(path);
        }
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
            dateAdded: node.dateAdded ?? null,
            canonical: canonicalUrl(node.url),
            path
          });
        } else if (String(node.id || '') !== '0') {
          folders.push({
            id: node.id,
            parentId: node.parentId,
            index: node.index,
            title: node.title,
            dateAdded: node.dateAdded ?? null,
            path
          });
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
      let timingOut = false;
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
        if (item?.state === 'interrupted' && !timingOut) finish(reject, Object.assign(new Error(`备份下载中断：${item.error || '未知原因'}`), { code: 'ARCHIVE_INTERRUPTED', details: { download: downloadDetails(item) } }));
      };
      const listener = delta => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === 'complete') {
          chrome.downloads.search({ id: downloadId }).then(found => inspect(found[0])).catch(error => finish(reject, error));
        }
        if (delta.state.current === 'interrupted' && !timingOut) chrome.downloads.search({ id: downloadId }).then(found => inspect(found[0])).catch(error => finish(reject, error));
      };
      chrome.downloads.onChanged.addListener(listener);
      timer = setTimeout(async () => {
        timingOut = true;
        try {
          let item = (await chrome.downloads.search({ id: downloadId }))[0];
          if (item?.state === 'complete') { inspect(item); return; }
          let cancellation = 'not-needed';
          if (item?.state === 'in_progress') {
            try { await chrome.downloads.cancel(downloadId); cancellation = 'requested'; }
            catch (error) { cancellation = error.message; }
          }
          item = (await chrome.downloads.search({ id: downloadId }))[0];
          if (item?.state === 'complete') { inspect(item); return; }
          const error = new Error('备份下载等待超时。请检查浏览器下载页中的暂停、待确认或安全检查项目；不要直接重复备份。');
          error.code = 'ARCHIVE_TIMEOUT';
          error.details = { download: downloadDetails(item || { id: downloadId }), cancellation, temporaryFileCleanup: 'unverified' };
          finish(reject, error);
        } catch (error) { finish(reject, error); }
      }, timeoutMs);
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

  async function archiveCurrentBookmarks(timeoutMs = 30000) {
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
      const item = await waitForDownload(downloadId, timeoutMs);
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

  function downloadDetails(item) {
    const details = Object.fromEntries(['id', 'filename', 'state', 'error', 'danger', 'paused', 'bytesReceived', 'totalBytes', 'exists', 'startTime', 'fileSize'].map(key => [key, item[key] ?? null]));
    details.elapsedMs = item.startTime ? Math.max(0, (Date.parse(item.endTime) || Date.now()) - Date.parse(item.startTime)) : null;
    return details;
  }

  async function archiveDiagnostics() {
    const items = await chrome.downloads.search({ query: [archiveDirectory, archivePrefix], orderBy: ['-startTime'], limit: 0 });
    return items.filter(item => isManagedArchive({ ...item, state: 'complete', filename: (item.filename || '').replace(/\.crdownload$/i, '') }))
      .map(downloadDetails);
  }

  function idsUnder(node) {
    const ids = new Set();
    if (node) walk(node, [], item => ids.add(item.id));
    return ids;
  }

  async function searchManagedArchives() {
    const downloads = await chrome.downloads.search({
      query: [archiveDirectory, archivePrefix],
      orderBy: ['-startTime'],
      limit: 0
    });
    return downloads.filter(item => isManagedArchive(item) && item.exists !== false);
  }

  async function listManagedArchives() {
    return (await searchManagedArchives()).slice(0, maxArchives);
  }

  function localDayBound(value, end) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return end ? new Date(year, month - 1, day, 23, 59, 59, 999).getTime() : new Date(year, month - 1, day).getTime();
  }

  function archivesInScope(archives, { olderThanDays = null, from = '', until = '', now = Date.now() } = {}) {
    const start = localDayBound(from, false);
    const end = localDayBound(until, true);
    if (from || until) {
      if (start === null || end === null) throw new Error('指定时段需要同时填写开始和结束日期。');
      if (start > end) throw new Error('开始日期不能晚于结束日期。');
      return archives.filter(item => {
        const time = Date.parse(item.startTime || '');
        return Number.isFinite(time) && time >= start && time <= end;
      });
    }
    if (olderThanDays === null || olderThanDays === undefined || olderThanDays === '') {
      throw new Error('需要指定天数，或同时给出开始和结束日期。');
    }
    const days = Number(olderThanDays);
    if (!Number.isInteger(days) || days < 0) throw new Error('天数必须是 0 或正整数。');
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    return archives.filter(item => {
      const time = Date.parse(item.startTime || '');
      return Number.isFinite(time) && time < cutoff;
    });
  }

  async function removeManagedArchives(items) {
    const removed = [];
    const warnings = [];
    for (const item of items) {
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

  function describeFolders(folders, bookmarks) {
    return folders.map(folder => {
      const parts = folder.path;
      const bookmarkCount = bookmarks.filter(item => {
        const parent = item.path.slice(0, -1);
        return parent.length >= parts.length && parts.every((part, index) => parent[index] === part);
      }).length;
      const childFolderCount = folders.filter(other =>
        other.path.length === parts.length + 1 && parts.every((part, index) => other.path[index] === part)
      ).length;
      return {
        id: folder.id,
        parentId: folder.parentId,
        index: folder.index,
        title: folder.title,
        dateAdded: folder.dateAdded ?? null,
        pathParts: parts,
        path: parts.join('/'),
        bookmarkCount,
        childFolderCount,
        isEmpty: bookmarkCount === 0 && childFolderCount === 0,
        protected: parts.includes(temporaryFolderName) || parts.includes(recycleFolderName)
      };
    });
  }

  function treeChecksum(folders, bookmarks) {
    const lines = [
      ...folders.map(folder => `f\t${folder.id}\t${folder.index}\t${folder.path.join('/')}`),
      ...bookmarks.map(item => `b\t${item.id}\t${item.index}\t${item.path.join('/')}\t${item.url}`)
    ].sort();
    let hash = 5381;
    const text = lines.join('\n');
    for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash, 33) ^ text.charCodeAt(index);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function snapshotNode(node) {
    if (!node) return null;
    if (node.url) return { title: node.title || '', url: node.url };
    return { title: node.title || '', children: (node.children || []).map(snapshotNode) };
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
    recycleFolderName,
    archiveDirectory,
    archivePrefix,
    maxArchives,
    normalizedQuery,
    canonicalUrl,
    siteKey,
    siteFootprint,
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
    waitForDownload,
    archiveDiagnostics,
    idsUnder,
    isManagedArchive,
    listManagedArchives,
    searchManagedArchives,
    archivesInScope,
    removeManagedArchives,
    trimArchives,
    archiveCleanupMessage,
    formatDate,
    formatBytes,
    bookmarkExists,
    describeFolders,
    treeChecksum,
    snapshotNode,
    createOperationStore
  };
})(globalThis);
