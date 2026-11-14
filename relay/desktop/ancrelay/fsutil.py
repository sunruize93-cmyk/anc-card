"""落盘的两个小工具：整文件替换式写入，和绝不覆盖的放置。"""

from __future__ import annotations

import os
import time
from pathlib import Path

_RETRIES = 5
_RETRY_WAIT_S = 0.2


def write_text_atomic(path: Path, text: str) -> None:
    """先写临时文件再替换：写到一半崩溃不会留下半个文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    _retry(lambda: temporary.replace(path))


def place_without_overwriting(temporary: Path, target: Path) -> bool:
    """把临时文件放到目标位置。目标已存在时不动它，返回 False，临时文件留给调用方处理。"""

    def link() -> bool:
        try:
            os.link(temporary, target)
        except FileExistsError:
            return False
        return True

    try:
        placed = _retry(link)
    except PermissionError:
        raise
    except OSError:
        # 文件系统不支持硬链接（例如 FAT）时退回改名。Windows 上目标已存在时改名会失败，不会覆盖。
        if target.exists():
            return False
        _retry(lambda: temporary.rename(target))
        return True
    if placed:
        temporary.unlink(missing_ok=True)
    return placed


def _retry(action):
    """Windows 上杀毒或索引服务会短暂占住刚写完的文件，等一下再试。"""
    for attempt in range(_RETRIES):
        try:
            return action()
        except PermissionError:
            if attempt == _RETRIES - 1:
                raise
            time.sleep(_RETRY_WAIT_S)
    return None
