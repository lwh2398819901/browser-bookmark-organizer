#!/usr/bin/env python3
"""Cross-platform installer for the bookmark-organizer skill and extension source."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import tempfile
import uuid
from pathlib import Path


EXPECTED_NAME = "收藏夹整理助手（本地）"
MINIMUM_VERSION = (1, 0, 2)
REQUIRED_PERMISSIONS = {"bookmarks", "downloads", "activeTab", "storage"}
BROWSER_NAMES = {"edge": "Microsoft-Edge", "chrome": "Google-Chrome", "brave": "Brave"}
WINDOWS_JUNCTION_TAG = 0xA0000003


def version_tuple(value: str) -> tuple[int, ...]:
    try:
        return tuple(int(part) for part in value.split("."))
    except (TypeError, ValueError):
        return ()


def default_extension_root(browser: str) -> Path:
    browser_name = BROWSER_NAMES[browser]
    system = platform.system()
    if system == "Windows":
        if Path("D:/").exists():
            return Path(f"D:/{browser_name}/Local-Extensions")
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return Path(local_app_data) / "BrowserLocalExtensions" / browser_name
        return Path.home() / "AppData" / "Local" / "BrowserLocalExtensions" / browser_name
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / "BrowserBookmarkOrganizer" / browser_name
    return Path.home() / ".local" / "share" / "browser-bookmark-organizer" / browser_name


def validate_manifest(extension_dir: Path) -> dict:
    manifest_path = extension_dir / "manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"扩展清单不存在：{manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    permissions = set(manifest.get("permissions", []))
    missing = REQUIRED_PERMISSIONS - permissions
    if manifest.get("name") != EXPECTED_NAME:
        raise RuntimeError("扩展名称校验失败。")
    if manifest.get("manifest_version") != 3:
        raise RuntimeError("扩展不是 Manifest V3。")
    if version_tuple(manifest.get("version", "")) < MINIMUM_VERSION:
        raise RuntimeError("扩展版本低于 1.0.2。")
    if missing:
        raise RuntimeError(f"扩展缺少权限：{', '.join(sorted(missing))}")
    return manifest


def is_windows_junction(path: Path) -> bool:
    """识别 Windows 目录联接，不把其他重解析点误认为 junction。"""
    if os.name != "nt":
        return False

    native_check = getattr(os.path, "isjunction", None)
    if native_check is not None:
        try:
            if native_check(path):
                return True
        except OSError:
            pass

    try:
        return getattr(os.lstat(path), "st_reparse_tag", 0) == WINDOWS_JUNCTION_TAG
    except OSError:
        return False


def is_directory_link(path: Path) -> bool:
    return path.is_symlink() or is_windows_junction(path)


def path_entry_exists(path: Path) -> bool:
    """包含断开的符号链接和目录联接。"""
    return path.exists() or is_directory_link(path)


def remove_path_entry(path: Path) -> None:
    """删除路径项；若为目录链接，只删除链接本身，不触及链接目标。"""
    if path.is_symlink():
        path.unlink()
    elif is_windows_junction(path):
        path.rmdir()
    elif path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def install_skill(source: Path, target: Path, update: bool) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    if is_directory_link(target):
        if target.resolve() == source.resolve():
            return f"技能已通过目录链接安装：{target}"
        if not update:
            return f"技能位置已有指向其他目录的链接，未覆盖：{target}"
        remove_path_entry(target)
    elif target.exists():
        if not update:
            return f"技能位置已存在，未覆盖：{target}（需要更新时加 --update-skill）"
        if not target.is_dir():
            raise RuntimeError(f"技能目标不是目录：{target}")
        shutil.copytree(source, target, dirs_exist_ok=True)
        return f"已更新技能副本：{target}"

    try:
        target.symlink_to(source, target_is_directory=True)
        return f"已创建技能软链接：{target} -> {source}"
    except OSError:
        shutil.copytree(source, target)
        return f"无法创建软链接，已复制技能：{target}"


def install_extension(source: Path, target: Path, update: bool) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    target_exists = path_entry_exists(target)
    if target_exists and not target.is_dir():
        raise RuntimeError(f"扩展目标不是目录：{target}")
    if target_exists and not update:
        return f"扩展位置已存在，未覆盖：{target}（需要更新时加 --update-extension）"

    staging = Path(tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent))
    backup: Path | None = None
    try:
        shutil.copytree(source, staging, dirs_exist_ok=True)
        validate_manifest(staging)

        if target_exists:
            backup = target.with_name(f".{target.name}.backup-{uuid.uuid4().hex}")
            target.rename(backup)

        try:
            staging.rename(target)
        except OSError as install_error:
            if backup is not None and path_entry_exists(backup) and not path_entry_exists(target):
                try:
                    backup.rename(target)
                except OSError as rollback_error:
                    raise RuntimeError(
                        f"扩展更新失败，且旧版本自动恢复失败；旧版本仍位于：{backup}"
                    ) from rollback_error
            raise RuntimeError("扩展更新失败，已恢复原有版本。") from install_error

        if backup is not None:
            try:
                remove_path_entry(backup)
            except OSError:
                return f"已更新扩展源码：{target}；旧版本回滚副本未能自动清理：{backup}"
            return f"已更新扩展源码：{target}；目标目录已与仓库版本完全同步"
        return f"已安装扩展源码：{target}"
    finally:
        if path_entry_exists(staging):
            remove_path_entry(staging)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="安装收藏夹整理技能与本地 Chromium 扩展")
    parser.add_argument("--browser", choices=sorted(BROWSER_NAMES), default="edge")
    parser.add_argument("--extension-root", type=Path, help="扩展父目录；默认按操作系统选择稳定位置")
    parser.add_argument("--update-extension", action="store_true", help="更新已存在的扩展源码")
    parser.add_argument("--update-skill", action="store_true", help="更新复制安装的技能；软链接安装无需此参数")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parent.parent
    skill_source = repo_root / ".agents" / "skills" / "bookmark-organizer"
    extension_source = repo_root / "extension" / "edge-bookmark-organizer"
    if not (skill_source / "SKILL.md").is_file():
        raise RuntimeError(f"技能源码不存在：{skill_source}")
    validate_manifest(extension_source)

    skill_target = Path.home() / ".agents" / "skills" / "bookmark-organizer"
    extension_root = args.extension_root.expanduser() if args.extension_root else default_extension_root(args.browser)
    extension_target = extension_root / "bookmark-organizer"

    print(install_skill(skill_source, skill_target, args.update_skill))
    print(install_extension(extension_source, extension_target, args.update_extension))
    manifest = validate_manifest(extension_target)
    print(f"扩展校验通过：{manifest['name']} v{manifest['version']}")
    print("\n仍需用户在浏览器中确认：")
    print("1. 打开 edge://extensions、chrome://extensions 或 brave://extensions。")
    print("2. 开启开发者模式，选择‘加载已解压的扩展程序’。")
    print(f"3. 选择目录：{extension_target}")
    print("4. 更新扩展后，在扩展卡片上点击‘重新加载’。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
