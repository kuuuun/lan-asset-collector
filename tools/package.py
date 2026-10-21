#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
素材采集器 · 打包脚本
=====================

把 lan-asset-collector/ 打成一个可直接分发的 zip，放在其**上一级目录**。

同时当一道闸门：校验 manifest 引用的文件齐备、版本号各处一致、行尾约定、
以及「局域网接收端」这个已下线的通道不再有残留。

用法：
    python tools/package.py           # 自动读取 manifest.json 里的版本号
    python tools/package.py --check   # 只做完整性检查，不产出 zip
"""

import argparse
import json
import os
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")

# 代码里按字符串路径加载的静态资源（如 'studio/studio.html'、'lib/comfy.js'）
REF_RE = re.compile(
    r"""['"]((?:[A-Za-z0-9_\-]+/)*[A-Za-z0-9_\-.]+\.(?:html|js|css|png|svg))['"]"""
)

# 打进包里的顶层条目
INCLUDE = [
    "manifest.json",
    "background.js",
    "offscreen.html",
    "offscreen.js",
    "lib",
    "content",
    "popup",
    "options",
    "studio",
    "help",
    "assets",
    "tools",
    "README.md",
    "HANDOVER.md",
]

# 明确排除：开发期验证脚本不属于交付内容
EXCLUDE_DIRS = {"dev-tests", "__pycache__", "node_modules", ".git", ".workbuddy"}
EXCLUDE_FILES = {".DS_Store", "Thumbs.db", ".seg-js.json", "receiver.log",
                 "receiver.out.log", "receiver.err.log"}

# 这些后缀在 Unix 上必须可执行
EXEC_EXTS = {".sh", ".command"}


def collect():
    """收集 (绝对路径, zip 内的相对路径) 列表"""
    items = []
    for entry in INCLUDE:
        p = ROOT / entry
        if not p.exists():
            print(f"[ERROR] 缺少条目：{entry}")
            return None
        if p.is_file():
            items.append((p, entry))
            continue
        for dirpath, dirnames, filenames in os.walk(p):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for fn in sorted(filenames):
                if fn in EXCLUDE_FILES or fn.endswith(".part"):
                    continue
                fp = Path(dirpath) / fn
                items.append((fp, str(fp.relative_to(ROOT)).replace(os.sep, "/")))
    return items


def check(items):
    """静态完整性检查"""
    problems = []

    manifest_path = ROOT / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as e:
        return None, [f"manifest.json 解析失败：{e}"]

    version = str(manifest.get("version", ""))
    if not VERSION_RE.match(version):
        problems.append(f"版本号格式异常：{version!r}")

    names = {rel for _, rel in items}

    # manifest 里引用的文件必须都在包里
    refs = []
    refs.append(manifest.get("background", {}).get("service_worker", ""))
    refs.append(manifest.get("action", {}).get("default_popup", ""))
    refs.append(manifest.get("options_ui", {}).get("page", ""))
    for cs in manifest.get("content_scripts", []):
        refs += cs.get("js", []) + cs.get("css", [])
    for sz in manifest.get("action", {}).get("default_icon", {}).values():
        refs.append(sz)
    for sz in manifest.get("icons", {}).values():
        refs.append(sz)
    for war in manifest.get("web_accessible_resources", []):
        for r in war.get("resources", []):
            if "*" in r:
                continue
            refs.append(r)

    for r in refs:
        if r and r not in names and not any(n.startswith(r.rstrip("/") + "/") for n in names):
            problems.append(f"manifest 引用了包内不存在的文件：{r}")

    # manifest 之外还有一类「靠字符串路径加载」的文件（chrome.offscreen 的文档、
    # studio 页面、getURL 目标等）。它们不在 manifest 里，光靠上面的检查会漏。
    # 做法：扫包内 .js/.html 里出现的相对路径字面量，若仓库里真有这个文件、却没进包，就报警。
    for fp, rel in items:
        if fp.suffix.lower() not in {".js", ".html"}:
            continue
        txt = fp.read_text(encoding="utf-8", errors="ignore")
        for m in REF_RE.finditer(txt):
            cand = m.group(1)
            if cand.startswith(("./", "../")):
                continue
            if (ROOT / cand).is_file() and cand not in names:
                problems.append(f"代码里按路径引用了未打进包的文件：{rel} → {cand}")

    # 版本号在关键文件里必须一致
    for rel, pattern in [
        ("background.js", r"const VERSION = '([^']+)'"),
        ("popup/popup.html", r"v(\d+\.\d+\.\d+)"),
        ("studio/studio.html", r'id="ver">v(\d+\.\d+\.\d+)<'),
        ("content/content.js", r"version: '([^']+)'"),
        ("help/help.html", r"版本 (\d+\.\d+\.\d+)"),
    ]:
        txt = (ROOT / rel).read_text(encoding="utf-8")
        m = re.search(pattern, txt)
        if not m:
            problems.append(f"{rel} 里找不到版本号")
        elif m.group(1) != version:
            problems.append(f"{rel} 版本号 {m.group(1)} 与 manifest 的 {version} 不一致")

    # 「局域网接收端」通道 v1.4.0 已下线：不允许再有残留
    leaked = [n for n in names if n.startswith("receiver/")]
    if leaked:
        problems.append(f"接收端残留（该通道已下线）：{leaked[:3]}")
    if "receiver" in INCLUDE:
        problems.append("INCLUDE 里仍列着 receiver")

    # dev-tests 绝不能混进来
    leaked = [n for n in names if n.startswith("dev-tests/")]
    if leaked:
        problems.append(f"dev-tests 混入包内：{leaked[:3]}")

    # .bat 必须 CRLF，其余文本文件必须 LF
    for fp, rel in items:
        if fp.suffix.lower() not in {".js", ".mjs", ".json", ".css", ".html", ".md",
                                     ".py", ".sh", ".command", ".bat"}:
            continue
        raw = fp.read_bytes()
        is_bat = fp.suffix.lower() == ".bat"
        has_crlf = b"\r\n" in raw
        if is_bat and not has_crlf:
            problems.append(f"{rel} 应为 CRLF 行尾")
        if not is_bat and has_crlf:
            problems.append(f"{rel} 含 CRLF（应为 LF）")

    # shell 脚本必须带 shebang
    for fp, rel in items:
        if fp.suffix.lower() in EXEC_EXTS:
            if not fp.read_bytes().startswith(b"#!"):
                problems.append(f"{rel} 缺少 shebang")

    return (version, problems)


