const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

function extensionFile(name) {
  return path.join(__dirname, '..', 'extension', 'edge-bookmark-organizer', name);
}

function makeEnvironment() {
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
  let listener = null;
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

  const context = {
    console, URL, Blob, Intl, Math, Date, setTimeout, clearTimeout, crypto: webcrypto,
    chrome: {
      runtime: {
        getManifest: () => ({ version: '2.0.0' }),
        onMessageExternal: { addListener(callback) { listener = callback; } }
      },
      bookmarks: {
        getTree: async () => tree,
        get: async ids => (Array.isArray(ids) ? ids : [ids]).map(value => findNode(value)).filter(Boolean),
        getChildren: async id => findNode(id)?.children || [],
        create: async options => {
          const parent = findNode(options.parentId);
          const node = { id: String(nextId++), parentId: parent.id, index: parent.children.length, title: options.title, children: [] };
          parent.children.push(node);
          return node;
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
          async get(defaults) { return { ...defaults, ...storage }; },
          async set(values) { Object.assign(storage, values); },
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
  context.findNode = findNode;
  context.storageData = storage;
  return context;
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

  console.log('Local Agent bridge checks passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
