const temporaryFolderName = '临时收藏';
const archiveDirectory = 'Bookmark-Organizer-Archives';
const archivePrefix = 'bookmark-archive-';
const maxArchives = 30;
let scan = null;
let validatedPlan = null;
let validatedPlanSignature = null;

const status = document.querySelector('#status');
const items = document.querySelector('#items');
const result = document.querySelector('#result');
const backupButton = document.querySelector('#backup');
const scanButton = document.querySelector('#scan');
const copyButton = document.querySelector('#copy');
const previewButton = document.querySelector('#preview');
const applyButton = document.querySelector('#apply');
const planInput = document.querySelector('#plan');

function canonical(url) {
  try {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) parsed.port = '';
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) parsed.pathname = parsed.pathname.slice(0, -1);
    parsed.hash = '';
    return parsed.toString();
  } catch { return url.trim(); }
}

function walk(node, ancestors, visit) {
  const path = node.title ? [...ancestors, node.title] : ancestors;
  visit(node, path);
  for (const child of node.children || []) walk(child, path, visit);
}

async function scanBookmarks() {
  const roots = await chrome.bookmarks.getTree();
  const folders = [];
  const urls = [];
  let temporary = null;
  for (const root of roots) {
    walk(root, [], (node, path) => {
      if (!node.url) folders.push({ id: node.id, path });
      else urls.push({ id: node.id, title: node.title, url: node.url, canonical: canonical(node.url), path });
      if (!node.url && node.title === temporaryFolderName) temporary = node;
    });
  }
  if (!temporary) throw new Error(`未找到“${temporaryFolderName}”文件夹。`);
  const temporaryUrls = [];
  walk(temporary, [], (node) => {
    if (node.url) temporaryUrls.push({ id: node.id, title: node.title, url: node.url, canonical: canonical(node.url) });
  });
  const duplicateMap = new Map();
  for (const bookmark of urls) {
    const arr = duplicateMap.get(bookmark.canonical) || [];
    arr.push(bookmark);
    duplicateMap.set(bookmark.canonical, arr);
  }
  return { folders, urls, temporaryUrls, duplicateMap };
}

function renderScan(data) {
  const rows = data.temporaryUrls.map(bookmark => {
    const duplicates = data.duplicateMap.get(bookmark.canonical) || [];
    const elsewhere = duplicates.filter(item => item.id !== bookmark.id);
    return {
      id: bookmark.id,
      title: bookmark.title,
      url: bookmark.url,
      duplicateCount: elsewhere.length,
      duplicatePaths: elsewhere.map(item => item.path.join('/'))
    };
  });
  items.textContent = JSON.stringify(rows, null, 2);
  status.textContent = `发现 ${rows.length} 条临时收藏；其中 ${rows.filter(row => row.duplicateCount).length} 条已有重复链接。`;
  copyButton.disabled = false;
}

function normalizePath(path) {
  return path.split('/').map(part => part.trim()).filter(Boolean);
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
    const addDate = dateAttribute('ADD_DATE', node.dateAdded);
    return `${indent}<DT><A HREF="${escapeHtml(node.url)}"${addDate}>${escapeHtml(node.title)}</A>\n`;
  }
  const title = escapeHtml(node.title || '未命名文件夹');
  const children = (node.children || []).map(child => bookmarkNodeToHtml(child, depth + 1)).join('');
  const addDate = dateAttribute('ADD_DATE', node.dateAdded);
  const lastModified = dateAttribute('LAST_MODIFIED', node.dateGroupModified);
  return `${indent}<DT><H3${addDate}${lastModified}${folderAttribute}>${title}</H3>\n${indent}<DL><p>\n${children}${indent}</DL><p>\n`;
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
  const stats = { bookmarks: 0, folders: 0 };
  for (const root of roots) {
    walk(root, [], node => {
      if (node.url) stats.bookmarks += 1;
      else if (String(node.id || '') !== '0') stats.folders += 1;
    });
  }
  return stats;
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
      if (item?.state === 'interrupted') finish(reject, new Error(`归档下载中断：${item.error || '未知原因'}`));
    };
    const listener = delta => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') {
        chrome.downloads.search({ id: downloadId }).then(items => inspect(items[0])).catch(error => finish(reject, error));
      }
      if (delta.state.current === 'interrupted') finish(reject, new Error(`归档下载中断：${delta.error?.current || '未知原因'}`));
    };
    chrome.downloads.onChanged.addListener(listener);
    timer = setTimeout(() => finish(reject, new Error('归档下载等待超时，未执行移动。')), timeoutMs);
    chrome.downloads.search({ id: downloadId }).then(items => inspect(items[0])).catch(error => finish(reject, error));
  });
}

async function archiveCurrentBookmarks() {
  const roots = await chrome.bookmarks.getTree();
  const content = bookmarksToNetscapeHtml(roots);
  const stats = bookmarkTreeStats(roots);
  const createdAt = new Date().toISOString();
  const blobUrl = URL.createObjectURL(new Blob([content], { type: 'text/html;charset=utf-8' }));
  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: archiveFileName(),
      saveAs: false,
      conflictAction: 'uniquify'
    });
    const item = await waitForDownload(downloadId);
    return { downloadId, filename: item.filename, createdAt, ...stats };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function isManagedArchive(item) {
  const escapedDirectory = archiveDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedPrefix = archivePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filenamePattern = new RegExp(`[\\\\/]${escapedDirectory}[\\\\/]${escapedPrefix}.+\\.html$`, 'i');
  return item.state === 'complete' && filenamePattern.test(item.filename || '');
}

