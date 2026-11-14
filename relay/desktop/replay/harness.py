"""离线 BLE 回放：一张按 JSON 脚本应答的「假卡」，从真实的 CardLink 通知回调喂数据。

被测的是现有代码本身：CardLink（AE22/AE23 分开组帧、取帧队列）、厂商 FrameParser、
ops.read_status / list_files / pull_file、cardfiles.pull_new_files / watch。
假卡只负责「卡会回什么、什么时候回、按什么边界拆成通知」，不替被测代码做任何判断。

场景里所有分片边界、时序、音频内容都是合成的（实测日志没有记录原始通知边界）。
"""

from __future__ import annotations

import asyncio
import io
import json
import wave
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from ancrelay.protocol import (
    KEY_NOTIFY_UUID,
    NOTIFY_UUID,
    WRITE_UUID,
    build_frame,
    decode_text,
)
from ancrelay.transport import CardLink

SCENARIO_DIR = Path(__file__).resolve().parent / "scenarios"
CHANNEL_UUID = {"ae22": NOTIFY_UUID, "ae23": KEY_NOTIFY_UUID}
PIECE_GAP_S = 0.002  # 同一条应答拆成多次通知时，相邻两片之间的间隔


def load_scenario(name: str) -> dict[str, Any]:
    return json.loads((SCENARIO_DIR / name).read_text(encoding="utf-8"))


def synthetic_wav(seconds: float = 0.25, rate: int = 16000) -> bytes:
    """合成的静音 WAV，只用来走下载流程，不是录音。"""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(bytes(int(seconds * rate) * 2))
    return buffer.getvalue()


def frame_bytes(spec: dict[str, Any], default_seq: int) -> bytes:
    """{"type":0,"cmd":4,"params_hex":"63","seq":0} → 整帧。seq 省略时用调用方给的值。"""
    params = bytes.fromhex(spec.get("params_hex", "").replace(" ", ""))
    if "params_text" in spec:
        params = spec["params_text"].encode()
    seq = spec.get("seq", default_seq)
    raw = bytearray(build_frame(bytes([spec["type"], spec["cmd"]]) + params, seq))
    if spec.get("zero_crc"):
        raw[2:4] = b"\x00\x00"
    return bytes(raw)


def split(data: bytes, cuts: list[int]) -> list[bytes]:
    """按字节位置切成多次通知，例如 cuts=[3, 7] → data[:3], data[3:7], data[7:]。"""
    points = [0, *sorted(c for c in cuts if 0 < c < len(data)), len(data)]
    return [data[a:b] for a, b in zip(points, points[1:]) if b > a]


@dataclass
class Notification:
    channel: str
    delay_ms: float
    frames: list[dict[str, Any]]
    split_at: list[int] = field(default_factory=list)
    raw_hex: str | None = None  # 直接给原始字节（用于半帧、垃圾数据）


def timeline_value(timeline: list[dict[str, Any]], now_ms: float, key: str) -> Any:
    value = None
    for entry in timeline:
        if entry["from_ms"] <= now_ms:
            value = entry[key]
    return value


