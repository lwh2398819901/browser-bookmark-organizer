import importlib.util
import unittest
from pathlib import Path


INSTALLER_PATH = Path(__file__).resolve().parents[1] / "installer" / "install.py"
SPEC = importlib.util.spec_from_file_location("bookmark_installer", INSTALLER_PATH)
installer = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_repository_manifest_is_valid(self):
        extension = INSTALLER_PATH.parents[1] / "extension" / "edge-bookmark-organizer"
        manifest = installer.validate_manifest(extension)
        self.assertEqual(manifest["version"], "1.0.1")

    def test_version_parsing_is_strict(self):
        self.assertGreaterEqual(installer.version_tuple("1.0.1"), installer.MINIMUM_VERSION)
        self.assertLess(installer.version_tuple("1.0.0"), installer.MINIMUM_VERSION)
        self.assertEqual(installer.version_tuple("not-a-version"), ())


if __name__ == "__main__":
    unittest.main()
