"""实时音频的落盘和计数。每次连接是一段，收到就写盘，段与段之间的缺口可以算出来。"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

from .protocol import wrap_qs668_raw_opus

PACKET_BYTES = 40
PACKET_MS = 20


@dataclass
class Segment:
    index: int
    connection_round: int
    raw_path: Path
    started_ms: int
    first_frame_ms: int | None = None
    last_frame_ms: int | None = None
    ended_ms: int | None = None
    end_reason: str | None = None
    packets: int = 0
    size: int = 0
    odd_payloads: int = 0

    def as_dict(self) -> dict[str, Any]:
        latency = (
            None
            if self.first_frame_ms is None
            else self.first_frame_ms - self.started_ms
        )
        return {
            "index": self.index,
            "connection_round": self.connection_round,
            "raw_file": self.raw_path.name,
            "started_ms": self.started_ms,
            "first_frame_ms": self.first_frame_ms,
            "last_frame_ms": self.last_frame_ms,
            "first_frame_latency_ms": latency,
            "ended_ms": self.ended_ms,
            "end_reason": self.end_reason,
            "packets": self.packets,
            "bytes": self.size,
            "audio_ms": self.packets * PACKET_MS,
            "odd_payloads": self.odd_payloads,
        }


class StreamRecorder:
    def __init__(
        self, out_dir: Path, session_id: str, *, now_ms: Callable[[], int]
    ) -> None:
        self._out_dir = out_dir
        self._session_id = session_id
        self._now_ms = now_ms
        self._segments: list[Segment] = []
        self._markers: list[dict[str, Any]] = []
        self._stream_names: list[str] = []
        self._stray_packets = 0
        self._open: Segment | None = None
        self._handle: BinaryIO | None = None
        self._out_dir.mkdir(parents=True, exist_ok=True)

    @property
    def current(self) -> Segment | None:
        return self._open

    def begin_segment(self, connection_round: int) -> Segment:
        self.end_segment("superseded")
        index = len(self._segments) + 1
        segment = Segment(
            index=index,
            connection_round=connection_round,
            raw_path=self._out_dir / f"{self._session_id}-seg{index:02d}.raw",
            started_ms=self._now_ms(),
        )
        self._handle = segment.raw_path.open("ab")
        self._segments.append(segment)
        self._open = segment
        return segment

    def on_audio(self, payload: bytes) -> None:
        """写一帧 1-1 的负载。立刻刷盘：断电或崩溃时已经收到的不丢。"""
        if not payload:
            return
        packets = len(payload) // PACKET_BYTES
        if self._open is None or self._handle is None:
            self._stray_packets += max(1, packets)
            return
        self._handle.write(payload)
        self._handle.flush()
        now = self._now_ms()
        segment = self._open
        if segment.first_frame_ms is None:
            segment.first_frame_ms = now
        segment.last_frame_ms = now
        segment.packets += packets
        segment.size += len(payload)
        if len(payload) % PACKET_BYTES:
            segment.odd_payloads += 1

    def end_segment(self, reason: str) -> Segment | None:
        if self._open is None:
            return None
        segment = self._open
        if self._handle is not None:
            self._handle.close()
        self._handle = None
        self._open = None
        segment.ended_ms = self._now_ms()
        segment.end_reason = reason
        return segment

    def close(self) -> None:
        """收尾：还开着的段按中止结束，释放文件句柄。"""
        self.end_segment("aborted")

    def mark(self, text: str) -> dict[str, Any]:
        marker = {"t_ms": self._now_ms(), "text": text}
        self._markers.append(marker)
        return marker

    def note_stream_name(self, name: str) -> None:
        self._stream_names.append(name)

    def summary(self) -> dict[str, Any]:
        with_audio = [
            segment for segment in self._segments if segment.first_frame_ms is not None
        ]
        gaps = [
            {
                "after_segment": before.index,
                "from_ms": before.last_frame_ms,
                "to_ms": after.first_frame_ms,
                "gap_ms": (after.first_frame_ms or 0) - (before.last_frame_ms or 0),
            }
            for before, after in zip(with_audio, with_audio[1:])
        ]
        total_packets = sum(segment.packets for segment in self._segments)
        return {
            "session": self._session_id,
            "segments": [segment.as_dict() for segment in self._segments],
            "gaps": gaps,
            "markers": list(self._markers),
            "stream_names": list(self._stream_names),
            "total_packets": total_packets,
            "total_audio_ms": total_packets * PACKET_MS,
            "stray_packets": self._stray_packets,
        }

    def wrap_ogg(self) -> list[Path]:
        """把已结束、长度正好是 40 字节整数倍的段包成可播放的 Ogg/Opus。"""
        written: list[Path] = []
        for segment in self._segments:
            if segment is self._open or segment.size == 0:
                continue
            if segment.odd_payloads or segment.size % PACKET_BYTES:
                continue
            ogg_path = segment.raw_path.with_suffix(".ogg")
            ogg_path.write_bytes(wrap_qs668_raw_opus(segment.raw_path.read_bytes()))
            written.append(ogg_path)
        return written
