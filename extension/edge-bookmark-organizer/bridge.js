importScripts('shared.js', 'bridge-config.js');

(function () {
  'use strict';

  const core = globalThis.BookmarkOrganizerCore;
  const bridgeConfig = globalThis.BookmarkOrganizerBridgeConfig || {};
  const historyKey = 'bookmarkOrganizerOperations';
  const pendingPlanKey = 'bookmarkOrganizerPendingPlan';
  const maxHistory = 20;
  const planLifetimeMs = 10 * 60 * 1000;

  function id() {
    return globalThis.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
    core.walk(folder, folderPath.slice(0, -1), (node, path) => {
      if (!node.url) return;
      found.push({
        id: node.id,
        parentId: node.parentId,
        index: node.index,
        title: node.title,
        url: node.url,
        canonical: core.canonicalUrl(node.url),
        path
      });
    });
    return found;
  }

  async function scanBookmarks() {
    const roots = await chrome.bookmarks.getTree();
    const collected = core.collectBookmarks(roots);
    const temporary = core.findTemporaryFolder(roots);
    if (!temporary) throw new Error(`未找到“${core.temporaryFolderName}”文件夹。请先收藏一个网页。`);
    const temporaryFolder = collected.folders.find(folder => folder.id === temporary.id);
    const temporaryUrls = temporaryBookmarks(temporary, temporaryFolder?.path || [core.temporaryFolderName]);
    const duplicateMap = new Map();
    for (const bookmark of collected.bookmarks) {
      const group = duplicateMap.get(bookmark.canonical) || [];
      group.push(bookmark);
      duplicateMap.set(bookmark.canonical, group);
    }
    const rows = temporaryUrls.map(bookmark => {
      const elsewhere = (duplicateMap.get(bookmark.canonical) || []).filter(item => item.id !== bookmark.id);
      return {
        id: bookmark.id,
        title: bookmark.title,
        url: bookmark.url,
        currentPath: bookmark.path.slice(0, -1).join('/'),
        duplicateCount: elsewhere.length,
        duplicatePaths: elsewhere.map(item => item.path.slice(0, -1).join('/'))
      };
    });
    const bookmarkBar = core.findBookmarkBar(roots);
    return {
      roots,
      folders: collected.folders,
      temporaryUrls,
      temporary,
      bookmarkBar,
      rows,
      stats: { bookmarks: collected.bookmarks.length, folders: collected.folders.length }
    };
  }

  function publicScan(scan) {
    return {
      bookmarkBar: scan.bookmarkBar?.title || 'bookmarks_bar',
      stats: scan.stats,
      temporaryCount: scan.rows.length,
      duplicateCount: scan.rows.filter(item => item.duplicateCount > 0).length,
      existingFolders: scan.folders
        .filter(folder => folder.path[0] === scan.bookmarkBar?.title && folder.id !== scan.temporary.id)
        .map(folder => folder.path.join('/')),
      temporaryBookmarks: scan.rows
    };
  }

  async function status() {
    const roots = await chrome.bookmarks.getTree();
    const collected = core.collectBookmarks(roots);
    const temporary = core.findTemporaryFolder(roots);
    const temporaryFolder = collected.folders.find(folder => folder.id === temporary?.id);
    return {
      connected: true,
      extensionVersion: chrome.runtime.getManifest().version,
      bookmarkBar: core.findBookmarkBar(roots)?.title || 'bookmarks_bar',
      stats: { bookmarks: collected.bookmarks.length, folders: collected.folders.length },
      temporaryCount: temporaryBookmarks(temporary, temporaryFolder?.path || [core.temporaryFolderName]).length
    };
  }

  function validatePlan(scan, rawPlan) {
    if (!Array.isArray(rawPlan) || !rawPlan.length) throw new Error('整理方案不能为空。');
    const temporaryById = new Map(scan.temporaryUrls.map(item => [item.id, item]));
    const seen = new Set();
    return rawPlan.map(item => {
      if (!item || typeof item.id !== 'string' || typeof item.folderPath !== 'string') {
        throw new Error('方案每项都需要字符串 id 和 folderPath。');
      }
      const bookmark = temporaryById.get(item.id);
      if (!bookmark) throw new Error(`书签 ${item.id} 不在当前“临时收藏”中。`);
      if (seen.has(item.id)) throw new Error(`书签 ${item.id} 重复出现在方案中。`);
      seen.add(item.id);
      const path = normalizePath(item.folderPath);
      const actualRoot = scan.bookmarkBar?.title;
      if (!actualRoot) throw new Error('没有找到浏览器的收藏夹栏根目录。');
      const acceptedRoots = new Set([actualRoot, 'bookmarks_bar', '收藏夹栏', '书签栏', 'Bookmarks bar', 'Favorites bar']);
      if (path.length < 2 || !acceptedRoots.has(path[0])) throw new Error(`目标路径必须以“${actualRoot}/…”开头：${item.folderPath}`);
      path[0] = actualRoot;
      if (path.includes(core.temporaryFolderName)) throw new Error(`目标目录不能位于“${core.temporaryFolderName}”：${item.folderPath}`);
      return {
        id: item.id,
        folderPath: path,
        title: bookmark.title,
        url: bookmark.url,
        fromParentId: bookmark.parentId,
        fromIndex: bookmark.index,
        fromPath: bookmark.path.slice(0, -1)
      };
    });
  }

  function missingFolderPaths(scan, plan) {
    const existing = new Set(scan.folders.map(folder => folder.path.join('/')));
    const missing = new Set();
    for (const item of plan) {
      for (let length = 2; length <= item.folderPath.length; length += 1) {
        const path = item.folderPath.slice(0, length).join('/');
        if (!existing.has(path)) missing.add(path);
      }
    }
    return [...missing];
  }

  async function ensureFolder(path) {
    const roots = await chrome.bookmarks.getTree();
    const bar = core.findBookmarkBar(roots);
    if (!bar) throw new Error('没有找到收藏夹栏。');
    let parentId = bar.id;
    for (const title of path.slice(1)) {
      const children = await chrome.bookmarks.getChildren(parentId);
      let folder = children.find(child => !child.url && child.title === title);
      if (!folder) folder = await chrome.bookmarks.create({ parentId, title });
      parentId = folder.id;
    }
    return parentId;
  }

  async function loadOperations() {
    const stored = await chrome.storage.local.get({ [historyKey]: [] });
    return Array.isArray(stored[historyKey]) ? stored[historyKey] : [];
  }

  async function saveOperations(operations) {
    await chrome.storage.local.set({ [historyKey]: operations.slice(0, maxHistory) });
  }

  async function addOperation(operation) {
    const operations = await loadOperations();
    operations.unshift(operation);
    await saveOperations(operations);
  }

  async function createBackup() {
    const archive = await core.archiveCurrentBookmarks();
    const cleanup = await core.trimArchives();
    return {
      filename: archive.filename,
      stats: archive.stats,
      removedOldArchives: cleanup.removed.length,
      warnings: cleanup.warnings
    };
  }

  async function validateAndStore(rawPlan) {
    const scan = await scanBookmarks();
    const plan = validatePlan(scan, rawPlan);
    const planToken = id();
    const pending = {
      token: planToken,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + planLifetimeMs,
      signature: planSignature(plan),
      plan: plan.map(item => ({ id: item.id, folderPath: item.folderPath.join('/') }))
    };
    await chrome.storage.local.set({ [pendingPlanKey]: pending });
    return {
      planToken,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      moveCount: plan.length,
      missingFolders: missingFolderPaths(scan, plan),
      preview: plan.map(item => ({
        id: item.id,
        title: item.title,
        url: item.url,
        fromPath: item.fromPath.join('/'),
        folderPath: item.folderPath.join('/')
      }))
    };
  }

  async function applyStoredPlan(planToken) {
    const stored = await chrome.storage.local.get({ [pendingPlanKey]: null });
    const pending = stored[pendingPlanKey];
    if (!pending || pending.token !== planToken) throw new Error('整理方案令牌无效，请重新校验方案。');
    if (Date.now() > pending.expiresAt) throw new Error('整理方案已过期，请重新扫描并校验。');
    const scan = await scanBookmarks();
    const currentPlan = validatePlan(scan, pending.plan);
    if (planSignature(currentPlan) !== pending.signature) throw new Error('收藏夹状态已经改变，请重新扫描并校验。');

    const backup = await createBackup();
    const moved = [];
    let operationSaved = false;
    try {
      const placements = new Map();
      for (const item of currentPlan) {
        const current = (await chrome.bookmarks.get(item.id))[0];
        if (!current) throw new Error(`无法读取书签 ${item.id}。`);
        placements.set(item.id, { parentId: current.parentId, index: current.index });
      }
      for (const item of currentPlan) {
        const placement = placements.get(item.id);
        const parentId = await ensureFolder(item.folderPath);
        await chrome.bookmarks.move(item.id, { parentId });
        moved.push({
          id: item.id,
          title: item.title,
          url: item.url,
          fromParentId: placement.parentId,
          fromIndex: placement.index,
          fromPath: item.fromPath,
          toPath: item.folderPath
        });
      }
      const operation = {
        id: id(),
        createdAt: new Date().toISOString(),
        status: 'complete',
        archivePath: backup.filename,
        moves: moved
      };
      await addOperation(operation);
      operationSaved = true;
      await chrome.storage.local.remove(pendingPlanKey);
      return { operationId: operation.id, movedCount: moved.length, backup };
    } catch (error) {
      if (moved.length && !operationSaved) {
        await addOperation({
          id: id(), createdAt: new Date().toISOString(), status: 'partial',
          archivePath: backup.filename, moves: moved
        });
      }
      throw error;
    }
  }

  async function undo(operationId) {
    const operations = await loadOperations();
    const operation = operationId
      ? operations.find(item => item.id === operationId)
      : operations.find(item => !item.undoneAt && item.moves?.length);
    if (!operation || operation.undoneAt) throw new Error('没有找到可撤销的操作记录。');
    const backup = await createBackup();
    let restored = 0;
    const ordered = [...operation.moves].sort((left, right) =>
      String(left.fromParentId).localeCompare(String(right.fromParentId)) || left.fromIndex - right.fromIndex
    );
    for (const move of ordered) {
      const current = (await chrome.bookmarks.get(move.id))[0];
      if (!current) continue;
      await chrome.bookmarks.move(move.id, { parentId: move.fromParentId, index: move.fromIndex });
      restored += 1;
    }
    operation.undoneAt = new Date().toISOString();
    operation.undoArchivePath = backup.filename;
    await saveOperations(operations);
    return { operationId: operation.id, restoredCount: restored, backup };
  }

  async function dispatch(request) {
    const command = request?.command;
    if (command === 'status') return status();
    if (command === 'scan') return publicScan(await scanBookmarks());
    if (command === 'backup') return createBackup();
    if (command === 'archives.list') {
      const archives = await core.listManagedArchives();
      return { archives: archives.map(item => ({ id: item.id, filename: item.filename, startTime: item.startTime, fileSize: item.fileSize })) };
    }
    if (command === 'plan.validate') return validateAndStore(request.plan);
    if (command === 'plan.apply') {
      if (request.confirmed !== true) throw new Error('扩展拒绝执行：缺少对当前预览的明确确认。');
      return applyStoredPlan(request.planToken);
    }
    if (command === 'operations.list') return { operations: await loadOperations() };
    if (command === 'operations.undo') {
      if (request.confirmed !== true) throw new Error('扩展拒绝撤销：缺少明确确认。');
      return undo(request.operationId);
    }
    throw new Error(`不支持的本地桥接命令：${command || '空命令'}`);
  }

  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    const source = sender?.url || '';
    const localSource = source.startsWith('http://127.0.0.1:') || source.startsWith('http://localhost:');
    if (!localSource || !bridgeConfig.token || message?.token !== bridgeConfig.token) {
      sendResponse({ ok: false, error: '本地桥接身份校验失败。' });
      return false;
    }
    dispatch(message.request)
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });
})();
