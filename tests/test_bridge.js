const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

function extensionFile(name) {
  return path.join(__dirname, '..', 'extension', 'edge-bookmark-organizer', name);
}

function makeEnvironment({ serviceWorker = false } = {}) {
  const tree = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', index: 0, title: '收藏夹栏', folderType: 'bookmarks-bar', children: [
      { id: '9', parentId: '1', index: 0, title: '临时收藏', children: [
        { id: '10', parentId: '9', index: 0, title: 'Git 教程', url: 'https://example.test/git' }
      ] },
      { id: '11', parentId: '1', index: 1, title: '开发', children: [] }
    ] },
    { id: '2', parentId: '0', index: 1, title: '其他收藏', children: [] }
  ] }];
  const storage = {};
  const downloads = [];
  const downloadRequests = [];
  let listener = null;
  let internalListener = null;
  let nextId = 100;

  function findNode(id, node = tree[0]) {
    if (String(node.id) === String(id)) return node;
    for (const child of node.children || []) {
      const found = findNode(id, child);
      if (found) return found;
    }
    return null;
  }
  function reindex(parent) {
    (parent.children || []).forEach((child, index) => {
      child.parentId = parent.id;
      child.index = index;
    });
  }

  class ServiceWorkerURL extends URL {}
  if (serviceWorker) {
    Object.defineProperties(ServiceWorkerURL, {
      createObjectURL: { value: undefined },
      revokeObjectURL: { value: undefined }
    });
  }
  const context = {
    console, URL: serviceWorker ? ServiceWorkerURL : URL, Blob, TextEncoder, Intl, Math, Date,
    setTimeout, clearTimeout, crypto: webcrypto,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    chrome: {
      runtime: {
        id: 'test-extension-id',
        getManifest: () => ({ version: '2.0.3' }),
        onMessageExternal: { addListener(callback) { listener = callback; } },
        onMessage: { addListener(callback) { internalListener = callback; } }
      },
      bookmarks: {
        getTree: async () => tree,
        get: async ids => {
          const list = Array.isArray(ids) ? ids : [ids];
          const missing = list.filter(id => !findNode(id));
          if (missing.length) throw new Error(`Can't find bookmark for id: ${missing.join(', ')}`);
          return list.map(value => findNode(value));
        },
        getChildren: async id => findNode(id)?.children || [],
        create: async options => {
          const parent = findNode(options.parentId);
          if (!parent || parent.url) throw new Error(`Can't create bookmark under ${options.parentId}`);
          const node = { id: String(nextId++), parentId: parent.id, title: options.title };
          if (options.url) node.url = options.url;
          else node.children = [];
          const index = Number.isInteger(options.index) ? Math.min(Math.max(options.index, 0), parent.children.length) : parent.children.length;
          parent.children.splice(index, 0, node);
          reindex(parent);
          return node;
        },
        update: async (nodeId, changes) => {
          const node = findNode(nodeId);
          if (!node) throw new Error(`Can't find bookmark for id: ${nodeId}`);
          if (Object.prototype.hasOwnProperty.call(changes, 'title')) node.title = changes.title;
          if (Object.prototype.hasOwnProperty.call(changes, 'url')) node.url = changes.url;
          return node;
        },
        remove: async nodeId => {
          const node = findNode(nodeId);
          if (!node) throw new Error(`Can't find bookmark for id: ${nodeId}`);
          if ((node.children || []).length) throw new Error("Can't remove non-empty folder");
          const parent = findNode(node.parentId);
          parent.children.splice(node.index, 1);
          reindex(parent);
        },
        removeTree: async nodeId => {
          const node = findNode(nodeId);
          if (!node) throw new Error(`Can't find bookmark for id: ${nodeId}`);
          const parent = findNode(node.parentId);
          parent.children.splice(node.index, 1);
          reindex(parent);
        },
        move: async (id, destination) => {
          const node = findNode(id);
          const oldParent = findNode(node.parentId);
          oldParent.children.splice(node.index, 1);
          reindex(oldParent);
          const newParent = findNode(destination.parentId);
          const index = Number.isInteger(destination.index) ? Math.min(destination.index, newParent.children.length) : newParent.children.length;
          newParent.children.splice(index, 0, node);
          reindex(newParent);
          return node;
        }
      },
      downloads: {
        download: async options => {
          downloadRequests.push(options);
          const item = { id: downloads.length + 1, state: 'complete', exists: true, filename: `D:\\Downloads\\${options.filename.replace(/\//g, '\\')}`, startTime: new Date().toISOString(), fileSize: 1000 };
          downloads.push(item);
          return item.id;
        },
        search: async query => query.id ? downloads.filter(item => item.id === query.id) : [...downloads].reverse(),
        removeFile: async () => {}, erase: async () => {},
        onChanged: { addListener() {}, removeListener() {} }
      },
      storage: {
        local: {
          async get(defaults) { return structuredClone({ ...defaults, ...storage }); },
          async set(values) { Object.assign(storage, structuredClone(values)); },
          async remove(key) { delete storage[key]; }
        }
      }
    }
  };
  context.globalThis = context;
  context.importScripts = (...names) => {
    for (const name of names) {
      if (name === 'bridge-config.js') {
        context.BookmarkOrganizerBridgeConfig = Object.freeze({ token: 'test-secret' });
      } else {
        vm.runInContext(fs.readFileSync(extensionFile(name), 'utf8'), context);
      }
    }
  };
  context.listener = () => listener;
  context.internalListener = () => internalListener;
  context.findNode = findNode;
  context.storageData = storage;
  context.downloadRequests = downloadRequests;
  context.downloads = downloads;
  return context;
}

