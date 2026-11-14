"""把 TX/RX 写进证据日志。

TX 每帧都记十六进制（命令里只有文件名和偏移，不含凭证）。
RX 记除音频数据以外的每一帧；2-4（文件数据）和 1-1（实时音频）量太大，只计数，
在 `flush()` 时汇总成一条。
"""

from __future__ import annotations

from typing import Any

from .evidence import EvidenceLog
from .protocol import Frame, hex_bytes
from .safety import describe

_BULK = {(2, 4): "2-4 文件数据", (1, 1): "1-1 实时音频"}
_PARAMS_SHOWN = 48


class Tracer:
    def __init__(self, log: EvidenceLog) -> None:
        self._log = log
        self._bulk: dict[tuple[int, int], dict[str, int]] = {}

    def __call__(self, direction: str, *args: Any) -> None:
        if direction == "tx":
            (frame,) = args
            payload = frame[6:]
            self._log.event("tx", cmd=describe(payload), bytes=len(frame), gatt_writes=1, hex=hex_bytes(frame))
            return
        source, frame = args
        self._on_rx(source, frame)

    def _on_rx(self, source: str, frame: Frame) -> None:
        key = (frame.type, frame.cmd)
        if key in _BULK:
            stats = self._bulk.setdefault(key, {"frames": 0, "bytes": 0, "min": 1 << 30, "max": 0})
            size = len(frame.params)
            stats["frames"] += 1
            stats["bytes"] += size
            stats["min"] = min(stats["min"], size)
            stats["max"] = max(stats["max"], size)
            return
        params = frame.params
        shown = hex_bytes(params[:_PARAMS_SHOWN]) + (" …" if len(params) > _PARAMS_SHOWN else "")
        self._log.event("rx", source=source, cmd=f"{frame.type}-{frame.cmd}", seq=frame.seq,
                        params_bytes=len(params), params_hex=shown)

    def flush(self, label: str = "") -> None:
        for key, stats in self._bulk.items():
            self._log.event("rx_bulk", label=label, cmd=_BULK[key], frames=stats["frames"], bytes=stats["bytes"],
                            min_frame=stats["min"], max_frame=stats["max"])
        self._bulk = {}
