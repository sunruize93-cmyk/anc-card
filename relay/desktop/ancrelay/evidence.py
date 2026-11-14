"""联调证据：文件哈希、WAV 校验、带时间的事件日志。"""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

_SECRET_KEYS = frozenset(
    {"token", "authorization", "secret", "password", "credential", "key"}
)
_HIDDEN = "[已隐藏]"
_CHUNK = 1024 * 1024


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class WavInfo:
    ok: bool
    reason: str = ""
    audio_format: int = 0
    channels: int = 0
    sample_rate: int = 0
    bits_per_sample: int = 0
    data_bytes: int = 0
    duration_s: float = 0.0


def inspect_wav(data: bytes) -> WavInfo:
    """按协议文档验收 WAV：RIFF/WAVE 头、声明长度等于实际长度、有 fmt 和 data 块。"""
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return WavInfo(False, "不是 RIFF/WAVE 文件")
    declared = int.from_bytes(data[4:8], "little") + 8
    if declared != len(data):
        return WavInfo(False, f"RIFF 声明长度 {declared} 字节，实际 {len(data)} 字节")

    fmt: bytes | None = None
    data_bytes: int | None = None
    offset = 12
    while offset + 8 <= len(data):
        chunk_id = data[offset : offset + 4]
        size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        body = offset + 8
        if body + size > len(data):
            name = chunk_id.decode("ascii", errors="replace")
            return WavInfo(False, f"{name} 块声明 {size} 字节，超出文件末尾")
        if chunk_id == b"fmt ":
            fmt = data[body : body + size]
        elif chunk_id == b"data":
            data_bytes = size
        offset = body + size + (size & 1)

    if fmt is None or len(fmt) < 16:
        return WavInfo(False, "缺少完整的 fmt 块")
    if data_bytes is None:
        return WavInfo(False, "缺少 data 块")

    audio_format = int.from_bytes(fmt[0:2], "little")
    channels = int.from_bytes(fmt[2:4], "little")
    sample_rate = int.from_bytes(fmt[4:8], "little")
    bits = int.from_bytes(fmt[14:16], "little")
    bytes_per_second = sample_rate * channels * bits // 8
    if bytes_per_second <= 0:
        return WavInfo(False, "fmt 块里的采样率、声道或位深为 0")
    return WavInfo(
        ok=True,
        audio_format=audio_format,
        channels=channels,
        sample_rate=sample_rate,
        bits_per_sample=bits,
        data_bytes=data_bytes,
        duration_s=data_bytes / bytes_per_second,
    )


def _local_now() -> datetime:
    return datetime.now().astimezone()


class EvidenceLog:
    """一行一个 JSON 事件：从开始算的毫秒数、本地时间、会话 ID，加上事件自己的字段。

    名字像凭证的字段不会写进文件。
    """

    def __init__(
        self,
        path: Path,
        session_id: str,
        *,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], datetime] = _local_now,
        echo: Callable[[str], None] = print,
    ) -> None:
        self._path = path
        self._session_id = session_id
        self._clock = clock
        self._wall = wall
        self._echo = echo
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._started = clock()

    @property
    def path(self) -> Path:
        return self._path

    def now_ms(self) -> int:
        return round((self._clock() - self._started) * 1000)

    def event(self, name: str, /, **fields: Any) -> dict[str, Any]:
        safe = {
            key: (_HIDDEN if key.lower() in _SECRET_KEYS else value)
            for key, value in fields.items()
        }
        record: dict[str, Any] = {
            "t_ms": self.now_ms(),
            "wall": self._wall().isoformat(timespec="milliseconds"),
            "session": self._session_id,
            "event": name,
            **safe,
        }
        with self._path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
        detail = " ".join(f"{key}={value}" for key, value in safe.items())
        self._echo(f"[{record['t_ms']:>8} ms] {name} {detail}".rstrip())
        return record
