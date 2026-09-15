const temporaryFolderName = '临时收藏';
let scan = null;
let validatedPlan = null;

const status = document.querySelector('#status');
const items = document.querySelector('#items');
const result = document.querySelector('#result');
const scanButton = document.querySelector('#scan');
const copyButton = document.querySelector('#copy');
const previewButton = document.querySelector('#preview');
const applyButton = document.querySelector('#apply');

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

function folderPath(node, ancestors = []) {
  return node.title ? [...ancestors, node.title] : ancestors;
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
  walk(temporary, folderPath(temporary.parentId ? temporary : { title: '' }), (node) => {
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
  const raw = document.querySelector('#plan').value.trim();
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

scanButton.addEventListener('click', async () => {
  try {
    scanButton.disabled = true;
    status.textContent = '正在扫描…';
    scan = await scanBookmarks();
    renderScan(scan);
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
    result.className = '';
    result.textContent = `已校验：将移动 ${validatedPlan.length} 条收藏；必要时会创建不存在的目标文件夹。`;
    applyButton.disabled = false;
  } catch (error) {
    validatedPlan = null;
    applyButton.disabled = true;
    result.className = 'error';
    result.textContent = `未通过：${error.message}`;
  }
});

applyButton.addEventListener('click', async () => {
  if (!validatedPlan) return;
  try {
    applyButton.disabled = true;
    const moved = [];
    for (const item of validatedPlan) {
      const destination = await ensureFolder(item.folderPath);
      await chrome.bookmarks.move(item.id, { parentId: destination });
      moved.push({ id: item.id, folderPath: item.folderPath.join('/') });
    }
    result.className = '';
    result.textContent = `已移动 ${moved.length} 条：\n${JSON.stringify(moved, null, 2)}`;
    scan = await scanBookmarks();
    renderScan(scan);
    validatedPlan = null;
  } catch (error) {
    result.className = 'error';
    result.textContent = `执行中断：${error.message}`;
  } finally { applyButton.disabled = false; }
});
