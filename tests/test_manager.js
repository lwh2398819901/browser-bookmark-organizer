const fs = require('fs');
const vm = require('vm');
const path = require('path');

class FakeElement {
  constructor(tag = 'div') {
    this.tag = tag;
    this.listeners = {};
    this.children = [];
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.textContent = '';
    this.value = '';
    this.className = '';
    this.type = '';
  }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this[name] = value; }
  scrollIntoView() {}
  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      if (!(node instanceof FakeElement)) return;
      if (selector === 'input[type="checkbox"]:checked' && node.tag === 'input' && node.type === 'checkbox' && node.checked) found.push(node);
      node.children.forEach(visit);
    };
    visit(this);
    return found;
  }
}

function makeTree() {
  return [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', index: 0, title: '收藏夹栏', dateAdded: 10000, dateGroupModified: 20000, children: [
      { id: '9', parentId: '1', index: 0, title: '临时收藏', children: [
        { id: '10', parentId: '9', index: 0, title: 'Example', url: 'https://example.test/?a=1&b=2', dateAdded: 30000 }
      ] },
      { id: '11', parentId: '1', index: 1, title: '开发', children: [] }
    ] },
    { id: '2', parentId: '0', index: 1, title: '其他收藏', children: [] }
  ] }];
}

function makeEnvironment(currentUrl = 'https://new.example.test/article') {
  const elements = new Map();
  const tree = makeTree();
  const storage = {};
  let nextBookmarkId = 100;

  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, new FakeElement());
    return elements.get(selector);
  }
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
    console, URL, Blob, Intl, Math, setTimeout, clearTimeout,
    confirm: () => { context.confirmCalls += 1; return true; },
    window: { closed: false, close() { this.closed = true; } },
    navigator: { clipboard: { value: '', async writeText(value) { this.value = value; } } },
    document: {
      querySelector: element,
      createElement: tag => new FakeElement(tag),
      createTextNode: text => ({ textContent: String(text) })
    },
    chrome: {
      runtime: {
        id: 'new-extension-id',
        getURL: file => `chrome-extension://test/${file}`,
        getManifest: () => ({ version: '2.0.3' }),
        onMessage: { addListener(callback) { context.internalListener = callback; } },
        onMessageExternal: { addListener() {} },
        async sendMessage(message) {
          if (context.internalListener) return new Promise(resolve => context.internalListener(message, { id: 'new-extension-id' }, resolve));
          if (message?.channel !== 'bookmark-organizer-popup' || message?.request?.command !== 'backup') {
            return { ok: false, error: 'unsupported' };
          }
          try {
            const archive = await context.BookmarkOrganizerCore.archiveCurrentBookmarks();
            const cleanup = await context.BookmarkOrganizerCore.trimArchives();
            return { ok: true, result: { filename: archive.filename, cleanup } };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        }
      },
      tabs: {
        created: [],
        query: async () => [{ id: 5, title: 'New page', url: currentUrl }],
        async create(options) { this.created.push(options); }
      },
      bookmarks: {
        getTree: async () => tree,
        get: async ids => {
          const list = Array.isArray(ids) ? ids : [ids];
          const missing = list.filter(id => !findNode(id));
          if (missing.length) throw new Error(`Can't find bookmark for id: ${missing.join(', ')}`);
          return list.map(id => findNode(id));
        },
        getChildren: async id => findNode(id)?.children || [],
        create: async options => {
          const parent = findNode(options.parentId);
          if (!parent) throw new Error(`Missing parent ${options.parentId}`);
          const node = { id: String(nextBookmarkId++), parentId: parent.id, index: parent.children.length, title: options.title, ...(options.url ? { url: options.url } : { children: [] }) };
          parent.children.push(node);
          reindex(parent);
          return node;
        },
        remove: async id => {
          const node = findNode(id);
          if (!node) throw new Error(`Can't find bookmark for id: ${id}`);
          if ((node.children || []).length) throw new Error("Can't remove non-empty folder");
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
          context.bookmarkMoves += 1;
          return node;
        }
      },
      downloads: {
        shown: [],
        download: async options => {
          const id = context.downloads.length + 1;
          context.downloads.push({
            id, state: 'complete', exists: true, fileSize: 2048,
            filename: `D:\\Downloads\\${options.filename.replace(/\//g, '\\')}`,
            startTime: new Date().toISOString()
          });
          return id;
        },
        search: async query => query.id ? context.downloads.filter(item => item.id === query.id) : [...context.downloads].reverse(),
        removeFile: async id => {
          const item = context.downloads.find(download => download.id === id);
          if (item) item.exists = false;
        },
        erase: async query => {
          const index = context.downloads.findIndex(download => download.id === query.id);
          if (index >= 0) context.downloads.splice(index, 1);
        },
        show(id) { this.shown.push(id); },
        onChanged: { addListener() {}, removeListener() {} }
      },
      storage: {
        local: {
          async get(defaults) { return { ...defaults, ...storage }; },
          async set(values) { Object.assign(storage, structuredClone(values)); },
          async remove(key) { delete storage[key]; }
        }
      }
    }
  };
  context.importScripts = (...names) => {
    for (const name of names) {
      if (name === 'bridge-config.js') context.BookmarkOrganizerBridgeConfig = { token: 'test-secret' };
      else vm.runInContext(fs.readFileSync(extensionFile(name), 'utf8'), context);
    }
  };
  context.globalThis = context;
  context.bookmarkMoves = 0;
  context.confirmCalls = 0;
  context.downloads = [];
  context.elements = elements;
  context.tree = tree;
  context.storageData = storage;
  context.findNode = findNode;
  return context;
}

