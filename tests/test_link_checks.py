import io
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from test_audit_bookmarks import audit_bookmarks as audit


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_HEAD(self):
        self.send_error(403)

    def do_GET(self):
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', '/login')
            self.end_headers()
            return
        if self.path.startswith('/status/'):
            self.send_error(int(self.path.rsplit('/', 1)[1]))
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/pdf' if self.path == '/pdf' else 'text/html; charset=gb18030')
        self.end_headers()
        title = 'Sign in' if self.path == '/login' else '中文标题'
        self.wfile.write((f'<title>{title}</title>' if self.path != '/missing' else '<p>empty</p>').encode('gb18030'))


class LinkChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_head_rejection_does_not_prevent_title(self):
        result = audit.check_one(self.base + '/', 2, retries=0)
        self.assertEqual(result['status'], 'available')
        self.assertEqual(result['page_title'], '中文标题')

    def test_login_redirect_is_unverified(self):
        result = audit.check_one(self.base + '/redirect', 2, retries=0)
        self.assertEqual(result['status'], 'unverified')
        self.assertEqual(result['reason'], 'possible_login_or_challenge')

    def test_non_html_and_missing_title(self):
        self.assertEqual(audit.check_one(self.base + '/pdf', 2)['title_status'], 'not_html')
        self.assertEqual(audit.check_one(self.base + '/missing', 2)['title_status'], 'missing')

    def test_error_semantics(self):
        for code in (400, 401, 403, 418, 429, 500):
            with self.subTest(code=code):
                self.assertEqual(audit.check_one(self.base + f'/status/{code}', 2, retries=0)['status'], 'unverified')
        for code in (404, 410):
            self.assertEqual(audit.check_one(self.base + f'/status/{code}', 2, retries=0)['status'], 'unavailable')

    def test_missing_title_not_a_content_change(self):
        with tempfile.TemporaryDirectory() as temp:
            baseline = Path(temp) / 'baseline.json'
            prior = {'status': 'available', 'final_url': self.base, 'page_title': 'before'}
            baseline.write_text(json.dumps({'link_results': {self.base: prior}}), encoding='utf-8')
            item = {'url': self.base, 'title': 'Bookmark', 'normalized_url': self.base, 'link': {**prior, 'page_title': None}}
            self.assertEqual(audit.compare_baseline([item], baseline), [])
            self.assertFalse(item['title_comparable'])
            item['link']['page_title'] = 'after'
            self.assertEqual(audit.compare_baseline([item], baseline)[0]['changed_fields'], ['page_title'])

    def test_expected_input_failure_has_no_traceback(self):
        with tempfile.TemporaryDirectory() as temp:
            err = io.StringIO()
            with patch.object(sys, 'argv', ['audit', '--input', str(Path(temp) / 'missing'), '--output-dir', temp]), patch.object(sys, 'stderr', err):
                self.assertEqual(audit.main(), 1)
            self.assertFalse(json.loads(err.getvalue())['ok'])
            self.assertNotIn('Traceback', err.getvalue())
