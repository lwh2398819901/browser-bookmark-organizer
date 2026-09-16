import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path


SCRIPT = (
    Path(__file__).parents[1]
    / ".agents"
    / "skills"
    / "bookmark-organizer"
    / "scripts"
    / "bookmarkctl.py"
)
SPEC = importlib.util.spec_from_file_location("bookmarkctl", SCRIPT)
bookmarkctl = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(bookmarkctl)


class BridgePageTests(unittest.TestCase):
    def test_write_json_result_is_utf8_without_bom(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "result.json"
            bookmarkctl.write_json_result({"folderPath": "收藏夹栏/开发"}, path, pretty=True)
            data = path.read_bytes()
            self.assertFalse(data.startswith(b"\xef\xbb\xbf"))
            self.assertEqual(json.loads(data.decode("utf-8"))["folderPath"], "收藏夹栏/开发")

    def test_read_plan_accepts_utf8_with_or_without_bom(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "plan.json"
            path.write_text('\ufeff[{"id":"1","folderPath":"收藏夹栏/开发"}]', encoding="utf-8")
            self.assertEqual(bookmarkctl.read_plan(str(path)), [{"id": "1", "folderPath": "收藏夹栏/开发"}])

    def test_javascript_literal_escapes_html_and_line_separators(self):
        hostile = '</script><img src=x onerror=1>\u2028\u2029&'
        literal = bookmarkctl.javascript_literal(hostile)
        for character in ("<", ">", "&"):
            self.assertNotIn(character, literal)
        self.assertEqual(json.loads(literal), hostile)

    def test_bridge_page_keeps_a_hostile_plan_inside_the_script_block(self):
        hostile = '</script><script>chrome.runtime.sendMessage("hijack")</script>'
        request = {"command": "plan.validate", "plan": [{"id": "1", "folderPath": f"收藏夹栏/{hostile}"}]}

        page = bookmarkctl.bridge_html("extension-id", "token-value", request, "nonce-value")
        text = page.decode("utf-8")

        self.assertEqual(text.count("</script>"), 1, "脚本块被提前闭合，令牌页面可被注入")
        literal = next(line for line in text.splitlines() if line.startswith("const message = "))
        payload = json.loads(literal[len("const message = ") :].rstrip(";"))
        self.assertEqual(payload["token"], "token-value")
        self.assertEqual(payload["request"], request)


class BridgeHandlerTests(unittest.TestCase):
    def setUp(self):
        self.state = {"response": None}
        self.completed = threading.Event()
        self.page = b"<html>bridge</html>"
        handler = bookmarkctl.bridge_handler(self.page, "test-nonce", self.state, self.completed)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, body=None):
        target = self.base + path
        try:
            if body is None:
                with urllib.request.urlopen(target, timeout=5) as response:
                    return response.status, response.read()
            with urllib.request.urlopen(urllib.request.Request(target, data=body, method="POST"), timeout=5) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def test_bridge_page_only_answers_its_own_nonce_path(self):
        status, body = self.request("/bridge/test-nonce")
        self.assertEqual(status, 200)
        self.assertEqual(body, self.page)
        self.assertEqual(self.request("/bridge/other-nonce")[0], 404)

    def test_valid_response_is_forwarded_and_wakes_the_waiter(self):
        payload = json.dumps({"ok": True, "result": {"temporaryCount": 2}}).encode("utf-8")

        status, body = self.request("/result/test-nonce", payload)

        self.assertEqual(status, 200)
        self.assertEqual(body, b"ok")
        self.assertTrue(self.completed.is_set())
        self.assertEqual(self.state["response"]["result"], {"temporaryCount": 2})

    def test_unparsable_response_fails_fast_instead_of_timing_out(self):
        status, _ = self.request("/result/test-nonce", b"not-json")

        self.assertEqual(status, 400)
        self.assertTrue(self.completed.is_set(), "校验失败必须唤醒等待者，否则命令会空等满超时")
        self.assertFalse(self.state["response"]["ok"])
        self.assertIn("无法解析", self.state["response"]["error"])

    def test_oversized_response_fails_fast(self):
        original = bookmarkctl.MAX_RESPONSE_BYTES
        bookmarkctl.MAX_RESPONSE_BYTES = 4
        try:
            status, _ = self.request("/result/test-nonce", b"12345")
        finally:
            bookmarkctl.MAX_RESPONSE_BYTES = original

        self.assertEqual(status, 400)
        self.assertTrue(self.completed.is_set())
        self.assertFalse(self.state["response"]["ok"])

    def test_result_endpoint_only_answers_its_own_nonce_path(self):
        self.assertEqual(self.request("/result/other-nonce", b"{}")[0], 404)
        self.assertFalse(self.completed.is_set())


if __name__ == "__main__":
    unittest.main()