function load(context, file) {
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  vm.runInContext(fs.readFileSync(extensionFile('bridge.js'), 'utf8'), context);
}

function extensionFile(name) {
  return path.join(__dirname, '..', 'extension', 'edge-bookmark-organizer', name);
}

function findButton(root, text) {
  let found = null;
  const visit = node => {
    if (!(node instanceof FakeElement) || found) return;
    if (node.tag === 'button' && node.textContent === text) found = node;
    node.children.forEach(visit);
  };
  visit(root);
  return found;
}

async function tick() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function testManager() {
  const context = makeEnvironment();
  load(context, extensionFile('shared.js'));
  vm.runInContext(fs.readFileSync(extensionFile('manager.js'), 'utf8'), context);
  await tick();

  const core = context.BookmarkOrganizerCore;
  if (context.elements.get('.version').textContent !== '2.0.3') {
    throw new Error('Version badge was not filled from the extension manifest.');
  }
  const archiveHtml = core.bookmarksToNetscapeHtml(context.tree);
  if (!archiveHtml.includes('PERSONAL_TOOLBAR_FOLDER="true"') || !archiveHtml.includes('UNFILED_BOOKMARKS_FOLDER="true"')) throw new Error('Archive root-folder semantics are missing.');
  if (!archiveHtml.includes('ADD_DATE="10"') || !archiveHtml.includes('LAST_MODIFIED="20"') || !archiveHtml.includes('ADD_DATE="30"')) throw new Error('Archive timestamps are missing.');
  if (!core.isManagedArchive({ byExtensionId: 'old-id', state: 'complete', filename: 'D:\\Downloads\\Bookmark-Organizer-Archives\\bookmark-archive-2026.html' })) throw new Error('Managed archive was not recognized.');
  if (core.canonicalUrl('https://example.test/guide/#a') === core.canonicalUrl('https://example.test/guide/#b')) throw new Error('Different chapter anchors were treated as exact duplicates.');
  if (core.canonicalUrl('https://example.test/?b=2&a=1&utm_source=x') !== core.canonicalUrl('https://EXAMPLE.test/?a=1&b=2')) throw new Error('Safe query normalization did not identify an exact duplicate.');
  if (core.canonicalUrl('https://example.test/?flag') === core.canonicalUrl('https://example.test/?flag=')) throw new Error('Valueless query parameters were collapsed.');
  context.downloads.push({
    id: 99, state: 'complete', exists: false, fileSize: 2048,
    filename: 'D:\\Downloads\\Bookmark-Organizer-Archives\\bookmark-archive-deleted.html',
    startTime: new Date().toISOString()
  });
  const visibleArchives = await core.listManagedArchives();
  if (visibleArchives.some(item => item.id === 99)) throw new Error('A deleted archive remained visible.');
  context.downloads.length = 0;

  await context.elements.get('#backup').listeners.click();
  if (context.downloads.length !== 1 || context.bookmarkMoves !== 0) throw new Error('Standalone backup changed bookmarks or failed.');
  await context.elements.get('#refresh-archives').listeners.click();
  const deleteBackupButton = findButton(context.elements.get('#archive-list'), '删除备份');
  if (!deleteBackupButton) throw new Error('Delete-backup action was not rendered.');
  const confirmationsBeforeDelete = context.confirmCalls;
  await deleteBackupButton.listeners.click();
  if (context.downloads.length !== 0) throw new Error('Deleting one backup did not remove its file record.');
  if (context.confirmCalls !== confirmationsBeforeDelete) throw new Error('Deleting a backup unexpectedly requested confirmation.');

  await context.elements.get('#scan').listeners.click();
  context.elements.get('#plan').value = `方案如下：\n\`\`\`json\n${JSON.stringify([{ id: '10', folderPath: '收藏夹栏/开发' }])}\n\`\`\``;
  await context.elements.get('#validate-plan').listeners.click();
  if (context.elements.get('#apply').disabled) throw new Error('A valid plan was not enabled.');
  await context.elements.get('#apply').listeners.click();
  if (context.findNode('10').parentId !== '11') throw new Error(`Plan did not move the bookmark: ${context.elements.get('#result').textContent}`);
  if (!context.storageData.bookmarkOrganizerOperations?.length) throw new Error('Operation history was not saved.');

  const undoButton = findButton(context.elements.get('#history-list'), '撤销本次整理');
  if (!undoButton) throw new Error('Undo action was not rendered.');
  await undoButton.listeners.click();
  if (context.findNode('10').parentId !== '9') throw new Error(`Undo did not restore the original folder: ${context.elements.get('#result').textContent}`);
  await context.elements.get('#clear-history').listeners.click();
  if (context.storageData.bookmarkOrganizerOperations.length !== 0) throw new Error('Clear history did not remove local operation records.');
  if (context.findNode('10').parentId !== '9') throw new Error('Clearing history changed bookmarks.');
  if (context.confirmCalls !== 0) throw new Error('Manager used a blocking confirmation dialog.');
}

