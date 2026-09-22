importScripts('shared.js', 'bridge-config.js');

(function () {
  'use strict';

  const core = globalThis.BookmarkOrganizerCore;
  const bridgeConfig = globalThis.BookmarkOrganizerBridgeConfig || {};
  const pendingPlanKey = 'bookmarkOrganizerPendingPlan';
  const planLifetimeMs = 10 * 60 * 1000;
  const operationStore = core.createOperationStore('bookmarkOrganizerOperations', 20);
  let busy = false;

  function failure(message, code, details = {}) {
    return Object.assign(new Error(message), { code, details });
  }

  async function exclusive(action) {
    if (busy) throw failure('另一个备份、校验或移动操作正在执行，请查询状态后再试。', 'BUSY');
    busy = true;
    try { return await action(); } finally { busy = false; }
  }

  function id() {
    return globalThis.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function scanBookmarks(scope = 'temporary') {
    if (!['temporary', 'all'].includes(scope)) throw new Error(`不支持的扫描范围：${scope}`);
    const roots = await chrome.bookmarks.getTree();
    const collected = core.collectBookmarks(roots);
    const temporary = core.findTemporaryFolder(roots);
    if (scope === 'temporary' && !temporary) throw new Error(`未找到“${core.temporaryFolderName}”文件夹。请先收藏一个网页。`);
    const temporaryFolder = collected.folders.find(folder => folder.id === temporary?.id);
    const temporaryUrls = core.temporaryBookmarks(temporary, temporaryFolder?.path || [core.temporaryFolderName]);
    const sourceBookmarks = scope === 'all' ? collected.bookmarks : temporaryUrls;
    const temporaryIds = new Set(temporaryUrls.map(item => item.id));
    const movableIds = core.idsUnder(core.findBookmarkBar(roots));
    const duplicateMap = new Map();
    for (const bookmark of collected.bookmarks) {
      const group = duplicateMap.get(bookmark.canonical) || [];
      group.push(bookmark);
      duplicateMap.set(bookmark.canonical, group);
    }
    const rows = sourceBookmarks.map(bookmark => {
      const elsewhere = (duplicateMap.get(bookmark.canonical) || []).filter(item => item.id !== bookmark.id);
      return {
        id: bookmark.id,
        movable: movableIds.has(bookmark.id),
        moveRestriction: movableIds.has(bookmark.id) ? null : '来源位于收藏夹栏之外，仅支持扫描',
        title: bookmark.title,
        url: bookmark.url,
        currentPath: bookmark.path.slice(0, -1).join('/'),
        duplicateCount: elsewhere.length,
        duplicatePaths: elsewhere.map(item => item.path.slice(0, -1).join('/'))
      };
    });
    const bookmarkBar = core.findBookmarkBar(roots);
    return {
      scope,
      roots,
      folders: collected.folders,
      allBookmarks: collected.bookmarks,
      temporaryUrls,
      temporaryRows: rows.filter(item => temporaryIds.has(item.id)),
      temporary,
      bookmarkBar,
      movableIds,
      rows,
      stats: { bookmarks: collected.bookmarks.length, folders: collected.folders.length }
    };
  }

  function publicScan(scan) {
    return {
      scope: scan.scope,
      bookmarkBar: scan.bookmarkBar?.title || 'bookmarks_bar',
      stats: scan.stats,
      folderCountPolicy: '包含浏览器返回的命名根目录、空目录和临时收藏；不含虚拟根节点',
      temporaryCount: scan.temporaryRows.length,
      duplicateCount: scan.rows.filter(item => item.duplicateCount > 0).length,
      existingFolders: scan.folders
        .filter(folder => folder.path[0] === scan.bookmarkBar?.title && folder.id !== scan.temporary?.id)
        .map(folder => folder.path.join('/')),
      bookmarks: scan.rows,
      temporaryBookmarks: scan.temporaryRows
    };
  }

  async function status() {
    const roots = await chrome.bookmarks.getTree();
    const collected = core.collectBookmarks(roots);
    const temporary = core.findTemporaryFolder(roots);
    const temporaryFolder = collected.folders.find(folder => folder.id === temporary?.id);
    return {
      connected: true,
      busy,
      extensionVersion: chrome.runtime.getManifest().version,
      bookmarkBar: core.findBookmarkBar(roots)?.title || 'bookmarks_bar',
      stats: { bookmarks: collected.bookmarks.length, folders: collected.folders.length },
      temporaryCount: core.temporaryBookmarks(temporary, temporaryFolder?.path || [core.temporaryFolderName]).length
    };
  }

  function validatePlan(scan, rawPlan, scope = 'temporary') {
    if (!Array.isArray(rawPlan) || !rawPlan.length) throw new Error('整理方案不能为空。');
    if (!['temporary', 'all'].includes(scope)) throw new Error(`不支持的整理范围：${scope}`);
    const source = scope === 'all' ? scan.allBookmarks : scan.temporaryUrls;
    const sourceById = new Map(source.map(item => [item.id, item]));
    const seen = new Set();
    return rawPlan.map(item => {
      if (!item || typeof item.id !== 'string' || typeof item.folderPath !== 'string') {
        throw new Error('方案每项都需要字符串 id 和 folderPath。');
      }
      const bookmark = sourceById.get(item.id);
      if (!bookmark) throw new Error(scope === 'all'
        ? `书签 ${item.id} 不在当前 Edge 收藏夹中。`
        : `书签 ${item.id} 不在当前“临时收藏”中。`);
      if (!scan.movableIds.has(item.id)) throw failure(`书签 ${item.id} 位于收藏夹栏之外，本版本仅支持扫描。`, 'SOURCE_OUT_OF_SCOPE');
      if (seen.has(item.id)) throw new Error(`书签 ${item.id} 重复出现在方案中。`);
      seen.add(item.id);
      const path = core.normalizePath(item.folderPath);
      const actualRoot = scan.bookmarkBar?.title;
      if (!actualRoot) throw new Error('没有找到浏览器的收藏夹栏根目录。');
      const acceptedRoots = new Set([actualRoot, 'bookmarks_bar', '收藏夹栏', '书签栏', 'Bookmarks bar', 'Favorites bar']);
      if (path.length < 2 || !acceptedRoots.has(path[0])) throw new Error(`目标路径必须以“${actualRoot}/…”开头：${item.folderPath}`);
      path[0] = actualRoot;
      if (path.includes(core.temporaryFolderName)) throw new Error(`目标目录不能位于“${core.temporaryFolderName}”：${item.folderPath}`);
      if (path.join('/') === bookmark.path.slice(0, -1).join('/')) throw failure(`书签 ${item.id} 已在目标目录，无需移动。`, 'NO_CHANGE');
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

  async function createBackup(timeoutMs) {
    try {
      const archive = await core.archiveCurrentBookmarks(timeoutMs);
      let cleanup;
      try { cleanup = await core.trimArchives(); }
      catch (error) { cleanup = { removed: [], warnings: [`归档成功，保留清理失败：${error.message}`] }; }
      return {
        filename: archive.filename,
        downloadId: archive.downloadId,
        stats: { bookmarks: archive.bookmarks, folders: archive.folders },
        removedOldArchives: cleanup.removed.length,
        warnings: cleanup.warnings
      };
    } catch (error) {
      throw failure(`归档失败，未执行任何收藏夹变更：${error?.message || String(error)}`, error.code || 'ARCHIVE_FAILED', error.details);
    }
  }

  async function validateAndStore(rawPlan, scope = 'temporary') {
    const scan = await scanBookmarks(scope);
    const plan = validatePlan(scan, rawPlan, scope);
    const planToken = id();
    const pending = {
      token: planToken,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + planLifetimeMs,
      scope,
      signature: core.planSignature(plan),
      plan: plan.map(item => ({ id: item.id, folderPath: item.folderPath.join('/') }))
    };
    await chrome.storage.local.set({ [pendingPlanKey]: pending });
    return {
      planToken,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      moveCount: plan.length,
      missingFolders: core.missingFolderPaths(scan.folders.map(folder => folder.path.join('/')), plan),
      preview: plan.map(item => ({
        id: item.id,
        title: item.title,
        url: item.url,
        fromPath: item.fromPath.join('/'),
        folderPath: item.folderPath.join('/')
      }))
    };
  }

  async function applyStoredPlan(planToken, timeoutMs) {
    const records = await operationStore.load();
    const previous = records.find(item => item.planToken === planToken);
    if (previous) throw failure('该计划已经开始执行，不能重复执行。请查询操作记录。', 'PLAN_ALREADY_STARTED', { operationId: previous.id, status: previous.status });
    const interrupted = records.find(item => item.status === 'running' && !item.undoneAt);
    if (interrupted) throw failure('存在未结束的操作，请先核对或撤销。', 'RECOVERY_REQUIRED', { operationId: interrupted.id });
    const stored = await chrome.storage.local.get({ [pendingPlanKey]: null });
    const pending = stored[pendingPlanKey];
    if (!pending || pending.token !== planToken) throw new Error('整理方案令牌无效，请重新校验方案。');
    if (Date.now() > pending.expiresAt) throw new Error('整理方案已过期，请重新扫描并校验。');
    const scan = await scanBookmarks(pending.scope || 'temporary');
    const currentPlan = validatePlan(scan, pending.plan, pending.scope || 'temporary');
    if (core.planSignature(currentPlan) !== pending.signature) throw new Error('收藏夹状态已经改变，请重新扫描并校验。');

    const backup = await createBackup(timeoutMs);
    const refreshed = validatePlan(await scanBookmarks(pending.scope || 'temporary'), pending.plan, pending.scope || 'temporary');
    if (Date.now() > pending.expiresAt || core.planSignature(refreshed) !== pending.signature) throw failure('归档期间收藏夹状态已经改变或计划过期，请重新校验。', 'PLAN_CHANGED');
    const operation = { id: id(), planToken, createdAt: new Date().toISOString(), status: 'running', archivePath: backup.filename, moves: [], plannedCount: currentPlan.length };
    await operationStore.add(operation);
    const persist = async () => {
      const records = await operationStore.load();
      await operationStore.save(records.map(item => item.id === operation.id ? operation : item));
    };
    await chrome.storage.local.remove(pendingPlanKey);
    try {
      for (const item of currentPlan) {
        const parentId = await ensureFolder(item.folderPath);
        const current = (await chrome.bookmarks.get(item.id))[0];
        const removedBefore = operation.moves.filter(move => move.state === 'moved' && move.fromParentId === item.fromParentId && move.toParentId !== item.fromParentId && move.fromIndex < item.fromIndex).length;
        if (current.parentId !== item.fromParentId || current.index !== item.fromIndex - removedBefore || current.title !== item.title || current.url !== item.url) throw failure(`书签 ${item.id} 在执行期间改变，已停止后续移动。`, 'PLAN_CHANGED');
        const move = { ...item, toPath: item.folderPath, toParentId: parentId, state: 'pending' };
        operation.moves.push(move);
        await persist();
        const placed = await chrome.bookmarks.move(item.id, { parentId });
        move.state = 'moved';
        move.toIndex = placed.index;
        await persist();
      }
      for (const move of operation.moves) {
        const current = (await chrome.bookmarks.get(move.id))[0];
        if (current.parentId !== move.toParentId || current.url !== move.url) throw failure(`移动后核验失败：${move.id}`, 'VERIFY_FAILED');
        move.toIndex = current.index;
      }
      operation.status = 'complete';
      await persist();
      return { operationId: operation.id, movedCount: operation.moves.length, verified: true, moves: operation.moves, backup };
    } catch (error) {
      operation.status = 'partial';
      operation.error = error.message;
      try { await persist(); } catch { /* The write-ahead record remains the recovery source. */ }
      throw failure(error.message, 'PARTIAL_OPERATION', { operationId: operation.id, status: 'partial', moves: operation.moves, backup });
    }
  }

  async function undo(operationId, timeoutMs) {
    const operations = await operationStore.load();
    const operation = operationId
      ? operations.find(item => item.id === operationId)
      : operations.find(item => !item.undoneAt && item.moves?.length);
    if (!operation) throw failure('没有找到指定的可撤销操作记录。', 'OPERATION_NOT_FOUND');
    if (operation.undoneAt) throw failure(`该操作已于 ${operation.undoneAt} 撤销。`, 'ALREADY_UNDONE');
    const backup = await createBackup(timeoutMs);
    let restored = 0;
    let skipped = 0;
    const ordered = [...operation.moves].sort((left, right) =>
      String(left.fromParentId).localeCompare(String(right.fromParentId)) || left.fromIndex - right.fromIndex
    );
    const conflicts = [];
    operation.undoArchivePath = backup.filename;
    operation.undoEvents = operation.undoEvents || [];
    for (const move of ordered) {
      if (move.undoState === 'restored' || move.undoState === 'missing') continue;
      if (!(await core.bookmarkExists(move.id))) {
        skipped += 1;
        move.undoState = 'missing';
        await operationStore.save(operations);
        continue;
      }
      try {
        const current = (await chrome.bookmarks.get(move.id))[0];
        const parent = (await chrome.bookmarks.get(move.fromParentId))[0];
        if (parent.url) throw new Error('原目录已不存在');
        if (current.url !== move.url || current.title !== move.title) throw new Error('条目内容已改变');
        if (current.parentId === move.fromParentId && current.index === move.fromIndex && (move.state === 'pending' || move.undoState === 'pending')) {
          move.undoState = 'restored';
          const event = operation.undoEvents.find(item => item.id === move.id);
          if (event) event.done = true;
        } else {
          if (move.toParentId ? current.parentId !== move.toParentId : core.collectBookmarks(await chrome.bookmarks.getTree()).bookmarks.find(item => item.id === move.id)?.path.slice(0, -1).join('/') !== move.toPath.join('/')) throw new Error('条目已被再次移动');
          let expectedIndex = move.toIndex;
          expectedIndex -= operation.moves.filter(item => item.undoState === 'missing' && item.toParentId === move.toParentId && item.toIndex < move.toIndex).length;
          for (const event of operation.undoEvents.filter(item => item.done)) {
            if (event.fromParentId === move.toParentId && event.fromIndex < expectedIndex) expectedIndex -= 1;
            if (event.toParentId === move.toParentId && event.toIndex <= expectedIndex) expectedIndex += 1;
          }
          if (Number.isInteger(move.toIndex) && current.index !== expectedIndex) throw new Error('条目位置已改变，请人工复核后恢复');
          move.undoState = 'pending';
          let event = operation.undoEvents.find(item => item.id === move.id);
          if (!event) {
            event = { id: move.id, fromParentId: current.parentId, fromIndex: current.index, toParentId: move.fromParentId, toIndex: move.fromIndex, done: false };
            operation.undoEvents.push(event);
          }
          await operationStore.save(operations);
          const placed = await chrome.bookmarks.move(move.id, { parentId: move.fromParentId, index: move.fromIndex });
          event.toIndex = placed.index;
          event.done = true;
          move.undoState = 'restored';
          restored += 1;
        }
        await operationStore.save(operations);
      } catch (error) {
        conflicts.push({ id: move.id, error: error.message });
      }
    }
    operation.undoStatus = conflicts.length ? 'partial' : 'complete';
    operation.undoConflicts = conflicts;
    if (!conflicts.length) operation.undoneAt = new Date().toISOString();
    await operationStore.save(operations);
    if (conflicts.length) throw failure('撤销部分完成，冲突条目保持当前位置。', 'PARTIAL_UNDO', { operationId: operation.id, restoredCount: restored, skippedCount: skipped, conflicts, backup });
    return { operationId: operation.id, restoredCount: restored, skippedCount: skipped, backup };
  }

  async function dispatch(request) {
    const command = request?.command;
    if (command === 'status') return status();
    if (command === 'scan') return publicScan(await scanBookmarks(request.scope || 'temporary'));
    const timeoutMs = request.archiveTimeoutMs ?? 30000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw failure('归档超时必须在 1–300 秒之间。', 'INVALID_TIMEOUT');
    if (command === 'backup') return exclusive(() => createBackup(timeoutMs));
    if (command === 'downloads.list') return { downloads: await core.archiveDiagnostics() };
    if (command === 'archives.list') {
      const archives = await core.listManagedArchives();
      return { archives: archives.map(item => ({ id: item.id, filename: item.filename, startTime: item.startTime, fileSize: item.fileSize })) };
    }
    if (command === 'plan.validate') return exclusive(() => validateAndStore(request.plan, request.scope || 'temporary'));
    if (command === 'plan.apply') {
      if (request.confirmed !== true) throw new Error('扩展拒绝执行：缺少对当前预览的明确确认。');
      return exclusive(() => applyStoredPlan(request.planToken, timeoutMs));
    }
    if (command === 'operations.list') return { operations: await operationStore.load() };
    if (command === 'operations.undo') {
      if (request.confirmed !== true) throw new Error('扩展拒绝撤销：缺少明确确认。');
      return exclusive(() => undo(request.operationId, timeoutMs));
    }
    if (command === 'operations.clear') return exclusive(async () => { await operationStore.save([]); return { cleared: true }; });
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
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error), code: error.code || 'COMMAND_FAILED', details: error.details || {} }));
    return true;
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const ownExtension = sender?.id === chrome.runtime.id;
    if (!ownExtension || !['bookmark-organizer-popup', 'bookmark-organizer-manager'].includes(message?.channel)) return false;
    if (message.channel === 'bookmark-organizer-popup' && message?.request?.command !== 'backup') {
      sendResponse({ ok: false, error: '工具栏只允许调用备份命令。' });
      return false;
    }
    dispatch(message.request)
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error), code: error.code || 'COMMAND_FAILED', details: error.details || {} }));
    return true;
  });
})();
