import hashlib
import json
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import contextmanager
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
INSTALLER = PROJECT / "scripts" / "install.py"
PAUSE_AFTER_REPLACE = """
import sys
from pathlib import Path
from scripts import install

app, data, ready = map(Path, sys.argv[1:])
replace = install.os.replace

def pause_after_replace(source, destination):
    replace(source, destination)
    if Path(destination) == app / "resources" / "app.asar":
        ready.touch()
        if sys.stdin.readline().strip() != "continue":
            raise RuntimeError("卸载测试未发出继续信号")

install.os.replace = pause_after_replace
install.manage("remove", app, data)
"""


def clean_archive():
    package = b'{"name":"@zcode/desktop","version":"4.0.0"}'
    entry = b'console.info("fixture");\n'
    asset = b"fixture-asset"
    digest = hashlib.sha256(entry).hexdigest()
    entry_node = {
        "offset": str(len(package)),
        "size": len(entry),
        "integrity": {
            "algorithm": "SHA256",
            "hash": digest,
            "blockSize": 4 * 1024 * 1024,
            "blocks": [digest],
        },
    }
    index = {
        "files": {
            "package.json": {"offset": "0", "size": len(package)},
            "out": {"files": {"main": {"files": {"index.js": entry_node}}}},
            "asset.txt": {"offset": str(len(package) + len(entry)), "size": len(asset)},
        },
    }
    encoded = json.dumps(index, separators=(",", ":")).encode("utf-8")
    pickle_size = (len(encoded) + 7) & ~3
    size_header = struct.pack("<4I", 4, pickle_size + 4, pickle_size, len(encoded))
    return size_header + encoded + b"\0" * (pickle_size - len(encoded) - 4) + package + entry + asset


class InstallerTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="zcode-tempo-installer-test-")
        self.addCleanup(scratch.cleanup)
        self.scratch = Path(scratch.name).resolve()
        self.app = self.create_app("zcode")
        self.data = self.scratch / "data"
        self.archive = self.app / "resources" / "app.asar"
        self.runtime = self.app / "resources" / "harness-zcode"

    def create_app(self, name):
        app = self.scratch / name
        resources = app / "resources"
        resources.mkdir(parents=True)
        (app / "ZCode.exe").touch()
        (resources / "app.asar").write_bytes(clean_archive())
        return app

    def command(self, operation, app=None, *, check=True):
        return subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(INSTALLER), operation,
             "--app-dir", str(app or self.app), "--data-base-dir", str(self.data)],
            cwd=PROJECT, capture_output=True, encoding="utf-8", timeout=8, check=check,
        )

    @contextmanager
    def pause_removal(self):
        ready = self.scratch / "replaced"
        with subprocess.Popen(
            [sys.executable, "-B", "-X", "utf8", "-c", PAUSE_AFTER_REPLACE,
             str(self.app), str(self.data), str(ready)],
            cwd=PROJECT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            encoding="utf-8",
        ) as removal:
            try:
                deadline = time.monotonic() + 8
                while not ready.is_file():
                    if removal.poll() is not None:
                        _, errors = removal.communicate(timeout=8)
                        self.fail(f"卸载进程提前退出。{errors}")
                    if time.monotonic() >= deadline:
                        self.fail("卸载进程未到达写回后、清理前的暂停点")
                    time.sleep(0.01)
                yield removal
            finally:
                if removal.poll() is None:
                    removal.kill()
                    removal.communicate(timeout=8)

    def test_install_cannot_enter_while_removal_is_cleaning_up(self):
        self.command("install")
        different_app = self.create_app("other-zcode")

        with self.pause_removal() as removal:
            concurrent_install = self.command("install", check=False)
            concurrent_check = self.command("check", check=False)
            self.command("install", app=different_app)
            _, errors = removal.communicate("continue\n", timeout=8)
            self.assertEqual(removal.returncode, 0, errors)

        status = self.command("check").stdout.strip()
        self.assertNotEqual(
            concurrent_install.returncode, 0,
            f"并发安装未被拒绝。{status}，运行文件存在={any(self.runtime.glob('*/bootstrap.cjs'))}",
        )
        self.assertIn("正在处理", concurrent_install.stderr)
        self.assertNotEqual(concurrent_check.returncode, 0)
        self.assertIn("正在处理", concurrent_check.stderr)
        self.assertEqual(status, "本扩展未安装")
        self.assertFalse(self.runtime.exists())
        self.command("install")
        self.assertEqual(self.command("check").stdout.strip(), "本扩展已安装")

    def test_install_can_recover_after_lock_owner_is_terminated(self):
        self.command("install")
        with self.pause_removal() as removal:
            removal.kill()
            removal.communicate(timeout=8)
        self.command("install")
        self.assertEqual(self.command("check").stdout.strip(), "本扩展已安装")
        self.assertTrue(any(self.runtime.glob("*/bootstrap.cjs")))

    def test_install_and_removal_are_repeatable(self):
        original = self.archive.read_bytes()
        self.assertEqual(self.command("check").stdout.strip(), "本扩展未安装")
        self.command("install")
        installed = self.archive.read_bytes()
        self.command("install")
        self.assertEqual(self.archive.read_bytes(), installed)
        self.assertEqual(self.command("check").stdout.strip(), "本扩展已安装")
        self.command("remove")
        self.command("remove")
        self.assertEqual(self.archive.read_bytes(), original)
        self.assertFalse(self.runtime.exists())
        self.assertEqual(self.command("check").stdout.strip(), "本扩展未安装")


if __name__ == "__main__":
    unittest.main()
