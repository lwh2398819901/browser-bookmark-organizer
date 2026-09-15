import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError


SCRIPT = Path(__file__).parents[1] / ".agents" / "skills" / "bookmark-organizer" / "scripts" / "audit_bookmarks.py"
SPEC = importlib.util.spec_from_file_location("audit_bookmarks", SCRIPT)
audit_bookmarks = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(audit_bookmarks)


class AuditBookmarksTests(unittest.TestCase):
    def test_normalized_query_preserves_valueless_parameters(self):
        flag = audit_bookmarks.normalized_url("https://EXAMPLE.test/page?b=1&a")
        empty = audit_bookmarks.normalized_url("https://example.test/page?b=1&a=")
        self.assertEqual(flag, "https://example.test/page?a&b=1")
        self.assertEqual(empty, "https://example.test/page?a=&b=1")
        self.assertNotEqual(flag, empty)

    def test_temporary_server_errors_are_unverified(self):
        for code in (500, 502, 503, 504):
            self.assertEqual(audit_bookmarks.http_result_status(code), "unverified")
        self.assertEqual(audit_bookmarks.http_result_status(404), "unavailable")

    def test_classification_tie_is_explicit(self):
        item = {"title": "guide repo", "url": "https://example.test", "path": []}
        self.assertEqual(
            audit_bookmarks.classify_item(item, audit_bookmarks.CONTENT_TYPE_RULES, "其他页面"),
            "混合／待判断",
        )

    def test_html_parser_counts_empty_folders(self):
        source = """<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
        <DT><H3>Bar</H3><DL><p>
        <DT><H3>Empty</H3><DL><p></DL><p>
        <DT><H3>Filled</H3><DL><p><DT><A HREF="https://example.test/">Example</A></DL><p>
        </DL><p></DL><p>"""
        parser = audit_bookmarks.NetscapeBookmarks()
        parser.feed(source)
        self.assertEqual(len(parser.items), 1)
        self.assertEqual(parser.folders, {("Bar",), ("Bar", "Empty"), ("Bar", "Filled")})

    def test_chromium_parser_counts_folder_only_trees(self):
        payload = {"roots": {"bookmark_bar": {"type": "folder", "children": [
            {"type": "folder", "name": "Empty", "children": []},
            {"type": "folder", "name": "Parent", "children": [
                {"type": "folder", "name": "Child", "children": []}
            ]},
        ]}}}
        items, folders = audit_bookmarks.chromium_items(payload)
        self.assertFalse(items)
        self.assertEqual(len(folders), 4)

    def test_baseline_implicitly_checks_current_links(self):
        source_text = """<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
        <DT><H3>Bar</H3><DL><p><DT><A HREF="https://example.test/">Example</A></DL><p>
        </DL><p>"""
        with tempfile.TemporaryDirectory(prefix="bookmark-audit-test-") as temp:
            root = Path(temp)
            source = root / "bookmarks.html"
            baseline = root / "baseline.json"
            output = root / "output"
            source.write_text(source_text, encoding="utf-8")
            baseline.write_text(json.dumps({"link_results": {
                "https://example.test/": {
                    "status": "unavailable", "http_status": 404,
                    "final_url": "https://example.test/", "page_title": None,
                }
            }}), encoding="utf-8")

            original_check = audit_bookmarks.check_one
            original_argv = sys.argv
            audit_bookmarks.check_one = lambda *_args, **_kwargs: {
                "status": "available", "http_status": 200,
                "final_url": "https://example.test/", "page_title": None,
            }
            try:
                sys.argv = [
                    "audit_bookmarks.py", "--input", str(source),
                    "--output-dir", str(output), "--baseline", str(baseline),
                ]
                self.assertEqual(audit_bookmarks.main(), 0)
            finally:
                audit_bookmarks.check_one = original_check
                sys.argv = original_argv

            report = json.loads((output / "audit.json").read_text(encoding="utf-8"))
            self.assertEqual(len(report["changes"]), 1)
            self.assertFalse(report["execution"]["runtime_ids_available"])
            self.assertIsNone(report["bookmarks"][0]["id"])

    def test_transient_error_retries(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def geturl(self):
                return "https://example.test/"

        calls = []

        def fake_urlopen(request, timeout):
            calls.append((request.method, timeout))
            if len(calls) < 3:
                raise HTTPError(request.full_url, 503, "temporary", {"Retry-After": "0"}, None)
            return Response()

        original_urlopen = audit_bookmarks.urlopen
        original_sleep = audit_bookmarks.time.sleep
        audit_bookmarks.urlopen = fake_urlopen
        audit_bookmarks.time.sleep = lambda _seconds: None
        try:
            result = audit_bookmarks.check_one("https://example.test/", 1.0, retries=2)
        finally:
            audit_bookmarks.urlopen = original_urlopen
            audit_bookmarks.time.sleep = original_sleep
        self.assertEqual(result["status"], "available")
        self.assertEqual(len(calls), 3)


if __name__ == "__main__":
    unittest.main()
