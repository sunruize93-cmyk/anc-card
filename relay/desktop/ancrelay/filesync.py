"""卡内文件列表的对账：哪些是新录音，下载下来叫什么名字。"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Sequence
from pathlib import Path

from .fsutil import write_text_atomic
from .protocol import FileEntry

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")
# Windows 的保留设备名：不管带不带扩展名，写进去都不会成为普通文件。
_RESERVED = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{n}" for n in range(1, 10)),
        *(f"LPT{n}" for n in range(1, 10)),
    }
)


def safe_filename(name: str) -> str:
    """文件名来自卡，是外部数据：去掉目录部分和不安全字符，保证落在输出目录里。"""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = _UNSAFE.sub("_", base).lstrip(".")
    if cleaned.split(".", 1)[0].upper() in _RESERVED:
        cleaned = f"_{cleaned}"
    return cleaned or "unnamed"


def output_name(requested: str, data: bytes) -> str:
    """内容是 RIFF 就存成 .wav；否则沿用请求时的扩展名。

    没有扩展名，或者请求的是 .wav 而内容不是 RIFF，都存成 .bin，不让它冒充 WAV。
    """
    safe = safe_filename(requested)
    stem, dot, extension = safe.rpartition(".")
    if not dot:
        stem, extension = safe, ""
    stem = stem or "unnamed"
    if data[:4] == b"RIFF":
        return f"{stem}.wav"
    if not extension or extension.lower() == "wav":
        return f"{stem}.bin"
    return f"{stem}.{extension}"


def new_entries(known: Iterable[str], listed: Sequence[FileEntry]) -> list[FileEntry]:
    """列表里不在基线中的条目，按列表顺序，同名只算一次。"""
    seen = set(known)
    fresh: list[FileEntry] = []
    for entry in listed:
        if not entry.name or entry.name in seen:
            continue
        seen.add(entry.name)
        fresh.append(entry)
    return fresh


def load_baseline(path: Path) -> set[str] | None:
    """读取上次保存的文件名基线；还没有基线时返回 None。"""
    if not path.exists():
        return None
    names = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        raise ValueError(f"基线文件格式不对：{path}")
    return set(names)


def save_baseline(path: Path, names: Iterable[str]) -> None:
    write_text_atomic(
        path, json.dumps(sorted(set(names)), ensure_ascii=False, indent=2) + "\n"
    )
