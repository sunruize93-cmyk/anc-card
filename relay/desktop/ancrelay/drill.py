"""实时推流与断连恢复演练。

一边收音频一边读控制台命令：
  /drop  主动断开蓝牙（不发结束命令，模拟真实掉线）
  /back  重新连接并恢复推流
  /stop  结束推流，列出卡内文件
  其他文字  记一个带时间的口令标记
意外掉线时自动重连。
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

from .evidence import EvidenceLog
from .ops import list_files, record_state_name
from .protocol import (
    Frame,
    cmd_get_record_state,
    cmd_start_realtime,
    cmd_stop_realtime,
    decode_text,
)
from .stream import StreamRecorder
from .transport import LinkLost

DRAIN_S = 1.0
PROGRESS_EVERY_PACKETS = 500  # 10 秒音频
BUTTON_EVENTS = {1: "start", 3: "save", 5: "pause", 7: "resume"}
CLOSING_COMMANDS = frozenset({"/drop", "/stop"})


def _describe(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}"


class StreamDrill:
    def __init__(
        self,
        *,
        connect: Callable[[], Awaitable[Any]],
        recorder: StreamRecorder,
        log: EvidenceLog,
        commands: asyncio.Queue[str],
        max_seconds: float | None = None,
        poll_s: float = 0.5,
        reconnect_wait_s: float = 2.0,
    ) -> None:
        self._connect = connect
        self._recorder = recorder
        self._log = log
        self._commands = commands
        self._max_seconds = max_seconds
        self._poll_s = poll_s
        self._reconnect_wait_s = reconnect_wait_s
        self._link: Any = None
        self._round = 0
        self._manual_drop = False
        self._retry_at = 0.0
        self._stopping = False
        self._next_progress = PROGRESS_EVERY_PACKETS

    async def run(self) -> dict[str, Any]:
        frame_task: asyncio.Task[Any] | None = None
        command_task: asyncio.Task[str] | None = None
        try:
            await self._open()
            started = time.monotonic()
            command_task = asyncio.create_task(self._commands.get())
            while True:
                if (
                    self._max_seconds is not None
                    and time.monotonic() - started >= self._max_seconds
                ):
                    frame_task = await self._settle(frame_task)
                    self._log.event("time_limit_reached", seconds=self._max_seconds)
                    await self._stop()
                    break
                if (
                    self._link is None
                    and not self._manual_drop
                    and time.monotonic() >= self._retry_at
                ):
                    await self._reconnect()
                if self._link is not None and frame_task is None:
                    frame_task = asyncio.create_task(
                        self._link.next_frame(self._poll_s)
                    )

                waiting = (
                    {command_task} if frame_task is None else {command_task, frame_task}
                )
                done, _pending = await asyncio.wait(
                    waiting, timeout=self._poll_s, return_when=asyncio.FIRST_COMPLETED
                )

                if frame_task is not None and frame_task in done:
                    frame_task = await self._settle(frame_task)

                if command_task in done:
                    command = command_task.result().strip()
                    command_task = asyncio.create_task(self._commands.get())
                    if command in CLOSING_COMMANDS:
                        # 先把已经到手的那一帧处理掉，再断开或结束。
                        frame_task = await self._settle(frame_task)
                    if await self._on_command(command):
                        break
        finally:
            await self._abandon(frame_task)
            await self._abandon(command_task)
            await self._abort_stream()

        summary = self._recorder.summary()
        self._log.event(
            "summary",
            segments=len(summary["segments"]),
            total_packets=summary["total_packets"],
            total_audio_s=summary["total_audio_ms"] / 1000,
            gaps_ms=[gap["gap_ms"] for gap in summary["gaps"]],
            stream_names=summary["stream_names"],
        )
        return summary

    async def _open(self) -> None:
        link = await self._connect()
        self._link = link
        self._round += 1
        self._manual_drop = False
        self._stopping = False
        self._log.event(
            "connected" if self._round == 1 else "reconnected", round=self._round
        )
        self._recorder.begin_segment(self._round)
        self._next_progress = PROGRESS_EVERY_PACKETS
        await link.send(cmd_get_record_state())
        await link.send(cmd_start_realtime())
        self._log.event("stream_start_sent", round=self._round)

    async def _reconnect(self) -> bool:
        try:
            await self._open()
        except Exception as error:  # noqa: BLE001 - 蓝牙库在不同平台抛的类型不一；记下来，稍后再试
            await self._close_link()
            self._end_segment("reconnect_failed")
            self._retry_at = time.monotonic() + self._reconnect_wait_s
            self._log.event("reconnect_failed", error=_describe(error))
            return False
        return True

    async def _settle(self, task: asyncio.Task[Any] | None) -> None:
        """收掉一个读帧任务：已完成的把结果处理掉，没完成的取消。总是返回 None，方便赋值。

        取消不会丢帧：连接对象把取队列的任务保留给下一次读取。
        """
        if task is None:
            return None
        if not task.done():
            await self._abandon(task)
            return None
        try:
            item = task.result()
        except LinkLost as error:
            await self._on_loss(str(error))
        else:
            if item is not None:
                self._on_frame(*item)
        self._log_card_events()
        return None

    def _log_card_events(self) -> None:
        """机身按键事件现在单独排队（见 transport.CardLink），不再出现在读帧结果里，在这里取出记日志。"""
        take = getattr(self._link, "take_events", None)
        if take is None:
            return
        for event in take():
            self._log.event("button", action=BUTTON_EVENTS.get(event.cmd, f"3-{event.cmd}"),
                            source=event.source, repeats=event.repeats)

    @staticmethod
    async def _abandon(task: asyncio.Task[Any] | None) -> None:
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, LinkLost):
            pass

    async def _on_loss(self, reason: str) -> None:
        if self._link is None:
            return
        self._log.event("link_lost", reason=reason, round=self._round)
        self._end_segment("link_lost")
        await self._close_link()
        self._retry_at = time.monotonic() + self._reconnect_wait_s

    async def _on_command(self, command: str) -> bool:
        if not command:
            return False
        if command == "/stop":
            await self._stop()
            return True
        if command == "/drop":
            if self._link is None:
                self._log.event("drop_ignored", reason="当前没有连接")
                return False
            self._log.event("drop_requested", round=self._round)
            self._manual_drop = True
            await self._close_link()
            self._end_segment("manual_drop")
            return False
        if command == "/back":
            if self._link is not None:
                self._log.event("back_ignored", reason="已经连接")
                return False
            self._log.event("back_requested")
            self._manual_drop = False
            await self._reconnect()
            return False
        if command.startswith("/"):
            self._log.event("unknown_command", command=command)
            return False
        self._recorder.mark(command)
        self._log.event("mark", text=command)
        return False

    def _on_frame(self, source: str, frame: Frame) -> None:
        if frame.type == 1:
            if frame.cmd == 1:
                self._on_audio(frame.params)
            elif frame.cmd == 0:
                name = decode_text(frame.params)
                self._recorder.note_stream_name(name)
                self._log.event("stream_name", name=name, round=self._round)
            elif frame.cmd == 4 and frame.params:
                status = frame.params[0]
                self._log.event("stream_status", status=status)
                if status == 2 and not self._stopping:
                    self._end_segment("card_stopped")
        elif frame.type == 3:
            if frame.cmd == 20 and frame.params:
                self._log.event(
                    "record_state",
                    state=record_state_name(frame.params[0]),
                    round=self._round,
                )
            elif frame.cmd in BUTTON_EVENTS:
                self._log.event(
                    "button", action=BUTTON_EVENTS[frame.cmd], source=source
                )

    def _on_audio(self, payload: bytes) -> None:
        segment = self._recorder.current
        first = segment is not None and segment.first_frame_ms is None
        self._recorder.on_audio(payload)
        if segment is None:
            return
        if first and segment.first_frame_ms is not None:
            self._log.event(
                "first_frame",
                round=self._round,
                latency_ms=segment.first_frame_ms - segment.started_ms,
            )
        if segment.packets >= self._next_progress:
            self._next_progress += PROGRESS_EVERY_PACKETS
            self._log.event(
                "progress", packets=segment.packets, audio_s=segment.packets * 20 / 1000
            )

    async def _stop(self) -> None:
        if self._link is None:
            self._log.event("stopped_while_disconnected")
            return
        self._stopping = True
        try:
            await self._link.send(cmd_stop_realtime())
            self._log.event("stop_sent", round=self._round)
            deadline = time.monotonic() + DRAIN_S
            while (remaining := deadline - time.monotonic()) > 0:
                item = await self._link.next_frame(min(remaining, self._poll_s))
                if item is None:
                    break
                self._on_frame(*item)
            self._end_segment("stopped")
            files = await list_files(self._link)
            self._log.event(
                "card_files", count=len(files), names=[entry.name for entry in files]
            )
        except Exception as error:  # noqa: BLE001 - 结束阶段出任何错都要走完收尾，已收到的音频不能丢
            self._end_segment("stopped")
            self._log.event("stop_incomplete", error=_describe(error))
        finally:
            await self._close_link()

    async def _abort_stream(self) -> None:
        """非正常退出（异常、Ctrl+C）时的收尾：尽量让卡停止推流，结束当前段，放掉连接。"""
        if self._link is not None and not self._stopping:
            try:
                await self._link.send(cmd_stop_realtime())
                self._log.event("stop_sent_on_abort", round=self._round)
            except Exception as error:  # noqa: BLE001 - 已经在退出路上，发不出去就记一笔
                self._log.event("stop_on_abort_failed", error=_describe(error))
        self._end_segment("aborted")
        await self._close_link()

    def _end_segment(self, reason: str) -> None:
        segment = self._recorder.end_segment(reason)
        if segment is not None:
            self._log.event("segment_end", **_segment_fields(segment.as_dict()))

    async def _close_link(self) -> None:
        link, self._link = self._link, None
        if link is None:
            return
        try:
            await link.disconnect()
        except Exception as error:  # noqa: BLE001 - 断开失败不该让演练中止，记下来即可
            self._log.event("disconnect_error", error=_describe(error))


def _segment_fields(segment: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "index",
        "connection_round",
        "end_reason",
        "packets",
        "bytes",
        "audio_ms",
        "first_frame_ms",
        "last_frame_ms",
        "first_frame_latency_ms",
        "odd_payloads",
        "raw_file",
    )
    return {key: segment[key] for key in keys}
