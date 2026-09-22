import importlib.util
import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


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
    def test_success_survives_output_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            args = ['bookmarkctl', '--output', str(Path(temp) / 'missing' / 'out.json'), 'backup']
            out, err = io.StringIO(), io.StringIO()
            with patch.object(sys, 'argv', args), patch.object(bookmarkctl, 'configure_stdio'), patch.object(bookmarkctl, 'load_config', return_value={}), patch.object(bookmarkctl, 'invoke_bridge', return_value={'operationId': 'done'}), patch.object(sys, 'stdout', out), patch.object(sys, 'stderr', err):
                self.assertEqual(bookmarkctl.main(), 1)
            result = json.loads(out.getvalue())
            self.assertTrue(result['ok'])
            self.assertEqual(result['operationId'], 'done')
            self.assertEqual(result['outputError']['code'], 'OUTPUT_WRITE_FAILED')

    def test_bridge_error_details_preserved(self):
        out = io.StringIO()
        with patch.object(sys, 'argv', ['bookmarkctl', 'backup']), patch.object(bookmarkctl, 'configure_stdio'), patch.object(bookmarkctl, 'load_config', return_value={}), patch.object(bookmarkctl, 'invoke_bridge', side_effect=bookmarkctl.BridgeError('超时', 'ARCHIVE_TIMEOUT', {'download': {'id': 7}})), patch.object(sys, 'stderr', out):
            self.assertEqual(bookmarkctl.main(), 1)
        result = json.loads(out.getvalue())
        self.assertEqual(result['code'], 'ARCHIVE_TIMEOUT')
        self.assertEqual(result['details']['download']['id'], 7)

    def test_build_request_preserves_scan_scope(self):
        self.assertEqual(
            bookmarkctl.build_request(SimpleNamespace(command="scan", scope="all")),
            {"command": "scan", "scope": "all"},
        )

    def test_build_request_preserves_validation_scope(self):
        with patch.object(bookmarkctl, "read_plan", return_value=[{"id": "1", "folderPath": "收藏夹栏/开发"}]):
            self.assertEqual(
                bookmarkctl.build_request(SimpleNamespace(command="validate-plan", scope="all", file="plan.json")),
                {"command": "plan.validate", "scope": "all", "plan": [{"id": "1", "folderPath": "收藏夹栏/开发"}]},
            )

    def test_parse_args_accepts_output_after_subcommand(self):
        with patch.object(sys, "argv", ["bookmarkctl.py", "scan", "--scope", "all", "--output", "out.json", "--pretty"]):
            ns = bookmarkctl.parse_args()
        self.assertEqual(ns.scope, "all")
        self.assertEqual(str(ns.output), "out.json")
        self.assertTrue(ns.pretty)

    def test_parse_args_keeps_global_flags_before_subcommand(self):
        with patch.object(sys, "argv", ["bookmarkctl.py", "--pretty", "scan", "--scope", "all"]):
            ns = bookmarkctl.parse_args()
        self.assertTrue(ns.pretty)
        self.assertIsNone(ns.output)
        self.assertEqual(ns.scope, "all")

    def test_read_plan_rejects_interactive_stdin_without_file(self):
        with patch.object(sys.stdin, "isatty", return_value=True):
            with self.assertRaises(RuntimeError):
                bookmarkctl.read_plan("-")

    def test_write_json_result_is_utf8_without_bom(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "result.json"
            bookmarkctl.write_json_result({"folderPath": "收藏夹栏/开发"}, path, pretty=True)
            data = path.read_bytes()
            self.assertFalse(data.startswith(b"\xef\xbb\xbf"))
            self.assertNotIn(b"\r\n", data)
            self.assertEqual(json.loads(data.decode("utf-8"))["folderPath"], "收藏夹栏/开发")

    def test_read_plan_accepts_utf8_without_bom(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "plan.json"
            path.write_text('[{"id":"1","folderPath":"收藏夹栏/开发"}]', encoding="utf-8")
            self.assertEqual(bookmarkctl.read_plan(str(path)), [{"id": "1", "folderPath": "收藏夹栏/开发"}])

    def test_read_plan_accepts_utf8_with_bom(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "plan.json"
            path.write_text('\ufeff[{"id":"1","folderPath":"收藏夹栏/开发"}]', encoding="utf-8")
            self.assertEqual(bookmarkctl.read_plan(str(path)), [{"id": "1", "folderPath": "收藏夹栏/开发"}])

    def test_read_plan_strips_bom_from_stdin(self):
        payload = '\ufeff[{"id":"1","folderPath":"\u6536\u85cf\u5939\u680f/\u5f00\u53d1"}]'
        with patch.object(bookmarkctl.sys, "stdin", io.StringIO(payload)):
            self.assertEqual(
                bookmarkctl.read_plan("-"),
                [{"id": "1", "folderPath": "收藏夹栏/开发"}],
            )

    def test_read_plan_rejects_non_utf8_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "plan.json"
            text = '[{"id":"1","folderPath":"\u6536\u85cf\u5939\u680f"}]'
            path.write_bytes(text.encode("gbk"))
            with self.assertRaises(RuntimeError) as raised:
                bookmarkctl.read_plan(str(path))
            self.assertIn("不是 UTF-8 文本", str(raised.exception))

    def test_read_plan_expands_user_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "plan.json"
            path.write_text('[{"id":"1","folderPath":"收藏夹栏/开发"}]', encoding="utf-8")
            with patch.object(bookmarkctl.Path, "expanduser", return_value=path):
                self.assertEqual(
                    bookmarkctl.read_plan("~/plan.json"),
                    [{"id": "1", "folderPath": "收藏夹栏/开发"}],
                )

    def test_main_writes_error_json_to_output_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "status.json"
            config = Path(temporary) / "missing.json"
            original_argv = sys.argv
            try:
                sys.argv = [
                    "bookmarkctl.py",
                    "--config",
                    str(config),
                    "--pretty",
                    "--output",
                    str(output),
                    "status",
                ]
                self.assertEqual(bookmarkctl.main(), 1)
            finally:
                sys.argv = original_argv
            data = output.read_bytes()
            self.assertFalse(data.startswith(b"\xef\xbb\xbf"))
            self.assertNotIn(b"\r\n", data)
            payload = json.loads(data.decode("utf-8"))
            self.assertFalse(payload["ok"])
            self.assertIn("尚未安装", payload["error"])

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
