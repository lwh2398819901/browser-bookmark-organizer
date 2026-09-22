"""Opt-in real Chromium smoke test. Uses only a fresh temporary browser profile.

Requires playwright and its Chromium: python -m playwright install chromium
Run: python tests/browser_smoke.py --output-dir <outside-repository-directory>
The profile and synthetic archives are retained there for diagnosis.
"""
import argparse
import json
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='browser-smoke-', dir=args.output_dir))
    extension = Path(__file__).resolve().parents[1] / 'extension' / 'edge-bookmark-organizer'
    report = {'profile': str(root), 'checks': []}
    try:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                str(root / 'profile'), channel='chromium', headless=True,
                downloads_path=str(root / 'downloads'), accept_downloads=True,
                args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'],
            )
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                extension_id = worker.url.split('/')[2]
                page = context.new_page()
                page.goto(f'chrome-extension://{extension_id}/manager.html')
                data = worker.evaluate("""async () => {
                  const bar = BookmarkOrganizerCore.findBookmarkBar(await chrome.bookmarks.getTree());
                  const inbox = await chrome.bookmarks.create({parentId: bar.id, title: '临时收藏'});
                  const target = await chrome.bookmarks.create({parentId: bar.id, title: 'Smoke target'});
                  const first = await chrome.bookmarks.create({parentId: inbox.id, title: 'Smoke A', url: 'https://example.test/a'});
                  const second = await chrome.bookmarks.create({parentId: inbox.id, title: 'Smoke B', url: 'https://example.test/b'});
                  return {bar: bar.title, inbox: inbox.id, target: target.id, ids: [first.id, second.id]};
                }""")

                def send(request):
                    response = page.evaluate("request => chrome.runtime.sendMessage({channel: 'bookmark-organizer-manager', request})", request)
                    if not response.get('ok'):
                        raise AssertionError(json.dumps(response, ensure_ascii=False))
                    return response['result']

                before = worker.evaluate('() => chrome.bookmarks.getTree()')
                plan = [{'id': bookmark_id, 'folderPath': data['bar'] + '/Smoke target'} for bookmark_id in data['ids']]
                validation = send({'command': 'plan.validate', 'plan': plan})
                applied = send({'command': 'plan.apply', 'planToken': validation['planToken'], 'confirmed': True, 'archiveTimeoutMs': 10000})
                assert applied['movedCount'] == 2 and applied['verified']
                report['checks'].append('real archive and apply: PASS')
                archive = Path(applied['backup']['filename'])
                assert archive.exists(), f'archive missing: {archive}'
                content = archive.read_text(encoding='utf-8')
                assert 'NETSCAPE-Bookmark-file-1' in content and content.count('<DT><A ') == 2
                report['checks'].append('archive content: PASS')
                undone = send({'command': 'operations.undo', 'operationId': applied['operationId'], 'confirmed': True, 'archiveTimeoutMs': 10000})
                assert undone['restoredCount'] == 2 and undone['skippedCount'] == 0
                after = worker.evaluate('() => chrome.bookmarks.getTree()')

                def structure(nodes):
                    return [{key: structure(value) if key == 'children' else value for key, value in node.items() if key in {'id', 'parentId', 'index', 'title', 'url', 'children'}} for node in nodes]

                assert structure(before) == structure(after)
                report['checks'].append('undo restores hierarchy and order: PASS')
                report['version'] = send({'command': 'status'})['extensionVersion']
                report['ok'] = True
            finally:
                context.close()
    except Exception as error:
        report.update(ok=False, error=str(error))
    result = root / 'result.json'
    result.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    print(f'Report: {result}')
    return 0 if report.get('ok') else 1


if __name__ == '__main__':
    raise SystemExit(main())
