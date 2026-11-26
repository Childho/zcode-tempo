"""安装或卸载 Windows ZCode 4.0.0 的本地扩展。"""

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import tempfile
from contextlib import contextmanager
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
ENTRY = ("out", "main", "index.js")
RUNTIME = "harness-zcode"
MARKER = re.compile(
    rb'\n;import\("file:[^"\n]*/harness-zcode/[a-f0-9]{16}/bootstrap\.cjs"\)'
    rb'\.catch\(\(error\) => console\.error\("\[harness-zcode\] load failed", error\)\);\n'
)
BUSY = "另一个进程正在处理此 ZCode 安装目录，请稍后重试"


@contextmanager
def installation_lock(resources):
    if os.name != "nt":
        import fcntl

        directory = os.open(resources, os.O_RDONLY)
        try:
            try:
                fcntl.flock(directory, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ValueError(BUSY) from error
            yield
        finally:
            os.close(directory)
        return

    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR)
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.ReleaseMutex.argtypes = (wintypes.HANDLE,)
    kernel.ReleaseMutex.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel.CloseHandle.restype = wintypes.BOOL

    # 安装包会原子替换。用安装目录作为锁的身份，避免锁随文件替换而失效。
    identity = hashlib.sha256(os.fsencode(os.path.normcase(resources))).hexdigest()
    mutex = kernel.CreateMutexW(None, False, f"Global\\zcode-tempo-install-{identity}")
    if not mutex:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        wait_object, wait_abandoned, wait_timeout = 0, 0x80, 0x102
        status = kernel.WaitForSingleObject(mutex, 0)
        if status == wait_timeout:
            raise ValueError(BUSY)
        # 前一个进程异常退出时，Windows 将所有权交给这次操作。安装逻辑会重新读取安装包。
        if status not in (wait_object, wait_abandoned):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            yield
        finally:
            kernel.ReleaseMutex(mutex)
    finally:
        kernel.CloseHandle(mutex)


def read_archive(stream):
    # ASAR Pickle 格式与入口重算方式参考 ByteRax v1.5.23 的 patch_install.py。
    first, header_size, payload_size, json_size = struct.unpack("<4I", stream.read(16))
    if first != 4 or header_size != payload_size + 4 or not 0 < json_size <= payload_size - 4:
        raise ValueError("无法识别 ZCode 安装包格式")
    return json.loads(stream.read(json_size)), 8 + header_size


def file_node(header, parts):
    node = header
    for name in parts:
        node = node["files"][name]
    if node.get("unpacked") or "offset" not in node:
        raise ValueError("ZCode 安装包入口不在归档内")
    return node


def read_file(stream, base, node):
    stream.seek(base + int(node["offset"]))
    return stream.read(node["size"])


def packed_nodes(header):
    for node in header.get("files", {}).values():
        if "files" in node:
            yield from packed_nodes(node)
        elif not node.get("unpacked") and "offset" in node:
            yield node


def inspect(stream):
    header, base = read_archive(stream)
    package = json.loads(read_file(stream, base, file_node(header, ("package.json",))))
    if package.get("name") != "@zcode/desktop" or package.get("version") != "4.0.0":
        raise ValueError("首版支持 Windows ZCode 4.0.0，请核对安装路径和版本")
    node = file_node(header, ENTRY)
    return header, base, node, read_file(stream, base, node)


def copy_exact(source, destination, length):
    while length:
        block = source.read(min(length, 4 * 1024 * 1024))
        if not block:
            raise ValueError("ZCode 安装包数据不完整")
        destination.write(block)
        length -= len(block)


def write_archive(source, destination, header, base, entry, new_content):
    start = int(entry["offset"])
    end = start + entry["size"]
    delta = len(new_content) - entry["size"]
    for node in packed_nodes(header):
        offset = int(node["offset"])
        if node is not entry and offset >= end:
            node["offset"] = str(offset + delta)
    block_size = entry.get("integrity", {}).get("blockSize", 4 * 1024 * 1024)
    entry["size"] = len(new_content)
    entry["integrity"] = {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(new_content).hexdigest(),
        "blockSize": block_size,
        "blocks": [hashlib.sha256(new_content[i:i + block_size]).hexdigest()
                   for i in range(0, len(new_content), block_size)],
    }
    encoded = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    padded_size = (len(encoded) + 7) & ~3
    destination.write(struct.pack("<4I", 4, padded_size + 4, padded_size, len(encoded)))
    destination.write(encoded)
    destination.write(b"\0" * (padded_size - len(encoded) - 4))
    source.seek(base)
    copy_exact(source, destination, start)
    destination.write(new_content)
    source.seek(base + end)
    shutil.copyfileobj(source, destination, 4 * 1024 * 1024)


