"""对录音卡的只读操作：读状态、列文件、下载一个文件。

流程和超时照厂商的 qs668-bringup.py 和协议文档写；这里不依赖蓝牙库，
只要求传入的连接对象有 `send(payload)` 和 `next_frame(timeout)`。
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from .protocol import (
    IMPORT_FRAME_BYTES,
    FileEntry,
    Frame,
    build_frame,
    cmd_abort_import,
    cmd_get_battery,
    cmd_get_capacity,
    cmd_get_firmware,
    cmd_get_record_state,
    cmd_import_file,
    cmd_list_files,
    decode_text,
    import_name_candidates,
    parse_file_list,
)

STATUS_TIMEOUT_S = 4.0
LIST_FIRST_TIMEOUT_S = 4.0
LIST_IDLE_S = 1.2
IMPORT_IDLE_S = 12.0
RECORD_STATE_TIMEOUT_S = 3.0
CHARGING = 110

LIST_ATTEMPTS = 2  # 第一次加一次受限重试
LATE_END_DEBT_CAP = 1  # 迟到结束帧欠账的上限：旧固件不发 2-18 时也不会无限增长
RECORD_STATES = {1: "recording", 2: "idle", 3: "paused"}
END_CODES = {0: "完成", 1: "文件不存在", 2: "偏移过大", 3: "其他原因停止"}


class CardError(RuntimeError):
    """录音卡没有按协议回应。"""


class PullFailed(CardError):
    """下载中途失败。`partial` 是失败前已经收到的字节，调用方可以留作证据。"""

    def __init__(self, message: str, *, requested_name: str, partial: bytes) -> None:
        super().__init__(message)
        self.requested_name = requested_name
        self.partial = partial


class ListUncertain(CardError):
    """列表结果无法确认：只收到孤立的结束帧，没有列表帧。不能当成空列表。"""


class Link(Protocol):
    async def send(self, payload: bytes) -> None: ...

    async def next_frame(self, timeout: float) -> tuple[str, Frame] | None: ...


@dataclass(frozen=True)
class PulledFile:
    requested_name: str
    reported_name: str
    data: bytes
    attempts: list[str] = field(default_factory=list)
    offset: int = 0
    data_frames: int = 0
    end_code: int | None = None  # None 表示按 stop_after 主动提前停下，没等到 2-5
    start_seen: bool = False  # 收到过 2-3


def stem_of(list_name: str) -> str:
    """列表名去掉末尾的点和扩展名：`note…-121309.` 和 `note…-121309.wav` 都得到 `note…-121309`。"""
    name = list_name.strip().rstrip(".")
    for extension in (".wav", ".opus"):
        if name.lower().endswith(extension):
            return name[: -len(extension)]
    return name


def record_state_name(code: int) -> str:
    return RECORD_STATES.get(code, f"unknown({code})")


async def read_status(link: Link) -> dict[str, Any]:
    status: dict[str, Any] = {
        "battery_percent": None,
        "charging": None,
        "remaining_kb": None,
        "total_kb": None,
        "firmware": None,
    }
    await link.send(cmd_get_battery())
    await link.send(cmd_get_capacity())
    await link.send(cmd_get_firmware())

    deadline = time.monotonic() + STATUS_TIMEOUT_S
    while any(status[key] is None for key in ("charging", "total_kb", "firmware")):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        item = await link.next_frame(remaining)
        if item is None:
            break
        _source, frame = item
        if frame.type != 0:
            continue
        if frame.cmd == 4 and frame.params:
            value = frame.params[0]
            status["charging"] = value == CHARGING
            status["battery_percent"] = None if value == CHARGING else value
        elif frame.cmd == 2 and len(frame.params) >= 8:
            status["remaining_kb"] = int.from_bytes(frame.params[0:4], "little")
            status["total_kb"] = int.from_bytes(frame.params[4:8], "little")
        elif frame.cmd == 11:
            status["firmware"] = decode_text(frame.params)

    if status["charging"] is None:
        raise CardError("没有收到电量应答（0-4）")
    return status


async def read_record_state(link: Link) -> str:
    await link.send(cmd_get_record_state())
    deadline = time.monotonic() + RECORD_STATE_TIMEOUT_S
    while (remaining := deadline - time.monotonic()) > 0:
        item = await link.next_frame(remaining)
        if item is None:
            break
        _source, frame = item
        if frame.type == 3 and frame.cmd == 20 and frame.params:
            return record_state_name(frame.params[0])
    raise CardError("没有收到录音状态应答（3-20）")


async def list_files(link: Link) -> list[FileEntry]:
    """读文件列表。等到 2-18；旧固件不发 2-18 时，最后一帧后空闲约 1.2 秒算收齐。

    应答序号不可靠，没法用它把 2-18 对应到请求，所以按下面的规则区分新旧结束帧：

    - 发 2-0 之前，队列里已经到达的 2-1/2-18 都是上一轮的，先取出丢掉。
    - 本轮还没收到 2-1 时来的 2-18 一律当孤立帧，不当结束。
    - 上一轮如果是靠空闲超时结束的（没等到它的 2-18），它的 2-18 可能还会迟到：
      链路上记一笔 `late_list_ends`。有这笔欠账时，本轮 2-1 之后来的第一个 2-18
      也先当作可能是旧的，继续收一个空闲周期。
    - 只收到孤立的 2-18、一直没有 2-1：重试一次；仍然这样就抛 ListUncertain，
      不返回空列表冒充成功。

    每次调用的情况写在 `link.last_list_report`，供日志和测试使用。
    """
    report: dict[str, Any] = {"attempts": 0, "stale_drained": 0, "orphan_ends": 0, "ended_by": None}
    try:
        for _attempt in range(LIST_ATTEMPTS):
            report["attempts"] += 1
            files = await _list_once(link, report)
            if files is not None:
                return files
        raise ListUncertain(
            f"列表不确定：发了 {report['attempts']} 次 2-0，只收到 {report['orphan_ends']} 个孤立的 2-18，"
            "一直没有 2-1。不能当成空列表。"
        )
    finally:
        _set(link, "last_list_report", report)


async def _list_once(link: Link, report: dict[str, Any]) -> list[FileEntry] | None:
    debt = getattr(link, "late_list_ends", 0)
    drain = getattr(link, "drain_responses", None)
    if drain is not None:
        stale = drain(_is_list_frame)
        stale_ends = sum(1 for _source, frame in stale if frame.cmd == 18)
        report["stale_drained"] += len(stale)
        debt = max(0, debt - stale_ends)

    files: list[FileEntry] = []
    got_list_frame = False
    ended_by_end_frame = False
    assumed_stale_after_list = False
    orphans = 0
    await link.send(cmd_list_files())
    while True:
        item = await link.next_frame(LIST_IDLE_S if got_list_frame else LIST_FIRST_TIMEOUT_S)
        if item is None:
            if got_list_frame:
                break
            _set(link, "late_list_ends", debt)
            if orphans:
                return None  # 只有孤立的结束帧：交给上层受限重试
            raise CardError("没有收到文件列表（2-1）")
        _source, frame = item
        if frame.type != 2:
            continue
        if frame.cmd == 1:
            got_list_frame = True
            files.extend(parse_file_list(frame.params))
        elif frame.cmd == 18:
            if not got_list_frame:
                orphans += 1
                report["orphan_ends"] += 1
                debt = max(0, debt - 1)
                continue
            if debt > 0:
                debt -= 1  # 可能是上一轮迟到的结束帧：不结束，再收一个空闲周期
                assumed_stale_after_list = True
                continue
            ended_by_end_frame = True
            break

    if not ended_by_end_frame and not assumed_stale_after_list:
        debt = min(debt + 1, LATE_END_DEBT_CAP)  # 本轮靠空闲结束，它的 2-18 之后可能还会迟到
    # 本轮在 2-1 之后已经收到过一个 2-18（当作旧的抵了账）、之后再没有 2-18：
    # 它多半就是本轮自己的，不再加欠账，否则上一轮的 2-18 真丢了时欠账会永远清不掉。
    report["ended_by"] = "2-18" if ended_by_end_frame else "idle"
    report["ambiguous_end"] = assumed_stale_after_list and not ended_by_end_frame
    _set(link, "late_list_ends", debt)
    return files


def _is_list_frame(_source: str, frame: Frame) -> bool:
    return frame.type == 2 and frame.cmd in (1, 18)


def _set(link: Link, name: str, value: Any) -> None:
    try:
        setattr(link, name, value)
    except AttributeError:
        pass


async def pull_file(
    link: Link,
    list_name: str,
    *,
    idle_timeout_s: float = IMPORT_IDLE_S,
    on_progress: Callable[[int], None] | None = None,
    offset: int = 0,
    exact: bool = False,
    stop_after: int | None = None,
) -> PulledFile:
    """下载一个文件。列表里的名字可能被截掉扩展名，按 .wav → .opus → 原名依次尝试。

    只有「文件不存在且一个字节都没收到」才换下一个名字；收到数据后再出问题一律报错，
    不换名字重试。

    - `exact`：只请求给定的名字，不试别的扩展名（例如专门取 .opus）。
    - `offset`：从第几个字节开始（协议 2-2 的 offset 参数）。
    - `stop_after`：收到这么多字节就停止读取并返回，不发终止命令，用来模拟中途掉线。
    """
    if offset < 0:
        raise CardError("offset 不能是负数")
    attempts: list[str] = []
    last_error = "下载失败"
    candidates = [list_name] if exact else import_name_candidates(list_name)

    for name in candidates:
        payload = cmd_import_file(name, offset)
        frame_size = len(build_frame(payload, 0))
        if frame_size != IMPORT_FRAME_BYTES:
            raise CardError(
                f"下载请求帧应为 {IMPORT_FRAME_BYTES} 字节，实际 {frame_size} 字节：{name}"
            )
        attempts.append(name)
        await link.send(payload)

        chunks: list[bytes] = []
        received = 0
        data_frames = 0
        reported = name
        started = False
        missing = False
        deadline = time.monotonic() + idle_timeout_s
        while (remaining := deadline - time.monotonic()) > 0:
            item = await link.next_frame(remaining)
            if item is None:
                break
            _source, frame = item
            if frame.type != 2:
                continue
            if frame.cmd == 3:
                started = True
                reported = decode_text(frame.params) or name
                deadline = time.monotonic() + idle_timeout_s
            elif frame.cmd == 4:
                chunks.append(frame.params)
                received += len(frame.params)
                data_frames += 1
                deadline = time.monotonic() + idle_timeout_s
                if on_progress is not None:
                    on_progress(received)
                if stop_after is not None and received >= stop_after:
                    return PulledFile(name, reported, b"".join(chunks), attempts, offset,
                                      data_frames, None, started)
            elif frame.cmd == 5:
                code = frame.params[0] if frame.params else 3
                if code == 0:
                    if not chunks:
                        raise CardError(f"{name}：卡说下载完成，但一个字节都没有发来")
                    return PulledFile(name, reported, b"".join(chunks), attempts, offset,
                                      data_frames, 0, started)
                if code == 1 and not chunks:
                    missing = True
                    last_error = f"{name}：文件不存在"
                    break
                raise PullFailed(
                    f"{name}：结束码 {code}（{END_CODES.get(code, '未知')}），已收到 {received} 字节",
                    requested_name=name,
                    partial=b"".join(chunks),
                )

        if missing:
            continue
        if started or chunks:
            # 卡可能还在发：先让它停，再报错或换下一个名字。
            await _abort_quietly(link)
        if chunks:
            raise PullFailed(
                f"{name}：收到 {received} 字节后 {idle_timeout_s:g} 秒没有新数据，下载中断",
                requested_name=name,
                partial=b"".join(chunks),
            )
        last_error = (
            f"{name}：已开始但没有数据也没有结束" if started else f"{name}：没有应答"
        )

    raise CardError(f"{last_error}（试过：{', '.join(attempts)}）")


async def _abort_quietly(link: Link) -> None:
    try:
        await link.send(cmd_abort_import())
    except RuntimeError:
        pass  # 连接已经断了就没什么可终止的；原来的下载错误照常上报
