"""机身事件队列和应答队列分流：容量、去重、生命周期、旧应答清理。用替身客户端，不碰蓝牙。"""

import asyncio
import unittest

from ancrelay.protocol import KEY_NOTIFY_UUID, NOTIFY_UUID, build_frame
from ancrelay.transport import EVENT_CAPACITY, CardLink, LinkLost

from test_transport import FakeClient


def make_link(client: FakeClient) -> CardLink:
    def factory(_address, disconnected_callback, timeout):
        client.disconnected_callback = disconnected_callback
        return client

    return CardLink(factory, write_room_wait_s=0.05, write_room_poll_s=0.01)


class EventQueueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = FakeClient()
        self.link = make_link(self.client)
        await self.link.connect("AA:BB")
        self.ae22 = self.client.callbacks[NOTIFY_UUID]
        self.ae23 = self.client.callbacks[KEY_NOTIFY_UUID]

    def push(self, callback, *payloads: bytes) -> None:
        callback(None, bytearray(b"".join(build_frame(p, 0) for p in payloads)))

    async def test_save_button_goes_to_events_and_battery_to_responses(self):
        self.push(
            self.ae23, bytes([0, 4, 99]), bytes([3, 3])
        )  # 同一条 AE23 通知里：电量应答 + 保存事件
        source, frame = await self.link.next_frame(0.2)
        self.assertEqual((source, frame.type, frame.cmd), ("ae23", 0, 4))
        self.assertIsNone(await self.link.next_frame(0.05))  # 应答队列里没有 3-3
        event = await self.link.next_event(0.2)
        self.assertEqual((event.type, event.cmd, event.repeats), (3, 3, 1))

    async def test_waiting_for_a_response_does_not_swallow_events(self):
        self.push(self.ae22, bytes([2, 4]) + bytes(200))
        self.push(self.ae23, bytes([3, 3]))
        self.push(self.ae22, bytes([2, 5, 0]))
        seen = [(await self.link.next_frame(0.2))[1].cmd for _ in range(2)]
        self.assertEqual(seen, [4, 5])
        self.assertEqual(
            [(e.type, e.cmd) for e in self.link.pending_events()], [(3, 3)]
        )

    async def test_duplicate_events_are_queued_once_until_taken(self):
        self.push(self.ae23, bytes([3, 3]))
        self.push(self.ae23, bytes([3, 3]))
        self.push(self.ae23, bytes([3, 3]))
        pending = self.link.pending_events()
        self.assertEqual([(e.cmd, e.repeats) for e in pending], [(3, 3)])
        self.assertEqual(len(self.link.take_events()), 1)
        self.push(self.ae23, bytes([3, 3]))  # 取走之后再来的，是新的一次
        self.assertEqual(
            [(e.cmd, e.repeats) for e in self.link.pending_events()], [(3, 1)]
        )

    async def test_different_events_keep_arrival_order(self):
        self.push(self.ae23, bytes([3, 1]), bytes([3, 3]), bytes([3, 5]))
        self.assertEqual([e.cmd for e in self.link.pending_events()], [1, 3, 5])
        first = await self.link.next_event(0.1)
        self.assertEqual(first.cmd, 1)
        taken = self.link.take_events(lambda e: e.cmd == 5)
        self.assertEqual([e.cmd for e in taken], [5])
        self.assertEqual([e.cmd for e in self.link.pending_events()], [3])

    async def test_capacity_drops_the_oldest_and_counts(self):
        for index in range(EVENT_CAPACITY + 4):
            self.push(self.ae23, bytes([3, 3, index]))  # 参数不同，不算重复
        pending = self.link.pending_events()
        self.assertEqual(len(pending), EVENT_CAPACITY)
        self.assertEqual(self.link.dropped_events, 4)
        self.assertEqual(pending[0].params, bytes([4]))

    async def test_next_event_waits_then_times_out(self):
        self.assertIsNone(await self.link.next_event(0.05))
        asyncio.get_running_loop().call_later(0.02, self.push, self.ae23, bytes([3, 3]))
        event = await self.link.next_event(0.5)
        self.assertEqual(event.cmd, 3)

    async def test_disconnect_discards_pending_events(self):
        self.push(self.ae23, bytes([3, 3]))
        await self.link.disconnect()
        self.assertEqual(self.link.pending_events(), [])
        with self.assertRaises(LinkLost):
            await self.link.next_event(0.05)

    async def test_unexpected_drop_discards_events_and_wakes_the_waiter(self):
        waiter = asyncio.create_task(self.link.next_event(5))
        await asyncio.sleep(0.01)
        self.push(self.ae23, bytes([3, 3]))
        await asyncio.sleep(0)  # 让等待者先拿到这一条
        self.assertEqual((await waiter).cmd, 3)
        self.push(self.ae23, bytes([3, 5]))
        self.client.is_connected = False
        self.client.disconnected_callback(self.client)
        self.assertEqual(self.link.pending_events(), [])
        with self.assertRaises(LinkLost):
            await self.link.next_event(0.05)

    async def test_new_connection_starts_with_no_events(self):
        self.push(self.ae23, bytes([3, 3]))
        await self.link.disconnect()
        fresh = make_link(FakeClient())
        await fresh.connect("AA:BB")
        self.assertEqual(fresh.pending_events(), [])
        self.assertIsNone(await fresh.next_event(0.05))


class DrainResponsesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = FakeClient()
        self.link = make_link(self.client)
        await self.link.connect("AA:BB")
        self.ae22 = self.client.callbacks[NOTIFY_UUID]

    def push(self, *payloads: bytes) -> None:
        self.ae22(None, bytearray(b"".join(build_frame(p, 0) for p in payloads)))

    async def test_only_matching_frames_are_removed_and_order_is_kept(self):
        self.push(
            bytes([2, 18, 0]),
            bytes([0, 4, 99]),
            bytes([2, 1, 0, 0, 0, 0]),
            bytes([3, 20, 2]),
        )
        drained = self.link.drain_responses(lambda _s, f: f.type == 2)
        self.assertEqual([f.cmd for _s, f in drained], [18, 1])
        rest = [(await self.link.next_frame(0.1))[1] for _ in range(2)]
        self.assertEqual([(f.type, f.cmd) for f in rest], [(0, 4), (3, 20)])

    async def _reader_waiting_on_getter(self) -> asyncio.Task:
        reader = asyncio.create_task(self.link.next_frame(5))
        while self.link._getter is None:  # 屏障：读者已经建好取帧任务、在等它
            await asyncio.sleep(0)
        return reader

    async def test_frame_already_taken_by_an_abandoned_reader_is_included(self):
        # 用确定性屏障固定「取帧任务已经拿到帧、读者还没被唤醒」这个时刻再取消，
        # 不靠 sleep(0.01)：那个时长在 Windows（时钟分辨率约 15.6 ms）和 macOS 上让出的轮数不同。
        reader = await self._reader_waiting_on_getter()
        self.push(bytes([2, 18, 0]))
        while not self.link._getter.done():  # 屏障：帧已经被取帧任务拿走
            await asyncio.sleep(0)
        self.assertFalse(reader.done(), "前提：读者还没被唤醒（帧已取未交付）")
        reader.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await reader
        drained = self.link.drain_responses(lambda _s, f: f.cmd == 18)
        self.assertEqual(len(drained), 1)
        self.assertIsNone(await self.link.next_frame(0.05))

    async def test_cancel_at_any_point_delivers_the_frame_exactly_once(self):
        # 帧到达后在第 0、1、2…… 轮取消读者：无论读者已经返回还是被取消，这一帧都恰好交付一次，
        # 要么由读者返回，要么由 drain_responses 取到，不会丢，也不会两边都拿到。
        outcomes = set()
        for yields in range(8):
            reader = await self._reader_waiting_on_getter()
            self.push(bytes([2, 18, 0]))
            for _ in range(yields):
                await asyncio.sleep(0)
            reader.cancel()
            try:
                got = [await reader]
                outcomes.add("reader_returned")
            except asyncio.CancelledError:
                got = []
                outcomes.add("reader_cancelled")
            got += self.link.drain_responses(lambda _s, f: f.cmd == 18)
            self.assertEqual(
                len(got), 1, f"让出 {yields} 轮后取消：交付了 {len(got)} 次"
            )
            self.assertIsNone(await self.link.next_frame(0.02), "队列里还有残留")
        self.assertEqual(
            outcomes,
            {"reader_returned", "reader_cancelled"},
            "两种取消时机都应当被覆盖到",
        )

    async def test_events_are_never_drained(self):
        self.client.callbacks[KEY_NOTIFY_UUID](
            None, bytearray(build_frame(bytes([3, 3]), 0))
        )
        self.assertEqual(self.link.drain_responses(lambda _s, _f: True), [])
        self.assertEqual(len(self.link.pending_events()), 1)


if __name__ == "__main__":
    unittest.main()