def publish_runtime(resources):
    sources = {item.relative_to(PROJECT / "src"): item.read_bytes()
               for item in (PROJECT / "src").rglob("*.cjs")}
    for required in ("bootstrap.cjs", "rate.cjs", "enhancement.cjs", "enhance-request.cjs",
                     "enhancement-prompt.cjs", "enhancement-fidelity.cjs", "reply-context.cjs", "markdown-fences.cjs"):
        if Path(required) not in sources:
            raise ValueError(f"安装文件缺失 {required}")
    license_path = Path("vendor/byte-rax-1.5.23/LICENSE")
    sources[license_path] = (PROJECT / "src" / license_path).read_bytes()
    digest = hashlib.sha256()
    for name, content in sorted(sources.items()):
        digest.update(name.as_posix().encode("utf-8") + b"\0" + hashlib.sha256(content).digest())
    runtime_root = resources / RUNTIME
    if runtime_root.is_symlink() or runtime_root.resolve().parent != resources:
        raise ValueError("扩展运行目录已重定向，停止安装")
    runtime_root.mkdir(exist_ok=True)
    target = runtime_root / digest.hexdigest()[:16]
    if target.is_symlink():
        raise ValueError("扩展版本目录已重定向，停止安装")
    if target.exists():
        for name, content in sources.items():
            if (target / name).read_bytes() != content:
                raise ValueError(f"已安装的扩展文件被修改 {name.name}")
        return target
    with tempfile.TemporaryDirectory(dir=runtime_root, prefix=".publish-") as temporary:
        staging = Path(temporary) / target.name
        for name, content in sources.items():
            output = staging / name
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(content)
        staging.rename(target)
    return target


def original_plugin_registered(data_base_dir):
    desktop_home = Path(os.environ.get("ZCODE_DESKTOP_HOME_DIR") or Path.home())
    base_dir = data_base_dir or os.environ.get("ZCODE_DATA_BASE_DIR")
    if not base_dir:
        settings_file = desktop_home / ".zcode" / "v2" / "setting.json"
        try:
            base_dir = json.loads(settings_file.read_text(encoding="utf-8-sig")).get("dataBaseDir")
        except (FileNotFoundError, ValueError):
            pass
    zcode_home = Path(base_dir) / ".zcode" if base_dir else desktop_home / ".zcode"
    registry = zcode_home / "cli" / "plugins" / "installed_plugins.json"
    try:
        data = registry.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return False
    return bool(re.search(r'"zcode-token-usage-statusbar(?:@[^"\s]+)?"', data))


def manage(operation, app_dir, data_base_dir):
    resources = (app_dir / "resources").resolve()
    archive = resources / "app.asar"
    if not (app_dir / "ZCode.exe").is_file() or not archive.is_file():
        raise ValueError("请选择包含 ZCode.exe 和 resources/app.asar 的安装目录")
    with installation_lock(resources):
        manage_archive(operation, archive, data_base_dir)


def manage_archive(operation, archive, data_base_dir):
    resources = archive.parent
    before = archive.stat()
    staging_path = None
    try:
        with archive.open("rb") as source:
            header, base, entry, content = inspect(source)
            old_markers = list(MARKER.finditer(content))
            original_loaded = b'"[zusage] load failed"' in content or b"zcode-token-usage-statusbar/inject-main.cjs" in content
            original_conflict = original_loaded or original_plugin_registered(data_base_dir)
            if operation == "check":
                print("检测到 ByteRax 原版" if original_conflict else "本扩展已安装" if old_markers else "本扩展未安装")
                return
            if operation == "install" and original_conflict:
                raise ValueError("检测到 ByteRax 原版，请先卸载原版并完全退出 ZCode")
            target_content = MARKER.sub(b"", content)
            if operation == "install":
                runtime = publish_runtime(resources)
                loader = json.dumps((runtime / "bootstrap.cjs").as_uri(), ensure_ascii=True)
                target_content += (
                    f'\n;import({loader}).catch((error) => console.error("[harness-zcode] load failed", error));\n'
                ).encode("ascii")
            if target_content != content:
                with tempfile.NamedTemporaryFile(dir=resources, prefix=".harness-asar-", delete=False) as temp:
                    staging_path = Path(temp.name)
                    write_archive(source, temp, header, base, entry, target_content)
                    temp.flush()
                    os.fsync(temp.fileno())
        if staging_path:
            with staging_path.open("rb") as result:
                if inspect(result)[3] != target_content:
                    raise ValueError("安装包写回校验失败")
            after = archive.stat()
            if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                raise ValueError("操作期间 ZCode 安装包有变动，请退出 ZCode 后重试")
            os.replace(staging_path, archive)
        if operation == "remove":
            runtime_root = resources / RUNTIME
            if runtime_root.is_dir() and not runtime_root.is_symlink() and runtime_root.resolve().parent == resources:
                for directory in runtime_root.iterdir():
                    if re.fullmatch(r"[a-f0-9]{16}", directory.name) and not directory.is_symlink() and directory.resolve().parent == runtime_root:
                        shutil.rmtree(directory)
                if not any(runtime_root.iterdir()):
                    runtime_root.rmdir()
        print("安装完成，重新打开 ZCode 生效" if operation == "install" else "卸载完成，重新打开 ZCode 生效")
    finally:
        if staging_path:
            staging_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("install", "remove", "check"))
    parser.add_argument("--app-dir", required=True, type=Path)
    parser.add_argument("--data-base-dir", type=Path, help="ZCode 自定义数据目录")
    args = parser.parse_args()
    try:
        manage(args.operation, args.app_dir.resolve(), args.data_base_dir)
    except PermissionError as error:
        parser.exit(1, f"操作失败。请先完全退出 ZCode。{error}\n")
    except (OSError, KeyError, ValueError, struct.error) as error:
        parser.exit(1, f"操作失败。{error}\n")


if __name__ == "__main__":
    main()
