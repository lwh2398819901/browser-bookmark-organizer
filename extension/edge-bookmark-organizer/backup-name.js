(function () {
  'use strict';

  const input = document.querySelector('#name');
  const fallback = new URLSearchParams(location.hash.slice(1)).get('name') || '';
  input.value = fallback;
  input.focus();
  input.select();

  chrome.windows.getCurrent(win => {
    if (!win?.id) return;
    const frame = Math.max(0, win.height - window.innerHeight);
    chrome.windows.update(win.id, {
      width: 420,
      height: Math.ceil(document.documentElement.offsetHeight + frame)
    });
  });

  function reply(cancelled) {
    const name = input.value.trim() || fallback;
    chrome.runtime.sendMessage({ type: 'bookmark-organizer-backup-name', cancelled, name });
  }

  document.querySelector('#ok').addEventListener('click', () => reply(false));
  document.querySelector('#cancel').addEventListener('click', () => reply(true));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') reply(false);
    if (event.key === 'Escape') reply(true);
  });
})();
