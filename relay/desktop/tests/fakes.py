"""测试用的假蓝牙连接：按脚本回帧，不碰真实硬件。"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Callable, Iterable
from typing import Any

from ancrelay.protocol import Frame
from ancrelay.safety import assert_safe


def frame(type_: int, cmd: int, params: bytes = b"") -> Frame:
    return Frame(seq=0, payload=bytes([type_, cmd]) + params)


class FakeLink:
    """`responder(payload)` 返回这条命令引出的条目：Frame、异常（读到时抛出）或可调用对象（读到时执行）。"""

    def __init__(
        self, responder: Callable[[bytes], Iterable[Any]] | None = None
    ) -> None:
        self._responder = responder or (lambda _payload: [])
        self._queue: deque[Any] = deque()
        self.sent: list[bytes] = []
        self.connected = True
        self.disconnect_calls = 0

    def push(self, *items: Any) -> None:
        self._queue.extend(items)

    async def send(self, payload: bytes) -> None:
        assert_safe(payload)
        self.sent.append(payload)
        self._queue.extend(self._responder(payload))

    async def next_frame(self, timeout: float) -> tuple[str, Frame] | None:
        await asyncio.sleep(0)
        while self._queue:
            item = self._queue.popleft()
            if isinstance(item, Exception):
                raise item
            if callable(item):
                item()
                continue
            return ("ae22", item)
        return None

    async def disconnect(self) -> None:
        self.connected = False
        self.disconnect_calls += 1