async function testPopupDuplicateGuard() {
  const context = makeEnvironment('https://new.example.test/article');
  load(context, extensionFile('shared.js'));
  vm.runInContext(fs.readFileSync(extensionFile('popup.js'), 'utf8'), context);
  await tick();
  const before = context.BookmarkOrganizerCore.collectBookmarks(context.tree).bookmarks.length;
  await context.elements.get('#add-temporary').listeners.click();
  await context.elements.get('#add-temporary').listeners.click();
  const after = context.BookmarkOrganizerCore.collectBookmarks(context.tree).bookmarks.length;
  if (after !== before + 1) throw new Error('Quick collect did not prevent an exact duplicate.');
  if (!context.elements.get('#page-state').textContent.includes('已经收藏')) throw new Error('Duplicate guard did not report the existing bookmark.');
  await context.elements.get('#backup').listeners.click();
  if (!context.window.closed || context.downloads.length !== 1) throw new Error('Popup backup did not finish in the background and close.');
  if (context.chrome.tabs.created.some(item => item.url.endsWith('manager.html?action=backup'))) throw new Error('Popup backup opened an unnecessary manager tab.');
}

async function testPopupUnbookmark() {
  const context = makeEnvironment('https://example.test/?b=2&a=1&utm_source=x');
  load(context, extensionFile('shared.js'));
  vm.runInContext(fs.readFileSync(extensionFile('popup.js'), 'utf8'), context);
  await tick();
  const button = context.elements.get('#add-temporary');
  if (button.disabled || button.textContent !== '取消收藏') {
    throw new Error(`Bookmarked page did not offer unbookmark: ${button.textContent}`);
  }
  if (!context.elements.get('#page-state').textContent.includes('已经收藏')) {
    throw new Error('Bookmarked page did not show its existing location.');
  }
  await button.listeners.click();
  const remaining = context.BookmarkOrganizerCore.collectBookmarks(context.tree).bookmarks;
  if (remaining.some(item => item.canonical === context.BookmarkOrganizerCore.canonicalUrl('https://example.test/?a=1&b=2'))) {
    throw new Error('Unbookmark left the current page saved.');
  }
  if (button.textContent !== '加入“临时收藏”' || !context.elements.get('#page-state').textContent.includes('已取消收藏')) {
    throw new Error(`Unbookmark did not return to the add state: ${button.textContent} / ${context.elements.get('#page-state').textContent}`);
  }
}