def build(items, version):
    out = ROOT.parent / f"lan-asset-collector-v{version}.zip"
    if out.exists():
        out.unlink()

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        # 目录条目
        dirs = sorted({str(Path(rel).parent).replace(os.sep, "/")
                       for _, rel in items if str(Path(rel).parent) != "."})
        for d in dirs:
            zi = zipfile.ZipInfo("lan-asset-collector/" + d + "/")
            zi.external_attr = (0o40755 << 16) | 0x10
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, b"")

        for fp, rel in sorted(items, key=lambda t: t[1]):
            arc = "lan-asset-collector/" + rel
            zi = zipfile.ZipInfo(arc, date_time=(2026, 1, 1, 0, 0, 0))
            mode = 0o100755 if fp.suffix.lower() in EXEC_EXTS else 0o100644
            zi.external_attr = mode << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, fp.read_bytes())

    return out


def verify_zip(zpath, expect_exec):
    """复查 zip：条目数、可执行位、是否混入 dev-tests"""
    problems = []
    with zipfile.ZipFile(zpath) as z:
        infos = z.infolist()
        names = [i.filename for i in infos]
        if any("dev-tests" in n for n in names):
            problems.append("zip 内混入 dev-tests")
        for n in names:
            if n.endswith("/"):
                continue
            info = z.getinfo(n)
            mode = (info.external_attr >> 16) & 0o777
            want_exec = Path(n).suffix.lower() in EXEC_EXTS
            if want_exec and not (mode & 0o111):
                problems.append(f"{n} 缺少可执行位（mode={oct(mode)}）")
            if not want_exec and (mode & 0o111) and not n.endswith("/"):
                pass  # 文件多一个 x 位无所谓，不报警
        for n in expect_exec:
            full = "lan-asset-collector/" + n
            if full not in names:
                problems.append(f"zip 内找不到 {n}")
            else:
                mode = (z.getinfo(full).external_attr >> 16) & 0o777
                if not (mode & 0o111):
                    problems.append(f"{n} 可执行位丢失（mode={oct(mode)}）")
        size = zpath.stat().st_size
        return len([n for n in names if not n.endswith("/")]), size, problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只做完整性检查，不产出 zip")
    args = ap.parse_args()

    items = collect()
    if items is None:
        return 1

    version, problems = check(items)
    print("=" * 56)
    print(f"  素材采集器 · 打包校验")
    print("=" * 56)
    print(f"  待打包文件：{len(items)} 个")

    if version is None:
        for p in problems:
            print(f"  [FAIL] {p}")
        return 1

    print(f"  版本号    ：{version}")
    if problems:
        for p in problems:
            print(f"  [FAIL] {p}")
        return 1
    print("  完整性    ：通过")

    if args.check:
        # 只检查不打包时，条目清单里也过一遍 dev-tests 泄漏检查
        names = {rel for _, rel in items}
        print(f"  未混入 dev-tests：{not any(n.startswith('dev-tests/') for n in names)}")
        return 0

    out = build(items, version)
    exec_expected = [rel for _, rel in items if Path(rel).suffix.lower() in EXEC_EXTS]
    count, size, vproblems = verify_zip(out, exec_expected)

    print(f"  产出      ：{out.name} · {count} 个文件 · {size / 1024:.1f} KB")
    if vproblems:
        for p in vproblems:
            print(f"  [FAIL] {p}")
        return 1
    print("  可执行位  ：保留正常（macOS/Linux 可直接跑）")
    print("  dev-tests ：未混入")
    print("-" * 56)
    return 0


if __name__ == "__main__":
    sys.exit(main())
