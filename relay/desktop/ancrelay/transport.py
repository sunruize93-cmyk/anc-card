"""蓝牙连接（Bleak）。AE22 和 AE23 各自组帧；所有写入先过安全闸门。"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .protocol import (
    KEY_NOTIFY_UUID,
    NOTIFY_UUID,
    SERVICE_UUID,
    WRITE_UUID,
    Frame,
    FrameParser,
    build_frame,
)
from .safety import assert_safe

CONNECT_TIMEOUT_S = 20.0
SCAN_S = 8.0
DEFAULT_WRITE_ROOM = 20  # 还没协商出更大的 MTU 时，一次只能写 20 字节
WRITE_ROOM_WAIT_S = 10.0
WRITE_ROOM_POLL_S = 0.5
_LOST = object()
# AE23 上的机身按键事件：3-1 开始、3-3 保存、3-5 暂停、3-7 继续（协议文档）。
# 同一通道上的 0-4 电量应答不是事件，照旧进应答队列。
BUTTON_EVENT_CMDS = frozenset({1, 3, 5, 7})
EVENT_CAPACITY = 16


class LinkLost(RuntimeError):
    """蓝牙连接断了。"""


class FrameTooLarge(RuntimeError):
    """这一帧超过当前连接一次能写的长度。下载请求必须一次写完，所以不拆包，直接报错。"""


@dataclass(frozen=True)
class ScanHit:
    address: str
    name: str
    rssi: int | None


@dataclass
class CardEvent:
    """一条还没被处理的机身事件。同一事件在被取走前重复到达，只增加 repeats，不另起一条。"""

    source: str
    type: int
    cmd: int
    params: bytes
    first_at: float
    last_at: float
    repeats: int = 1

    def same_as(self, other: "CardEvent") -> bool:
        return (self.source, self.type, self.cmd, self.params) == (other.source, other.type, other.cmd, other.params)


def is_card_event(source: str, frame: Frame) -> bool:
    return source == "ae23" and frame.type == 3 and frame.cmd in BUTTON_EVENT_CMDS


@dataclass(frozen=True)
class LinkInfo:
    address: str
    mtu: int | None
    max_write: int
    key_events: bool


def _looks_like_card(name: str, service_uuids: list[str]) -> bool:
    lowered = name.lower()
    joined = " ".join(service_uuids)
    return (
        SERVICE_UUID in service_uuids
        or "ae20" in joined
        or "qs668" in lowered
        or "cb08" in lowered
    )


async def scan(timeout_s: float = SCAN_S) -> list[ScanHit]:
    """扫描附近广播 AE20 服务的录音卡。只听广播，不连接。"""
    from bleak import BleakScanner

    found = await BleakScanner.discover(timeout=timeout_s, return_adv=True)
    hits: list[ScanHit] = []
    for device, advertisement in found.values():
        uuids = [value.lower() for value in (advertisement.service_uuids or [])]
        name = device.name or advertisement.local_name or ""
        if _looks_like_card(name, uuids):
            hits.append(ScanHit(device.address, name or "(无名称)", advertisement.rssi))
    return sorted(
        hits, key=lambda hit: hit.rssi if hit.rssi is not None else -999, reverse=True
    )


def _bleak_client(address: str, **options: Any) -> Any:
    from bleak import BleakClient

    return BleakClient(address, **options)


def _ble_errors() -> tuple[type[BaseException], ...]:
    from bleak.exc import BleakError

    return (BleakError, OSError, asyncio.TimeoutError)


async def _quiet_disconnect(client: Any) -> None:
    try:
        await client.disconnect()
    except _ble_errors():
        pass  # 连接本来就没建好或已经断了，没有可以再做的


class CardLink:
    def __init__(
        self,
        client_factory: Callable[..., Any] | None = None,
        *,
        write_room_wait_s: float = WRITE_ROOM_WAIT_S,
        write_room_poll_s: float = WRITE_ROOM_POLL_S,
        trace: Callable[..., None] | None = None,
    ) -> None:
        self._client_factory = client_factory or _bleak_client
        # trace("tx", frame_bytes) 在每次 GATT 写入之前调用；trace("rx", source, Frame) 在每收齐一帧时调用。
        self._trace = trace
        self._write_room_wait_s = write_room_wait_s
        self._write_room_poll_s = write_room_poll_s
        self._client: Any = None
        self._write_char: Any = None
        self._events: asyncio.Queue[Any] = asyncio.Queue()  # 应答队列：命令的应答帧
        # 机身事件单独存放，命令等待者读不到、也就吞不掉。生命周期与本连接相同。
        self._card_events: deque[CardEvent] = deque()
        self._event_signal = asyncio.Event()
        self.dropped_events = 0
        # 以空闲超时结束、没等到 2-18 的列表请求数：它们的 2-18 可能还会迟到。
        self.late_list_ends = 0
        self._getter: asyncio.Future[Any] | None = None
        self._ae22 = FrameParser()
        self._ae23 = FrameParser()
        self._seq = 0
        self._lost = False

    @property
    def connected(self) -> bool:
        return (
            self._client is not None
            and bool(self._client.is_connected)
            and not self._lost
        )

    async def connect(
        self, address: str, timeout_s: float = CONNECT_TIMEOUT_S
    ) -> LinkInfo:
        client = self._client_factory(
            address, disconnected_callback=self._on_disconnect, timeout=timeout_s
        )
        await client.connect()
        try:
            await client.start_notify(NOTIFY_UUID, self._on_ae22)
            key_events = await self._subscribe_key_events(client)
            write_char = client.services.get_characteristic(WRITE_UUID)
            if write_char is None:
                raise LinkLost("这台设备没有 AE21 写入特征：不是录音卡，或者固件不兼容")
        except BaseException:
            # 订阅失败或被取消时，已经建好的连接要放掉，否则它会一直占着卡。
            await _quiet_disconnect(client)
            raise
        self._client = client
        self._write_char = write_char
        return LinkInfo(
            address, getattr(client, "mtu_size", None), self.write_room(), key_events
        )

    async def _subscribe_key_events(self, client: Any) -> bool:
        from bleak.exc import BleakError

        try:
            await client.start_notify(KEY_NOTIFY_UUID, self._on_ae23)
        except BleakError:
            return False  # 有的固件没有 AE23；没有它只是收不到机身按键事件
        return True

    def write_room(self) -> int:
        """当前连接一次能写多少字节。每次现读：刚连上时可能还是 20，协商完才变大。"""
        room = getattr(self._write_char, "max_write_without_response_size", None)
        return room if isinstance(room, int) and room > 0 else DEFAULT_WRITE_ROOM

    async def disconnect(self) -> None:
        client, self._client = self._client, None
        self._lost = True
        self._card_events.clear()  # 断开后旧事件作废，不带到下一个连接
        self._event_signal.set()
        if self._getter is not None:
            self._getter.cancel()
            self._getter = None
        if client is not None and client.is_connected:
            await client.disconnect()

    async def send(self, payload: bytes) -> None:
        assert_safe(payload)
        if not self.connected:
            raise LinkLost("蓝牙未连接")
        frame = build_frame(payload, self._seq)
        await self._wait_for_write_room(len(frame))
        self._seq = (self._seq + 1) & 0xFF
        if self._trace is not None:
            self._trace("tx", frame)
        try:
            # 整帧一次写入：下载请求的 36 字节不拆包。
            await self._client.write_gatt_char(WRITE_UUID, frame, response=False)
        except _ble_errors() as error:
            if self.connected:
                raise
            raise LinkLost(f"写入时连接已断开：{error}") from error

    async def _wait_for_write_room(self, size: int) -> None:
        deadline = asyncio.get_running_loop().time() + self._write_room_wait_s
        while (room := self.write_room()) < size:
            if not self.connected:
                raise LinkLost("等待连接参数时蓝牙断开")
            if asyncio.get_running_loop().time() >= deadline:
                raise FrameTooLarge(
                    f"这一帧 {size} 字节，当前连接一次只能写 {room} 字节（等了 {self._write_room_wait_s:g} 秒）。"
                    "下载请求必须一次写完，没有发送"
                )
            await asyncio.sleep(self._write_room_poll_s)

    async def next_frame(self, timeout: float) -> tuple[str, Frame] | None:
        """等下一帧，超时返回 None。

        取队列的任务跨调用保留：超时或调用方被取消时，已经到达的帧留给下一次调用，不会丢。
        """
        if self._getter is None:
            if self._lost and self._events.empty():
                raise LinkLost("蓝牙连接已断开")
            self._getter = asyncio.ensure_future(self._events.get())
        done, _pending = await asyncio.wait({self._getter}, timeout=timeout)
        if not done:
            return None
        item = self._getter.result()
        self._getter = None
        if item is _LOST:
            raise LinkLost("蓝牙连接已断开")
        return item

    # ---- 机身事件 ----
    def pending_events(self) -> list[CardEvent]:
        return list(self._card_events)

    def take_events(self, predicate: Callable[[CardEvent], bool] = lambda _e: True) -> list[CardEvent]:
        """取走满足条件的事件（按到达顺序），其余留下。"""
        taken = [e for e in self._card_events if predicate(e)]
        kept = [e for e in self._card_events if not predicate(e)]
        self._card_events = deque(kept)
        if not self._card_events:
            self._event_signal.clear()
        return taken

    async def next_event(self, timeout: float) -> CardEvent | None:
        """取最早的一条机身事件；超时返回 None。断开后抛 LinkLost。"""
        if not self._card_events:
            if self._lost:
                raise LinkLost("蓝牙连接已断开")
            try:
                await asyncio.wait_for(self._event_signal.wait(), timeout)
            except asyncio.TimeoutError:
                return None
        if not self._card_events:
            if self._lost:
                raise LinkLost("蓝牙连接已断开")
            self._event_signal.clear()
            return None
        event = self._card_events.popleft()
        if not self._card_events:
            self._event_signal.clear()
        return event

    def _push_event(self, source: str, frame: Frame) -> None:
        now = time.monotonic()
        event = CardEvent(source, frame.type, frame.cmd, bytes(frame.params), now, now)
        for pending in self._card_events:
            if pending.same_as(event):
                pending.repeats += 1
                pending.last_at = now
                return
        if len(self._card_events) >= EVENT_CAPACITY:
            self._card_events.popleft()  # 满了丢最旧的，并计数
            self.dropped_events += 1
        self._card_events.append(event)
        self._event_signal.set()

    # ---- 应答队列 ----
    def drain_responses(self, predicate: Callable[[str, Frame], bool]) -> list[tuple[str, Frame]]:
        """把队列里已经到达、满足条件的旧应答取出来丢掉，其余按原顺序放回。"""
        items: list[Any] = []
        if self._getter is not None and self._getter.done() and not self._getter.cancelled():
            items.append(self._getter.result())
            self._getter = None
        while not self._events.empty():
            items.append(self._events.get_nowait())
        drained = [i for i in items if i is not _LOST and predicate(*i)]
        for item in items:
            if item is _LOST or not predicate(*item):
                self._events.put_nowait(item)
        return drained

    def _on_ae22(self, _sender: Any, data: bytearray) -> None:
        for frame in self._ae22.push(bytes(data)):
            if self._trace is not None:
                self._trace("rx", "ae22", frame)
            self._events.put_nowait(("ae22", frame))

    def _on_ae23(self, _sender: Any, data: bytearray) -> None:
        for frame in self._ae23.push(bytes(data)):
            if self._trace is not None:
                self._trace("rx", "ae23", frame)
            if is_card_event("ae23", frame):
                self._push_event("ae23", frame)
            else:
                self._events.put_nowait(("ae23", frame))

    def _on_disconnect(self, _client: Any) -> None:
        self._lost = True
        self._card_events.clear()
        self._event_signal.set()
        self._events.put_nowait(_LOST)