function sendInternal(context, request, senderId = 'test-extension-id') {
  return new Promise(resolve => {
    const keepAlive = context.internalListener()(
      { channel: 'bookmark-organizer-popup', request },
      { id: senderId },
      resolve
    );
    if (keepAlive === false) setTimeout(() => resolve({ ok: false, error: 'rejected' }), 0);
  });
}

function send(context, request, token = 'test-secret', senderUrl = 'http://127.0.0.1:32123/bridge/test') {
  return new Promise(resolve => {
    const keepAlive = context.listener()(
      { token, request },
      { url: senderUrl },
      resolve
    );
    if (keepAlive === false) setTimeout(() => resolve({ ok: false, error: 'rejected' }), 0);
  });
}

(async () => {
  const context = makeEnvironment();
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(extensionFile('bridge.js'), 'utf8'), context);

  const denied = await send(context, { command: 'scan' }, 'wrong');
  if (denied.ok) throw new Error('Bridge accepted an invalid token.');
  const remoteDenied = await send(context, { command: 'scan' }, 'test-secret', 'https://example.test/bridge');
  if (remoteDenied.ok) throw new Error('Bridge accepted a non-local sender.');

  const scan = await send(context, { command: 'scan' });
  if (!scan.ok || scan.result.temporaryCount !== 1 || scan.result.temporaryBookmarks[0].id !== '10') {
    throw new Error(`Bridge scan failed: ${JSON.stringify(scan)}`);
  }
  const allContext = makeEnvironment();
  allContext.findNode('11').children.push({ id: '12', parentId: '11', index: 0, title: '已有项目', url: 'https://example.test/project' });
  vm.createContext(allContext);
  vm.runInContext(fs.readFileSync(extensionFile('bridge.js'), 'utf8'), allContext);
  const allScan = await send(allContext, { command: 'scan', scope: 'all' });
  if (!allScan.ok || allScan.result.scope !== 'all' || allScan.result.bookmarks.length !== 2 || allScan.result.temporaryCount !== 1) {
    throw new Error(`Bridge full scan failed: ${JSON.stringify(allScan)}`);
  }
  const allValidation = await send(allContext, {
    command: 'plan.validate', scope: 'all',
    plan: [{ id: '12', folderPath: '收藏夹栏/开发/项目' }]
  });
  if (!allValidation.ok || allValidation.result.moveCount !== 1 || !allValidation.result.planToken) {
    throw new Error(`Bridge full validation failed: ${JSON.stringify(allValidation)}`);
  }
  const allApply = await send(allContext, { command: 'plan.apply', planToken: allValidation.result.planToken, confirmed: true });
  if (!allApply.ok || allApply.result.movedCount !== 1 || allContext.findNode('12').parentId === '11') {
    throw new Error(`Bridge full-scope apply failed: ${JSON.stringify(allApply)}`);
  }

  const validation = await send(context, {
    command: 'plan.validate',
    plan: [{ id: '10', folderPath: '收藏夹栏/开发/Git' }]
  });
  if (!validation.ok || !validation.result.planToken || validation.result.moveCount !== 1) {
    throw new Error(`Bridge validation failed: ${JSON.stringify(validation)}`);
  }

  const unconfirmed = await send(context, { command: 'plan.apply', planToken: validation.result.planToken });
  if (unconfirmed.ok || !unconfirmed.error.includes('明确确认')) throw new Error('Bridge accepted an unconfirmed mutation.');

  const applied = await send(context, { command: 'plan.apply', planToken: validation.result.planToken, confirmed: true });
  if (!applied.ok || context.findNode('10').parentId === '9' || applied.result.movedCount !== 1) {
    throw new Error(`Bridge apply failed: ${JSON.stringify(applied)}`);
  }
  if (!context.storageData.bookmarkOrganizerOperations?.length) throw new Error('Bridge did not store operation history.');

  const undone = await send(context, { command: 'operations.undo', operationId: applied.result.operationId, confirmed: true });
  if (!undone.ok || context.findNode('10').parentId !== '9') throw new Error(`Bridge undo failed: ${JSON.stringify(undone)}`);

  const changedContext = makeEnvironment();
  vm.createContext(changedContext);
  vm.runInContext(fs.readFileSync(extensionFile('bridge.js'), 'utf8'), changedContext);
  const changedValidation = await send(changedContext, {
    command: 'plan.validate',
    plan: [{ id: '10', folderPath: '收藏夹栏/开发' }]
  });
  changedContext.findNode('10').title = '校验后改名';
  const changedApply = await send(changedContext, {
    command: 'plan.apply', planToken: changedValidation.result.planToken, confirmed: true
  });
  if (changedApply.ok || !changedApply.error.includes('状态已经改变')) {
    throw new Error(`Bridge did not reject changed source state: ${JSON.stringify(changedApply)}`);
  }
  if (changedContext.findNode('10').parentId !== '9') throw new Error('Changed-state rejection moved the bookmark.');

  const concurrentContext = makeEnvironment();
  vm.createContext(concurrentContext);
  vm.runInContext(fs.readFileSync(extensionFile('bridge.js'), 'utf8'), concurrentContext);
  const first = await send(concurrentContext, { command: 'plan.validate', plan: [{ id: '10', folderPath: '收藏夹栏/开发' }] });
  await send(concurrentContext, { command: 'plan.validate', plan: [{ id: '10', folderPath: '收藏夹栏/开发/Git' }] });
  const staleApply = await send(concurrentContext, { command: 'plan.apply', planToken: first.result.planToken, confirmed: true });
  if (staleApply.ok || !staleApply.error.includes('令牌无效')) throw new Error('An older concurrent plan remained executable.');

  const expiredContext = makeEnvironment();
  vm.createContext(expiredContext);
  vm.runInContext(fs.readFileSync(extensionFile('bridge.js'), 'utf8'), expiredContext);
  const expiring = await send(expiredContext, { command: 'plan.validate', plan: [{ id: '10', folderPath: '收藏夹栏/开发' }] });
  expiredContext.storageData.bookmarkOrganizerPendingPlan.expiresAt = Date.now() - 1;
  const expiredApply = await send(expiredContext, { command: 'plan.apply', planToken: expiring.result.planToken, confirmed: true });
  if (expiredApply.ok || !expiredApply.error.includes('已过期')) throw new Error('Bridge accepted an expired plan token.');

  const serviceWorkerContext = makeEnvironment({ serviceWorker: true });
  vm.createContext(serviceWorkerContext);
  vm.runInContext(fs.readFileSync(extensionFile('bridge.js'), 'utf8'), serviceWorkerContext);
  const serviceWorkerBackup = await send(serviceWorkerContext, { command: 'backup' });
  if (!serviceWorkerBackup.ok) throw new Error(`Service worker backup failed: ${JSON.stringify(serviceWorkerBackup)}`);
  if (serviceWorkerBackup.result.stats?.bookmarks !== 1 || serviceWorkerBackup.result.stats?.folders !== 4) {
    throw new Error(`Service worker backup returned incorrect stats: ${JSON.stringify(serviceWorkerBackup)}`);
  }
  const archiveUrl = serviceWorkerContext.downloadRequests[0]?.url || '';
  const prefix = 'data:text/html;charset=utf-8;base64,';
  if (!archiveUrl.startsWith(prefix)) throw new Error('Service worker backup did not use the data URL fallback.');
  const archiveHtml = Buffer.from(archiveUrl.slice(prefix.length), 'base64').toString('utf8');
  if (!archiveHtml.includes('Git 教程') || !archiveHtml.includes('https://example.test/git')) {
    throw new Error('Service worker backup did not preserve UTF-8 bookmark content.');
  }
  const popupBackup = await sendInternal(serviceWorkerContext, { command: 'backup' });
  if (!popupBackup.ok) throw new Error(`Popup background backup failed: ${JSON.stringify(popupBackup)}`);
  const forbiddenInternal = await sendInternal(serviceWorkerContext, { command: 'scan' });
  if (forbiddenInternal.ok) throw new Error('Popup internal channel accepted a non-backup command.');
  const foreignInternal = await sendInternal(serviceWorkerContext, { command: 'backup' }, 'foreign-extension');
  if (foreignInternal.ok) throw new Error('Popup internal channel accepted a foreign sender.');

  const deletedContext = makeEnvironment();
  deletedContext.findNode('9').children.push({
    id: '10b', parentId: '9', index: 1, title: 'Second', url: 'https://example.test/second'
  });
  vm.createContext(deletedContext);
  vm.runInContext(fs.readFileSync(extensionFile('bridge.js'), 'utf8'), deletedContext);
  const deletedValidation = await send(deletedContext, {
    command: 'plan.validate',
    plan: [{ id: '10', folderPath: '收藏夹栏/开发' }, { id: '10b', folderPath: '收藏夹栏/开发' }]
  });
  const deletedApply = await send(deletedContext, {
    command: 'plan.apply', planToken: deletedValidation.result.planToken, confirmed: true
  });
  if (!deletedApply.ok) throw new Error(`Bridge apply failed before the deletion scenario: ${JSON.stringify(deletedApply)}`);
  const removedNode = deletedContext.findNode('10b');
  const removedParent = deletedContext.findNode(removedNode.parentId);
  removedParent.children.splice(removedNode.index, 1);
  removedParent.children.forEach((child, index) => { child.index = index; });
  const deletedUndo = await send(deletedContext, {
    command: 'operations.undo', operationId: deletedApply.result.operationId, confirmed: true
  });
  if (!deletedUndo.ok) throw new Error(`Undo failed after a bookmark was deleted: ${JSON.stringify(deletedUndo)}`);
  if (deletedUndo.result.restoredCount !== 1 || deletedUndo.result.skippedCount !== 1) {
    throw new Error(`Undo did not report the deleted bookmark: ${JSON.stringify(deletedUndo.result)}`);
  }
  if (deletedContext.findNode('10').parentId !== '9') throw new Error('Undo did not restore the surviving bookmark.');

  const boot = () => {
    const env = makeEnvironment();
    vm.createContext(env);
    vm.runInContext(fs.readFileSync(extensionFile('bridge.js'), 'utf8'), env);
    return env;
  };
  const assert = require('assert/strict');
  const plan = [{ id: '10', folderPath: '收藏夹栏/开发' }];
  const outside = boot();
  outside.findNode('2').children.push({ id: '20', parentId: '2', index: 0, title: 'Outside', url: 'https://example.test/outside' });
  const outsideScan = await send(outside, { command: 'scan', scope: 'all' });
  assert.equal(outsideScan.result.bookmarks.find(item => item.id === '20').movable, false);
  assert.equal((await send(outside, { command: 'plan.validate', scope: 'all', plan: [{ id: '20', folderPath: '收藏夹栏/开发' }] })).code, 'SOURCE_OUT_OF_SCOPE');

  const duringBackup = boot();
  const pre = await send(duringBackup, { command: 'plan.validate', plan });
  const download = duringBackup.chrome.downloads.download;
  duringBackup.chrome.downloads.download = async options => { duringBackup.findNode('10').title = 'Changed'; return download(options); };
  assert.equal((await send(duringBackup, { command: 'plan.apply', planToken: pre.result.planToken, confirmed: true })).code, 'PLAN_CHANGED');
  assert.equal(duringBackup.findNode('10').parentId, '9');

  const concurrent = boot();
  const token = (await send(concurrent, { command: 'plan.validate', plan })).result.planToken;
  const pair = await Promise.all([send(concurrent, { command: 'plan.apply', planToken: token, confirmed: true }), send(concurrent, { command: 'plan.apply', planToken: token, confirmed: true })]);
  assert.equal(pair.filter(item => item.ok).length, 1);
  assert.equal(pair.find(item => !item.ok).code, 'BUSY');
  assert.equal((await send(concurrent, { command: 'plan.apply', planToken: token, confirmed: true })).code, 'PLAN_ALREADY_STARTED');
  concurrent.findNode('10').title = 'User edited';
  const conflict = await send(concurrent, { command: 'operations.undo', operationId: pair.find(item => item.ok).result.operationId, confirmed: true });
  assert.equal(conflict.code, 'PARTIAL_UNDO');
  assert.equal(concurrent.findNode('10').parentId, '11');

  const partial = boot();
  partial.findNode('9').children.push({ id: '10b', parentId: '9', index: 1, title: 'Second', url: 'https://example.test/2' });
  const partialPlan = (await send(partial, { command: 'plan.validate', plan: [...plan, { id: '10b', folderPath: '收藏夹栏/开发' }] })).result;
  const move = partial.chrome.bookmarks.move;
  partial.chrome.bookmarks.move = async (id, destination) => { if (id === '10b') throw new Error('injected move failure'); return move(id, destination); };
  const failed = await send(partial, { command: 'plan.apply', planToken: partialPlan.planToken, confirmed: true });
  assert.equal(failed.code, 'PARTIAL_OPERATION');
  assert.equal(failed.details.moves[0].state, 'moved');
  assert.equal(failed.details.moves[1].state, 'pending');
  partial.chrome.bookmarks.move = move;
  const recovered = await send(partial, { command: 'operations.undo', operationId: failed.details.operationId, confirmed: true });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(partial.findNode('9').children.map(item => item.id).join(','), '10,10b');

  const hung = boot();
  const swap = boot();
  swap.findNode('1').children.push(
    { id: '12', parentId: '1', index: 2, title: 'A', children: [{ id: '21', parentId: '12', index: 0, title: 'A1', url: 'https://example.test/a' }] },
    { id: '13', parentId: '1', index: 3, title: 'B', children: [{ id: '22', parentId: '13', index: 0, title: 'B1', url: 'https://example.test/b' }] }
  );
  const swapPlan = await send(swap, { command: 'plan.validate', scope: 'all', plan: [{ id: '21', folderPath: '收藏夹栏/B' }, { id: '22', folderPath: '收藏夹栏/A' }] });
  const swapped = await send(swap, { command: 'plan.apply', planToken: swapPlan.result.planToken, confirmed: true });
  assert.equal(swapped.ok, true, JSON.stringify(swapped));
  const unswapped = await send(swap, { command: 'operations.undo', operationId: swapped.result.operationId, confirmed: true });
  assert.equal(unswapped.ok, true, JSON.stringify(unswapped));
  assert.equal(swap.findNode('21').parentId, '12');
  assert.equal(swap.findNode('22').parentId, '13');
  hung.downloads.push({ id: 123, filename: 'D:\\Downloads\\Bookmark-Organizer-Archives\\bookmark-archive-test.html', state: 'in_progress', bytesReceived: 100, totalBytes: 100, danger: 'asyncScanning' });
  let cancelled = 0;
  hung.chrome.downloads.cancel = async id => { assert.equal(id, 123); cancelled++; hung.downloads[0].state = 'interrupted'; };
  await assert.rejects(hung.BookmarkOrganizerCore.waitForDownload(123, 5), error => error.code === 'ARCHIVE_TIMEOUT' && error.details.download.id === 123 && error.details.temporaryFileCleanup === 'unverified');
  assert.equal(cancelled, 1);
  assert.equal((await send(hung, { command: 'downloads.list' })).result.downloads.length, 1);
  assert.equal((await send(hung, { command: 'archives.list' })).result.archives.length, 0);
  hung.downloads[0].state = 'in_progress';
  hung.chrome.downloads.cancel = async () => { throw new Error('cancel failed'); };
  await assert.rejects(hung.BookmarkOrganizerCore.waitForDownload(123, 5), error => error.details.cancellation === 'cancel failed');
  hung.downloads[0].state = 'interrupted';
  hung.downloads[0].error = 'FILE_ACCESS_DENIED';
  await assert.rejects(hung.BookmarkOrganizerCore.waitForDownload(123, 5), error => error.code === 'ARCHIVE_INTERRUPTED' && error.details.download.error === 'FILE_ACCESS_DENIED');

  const maintenance = boot();
  const firstScan = await send(maintenance, { command: 'scan', scope: 'all' });
  const secondScan = await send(maintenance, { command: 'scan', scope: 'all' });
  assert.equal(firstScan.result.checksum, secondScan.result.checksum);
  assert.ok(firstScan.result.folders.some(folder => folder.path === '收藏夹栏/开发' && folder.isEmpty && folder.id === '11'));
  assert.equal(firstScan.result.folders.find(folder => folder.path === '收藏夹栏/临时收藏').protected, true);
  const lifetime = Date.parse(firstScan.result.scannedAt);
  assert.ok(Number.isFinite(lifetime));
  const emptyPreview = await send(maintenance, { command: 'folders.prune', empty: true });
  assert.equal(emptyPreview.result.moveCount, 1);
  assert.equal(emptyPreview.result.preview[0].id, '11');
  assert.equal(emptyPreview.result.preview[0].action, 'purgeFolder');
  const tokenLifetime = Date.parse(emptyPreview.result.expiresAt) - Date.now();
  assert.ok(tokenLifetime > 29 * 60 * 1000 && tokenLifetime < 31 * 60 * 1000);
  const pruned = await send(maintenance, { command: 'folders.prune', empty: true, confirmed: true });
  assert.equal(pruned.ok, true, JSON.stringify(pruned));
  assert.equal(maintenance.findNode('11'), null);
  const pruneUndo = await send(maintenance, { command: 'operations.undo', operationId: pruned.result.operationId, confirmed: true });
  assert.equal(pruneUndo.ok, true, JSON.stringify(pruneUndo));
  assert.equal(maintenance.findNode('1').children.some(child => child.title === '开发' && !child.url), true);
  const listed = await send(maintenance, { command: 'operations.list', type: 'prune' });
  assert.equal(listed.result.operations.length, 1);
  assert.equal((await send(maintenance, { command: 'operations.list', type: 'rename' })).result.operations.length, 0);

  const renamePreview = await send(maintenance, { command: 'folders.rename', path: '收藏夹栏/开发', name: '工程' });
  assert.equal(renamePreview.result.preview[0].name, '工程');
  const renamed = await send(maintenance, { command: 'folders.rename', path: '收藏夹栏/开发', name: '工程', confirmed: true });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal(maintenance.findNode('1').children.find(child => !child.url && child.title === '工程').id !== undefined, true);
  const renameUndo = await send(maintenance, { command: 'operations.undo', operationId: renamed.result.operationId, confirmed: true });
  assert.equal(renameUndo.ok, true, JSON.stringify(renameUndo));
  assert.ok(maintenance.findNode('1').children.some(child => child.title === '开发'));
  const protectedRename = await send(maintenance, { command: 'folders.rename', path: '收藏夹栏/临时收藏', name: '收件箱' });
  assert.equal(protectedRename.ok, false);
  assert.match(protectedRename.error, /不能对/);

  maintenance.findNode('1').children.push({ id: '40', parentId: '1', index: maintenance.findNode('1').children.length, title: '前端', children: [] });
  await send(maintenance, { command: 'folders.move', path: '收藏夹栏/开发', to: '收藏夹栏', index: -1 });
  const movedFolder = await send(maintenance, { command: 'folders.move', path: '收藏夹栏/开发', to: '收藏夹栏', index: -1, confirmed: true });
  assert.equal(movedFolder.ok, true, JSON.stringify(movedFolder));
  const barChildren = maintenance.findNode('1').children;
  assert.equal(barChildren[barChildren.length - 1].title, '开发');
  const folderUndo = await send(maintenance, { command: 'operations.undo', operationId: movedFolder.result.operationId, confirmed: true });
  assert.equal(folderUndo.ok, true, JSON.stringify(folderUndo));

  const soft = boot();
  const softPlan = await send(soft, { command: 'plan.validate', plan: [{ id: '10', action: 'delete' }] });
  assert.equal(softPlan.result.preview[0].effect, '移入回收站');
  assert.equal(softPlan.result.preview[0].folderPath, '收藏夹栏/回收站');
  const softApply = await send(soft, { command: 'plan.apply', planToken: softPlan.result.planToken, confirmed: true });
  assert.equal(softApply.ok, true, JSON.stringify(softApply));
  assert.equal(soft.findNode(soft.findNode('10').parentId).title, '回收站');
  const recyclePreview = await send(soft, { command: 'recycle.purge', olderThanDays: null });
  assert.equal(recyclePreview.result.preview.length, 1);
  assert.equal(recyclePreview.result.preview[0].id, '10');
  assert.equal(recyclePreview.result.preview[0].action, 'purge');
  const softUndo = await send(soft, { command: 'operations.undo', operationId: softApply.result.operationId, confirmed: true });
  assert.equal(softUndo.ok, true, JSON.stringify(softUndo));
  assert.equal(soft.findNode('10').parentId, '9');

  const purged = boot();
  const purgePlan = await send(purged, { command: 'plan.validate', purge: true, plan: [{ id: '10', action: 'delete' }] });
  assert.equal(purgePlan.result.preview[0].action, 'purge');
  const purgeApply = await send(purged, { command: 'plan.apply', planToken: purgePlan.result.planToken, confirmed: true });
  assert.equal(purgeApply.ok, true, JSON.stringify(purgeApply));
  assert.equal(purged.findNode('10'), null);
  const purgeUndo = await send(purged, { command: 'operations.undo', operationId: purgeApply.result.operationId, confirmed: true });
  assert.equal(purgeUndo.ok, true, JSON.stringify(purgeUndo));
  assert.ok(purged.findNode('9').children.some(child => child.url === 'https://example.test/git' && child.title === 'Git 教程'));

  const nested = boot();
  nested.findNode('1').children.push({
    id: '50', parentId: '1', index: 2, title: '资料', children: [
      { id: '51', parentId: '50', index: 0, title: '编程语言', children: [
        { id: '52', parentId: '51', index: 0, title: 'c', children: [] }
      ] },
      { id: '53', parentId: '50', index: 1, title: '笔记', children: [
        { id: '54', parentId: '53', index: 0, title: '记录', url: 'https://example.test/note' }
      ] }
    ]
  });
  const leaves = await send(nested, { command: 'folders.prune', empty: true });
  assert.ok(leaves.result.preview.some(item => item.title === 'c'));
  assert.ok(!leaves.result.preview.some(item => item.title === '编程语言'));
  const recursive = await send(nested, { command: 'folders.prune', empty: true, recursive: true });
  assert.ok(recursive.result.preview.some(item => item.title === '编程语言'));
  assert.ok(!recursive.result.preview.some(item => item.title === 'c'));
  const blocked = await send(nested, { command: 'folders.prune', path: '收藏夹栏/资料/笔记' });
  assert.match(blocked.error, /目录非空/);
  const recursiveApply = await send(nested, { command: 'folders.prune', empty: true, recursive: true, confirmed: true });
  assert.equal(recursiveApply.ok, true, JSON.stringify(recursiveApply));
  assert.equal(nested.findNode('51'), null);
  assert.equal(nested.findNode('52'), null);
  assert.ok(nested.findNode('54'));
  nested.findNode('1').children.push({ id: '60', parentId: '1', index: nested.findNode('1').children.length, title: '稍后阅读', children: [] });
  nested.findNode('50').children.push({ id: '61', parentId: '50', index: nested.findNode('50').children.length, title: '空壳', children: [] });
  const everywhere = await send(nested, { command: 'folders.prune', empty: true });
  assert.ok(everywhere.result.preview.some(item => item.title === '稍后阅读'));
  assert.ok(everywhere.result.preview.some(item => item.title === '空壳'));
  const scoped = await send(nested, { command: 'folders.prune', empty: true, path: '收藏夹栏/资料' });
  assert.equal(scoped.result.preview.length, 1, JSON.stringify(scoped.result.preview));
  assert.equal(scoped.result.preview[0].title, '空壳');
  assert.equal(scoped.result.preview[0].fromPath, '收藏夹栏/资料');
  const kept = await send(nested, { command: 'folders.prune', empty: true, exclude: ['收藏夹栏/稍后阅读'] });
  assert.ok(kept.result.preview.some(item => item.title === '空壳'));
  assert.ok(!kept.result.preview.some(item => item.title === '稍后阅读'));

  console.log('Local Agent bridge checks passed (including failure, concurrency and recovery scenarios).');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