async function trimArchives() {
  const downloads = await chrome.downloads.search({
    query: [archiveDirectory, archivePrefix],
    orderBy: ['-startTime'],
    limit: 0
  });
  const oldArchives = downloads.filter(isManagedArchive).slice(maxArchives);
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
  const removed = cleanup.removed.length
    ? `\n已清理 ${cleanup.removed.length} 份最早归档。`
    : '';
  const warnings = cleanup.warnings.length
    ? `\n归档保留清理提示：${cleanup.warnings.join('；')}`
    : '';
  return `${removed}${warnings}`;
}

async function ensureFolder(path) {
  let parentId = '1';
  for (const title of path.slice(1)) {
    const children = await chrome.bookmarks.getChildren(parentId);
    let folder = children.find(child => !child.url && child.title === title);
    if (!folder) folder = await chrome.bookmarks.create({ parentId, title });
    parentId = folder.id;
  }
  return parentId;
}

function validatePlan() {
  if (!scan) throw new Error('请先扫描临时收藏。');
  const raw = planInput.value.trim();
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch {
    plan = raw.split(/\r?\n/).filter(Boolean).map(line => {
      const separator = line.indexOf('|');
      if (separator < 1) throw new Error('每行请使用“书签编号|目标目录”格式。');
      return { id: line.slice(0, separator).trim(), folderPath: line.slice(separator + 1).trim() };
    });
  }
  if (!Array.isArray(plan) || !plan.length) throw new Error('方案必须是非空 JSON 数组。');
  const temporaryIds = new Set(scan.temporaryUrls.map(item => item.id));
  const seen = new Set();
  const checked = plan.map(item => {
    if (!item || typeof item.id !== 'string' || typeof item.folderPath !== 'string') throw new Error('每项都需要字符串 id 和 folderPath。');
    if (!temporaryIds.has(item.id)) throw new Error(`书签 ${item.id} 不在临时收藏中。`);
    if (seen.has(item.id)) throw new Error(`书签 ${item.id} 重复出现在方案中。`);
    seen.add(item.id);
    const path = normalizePath(item.folderPath);
    if (!path.length || path[0] !== '收藏夹栏') throw new Error(`目标路径必须以“收藏夹栏”开头：${item.folderPath}`);
    return { id: item.id, folderPath: path };
  });
  return checked;
}

function planSignature(plan) {
  return JSON.stringify(plan);
}

planInput.addEventListener('input', () => {
  if (!validatedPlan) return;
  validatedPlan = null;
  validatedPlanSignature = null;
  applyButton.disabled = true;
  result.className = 'error';
  result.textContent = '方案内容已改变，请重新校验。';
});

backupButton.addEventListener('click', async () => {
  try {
    backupButton.disabled = true;
    applyButton.disabled = true;
    result.className = '';
    result.textContent = '正在备份当前全部收藏夹…';
    const archive = await archiveCurrentBookmarks();
    const cleanup = await trimArchives();
    result.textContent = [
      `备份已完成：${archive.filename}`,
      `生成时间：${archive.createdAt}`,
      `书签 ${archive.bookmarks} 条，文件夹 ${archive.folders} 个。`,
      '本次没有修改任何收藏夹。'
    ].join('\n') + archiveCleanupMessage(cleanup);
  } catch (error) {
    result.className = 'error';
    result.textContent = `备份失败：${error.message}\n本次没有修改任何收藏夹。`;
  } finally {
    backupButton.disabled = false;
    applyButton.disabled = !validatedPlan;
  }
});

scanButton.addEventListener('click', async () => {
  try {
    scanButton.disabled = true;
    status.textContent = '正在扫描…';
    scan = await scanBookmarks();
    renderScan(scan);
    validatedPlan = null;
    validatedPlanSignature = null;
    result.textContent = '';
    applyButton.disabled = true;
  } catch (error) {
    status.textContent = error.message;
  } finally { scanButton.disabled = false; }
});

copyButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(items.textContent);
  status.textContent = '扫描结果已复制。';
});

previewButton.addEventListener('click', () => {
  try {
    validatedPlan = validatePlan();
    validatedPlanSignature = planSignature(validatedPlan);
    result.className = '';
    result.textContent = `已校验：将移动 ${validatedPlan.length} 条收藏；必要时会创建不存在的目标文件夹。`;
    applyButton.disabled = false;
  } catch (error) {
    validatedPlan = null;
    validatedPlanSignature = null;
    applyButton.disabled = true;
    result.className = 'error';
    result.textContent = `未通过：${error.message}`;
  }
});

applyButton.addEventListener('click', async () => {
  if (!validatedPlan) return;
  try {
    applyButton.disabled = true;
    backupButton.disabled = true;
    const currentPlan = validatePlan();
    if (planSignature(currentPlan) !== validatedPlanSignature) {
      throw new Error('方案内容已改变，请重新校验后再执行。');
    }
    result.className = '';
    result.textContent = '正在归档当前全部收藏夹…';
    const archive = await archiveCurrentBookmarks();
    const cleanup = await trimArchives();
    const moved = [];
    for (const item of validatedPlan) {
      const destination = await ensureFolder(item.folderPath);
      await chrome.bookmarks.move(item.id, { parentId: destination });
      moved.push({ id: item.id, folderPath: item.folderPath.join('/') });
    }
    result.className = '';
    result.textContent = `归档已完成：${archive.filename}\n已移动 ${moved.length} 条：\n${JSON.stringify(moved, null, 2)}${archiveCleanupMessage(cleanup)}`;
    scan = await scanBookmarks();
    renderScan(scan);
    validatedPlan = null;
    validatedPlanSignature = null;
  } catch (error) {
    validatedPlan = null;
    validatedPlanSignature = null;
    result.className = 'error';
    result.textContent = `执行中断：${error.message}`;
  } finally {
    backupButton.disabled = false;
    applyButton.disabled = !validatedPlan;
  }
});
