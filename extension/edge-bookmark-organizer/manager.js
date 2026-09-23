(function () {
  'use strict';

  const core = globalThis.BookmarkOrganizerCore;
  const operationStore = core.createOperationStore('bookmarkOrganizerOperations', 20);
  let scan = null;
  let validatedPlan = null;
  let previewRevision = 0;
  let planToken = null;

  async function background(request) {
    const reply = await chrome.runtime.sendMessage({ channel: 'bookmark-organizer-manager', request });
    if (!reply?.ok) throw new Error(`${reply?.error || '后台无响应'}${reply?.details?.operationId ? `（操作 ${reply.details.operationId}）` : ''}`);
    return reply.result;
  }

  const bookmarkCount = document.querySelector('#bookmark-count');
  const folderCount = document.querySelector('#folder-count');
  const temporaryCount = document.querySelector('#temporary-count');
  const archiveCount = document.querySelector('#archive-count');
  const backupButton = document.querySelector('#backup');
  const refreshArchivesButton = document.querySelector('#refresh-archives');
  const backupStatus = document.querySelector('#backup-status');
  const archiveOlderDays = document.querySelector('#archive-older-days');
  const archiveFrom = document.querySelector('#archive-from');
  const archiveUntil = document.querySelector('#archive-until');
  const purgeArchivesButton = document.querySelector('#purge-archives');
  const archiveList = document.querySelector('#archive-list');
  const restoreGuide = document.querySelector('#restore-guide');
  const restoreFile = document.querySelector('#restore-file');
  const scanButton = document.querySelector('#scan');
  const copyAgentButton = document.querySelector('#copy-agent');
  const scanStatus = document.querySelector('#scan-status');
  const temporaryList = document.querySelector('#temporary-list');
  const manualTools = document.querySelector('#manual-tools');
  const manualTarget = document.querySelector('#manual-target');
  const folderOptions = document.querySelector('#folder-options');
  const buildManualPlanButton = document.querySelector('#build-manual-plan');
  const planSummary = document.querySelector('#plan-summary');
  const planPreview = document.querySelector('#plan-preview');
  const applyButton = document.querySelector('#apply');
  const clearPlanButton = document.querySelector('#clear-plan');
  const planInput = document.querySelector('#plan');
  const validatePlanButton = document.querySelector('#validate-plan');
  const result = document.querySelector('#result');
  const refreshHistoryButton = document.querySelector('#refresh-history');
  const clearHistoryButton = document.querySelector('#clear-history');
  const historyList = document.querySelector('#history-list');
  const versionBadge = document.querySelector('.version');

  function createElement(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function setMessage(node, text, kind = '') {
    node.textContent = text;
    node.className = `message${kind ? ` ${kind}` : ''}`;
  }

  async function scanBookmarks() {
    const roots = await chrome.bookmarks.getTree();
    const collected = core.collectBookmarks(roots);
    const temporary = core.findTemporaryFolder(roots);
    if (!temporary) throw new Error(`未找到“${core.temporaryFolderName}”文件夹。请先通过工具栏加入一个临时收藏。`);
    const temporaryFolder = collected.folders.find(folder => folder.id === temporary.id);
    const temporaryUrls = core.temporaryBookmarks(temporary, temporaryFolder?.path || [core.temporaryFolderName]);
    const duplicateMap = new Map();
    for (const bookmark of collected.bookmarks) {
      const group = duplicateMap.get(bookmark.canonical) || [];
      group.push(bookmark);
      duplicateMap.set(bookmark.canonical, group);
    }
    return {
      roots,
      folders: collected.folders,
      urls: collected.bookmarks,
      temporary,
      temporaryUrls,
      duplicateMap,
      bookmarkBar: core.findBookmarkBar(roots)
    };
  }

  function duplicateRows(data) {
    return data.temporaryUrls.map(bookmark => {
      const elsewhere = (data.duplicateMap.get(bookmark.canonical) || []).filter(item => item.id !== bookmark.id);
      return { ...bookmark, duplicateCount: elsewhere.length, duplicatePaths: elsewhere.map(item => item.path.slice(0, -1).join('/')) };
    });
  }

  function renderScan(data) {
    const rows = duplicateRows(data);
    temporaryList.replaceChildren();
    folderOptions.replaceChildren();
    const rootTitle = data.bookmarkBar?.title || 'bookmarks_bar';
    manualTarget.placeholder = `${rootTitle}/开发/Git`;
    planInput.placeholder = `[{"id":"123","folderPath":"${rootTitle}/开发/Git"}]`;

    for (const folder of data.folders.filter(item => item.path[0] === data.bookmarkBar?.title && item.id !== data.temporary.id)) {
      const option = document.createElement('option');
      option.value = folder.path.join('/');
      folderOptions.append(option);
    }

    if (!rows.length) {
      temporaryList.append(createElement('p', 'empty', '“临时收藏”现在是空的。'));
    }
    for (const row of rows) {
      const item = createElement('article', 'bookmark-item');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.bookmarkId = row.id;
      checkbox.setAttribute('aria-label', `选择 ${row.title}`);
      const content = createElement('div');
      content.append(createElement('p', 'item-title', row.title || row.url));
      content.append(createElement('p', 'item-meta', row.url));
      if (row.duplicatePaths.length) content.append(createElement('p', 'item-meta', `已有位置：${row.duplicatePaths.join('；')}`));
      item.append(checkbox, content);
      if (row.duplicateCount) item.append(createElement('span', 'duplicate-badge', `重复 ${row.duplicateCount} 处`));
      temporaryList.append(item);
    }

    const duplicateTotal = rows.filter(row => row.duplicateCount > 0).length;
    setMessage(scanStatus, `发现 ${rows.length} 条临时收藏，其中 ${duplicateTotal} 条在其他位置已有相同网址。`, 'success');
    copyAgentButton.disabled = false;
    manualTools.hidden = rows.length === 0;
    temporaryCount.textContent = String(rows.length);
  }

  async function refreshOverview() {
    const roots = await chrome.bookmarks.getTree();
    const collected = core.collectBookmarks(roots);
    const temporary = core.findTemporaryFolder(roots);
    const temporaryFolder = collected.folders.find(folder => folder.id === temporary?.id);
    bookmarkCount.textContent = String(collected.bookmarks.length);
    folderCount.textContent = String(collected.folders.length);
    temporaryCount.textContent = String(core.temporaryBookmarks(temporary, temporaryFolder?.path || [core.temporaryFolderName]).length);
  }

  async function refreshArchives() {
    archiveList.replaceChildren(createElement('p', 'empty', '正在读取备份记录…'));
    try {
      const archives = await core.listManagedArchives();
      archiveList.replaceChildren();
      archiveCount.textContent = String(archives.filter(item => item.exists !== false).length);
      if (!archives.length) {
        archiveList.append(createElement('p', 'empty', '尚无本扩展创建的备份。'));
        return;
      }
      for (const archive of archives) {
        const row = createElement('article', 'archive-item');
        const content = createElement('div');
        const title = core.formatDate(archive.startTime);
        const state = archive.exists === false ? '文件已被移动或删除' : '文件存在';
        content.append(createElement('p', 'item-title', title));
        content.append(createElement('p', 'item-meta', `${core.formatBytes(archive.fileSize ?? archive.totalBytes)} · ${state}`));
        content.append(createElement('p', 'item-meta', archive.filename || '路径未知'));
        const actions = createElement('div', 'archive-actions');
        const show = createElement('button', '', '显示文件');
        show.disabled = archive.exists === false;
        show.addEventListener('click', () => chrome.downloads.show(archive.id));
        const copy = createElement('button', '', '复制路径');
        copy.addEventListener('click', async () => {
          await navigator.clipboard.writeText(archive.filename || '');
          setMessage(backupStatus, '备份文件路径已复制。', 'success');
        });
        const restore = createElement('button', '', '恢复方法');
        restore.addEventListener('click', () => {
          restoreFile.textContent = archive.filename || '路径未知';
          restoreGuide.hidden = false;
          globalThis.scrollTo?.({ top: Math.max(0, restoreGuide.offsetTop - 24), behavior: 'smooth' });
        });
        const remove = createElement('button', 'danger-button', '删除备份');
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try {
            await chrome.downloads.removeFile(archive.id);
            await chrome.downloads.erase({ id: archive.id });
            setMessage(backupStatus, '指定备份已删除；收藏夹没有改变。', 'success');
            restoreGuide.hidden = true;
            await refreshArchives();
          } catch (error) {
            setMessage(backupStatus, `删除备份失败：${error.message}`, 'error');
            remove.disabled = false;
          }
        });
        actions.append(show, copy, restore, remove);
        row.append(content, actions);
        archiveList.append(row);
      }
    } catch (error) {
      archiveCount.textContent = '—';
      archiveList.replaceChildren(createElement('p', 'empty', `读取备份失败：${error.message}`));
    }
  }

  function parsePlan(raw) {
    const trimmed = String(raw || '').trim();
    const candidates = [trimmed];
    for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
    const firstBracket = trimmed.indexOf('[');
    const lastBracket = trimmed.lastIndexOf(']');
    if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(trimmed.slice(firstBracket, lastBracket + 1));
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* Try the next representation. */ }
    }
    try {
      return trimmed.split(/\r?\n/).filter(Boolean).map(line => {
        const separator = line.indexOf('|');
        if (separator < 1) throw new Error('没有从 Agent 回复中找到可用的整理方案。');
        return { id: line.slice(0, separator).trim(), folderPath: line.slice(separator + 1).trim() };
      });
    } catch {
      throw new Error('没有从 Agent 回复中找到可用方案。请让 Agent 返回包含 id 和 folderPath 的 JSON 数组。');
    }
  }

  function validatePlan(rawPlan = planInput.value.trim()) {
    if (!scan) throw new Error('请先扫描临时收藏。');
    const plan = typeof rawPlan === 'string' ? parsePlan(rawPlan) : rawPlan;
    if (!Array.isArray(plan) || !plan.length) throw new Error('整理方案不能为空。');
    const temporaryById = new Map(scan.temporaryUrls.map(item => [item.id, item]));
    const seen = new Set();
    return plan.map(item => {
      const action = item?.action || 'move';
      if (!item || typeof item.id !== 'string' || (action === 'move' && typeof item.folderPath !== 'string')) throw new Error('每项都需要字符串 id 和 folderPath。');
      if (!['move', 'delete', 'purge'].includes(action)) throw new Error(`整理中心不能执行“${action}”。目录操作请使用 bookmarkctl。`);
      const bookmark = temporaryById.get(item.id);
      if (!bookmark) throw new Error(`书签 ${item.id} 不在当前“临时收藏”中。`);
      if (!core.idsUnder(scan.bookmarkBar).has(item.id)) throw new Error('来源位于收藏夹栏之外，仅支持扫描。');
      if (seen.has(item.id)) throw new Error(`书签 ${item.id} 重复出现在方案中。`);
      seen.add(item.id);
      if (action !== 'move') {
        return {
          action,
          id: item.id,
          title: bookmark.title,
          url: bookmark.url,
          fromParentId: bookmark.parentId,
          fromIndex: bookmark.index,
          fromPath: bookmark.path.slice(0, -1)
        };
      }
      const path = core.normalizePath(item.folderPath);
      const actualRoot = scan.bookmarkBar?.title;
      if (!actualRoot) throw new Error('没有找到浏览器的收藏夹栏根目录。');
      const acceptedRoots = new Set([actualRoot, 'bookmarks_bar', '收藏夹栏', '书签栏', 'Bookmarks bar', 'Favorites bar'].filter(Boolean));
      if (path.length < 2 || !acceptedRoots.has(path[0])) throw new Error(`目标路径必须以“${actualRoot || '收藏夹栏'}/…”开头：${item.folderPath}`);
      path[0] = actualRoot;
      if (path.includes(core.temporaryFolderName)) throw new Error(`目标目录不能仍然位于“${core.temporaryFolderName}”：${item.folderPath}`);
      return {
        action: 'move',
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

  function missingFolderPaths(plan) {
    return core.missingFolderPaths(scan.folders.map(folder => folder.path.join('/')), plan);
  }

  async function renderPlan(plan) {
    const revision = ++previewRevision;
    planToken = null;
    applyButton.disabled = true;
    const checked = await background({
      command: 'plan.validate',
      plan: plan.map(item => item.action === 'move'
        ? { id: item.id, folderPath: item.folderPath.join('/') }
        : { id: item.id, action: item.action })
    });
    if (revision !== previewRevision) return;
    if (checked.preview.some((item, index) => {
      const sameIdentity = item.id === plan[index].id && item.title === plan[index].title && item.url === plan[index].url && item.fromPath === plan[index].fromPath.join('/');
      if (plan[index].action !== 'move') return !sameIdentity || item.action !== plan[index].action;
      return !sameIdentity || item.folderPath !== plan[index].folderPath.join('/');
    })) throw new Error('扫描后条目已改变，请重新扫描并预览。');
    planToken = checked.planToken;
    validatedPlan = plan;
    planPreview.replaceChildren();
    const missing = missingFolderPaths(plan);
    const moves = plan.filter(item => item.action === 'move').length;
    const recycled = plan.filter(item => item.action === 'delete').length;
    const purged = plan.filter(item => item.action === 'purge').length;
    const parts = [];
    if (moves) parts.push(`移动 ${moves} 条收藏`);
    if (recycled) parts.push(`${recycled} 条移入回收站`);
    if (purged) parts.push(`永久删除 ${purged} 条`);
    planSummary.className = 'plan-summary';
    planSummary.textContent = `将${parts.join('，')}${missing.length ? `，并创建 ${missing.length} 个目标文件夹` : moves ? '，不需要创建新文件夹' : ''}。`;
    for (const item of plan) {
      const row = createElement('article', 'plan-item');
      const from = createElement('div', 'path-box');
      from.append(createElement('small', '', item.title || item.url));
      from.append(document.createTextNode(item.fromPath.join(' / ')));
      const to = createElement('div', 'path-box');
      const destination = item.action === 'delete'
        ? `${scan.bookmarkBar?.title || '收藏夹栏'} / 回收站`
        : item.action === 'purge'
          ? '永久删除'
          : item.folderPath.join(' / ');
      to.append(createElement('small', '', item.action === 'move' ? '移动到' : item.action === 'delete' ? '软删除到' : '删除'));
      to.append(document.createTextNode(destination));
      row.append(from, createElement('div', 'arrow', '→'), to);
      planPreview.append(row);
    }
    applyButton.disabled = false;
    clearPlanButton.disabled = false;
    setMessage(result, '方案已通过本地校验。请检查上方逐条预览。', 'success');
  }

  function clearPlan(message = '') {
    previewRevision += 1;
    planToken = null;
    validatedPlan = null;
    planPreview.replaceChildren();
    planSummary.className = 'plan-summary empty';
    planSummary.textContent = '尚未生成或导入整理方案。';
    applyButton.disabled = true;
    clearPlanButton.disabled = true;
    if (message) setMessage(result, message);
  }

  async function renderHistory() {
    historyList.replaceChildren(createElement('p', 'empty', '正在读取操作记录…'));
    const operations = await operationStore.load();
    historyList.replaceChildren();
    if (!operations.length) {
      historyList.append(createElement('p', 'empty', '尚无插件执行的整理记录。'));
      return;
    }
    const latestActiveId = operations.find(operation => !operation.undoneAt)?.id;
    for (const operation of operations) {
      const row = createElement('article', `history-item${operation.undoneAt ? ' undone' : ''}`);
      const content = createElement('div');
      content.append(createElement('p', 'item-title', `${core.formatDate(operation.createdAt)} · 已处理 ${operation.moves.filter(item => item.state !== 'pending').length} 条，待核对 ${operation.moves.filter(item => item.state === 'pending').length} 条`));
      const state = operation.undoneAt ? `已于 ${core.formatDate(operation.undoneAt)} 撤销` : operation.undoStatus === 'partial' ? '撤销有冲突，请查看操作详情' : operation.status === 'complete' ? '已完成' : '未完成，需核对逐项记录';
      content.append(createElement('p', 'item-meta', state));
      for (const conflict of operation.undoConflicts || []) content.append(createElement('p', 'item-meta', `条目 ${conflict.id}：${conflict.error}`));
      content.append(createElement('p', 'item-meta', `整理前备份：${operation.archivePath}`));
      row.append(content);
      if (!operation.undoneAt && operation.moves.length && operation.id === latestActiveId) {
        const undo = createElement('button', '', '撤销本次整理');
        undo.addEventListener('click', () => undoOperation(operation.id, undo));
        row.append(undo);
      } else if (!operation.undoneAt && operation.moves.length) {
        row.append(createElement('span', 'item-meta', '请先撤销较新的整理'));
      }
      historyList.append(row);
    }
  }

  async function undoOperation(id, button) {
    button.disabled = true;
    setMessage(result, '正在备份当前状态并撤销…');
    try {
      const response = await background({ command: 'operations.undo', operationId: id, confirmed: true });
      const { restoredCount: restored, skippedCount: skipped, backup: undoArchive } = response;
      const skippedNote = skipped ? `；${skipped} 条书签已被删除，无法放回` : '';
      setMessage(result, `撤销完成：${restored} 条书签已移回原目录${skippedNote}。撤销前备份：${undoArchive.filename}`, 'success');
      await Promise.all([renderHistory(), refreshOverview()]);
    } catch (error) {
      setMessage(result, `撤销中断：${error.message}。请核对操作记录后再决定下一步。`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function runBackup() {
    try {
      backupButton.disabled = true;
      setMessage(backupStatus, '正在备份当前全部收藏夹…');
      const response = await background({ command: 'backup' });
      const archive = { ...response, ...response.stats };
      const cleanup = { removed: Array(response.removedOldArchives).fill(''), warnings: response.warnings };
      setMessage(backupStatus, `备份完成：${archive.bookmarks} 条书签、${archive.folders} 个文件夹。\n${archive.filename}\n本次没有修改收藏夹。${core.archiveCleanupMessage(cleanup)}`, 'success');
      await refreshArchives();
    } catch (error) {
      setMessage(backupStatus, `备份失败：${error.message}\n本次没有修改收藏夹。`, 'error');
    } finally {
      backupButton.disabled = false;
    }
  }

  backupButton.addEventListener('click', runBackup);

  function purgeUsesRange() {
    return Boolean(archiveFrom.value || archiveUntil.value);
  }

  function updatePurgeLabel() {
    if (purgeUsesRange()) {
      purgeArchivesButton.textContent = '清空该时段的备份';
      return;
    }
    const days = archiveOlderDays.value === '' ? 7 : archiveOlderDays.value;
    purgeArchivesButton.textContent = `清空 ${days} 天前的备份`;
  }

  async function purgeArchives() {
    purgeArchivesButton.disabled = true;
    try {
      const archives = await core.searchManagedArchives();
      const selected = core.archivesInScope(archives, purgeUsesRange()
        ? { from: archiveFrom.value, until: archiveUntil.value }
        : { olderThanDays: archiveOlderDays.value === '' ? 7 : Number(archiveOlderDays.value) });
      if (!selected.length) {
        setMessage(backupStatus, '没有符合条件的备份。收藏夹没有改变。');
        return;
      }
      const cleanup = await core.removeManagedArchives(selected);
      const failed = cleanup.warnings.length ? ` ${cleanup.warnings.length} 份未能删除。` : '';
      setMessage(backupStatus, `已清空 ${cleanup.removed.length} 份备份。${failed}收藏夹没有改变。`, cleanup.warnings.length ? 'error' : 'success');
      restoreGuide.hidden = true;
      await refreshArchives();
    } catch (error) {
      setMessage(backupStatus, `清空备份失败：${error.message}`, 'error');
    } finally {
      purgeArchivesButton.disabled = false;
    }
  }

  archiveOlderDays.addEventListener('input', updatePurgeLabel);
  archiveFrom.addEventListener('input', updatePurgeLabel);
  archiveUntil.addEventListener('input', updatePurgeLabel);
  purgeArchivesButton.addEventListener('click', purgeArchives);
  updatePurgeLabel();

  refreshArchivesButton.addEventListener('click', refreshArchives);

  scanButton.addEventListener('click', async () => {
    try {
      scanButton.disabled = true;
      setMessage(scanStatus, '正在扫描…');
      scan = await scanBookmarks();
      renderScan(scan);
      clearPlan();
      setMessage(result, '');
    } catch (error) {
      setMessage(scanStatus, error.message, 'error');
    } finally {
      scanButton.disabled = false;
    }
  });

  copyAgentButton.addEventListener('click', async () => {
    if (!scan) return;
    const payload = {
      task: `请使用 bookmark-organizer 技能理解下列网页内容，并为每条临时收藏选择合适目录。优先复用现有目录；如需新建目录应保持稳定清晰。不要删除书签。只返回 JSON 数组，每项为 {"id":"…","folderPath":"${scan.bookmarkBar?.title || 'bookmarks_bar'}/…"}。`,
      existingFolders: scan.folders.filter(folder => folder.path[0] === scan.bookmarkBar?.title).map(folder => folder.path.join('/')),
      temporaryBookmarks: duplicateRows(scan).map(item => ({
        id: item.id,
        title: item.title,
        url: item.url,
        currentPath: item.path.join('/'),
        duplicatePaths: item.duplicatePaths
      }))
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setMessage(scanStatus, '整理任务已复制。粘贴给 Agent；完成后把它的整段回复粘贴到“使用 Agent 自动分类”。', 'success');
  });

  buildManualPlanButton.addEventListener('click', async () => {
    try {
      const selectedIds = [...temporaryList.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.dataset.bookmarkId);
      if (!selectedIds.length) throw new Error('请先选择至少一条临时收藏。');
      const target = manualTarget.value.trim();
      if (!target) throw new Error('请输入或选择目标目录。');
      const rawPlan = selectedIds.map(id => ({ id, folderPath: target }));
      planInput.value = JSON.stringify(rawPlan, null, 2);
      await renderPlan(validatePlan(rawPlan));
      const panel = document.querySelector('#plan-panel');
      globalThis.scrollTo?.({ top: Math.max(0, panel.offsetTop - 16), behavior: 'smooth' });
    } catch (error) {
      setMessage(scanStatus, error.message, 'error');
    }
  });

  validatePlanButton.addEventListener('click', async () => {
    try {
      await renderPlan(validatePlan());
    } catch (error) {
      clearPlan();
      setMessage(result, `方案未通过：${error.message}`, 'error');
    }
  });

  planInput.addEventListener('input', () => {
    clearPlan('方案内容已改变，请重新校验。');
  });

  clearPlanButton.addEventListener('click', () => {
    planInput.value = '';
    clearPlan('整理方案已清除。');
  });

  applyButton.addEventListener('click', async () => {
    if (!validatedPlan) return;
    try {
      applyButton.disabled = true;
      backupButton.disabled = true;
      setMessage(result, '正在校验、备份并执行移动…');
      const response = await background({ command: 'plan.apply', planToken, confirmed: true });
      clearPlan();
      setMessage(result, `整理完成：已移动并核验 ${response.movedCount} 条收藏。\n整理前备份：${response.backup.filename}`, 'success');
      scan = await scanBookmarks();
      renderScan(scan);
      await Promise.all([refreshOverview(), refreshArchives(), renderHistory()]);
    } catch (error) {
      clearPlan();
      setMessage(result, `执行中断：${error.message}。请查看操作记录，不要直接重复执行。`, 'error');
      await renderHistory();
    } finally {
      backupButton.disabled = false;
      applyButton.disabled = !validatedPlan;
    }
  });

  refreshHistoryButton.addEventListener('click', renderHistory);

  clearHistoryButton.addEventListener('click', async () => {
    const operations = await operationStore.load();
    if (!operations.length) {
      setMessage(result, '当前没有可清除的操作记录。');
      return;
    }
    await background({ command: 'operations.clear' });
    await renderHistory();
    setMessage(result, '操作记录已清空；收藏夹和备份文件没有改变。', 'success');
  });

  async function initializeManager() {
    if (versionBadge) {
      try {
        versionBadge.textContent = chrome.runtime.getManifest().version;
      } catch { /* 读取不到时保留占位符 */ }
    }
    await Promise.allSettled([refreshOverview(), refreshArchives(), renderHistory()]);
  }

  initializeManager();
})();
