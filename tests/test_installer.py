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
    def write_valid_extension(self, directory: Path, version: str = "1.0.2") -> None:
        directory.mkdir(parents=True, exist_ok=True)
        manifest = {
            "name": installer.EXPECTED_NAME,
            "manifest_version": 3,
            "version": version,
            "permissions": sorted(installer.REQUIRED_PERMISSIONS),
        }
        (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    def test_repository_manifest_is_valid(self):
        extension = INSTALLER_PATH.parents[1] / "extension" / "edge-bookmark-organizer"
        manifest = installer.validate_manifest(extension)
        self.assertEqual(manifest["version"], "1.0.2")

    def test_version_parsing_is_strict(self):
        self.assertGreaterEqual(installer.version_tuple("1.0.2"), installer.MINIMUM_VERSION)
        self.assertLess(installer.version_tuple("1.0.0"), installer.MINIMUM_VERSION)
        self.assertEqual(installer.version_tuple("not-a-version"), ())

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