class ScriptedCard:
    """照 Bleak 客户端的样子做的假卡。同一个实例可以被多次「连接」。"""

    def __init__(self, card: dict[str, Any]) -> None:
        self.card = card
        self.is_connected = False
        self.mtu_size = 527
        self.services = SimpleNamespace(
            get_characteristic=lambda _uuid: SimpleNamespace(
                max_write_without_response_size=524
            )
        )
        self.callbacks: dict[str, Any] = {}
        self.writes: list[
            dict[str, Any]
        ] = []  # 主机发出的每条命令：时间、命令、请求序号、参数
        self.connects = 0
        self.drops = 0
        self._started = 0.0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._pending: list[asyncio.TimerHandle] = []
        self._calls: dict[str, int] = {}
        self._reply_seq = 0
        self._wav = synthetic_wav(card.get("wav_seconds", 0.25))

    # ---- Bleak 客户端接口 ----
    async def connect(self) -> None:
        self._loop = asyncio.get_running_loop()
        if self.connects == 0:
            self._started = self._loop.time()
            for event in self.card.get("unsolicited", []):
                self._schedule(
                    Notification(
                        event["channel"],
                        event["at_ms"],
                        event.get("frames", []),
                        event.get("split_at", []),
                        event.get("raw_hex"),
                    ),
                    absolute=True,
                )
            for at_ms in self.card.get("drops_at_ms", []):  # 卡这一侧主动断开（模拟掉线）
                self._pending.append(self._loop.call_later(at_ms / 1000, self._drop))
        self.connects += 1
        self.is_connected = True

    async def disconnect(self) -> None:
        self.is_connected = False

    async def start_notify(self, uuid: str, callback: Any) -> None:
        self.callbacks[uuid] = callback

    async def write_gatt_char(self, uuid: str, data: bytes, response: bool) -> None:
        assert uuid == WRITE_UUID and response is False
        data = bytes(data)
        key = f"{data[6]}-{data[7]}"
        params = data[8:]
        self.writes.append(
            {
                "at_ms": round(self.now_ms()),
                "cmd": key,
                "req_seq": data[1],
                "params_hex": params.hex(),
            }
        )
        count = self._calls.get(key, 0)
        self._calls[key] = count + 1
        scripted = self.card.get("on_command", {}).get(key)
        if scripted is not None:
            replies = scripted[min(count, len(scripted) - 1)]
            if replies == "default":  # 这一次按默认行为回（脚本只改写个别几次调用）
                self._default_reply(key, params, data[1])
                return
            for reply in replies:
                self._schedule(
                    Notification(
                        reply["channel"],
                        reply.get("delay_ms", 0),
                        reply.get("frames", []),
                        reply.get("split_at", []),
                        reply.get("raw_hex"),
                    )
                )
            return
        self._default_reply(key, params, data[1])

    # ---- 默认行为（脚本没写时，模拟 A 卡 V1.0.0 的实测习惯） ----
    def _default_reply(self, key: str, params: bytes, req_seq: int) -> None:
        now = self.now_ms()
        delay = self.card.get("reply_delay_ms", 5)
        if key == "0-3":
            self._reply(
                "ae23", delay, {"type": 0, "cmd": 4, "params_hex": "63"}, req_seq
            )  # 实测：电量从 AE23 回来
        elif key == "0-1":
            self._reply(
                "ae22",
                delay,
                {"type": 0, "cmd": 2, "params_hex": "c0a6d10100b8d101"},
                req_seq,
            )
        elif key == "0-10":
            self._reply(
                "ae22", delay, {"type": 0, "cmd": 11, "params_text": "V1.0.0"}, req_seq
            )
        elif key == "3-19":
            state = timeline_value(
                self.card.get("record_state", [{"from_ms": 0, "state": 2}]),
                now,
                "state",
            )
            self._reply(
                "ae22",
                delay,
                {"type": 3, "cmd": 20, "params_hex": f"{state:02x}"},
                req_seq,
            )
        elif key == "2-0":
            names = timeline_value(self.card["files"], now, "names")
            body = len(names).to_bytes(4, "big")
            for name in names:
                body += (
                    (1).to_bytes(4, "big")
                    + (1000).to_bytes(4, "big")
                    + name.encode()[:20].ljust(20, b"\0")
                )
            self._reply(
                "ae22", delay, {"type": 2, "cmd": 1, "params_hex": body.hex()}, req_seq
            )
            by_call = self.card.get("list_end_delay_ms_by_call")
            extra = by_call[min(self._calls["2-0"] - 1, len(by_call) - 1)] if by_call else self.card.get("list_end_delay_ms", 0)
            end_delay = delay + extra
            self._reply(
                "ae22", end_delay, {"type": 2, "cmd": 18, "params_hex": "00"}, req_seq
            )
        elif key == "2-2":
            name = decode_text(params[4:28])
            self._reply(
                "ae22", delay, {"type": 2, "cmd": 3, "params_text": name}, req_seq
            )
            data = self._wav[int.from_bytes(params[0:4], "little") :]
            for index in range(0, len(data), 200):
                chunk = data[index : index + 200]
                self._reply(
                    "ae22",
                    delay + 1 + (index // 200) * self.card.get("ms_per_data_frame", 0.1),
                    {"type": 2, "cmd": 4, "params_hex": chunk.hex()},
                    req_seq,
                )
            end_at = delay + 2 + (len(data) // 200 + 1) * self.card.get("ms_per_data_frame", 0.1)
            end_at += self.card.get("end_extra_delay_ms", 0)
            self._reply(
                "ae22", end_at, {"type": 2, "cmd": 5, "params_hex": "00"}, req_seq
            )
            duplicate = self.card.get("duplicate_end_after_ms")
            if duplicate is not None:
                self._reply(
                    "ae22",
                    end_at + duplicate,
                    {"type": 2, "cmd": 5, "params_hex": "00"},
                    req_seq,
                )
        # 2-7 等命令：卡不回（与实测一致：没有观察到应答）

    def _reply(
        self, channel: str, delay_ms: float, spec: dict[str, Any], req_seq: int
    ) -> None:
        self._schedule(
            Notification(
                channel, delay_ms, [{**spec, "seq": self._seq_for(req_seq, spec)}]
            )
        )

    def _seq_for(self, req_seq: int, spec: dict[str, Any]) -> int:
        mode = self.card.get("reply_seq", "echo")
        if "seq" in spec:
            return spec["seq"]
        if mode == "echo":
            return req_seq
        if mode == "zero":
            return 0
        self._reply_seq = (
            self._reply_seq * 37 + 11
        ) & 0xFF  # "scrambled"：和请求序号无关
        return self._reply_seq

    # ---- 调度 ----
    def now_ms(self) -> float:
        return (asyncio.get_running_loop().time() - self._started) * 1000

    def _schedule(self, note: Notification, absolute: bool = False) -> None:
        loop = self._loop or asyncio.get_running_loop()
        if note.raw_hex is not None:
            data = bytes.fromhex(note.raw_hex.replace(" ", ""))
        else:
            data = b"".join(
                frame_bytes(spec, spec.get("seq", 0)) for spec in note.frames
            )
        start_s = note.delay_ms / 1000
        if absolute:
            start_s = max(0.0, note.delay_ms / 1000 - (loop.time() - self._started))
        for index, piece in enumerate(split(data, note.split_at)):
            handle = loop.call_later(
                start_s + index * PIECE_GAP_S, self._deliver, note.channel, piece
            )
            self._pending.append(handle)

    def _deliver(self, channel: str, piece: bytes) -> None:
        if not self.is_connected:
            return  # 断开期间的通知收不到
        callback = self.callbacks.get(CHANNEL_UUID[channel])
        if callback is not None:
            callback(None, bytearray(piece))

    def _drop(self) -> None:
        if not self.is_connected:
            return
        self.is_connected = False
        self.drops += 1
        callback = getattr(self, "disconnected_callback", None)
        if callback is not None:
            callback(self)

    def close(self) -> None:
        for handle in self._pending:
            handle.cancel()


async def connect_link(card: ScriptedCard) -> CardLink:
    def factory(
        _address: str, disconnected_callback: Any, timeout: float
    ) -> ScriptedCard:
        card.disconnected_callback = disconnected_callback
        return card

    link = CardLink(factory, write_room_wait_s=0.1, write_room_poll_s=0.01)
    await link.connect("SCRIPTED-CARD")
    return link
