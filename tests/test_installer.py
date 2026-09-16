import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


INSTALLER_PATH = Path(__file__).resolve().parents[1] / "installer" / "install.py"
SPEC = importlib.util.spec_from_file_location("bookmark_installer", INSTALLER_PATH)
installer = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def write_valid_extension(self, directory: Path, version: str = "2.0.1") -> None:
        directory.mkdir(parents=True, exist_ok=True)
        manifest = {
            "name": installer.EXPECTED_NAME,
            "manifest_version": 3,
            "version": version,
            "permissions": sorted(installer.REQUIRED_PERMISSIONS),
            "key": "YWJj",
            "background": {"service_worker": "bridge.js"},
            "externally_connectable": {"matches": ["http://127.0.0.1/*", "http://localhost/*"]},
        }
        (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (directory / "bridge.js").write_text("", encoding="utf-8")
        (directory / "bridge-config.js").write_text("", encoding="utf-8")

    def test_repository_manifest_is_valid(self):
        extension = INSTALLER_PATH.parents[1] / "extension" / "edge-bookmark-organizer"
        manifest = installer.validate_manifest(extension)
        self.assertEqual(manifest["version"], "2.0.2")

    def test_version_parsing_is_strict(self):
        self.assertGreaterEqual(installer.version_tuple("2.0.1"), installer.MINIMUM_VERSION)
        self.assertLess(installer.version_tuple("2.0.0"), installer.MINIMUM_VERSION)
        self.assertEqual(installer.version_tuple("not-a-version"), ())

    def test_extension_id_from_manifest_key_is_stable(self):
        self.assertEqual(installer.extension_id_from_key("YWJj"), "lkhibglpipabmpokebebeanofnkocccd")

    def test_extension_update_replaces_directory_and_removes_stale_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            target = root / "target"
            self.write_valid_extension(source)
            (source / "current.js").write_text("new", encoding="utf-8")
            self.write_valid_extension(target)
            (target / "current.js").write_text("old", encoding="utf-8")
            (target / "stale.js").write_text("stale", encoding="utf-8")

            message = installer.install_extension(source, target, update=True)

            self.assertIn("完全同步", message)
            self.assertEqual((target / "current.js").read_text(encoding="utf-8"), "new")
            self.assertFalse((target / "stale.js").exists())
            self.assertFalse(list(root.glob(".target.staging-*")))
            self.assertFalse(list(root.glob(".target.backup-*")))

    def test_extension_install_injects_local_bridge_token(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            target = root / "target"
            self.write_valid_extension(source)

            installer.install_extension(source, target, update=False, bridge_token="local-secret")

            bridge_config = (target / "bridge-config.js").read_text(encoding="utf-8")
            self.assertIn('"local-secret"', bridge_config)
            self.assertNotIn("local-secret", (source / "bridge-config.js").read_text(encoding="utf-8"))

    def test_missing_cli_config_recovers_token_from_deployed_extension(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            extension = root / "extension"
            extension.mkdir()
            deployed_token = "deployed-token-that-is-long-enough-1234567890"
            installer.write_extension_bridge_config(extension, deployed_token)
            missing_config = root / "home" / "bridge.json"

            with mock.patch.object(installer, "bridge_config_path", return_value=missing_config):
                config = installer.load_or_create_bridge_config({"key": "YWJj"}, "edge", extension)

            self.assertEqual(config["token"], deployed_token)

    def test_deployed_token_wins_when_cli_config_is_stale(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            extension = root / "extension"
            extension.mkdir()
            deployed_token = "deployed-token-that-is-long-enough-1234567890"
            installer.write_extension_bridge_config(extension, deployed_token)
            config_path = root / "home" / "bridge.json"
            config_path.parent.mkdir()
            config_path.write_text(json.dumps({"token": "stale-token-that-is-long-enough-123456789012"}), encoding="utf-8")

            with mock.patch.object(installer, "bridge_config_path", return_value=config_path):
                config = installer.load_or_create_bridge_config({"key": "YWJj"}, "edge", extension)

            self.assertEqual(config["token"], deployed_token)

    def test_extension_update_rejects_a_file_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            target = root / "target"
            self.write_valid_extension(source)
            target.write_text("not a directory", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "扩展目标不是目录"):
                installer.install_extension(source, target, update=True)

    def test_invalid_staging_copy_does_not_replace_existing_extension(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            target = root / "target"
            self.write_valid_extension(source, version="0.9.0")
            self.write_valid_extension(target)
            (target / "current.js").write_text("keep", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "扩展版本低于"):
                installer.install_extension(source, target, update=True)

            self.assertEqual((target / "current.js").read_text(encoding="utf-8"), "keep")
            self.assertFalse(list(root.glob(".target.staging-*")))
            self.assertFalse(list(root.glob(".target.backup-*")))

    def test_extension_update_rolls_back_when_staging_cannot_be_activated(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            target = root / "target"
            self.write_valid_extension(source)
            self.write_valid_extension(target)
            (source / "current.js").write_text("new", encoding="utf-8")
            (target / "current.js").write_text("old", encoding="utf-8")
            path_type = type(target)
            original_rename = path_type.rename

            def fail_staging_activation(path: Path, destination: Path):
                if path.name.startswith(".target.staging-"):
                    raise OSError("simulated activation failure")
                return original_rename(path, destination)

            with mock.patch.object(path_type, "rename", autospec=True, side_effect=fail_staging_activation):
                with self.assertRaisesRegex(RuntimeError, "已恢复原有版本"):
                    installer.install_extension(source, target, update=True)

            self.assertEqual((target / "current.js").read_text(encoding="utf-8"), "old")
            self.assertFalse(list(root.glob(".target.staging-*")))
            self.assertFalse(list(root.glob(".target.backup-*")))

    def test_directory_link_includes_windows_junction(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            with mock.patch.object(installer, "is_windows_junction", return_value=True):
                self.assertTrue(installer.is_directory_link(path))

    def test_junction_fallback_matches_only_mount_point_tag(self):
        path = Path("junction-under-test")
        with (
            mock.patch.object(installer.os, "name", "nt"),
            mock.patch.object(installer.os.path, "isjunction", return_value=False, create=True),
            mock.patch.object(
                installer.os,
                "lstat",
                return_value=mock.Mock(st_reparse_tag=installer.WINDOWS_JUNCTION_TAG),
            ),
        ):
            self.assertTrue(installer.is_windows_junction(path))

        with (
            mock.patch.object(installer.os, "name", "nt"),
            mock.patch.object(installer.os.path, "isjunction", return_value=False, create=True),
            mock.patch.object(installer.os, "lstat", return_value=mock.Mock(st_reparse_tag=0xDEADBEEF)),
        ):
            self.assertFalse(installer.is_windows_junction(path))


if __name__ == "__main__":
    unittest.main()
