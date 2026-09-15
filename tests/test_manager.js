const fs = require('fs');
const vm = require('vm');
const path = require('path');

const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      listeners: {}, disabled: false, textContent: '', value: '', className: '',
      addEventListener(type, callback) { this.listeners[type] = callback; }
    });
  }
  return elements.get(id);
}

const inbox = '临时收藏';
const bar = '收藏夹栏';
const tree = [{ id: '0', title: '', children: [
  { id: '1', title: bar, dateAdded: 10000, dateGroupModified: 20000, children: [
    { id: '9', title: inbox, children: [
      { id: '10', title: 'Example', url: 'https://example.test/?a=1&b=2', dateAdded: 30000 }
    ] }
  ] },
  { id: '2', title: 'Other', children: [] }
] }];

const context = {
  console, URL, Blob, setTimeout, clearTimeout,
  navigator: { clipboard: { writeText: async () => {} } },
  document: { querySelector: selector => element(selector) },
  chrome: {
    runtime: { id: 'new-extension-id' },
    bookmarks: {
      getTree: async () => tree,
      move: async () => { context.bookmarkMoves += 1; }
    },
    downloads: {
      download: async options => {
        const id = context.downloads.length + 1;
        context.downloads.push({
          id,
          state: 'complete',
          filename: `D:\\Downloads\\${options.filename.replace(/\//g, '\\')}`,
          startTime: new Date().toISOString()
        });
        return id;
      },
      search: async query => query.id
        ? context.downloads.filter(item => item.id === query.id)
        : [...context.downloads].reverse(),
      removeFile: async () => {},
      erase: async () => {},
      onChanged: { addListener() {}, removeListener() {} }
    }
  }
};
context.bookmarkMoves = 0;
context.downloads = [];

vm.createContext(context);
const manager = path.join(__dirname, '..', 'extension', 'edge-bookmark-organizer', 'manager.js');
vm.runInContext(fs.readFileSync(manager, 'utf8'), context);

const archive = context.bookmarksToNetscapeHtml(tree);
if (!archive.includes('PERSONAL_TOOLBAR_FOLDER="true"') || !archive.includes('UNFILED_BOOKMARKS_FOLDER="true"')) {
  throw new Error('Archive root-folder semantics are missing.');
}
if (!archive.includes('ADD_DATE="10"') || !archive.includes('LAST_MODIFIED="20"') || !archive.includes('ADD_DATE="30"')) {
  throw new Error('Archive timestamps are missing.');
}
if (!context.isManagedArchive({
  byExtensionId: 'old-extension-id', state: 'complete',
  filename: 'D:\\Downloads\\Bookmark-Organizer-Archives\\bookmark-archive-2026.html'
})) {
  throw new Error('Archive created under an earlier unpacked-extension ID was not recognized.');
}

(async () => {
  await element('#backup').listeners.click();
  if (context.downloads.length !== 1) throw new Error('Standalone backup did not create an archive.');
  if (context.bookmarkMoves !== 0) throw new Error('Standalone backup modified bookmarks.');
  if (!element('#result').textContent.includes('本次没有修改任何收藏夹')) {
    throw new Error('Standalone backup did not report its non-mutating result.');
  }

  await element('#scan').listeners.click();
  element('#plan').value = JSON.stringify([{ id: '10', folderPath: `${bar}/Test` }]);
  element('#preview').listeners.click();
  if (element('#apply').disabled) throw new Error('A valid plan was not enabled.');

  element('#plan').value = JSON.stringify([{ id: '10', folderPath: `${bar}/Changed` }]);
  element('#plan').listeners.input();
  if (!element('#apply').disabled || !element('#result').textContent.includes('重新校验')) {
    throw new Error('Editing a validated plan did not invalidate it.');
  }
  console.log('Manager behavior checks passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