async function testUndoRestoresOriginalOrder() {
  const context = makeEnvironment();
  const temporary = context.findNode('9');
  temporary.children.push(
    { id: '10b', parentId: '9', index: 1, title: 'Second', url: 'https://example.test/?b=2' },
    { id: '10c', parentId: '9', index: 2, title: 'Third', url: 'https://example.test/?c=3' }
  );
  load(context, extensionFile('shared.js'));
  vm.runInContext(fs.readFileSync(extensionFile('manager.js'), 'utf8'), context);
  await tick();
  await context.elements.get('#scan').listeners.click();
  context.elements.get('#plan').value = JSON.stringify([
    { id: '10', folderPath: '收藏夹栏/开发' },
    { id: '10b', folderPath: '收藏夹栏/开发' },
    { id: '10c', folderPath: '收藏夹栏/开发' }
  ]);
  await context.elements.get('#validate-plan').listeners.click();
  await context.elements.get('#apply').listeners.click();
  const undoButton = findButton(context.elements.get('#history-list'), '撤销本次整理');
  if (!undoButton) throw new Error('Undo action was not rendered.');
  await undoButton.listeners.click();
  const order = (context.findNode('9').children || []).map(node => node.id).join(',');
  if (order !== '10,10b,10c') throw new Error(`Undo did not restore the original order: ${order}`);
}

async function testLocalizedBookmarkBar() {
  const context = makeEnvironment();
  context.tree[0].children[0].title = 'Bookmarks bar';
  context.tree[0].children[0].children[1].title = 'Development';
  load(context, extensionFile('shared.js'));
  vm.runInContext(fs.readFileSync(extensionFile('manager.js'), 'utf8'), context);
  await tick();
  await context.elements.get('#scan').listeners.click();
  context.elements.get('#plan').value = JSON.stringify([{ id: '10', folderPath: 'bookmarks_bar/Development' }]);
  await context.elements.get('#validate-plan').listeners.click();
  if (context.elements.get('#apply').disabled) throw new Error('Logical root alias was not accepted in an English browser.');
  await context.elements.get('#apply').listeners.click();
  if (context.findNode('10').parentId !== '11') throw new Error('Localized bookmark-bar plan was not applied.');
}

async function testUndoSkipsDeletedBookmarks() {
  const context = makeEnvironment();
  context.findNode('9').children.push(
    { id: '10b', parentId: '9', index: 1, title: 'Second', url: 'https://example.test/?b=2' }
  );
  load(context, extensionFile('shared.js'));
  vm.runInContext(fs.readFileSync(extensionFile('manager.js'), 'utf8'), context);
  await tick();
  await context.elements.get('#scan').listeners.click();
  context.elements.get('#plan').value = JSON.stringify([
    { id: '10', folderPath: '收藏夹栏/开发' },
    { id: '10b', folderPath: '收藏夹栏/开发' }
  ]);
  await context.elements.get('#validate-plan').listeners.click();
  await context.elements.get('#apply').listeners.click();

  const removed = context.findNode('10b');
  const parent = context.findNode(removed.parentId);
  parent.children.splice(removed.index, 1);
  parent.children.forEach((child, index) => { child.index = index; });

  const undoButton = findButton(context.elements.get('#history-list'), '撤销本次整理');
  if (!undoButton) throw new Error('Undo action was not rendered.');
  await undoButton.listeners.click();
  const order = (context.findNode('9').children || []).map(node => node.id).join(',');
  if (order !== '10') throw new Error(`Undo did not restore the surviving bookmark: ${order}`);
  const message = context.elements.get('#result').textContent;
  if (!message.includes('撤销完成') || !message.includes('1 条书签已被删除')) {
    throw new Error(`Undo did not report the deleted bookmark: ${message}`);
  }
}

(async () => {
  await testManager();
  await testPopupDuplicateGuard();
  await testPopupUnbookmark();
  await testUndoRestoresOriginalOrder();
  await testUndoSkipsDeletedBookmarks();
  await testLocalizedBookmarkBar();
  console.log('Extension 2.0 manager behavior checks passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
