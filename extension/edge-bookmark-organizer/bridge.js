importScripts('shared.js', 'bridge-config.js');

(function () {
  'use strict';

  const core = globalThis.BookmarkOrganizerCore;
  const bridgeConfig = globalThis.BookmarkOrganizerBridgeConfig || {};
  const pendingPlanKey = 'bookmarkOrganizerPendingPlan';
  const planLifetimeMs = 30 * 60 * 1000;
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
      folders: core.describeFolders(scan.folders, scan.allBookmarks)
        .filter(folder => folder.pathParts[0] === scan.bookmarkBar?.title && folder.id !== scan.bookmarkBar?.id)
        .map(folder => ({
          id: folder.id,
          path: folder.path,
          bookmarkCount: folder.bookmarkCount,
          childFolderCount: folder.childFolderCount,
          isEmpty: folder.isEmpty,
          index: folder.index,
          protected: folder.protected
        })),
      scannedAt: new Date().toISOString(),
      checksum: core.treeChecksum(scan.folders, scan.allBookmarks),
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

  function findTreeNode(roots, id) {
    let found = null;
    for (const root of roots) {
      core.walk(root, [], node => {
        if (String(node.id) === String(id)) found = node;
      });
    }
    return found;
  }

  function barFolders(scan) {
    return core.describeFolders(scan.folders, scan.allBookmarks)
      .filter(folder => folder.pathParts[0] === scan.bookmarkBar?.title && folder.id !== scan.bookmarkBar?.id);
  }

  function canonicalParts(scan, rawPath, minimum) {
    const actualRoot = scan.bookmarkBar?.title;
    if (!actualRoot) throw new Error('没有找到浏览器的收藏夹栏根目录。');
    const path = core.normalizePath(rawPath);
    const acceptedRoots = new Set([actualRoot, 'bookmarks_bar', '收藏夹栏', '书签栏', 'Bookmarks bar', 'Favorites bar']);
    if (path.length < minimum || !acceptedRoots.has(path[0])) {
      throw new Error(`目标路径必须以“${actualRoot}/…”开头：${rawPath}`);
    }
    path[0] = actualRoot;
    return path;
  }

  function declaredAction(item, purge) {
    if (!item || typeof item !== 'object') throw new Error('方案每项都需要字符串 id 和 folderPath。');
    let action = item.action || (typeof item.folderPath === 'string' ? 'move' : '');
    if (!action || (action === 'move' && typeof item.folderPath !== 'string') || typeof item.id !== 'string') {
      throw new Error('方案每项都需要字符串 id 和 folderPath。');
    }
    if (purge && action === 'delete') action = 'purge';
    if (purge && action === 'deleteFolder') action = 'purgeFolder';
    return action;
  }

  function rejectProtected(folder) {
    if (folder.protected) throw new Error(`不能对“${folder.path}”执行该操作。临时收藏和回收站需要保留。`);
  }

  function validatePlan(scan, rawPlan, scope = 'temporary', purge = false) {
    if (!Array.isArray(rawPlan) || !rawPlan.length) throw new Error('整理方案不能为空。');
    if (!['temporary', 'all'].includes(scope)) throw new Error(`不支持的整理范围：${scope}`);
    const source = scope === 'all' ? scan.allBookmarks : scan.temporaryUrls;
    const sourceById = new Map(source.map(item => [item.id, item]));
    const folders = barFolders(scan);
    const folderById = new Map(folders.map(folder => [folder.id, folder]));
    const seen = new Set();
    const plan = rawPlan.map(item => {
      const action = declaredAction(item, purge);
      if (seen.has(item.id)) throw new Error(`书签 ${item.id} 重复出现在方案中。`);
      seen.add(item.id);
      if (action === 'move' || action === 'delete' || action === 'purge') return validateBookmarkAction(scan, sourceById, scope, item, action);
      if (['deleteFolder', 'purgeFolder', 'renameFolder', 'moveFolder'].includes(action)) {
        return validateFolderAction(scan, folderById, item, action);
      }
      throw new Error(`不支持的方案动作：${action}`);
    });
    const folderPaths = plan
      .filter(item => item.sourcePath)
      .map(item => item.sourcePath);
    for (const item of plan.filter(entry => entry.sourcePath)) {
      if (folderPaths.some(path => path !== item.sourcePath && (item.sourcePath.startsWith(`${path}/`) || path.startsWith(`${item.sourcePath}/`)))) {
        throw new Error(`目录操作重叠：${item.sourcePath}`);
      }
      if (plan.some(entry => !entry.sourcePath && `${entry.fromPath.join('/')}/`.startsWith(`${item.sourcePath}/`))) {
        throw new Error(`目录操作与其中的书签操作重叠：${item.sourcePath}`);
      }
    }
    return plan;
  }

  function validateBookmarkAction(scan, sourceById, scope, item, action) {
    const bookmark = sourceById.get(item.id);
    if (!bookmark) throw new Error(scope === 'all'
      ? `书签 ${item.id} 不在当前 Edge 收藏夹中。`
      : `书签 ${item.id} 不在当前“临时收藏”中。`);
    if (!scan.movableIds.has(item.id)) throw failure(`书签 ${item.id} 位于收藏夹栏之外，本版本仅支持扫描。`, 'SOURCE_OUT_OF_SCOPE');
    const fromPath = bookmark.path.slice(0, -1);
    let path = null;
    if (action === 'move') {
      path = canonicalParts(scan, item.folderPath, 2);
      if (path.includes(core.temporaryFolderName)) throw new Error(`目标目录不能位于“${core.temporaryFolderName}”：${item.folderPath}`);
      if (path.join('/') === fromPath.join('/')) throw failure(`书签 ${item.id} 已在目标目录，无需移动。`, 'NO_CHANGE');
    } else if (action === 'delete') {
      path = [scan.bookmarkBar.title, core.recycleFolderName];
      if (fromPath.join('/') === path.join('/')) throw failure(`书签 ${item.id} 已在回收站，无需再次软删除。`, 'NO_CHANGE');
    }
    return {
      action,
      id: item.id,
      folderPath: path,
      title: bookmark.title,
      url: bookmark.url,
      fromParentId: bookmark.parentId,
      fromIndex: bookmark.index,
      fromPath,
      snapshot: action === 'purge' ? { title: bookmark.title, url: bookmark.url } : null
    };
  }

  function validateFolderAction(scan, folderById, item, action) {
    const folder = folderById.get(item.id);
    if (!folder) throw new Error(`目录 ${item.id} 不在收藏夹栏中。`);
    if (!scan.movableIds.has(item.id)) throw failure(`目录 ${item.id} 位于收藏夹栏之外，本版本仅支持扫描。`, 'SOURCE_OUT_OF_SCOPE');
    rejectProtected(folder);
    const node = findTreeNode(scan.roots, folder.id);
    const base = {
      action,
      id: folder.id,
      folderPath: null,
      title: folder.title,
      url: null,
      fromParentId: folder.parentId,
      fromIndex: folder.index,
      fromPath: folder.pathParts.slice(0, -1),
      sourcePath: folder.path,
      bookmarkCount: folder.bookmarkCount,
      childFolderCount: folder.childFolderCount,
      snapshot: action === 'purgeFolder' ? core.snapshotNode(node) : null
    };
    if (action === 'deleteFolder') {
      base.folderPath = [scan.bookmarkBar.title, core.recycleFolderName];
      return base;
    }
    if (action === 'purgeFolder') return base;
    if (action === 'renameFolder') {
      const name = String(item.name || '').trim();
      if (!name || name.includes('/')) throw new Error('新目录名不能为空，也不能包含“/”。');
      if (name === folder.title) throw failure(`目录 ${folder.path} 已使用该名称。`, 'NO_CHANGE');
      const parent = findTreeNode(scan.roots, folder.parentId);
      if ((parent?.children || []).some(child => !child.url && child.title === name && child.id !== folder.id)) {
        throw new Error(`同级已有目录“${name}”。`);
      }
      base.name = name;
      return base;
    }
    const destination = canonicalParts(scan, item.to, 1);
    const folderPath = folder.path;
    const destinationPath = destination.join('/');
    if (destinationPath === folderPath || destinationPath.startsWith(`${folderPath}/`)) {
      throw new Error('不能把目录移动到自身或其子目录中。');
    }
    if (!Number.isInteger(item.index)) throw new Error('目录移动需要整数 index，末尾使用 -1。');
    const parentPath = folder.pathParts.slice(0, -1).join('/');
    const currentParent = findTreeNode(scan.roots, folder.parentId);
    const lastIndex = Math.max(0, (currentParent?.children || []).length - 1);
    const resolved = item.index < 0 ? lastIndex : item.index;
    if (destinationPath === parentPath && resolved === folder.index) throw failure(`目录 ${folder.path} 已在目标位置。`, 'NO_CHANGE');
    const targetParent = barFolders(scan).find(candidate => candidate.path === destinationPath) ||
      (destinationPath === scan.bookmarkBar.title ? { id: scan.bookmarkBar.id, path: destinationPath } : null);
    if (targetParent?.protected) throw new Error(`不能把目录移动到“${destinationPath}”。`);
    if (destinationPath !== scan.bookmarkBar.title && !targetParent) {
      base.toParentPath = destination;
    } else if (targetParent && destination.length > 1) {
      const liveParent = findTreeNode(scan.roots, targetParent.id);
      if ((liveParent?.children || []).some(child => !child.url && child.id !== folder.id && child.title === folder.title)) {
        throw new Error(`目标位置已有同名目录“${folder.title}”。`);
      }
      base.toParentPath = destination;
    } else {
      base.toParentPath = destination;
      const liveParent = findTreeNode(scan.roots, scan.bookmarkBar.id);
      if ((liveParent?.children || []).some(child => !child.url && child.title === folder.title && child.id !== folder.id)) {
        throw new Error(`目标位置已有同名目录“${folder.title}”。`);
      }
    }
    base.toIndex = item.index;
    return base;
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

  function storedPlanItem(item) {
    if (item.action === 'move') return { id: item.id, action: 'move', folderPath: item.folderPath.join('/') };
    if (item.action === 'delete' || item.action === 'purge') return { id: item.id, action: item.action };
    if (item.action === 'deleteFolder' || item.action === 'purgeFolder') return { id: item.id, action: item.action };
    if (item.action === 'renameFolder') return { id: item.id, action: 'renameFolder', name: item.name };
    if (item.action === 'moveFolder') return { id: item.id, action: 'moveFolder', to: item.toParentPath.join('/'), index: item.toIndex };
    throw new Error(`不支持的方案动作：${item.action}`);
  }

  function operationKind(plan) {
    const actions = new Set(plan.map(item => item.action));
    if (actions.size !== 1) return 'mixed';
    const only = [...actions][0];
    if (only === 'move') return 'move';
    if (only === 'delete' || only === 'purge') return 'delete';
    if (only === 'deleteFolder' || only === 'purgeFolder') return 'prune';
    if (only === 'renameFolder') return 'rename';
    if (only === 'moveFolder') return 'move-folder';
    return 'mixed';
  }

  function previewItem(item) {
    const effects = {
      move: '移动',
      delete: '移入回收站',
      purge: '永久删除',
      deleteFolder: '整目录移入回收站',
      purgeFolder: '永久删除目录',
      renameFolder: '重命名目录',
      moveFolder: '移动目录'
    };
    return {
      action: item.action,
      effect: effects[item.action] || item.action,
      id: item.id,
      title: item.title,
      url: item.url,
      fromPath: item.fromPath.join('/'),
      folderPath: item.folderPath ? item.folderPath.join('/') : null,
      name: item.name || null,
      to: item.toParentPath ? item.toParentPath.join('/') : null,
      index: Number.isInteger(item.toIndex) ? item.toIndex : null,
      bookmarkCount: item.bookmarkCount ?? null,
      childFolderCount: item.childFolderCount ?? null
    };
  }

  async function validateAndStore(rawPlan, scope = 'temporary', purge = false) {
    const scan = await scanBookmarks(scope);
    const plan = validatePlan(scan, rawPlan, scope, purge);
    const planToken = id();
    const pending = {
      token: planToken,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + planLifetimeMs,
      scope,
      purge: purge === true,
      signature: core.planSignature(plan),
      plan: plan.map(storedPlanItem)
    };
    await chrome.storage.local.set({ [pendingPlanKey]: pending });
    return {
      planToken,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      lifetimeMinutes: planLifetimeMs / 60000,
      moveCount: plan.length,
      kind: operationKind(plan),
      missingFolders: core.missingFolderPaths(scan.folders.map(folder => folder.path.join('/')), plan),
      preview: plan.map(previewItem)
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
    const scope = pending.scope || 'temporary';
    const scan = await scanBookmarks(scope);
    const currentPlan = validatePlan(scan, pending.plan, scope, pending.purge === true);
    if (core.planSignature(currentPlan) !== pending.signature) throw new Error('收藏夹状态已经改变，请重新扫描并校验。');

    const backup = await createBackup(timeoutMs);
    const refreshed = validatePlan(await scanBookmarks(scope), pending.plan, scope, pending.purge === true);
    if (Date.now() > pending.expiresAt || core.planSignature(refreshed) !== pending.signature) throw failure('归档期间收藏夹状态已经改变或计划过期，请重新校验。', 'PLAN_CHANGED');
    const operation = { id: id(), planToken, createdAt: new Date().toISOString(), status: 'running', kind: operationKind(currentPlan), archivePath: backup.filename, moves: [], plannedCount: currentPlan.length };
    await operationStore.add(operation);
    const persist = async () => {
      const records = await operationStore.load();
      await operationStore.save(records.map(item => item.id === operation.id ? operation : item));
    };
    await chrome.storage.local.remove(pendingPlanKey);
    try {
      for (const item of currentPlan) await executePlanItem(item, operation, persist);
      for (const move of operation.moves) {
        if (move.state === 'purged') {
          if (await core.bookmarkExists(move.id)) throw failure(`删除后核验失败：${move.id}`, 'VERIFY_FAILED');
          continue;
        }
        const current = (await chrome.bookmarks.get(move.id))[0];
        if (move.action === 'renameFolder') {
          if (current.title !== move.name) throw failure(`重命名后核验失败：${move.id}`, 'VERIFY_FAILED');
          continue;
        }
        if (current.parentId !== move.toParentId || (current.url || null) !== (move.url || null)) throw failure(`移动后核验失败：${move.id}`, 'VERIFY_FAILED');
        move.toIndex = current.index;
      }
      operation.status = 'complete';
      await persist();
      return { operationId: operation.id, movedCount: operation.moves.length, verified: true, kind: operation.kind, moves: operation.moves, backup };
    } catch (error) {
      operation.status = 'partial';
      operation.error = error.message;
      try { await persist(); } catch { /* The write-ahead record remains the recovery source. */ }
      throw failure(error.message, 'PARTIAL_OPERATION', { operationId: operation.id, status: 'partial', moves: operation.moves, backup });
    }
  }

  function displacedBefore(operation, item) {
    return operation.moves.filter(move =>
      move.fromParentId === item.fromParentId &&
      move.fromIndex < item.fromIndex &&
      ((move.state === 'moved' && move.toParentId && move.toParentId !== item.fromParentId) || move.state === 'purged')
    ).length;
  }

  async function executePlanItem(item, operation, persist) {
    const parentId = item.action === 'move' || item.action === 'delete' || item.action === 'deleteFolder'
      ? await ensureFolder(item.folderPath)
      : item.action === 'moveFolder'
        ? await ensureFolder(item.toParentPath)
        : null;
    const current = (await chrome.bookmarks.get(item.id))[0];
    const removedBefore = displacedBefore(operation, item);
    if (current.parentId !== item.fromParentId || current.index !== item.fromIndex - removedBefore || current.title !== item.title || (current.url || null) !== (item.url || null)) {
      throw failure(`书签 ${item.id} 在执行期间改变，已停止后续移动。`, 'PLAN_CHANGED');
    }
    if (item.action === 'purgeFolder') {
      const live = findTreeNode(await chrome.bookmarks.getTree(), item.id);
      if (!live || JSON.stringify(core.snapshotNode(live)) !== JSON.stringify(item.snapshot)) {
        throw failure(`目录 ${item.id} 的内容已经改变，请重新校验。`, 'PLAN_CHANGED');
      }
    }
    const move = {
      action: item.action || 'move',
      id: item.id,
      title: item.title,
      url: item.url || null,
      fromParentId: item.fromParentId,
      fromIndex: item.fromIndex,
      fromPath: item.fromPath,
      folderPath: item.folderPath || null,
      toPath: item.folderPath || item.toParentPath || null,
      toParentId: parentId,
      name: item.name || null,
      snapshot: item.snapshot || null,
      state: 'pending'
    };
    operation.moves.push(move);
    await persist();
    if (item.action === 'renameFolder') {
      await chrome.bookmarks.update(item.id, { title: item.name });
      move.state = 'renamed';
    } else if (item.action === 'purge') {
      await chrome.bookmarks.remove(item.id);
      move.state = 'purged';
    } else if (item.action === 'purgeFolder') {
      await chrome.bookmarks.removeTree(item.id);
      move.state = 'purged';
    } else if (item.action === 'moveFolder') {
      const destination = { parentId };
      if (Number.isInteger(item.toIndex) && item.toIndex >= 0) destination.index = item.toIndex;
      const placed = await chrome.bookmarks.move(item.id, destination);
      move.state = 'moved';
      move.toParentId = placed.parentId;
      move.toIndex = placed.index;
    } else {
      const placed = await chrome.bookmarks.move(item.id, { parentId });
      move.state = 'moved';
      move.toParentId = placed.parentId;
      move.toIndex = placed.index;
    }
    await persist();
  }

  async function recreateSnapshot(snapshot, parentId, index) {
    const options = { parentId, title: snapshot.title };
    if (snapshot.url) options.url = snapshot.url;
    if (Number.isInteger(index)) options.index = index;
    const created = await chrome.bookmarks.create(options);
    for (const child of snapshot.children || []) await recreateSnapshot(child, created.id);
    return created;
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
      if (move.action === 'purge' || move.action === 'purgeFolder') {
        try {
          const exists = await core.bookmarkExists(move.id);
          if (exists && move.state === 'pending') {
            move.undoState = 'restored';
            await operationStore.save(operations);
            continue;
          }
          if (exists) throw new Error('条目仍存在，无法按删除记录重建');
          const parent = (await chrome.bookmarks.get(move.fromParentId))[0];
          if (parent.url) throw new Error('原目录已不存在');
          const snapshot = move.snapshot || { title: move.title, url: move.url || undefined };
          const siblings = await chrome.bookmarks.getChildren(move.fromParentId);
          if (siblings.some(child => child.title === snapshot.title && (snapshot.url ? child.url === snapshot.url : !child.url))) {
            throw new Error('原位置已有同名条目');
          }
          move.undoState = 'pending';
          await operationStore.save(operations);
          const created = await recreateSnapshot(snapshot, move.fromParentId, move.fromIndex);
          move.restoredId = created.id;
          move.undoState = 'restored';
          restored += 1;
          await operationStore.save(operations);
        } catch (error) {
          conflicts.push({ id: move.id, error: error.message });
        }
        continue;
      }
      if (move.action === 'renameFolder') {
        try {
          const current = (await chrome.bookmarks.get(move.id))[0];
          if (current.title === move.title) {
            move.undoState = 'restored';
            await operationStore.save(operations);
            continue;
          }
          if (current.title !== move.name) throw new Error('目录名称已再次改变');
          await chrome.bookmarks.update(move.id, { title: move.title });
          move.undoState = 'restored';
          restored += 1;
          await operationStore.save(operations);
        } catch (error) {
          conflicts.push({ id: move.id, error: error.message });
        }
        continue;
      }
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
        if ((current.url || '') !== (move.url || '') || current.title !== move.title) throw new Error('条目内容已改变');
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

  function folderByPath(scan, rawPath) {
    const parts = canonicalParts(scan, rawPath, 2);
    const folder = barFolders(scan).find(item => item.path === parts.join('/'));
    if (!folder) throw new Error(`没有找到目录：${parts.join('/')}`);
    return folder;
  }

  function buildPreparedPlan(scan, command, request) {
    if (command === 'folders.rename') {
      const folder = folderByPath(scan, request.path);
      return [{ id: folder.id, action: 'renameFolder', name: request.name }];
    }
    if (command === 'folders.move') {
      const folder = folderByPath(scan, request.path);
      return [{ id: folder.id, action: 'moveFolder', to: request.to, index: request.index }];
    }
    if (command === 'recycle.purge') {
      const recycle = barFolders(scan).find(folder => folder.path === `${scan.bookmarkBar.title}/${core.recycleFolderName}`);
      if (!recycle) return [];
      const node = findTreeNode(scan.roots, recycle.id);
      const hasAgeLimit = request.olderThanDays !== null && request.olderThanDays !== undefined && request.olderThanDays !== '';
      const days = Number(request.olderThanDays);
      const cutoff = hasAgeLimit && Number.isFinite(days) ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
      const raw = [];
      for (const child of node?.children || []) {
        if (cutoff !== null && (!Number.isFinite(child.dateAdded) || child.dateAdded > cutoff)) continue;
        raw.push(child.url ? { id: child.id, action: 'purge' } : { id: child.id, action: 'purgeFolder' });
      }
      return raw;
    }
    const selected = [];
    if (request.path) {
      const folder = folderByPath(scan, request.path);
      rejectProtected(folder);
      if (!request.recursive && folder.bookmarkCount > 0) {
        throw new Error(`目录非空（${folder.bookmarkCount} 条书签）。请加上 --recursive 预览连带影响，或使用 --move-to 转移该目录。`);
      }
      if (request.moveTo) return [{ id: folder.id, action: 'moveFolder', to: request.moveTo, index: -1 }];
      const action = request.purge || folder.bookmarkCount === 0 ? 'purgeFolder' : 'deleteFolder';
      return [{ id: folder.id, action }];
    }
    if (!request.empty) throw new Error('清理目录需要 --empty 或 --path。');
    const candidates = barFolders(scan).filter(folder => !folder.protected && folder.bookmarkCount === 0);
    const picked = request.recursive
      ? candidates.filter(folder => !candidates.some(other => folder.path.startsWith(`${other.path}/`)))
      : candidates.filter(folder => folder.isEmpty);
    selected.push(...picked);
    return selected.map(folder => ({ id: folder.id, action: 'purgeFolder' }));
  }

  async function prepareAndMaybeApply(command, request, timeoutMs) {
    const scan = await scanBookmarks('all');
    const rawPlan = buildPreparedPlan(scan, command, request);
    if (!rawPlan.length) {
      return { planToken: null, moveCount: 0, preview: [], message: '没有需要执行的变更。' };
    }
    const stored = await chrome.storage.local.get({ [pendingPlanKey]: null });
    const previousSignature = stored[pendingPlanKey]?.signature || null;
    const preview = await validateAndStore(rawPlan, 'all', false);
    if (request.confirmed !== true) return preview;
    const current = await chrome.storage.local.get({ [pendingPlanKey]: null });
    if (!previousSignature || previousSignature !== current[pendingPlanKey]?.signature) {
      throw failure('还没有与当前目录状态一致的预览。请先确认返回的预览，再执行同一命令。', 'PREVIEW_REQUIRED', {
        planToken: preview.planToken,
        preview: preview.preview
      });
    }
    const applied = await applyStoredPlan(preview.planToken, timeoutMs);
    return { ...applied, preview: preview.preview, missingFolders: preview.missingFolders };
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
    if (command === 'plan.validate') return exclusive(() => validateAndStore(request.plan, request.scope || 'temporary', request.purge === true));
    if (command === 'plan.apply') {
      if (request.confirmed !== true) throw new Error('扩展拒绝执行：缺少对当前预览的明确确认。');
      return exclusive(() => applyStoredPlan(request.planToken, timeoutMs));
    }
    if (command === 'folders.list') {
      const published = publicScan(await scanBookmarks('all'));
      return { bookmarkBar: published.bookmarkBar, scannedAt: published.scannedAt, checksum: published.checksum, folders: published.folders };
    }
    if (command === 'folders.prune' || command === 'folders.rename' || command === 'folders.move' || command === 'recycle.purge') {
      return exclusive(() => prepareAndMaybeApply(command, request, timeoutMs));
    }
    if (command === 'operations.list') {
      const operations = await operationStore.load();
      const filtered = request.type ? operations.filter(item => item.kind === request.type) : operations;
      return { operations: filtered };
    }
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
