import asyncio
import unittest
from types import SimpleNamespace

from bleak.exc import BleakError

from ancrelay.protocol import (
    NOTIFY_UUID,
    WRITE_UUID,
    build_frame,
    cmd_import_file,
    cmd_list_files,
)
from ancrelay.safety import ForbiddenCommand
from ancrelay.transport import CardLink, FrameTooLarge, LinkLost


class FakeClient:
    """照 Bleak 客户端的样子做的替身，只实现 CardLink 用到的部分。"""

    def __init__(
        self, *, room=244, has_write_char=True, notify_error=None, key_error=None
    ) -> None:
        self.is_connected = False
        self.mtu_size = 247
        self.writes: list[tuple[str, bytes, bool]] = []
        self.callbacks: dict[str, object] = {}
        self.disconnects = 0
        self.disconnected_callback = None
        self._notify_error = notify_error
        self._key_error = key_error
        self.write_char = (
            SimpleNamespace(max_write_without_response_size=room)
            if has_write_char
            else None
        )
        self.services = SimpleNamespace(
            get_characteristic=lambda _uuid: self.write_char
        )

    async def connect(self) -> None:
        self.is_connected = True

    async def disconnect(self) -> None:
        self.is_connected = False
        self.disconnects += 1

    async def start_notify(self, uuid: str, callback) -> None:
        if uuid == NOTIFY_UUID and self._notify_error:
            raise self._notify_error
        if uuid != NOTIFY_UUID and self._key_error:
            raise self._key_error
        self.callbacks[uuid] = callback

    async def write_gatt_char(self, uuid: str, data: bytes, response: bool) -> None:
        self.writes.append((uuid, bytes(data), response))


def link_with(client: FakeClient, **options) -> CardLink:
    def factory(_address, disconnected_callback, timeout):
        client.disconnected_callback = disconnected_callback
        return client

    return CardLink(factory, **options)


class ConnectTests(unittest.IsolatedAsyncioTestCase):
    async def test_connect_reports_link_parameters(self):
        client = FakeClient(room=244)
        info = await link_with(client).connect("AA:BB")
        self.assertEqual((info.mtu, info.max_write, info.key_events), (247, 244, True))

    async def test_missing_key_event_characteristic_is_tolerated(self):
        client = FakeClient(key_error=BleakError("no AE23"))
        info = await link_with(client).connect("AA:BB")
        self.assertFalse(info.key_events)
        self.assertEqual(client.disconnects, 0)

    async def test_failed_subscription_releases_the_connection(self):
        client = FakeClient(notify_error=BleakError("notify failed"))
        with self.assertRaises(BleakError):
            await link_with(client).connect("AA:BB")
        self.assertEqual(client.disconnects, 1)

    async def test_device_without_write_characteristic_is_rejected_and_released(self):
        client = FakeClient(has_write_char=False)
        with self.assertRaises(LinkLost):
            await link_with(client).connect("AA:BB")
        self.assertEqual(client.disconnects, 1)


class SendTests(unittest.IsolatedAsyncioTestCase):
    async def test_download_request_goes_out_as_one_36_byte_write(self):
        client = FakeClient(room=244)
        link = link_with(client)
        await link.connect("AA:BB")
        payload = cmd_import_file("note20261114-090000.wav", 0)
        await link.send(payload)
        self.assertEqual(client.writes, [(WRITE_UUID, build_frame(payload, 0), False)])
        self.assertEqual(len(client.writes[0][1]), 36)

    async def test_send_waits_for_the_connection_to_allow_a_full_frame(self):
        client = FakeClient(room=20)  # 刚连上，MTU 还没协商完
        link = link_with(client, write_room_wait_s=2.0, write_room_poll_s=0.01)
        await link.connect("AA:BB")

        async def negotiate() -> None:
            await asyncio.sleep(0.05)
            client.write_char.max_write_without_response_size = 244

        asyncio.create_task(negotiate())
        await link.send(cmd_import_file("a.wav", 0))
        self.assertEqual(len(client.writes), 1)

    async def test_frame_that_never_fits_is_refused_not_split(self):
        client = FakeClient(room=20)
        link = link_with(client, write_room_wait_s=0.05, write_room_poll_s=0.01)
        await link.connect("AA:BB")
        with self.assertRaises(FrameTooLarge):
            await link.send(cmd_import_file("a.wav", 0))
        self.assertEqual(client.writes, [])
        await link.send(cmd_list_files())  # 8 字节的命令不受影响
        self.assertEqual(len(client.writes), 1)

    async def test_unknown_write_room_is_treated_as_the_small_default(self):
        client = FakeClient(room=None)
        link = link_with(client, write_room_wait_s=0.02, write_room_poll_s=0.01)
        await link.connect("AA:BB")
        self.assertEqual(link.write_room(), 20)
        with self.assertRaises(FrameTooLarge):
            await link.send(cmd_import_file("a.wav", 0))

    async def test_delete_commands_never_reach_the_radio(self):
        client = FakeClient()
        link = link_with(client)
        await link.connect("AA:BB")
        for payload in (bytes([2, 8]) + bytes(28), bytes([2, 9])):
            with self.assertRaises(ForbiddenCommand):
                await link.send(payload)
        self.assertEqual(client.writes, [])

    async def test_sequence_numbers_advance_per_frame(self):
        client = FakeClient()
        link = link_with(client)
        await link.connect("AA:BB")
        await link.send(cmd_list_files())
        await link.send(cmd_list_files())
        self.assertEqual([write[1][1] for write in client.writes], [0, 1])

    async def test_send_after_disconnect_raises_link_lost(self):
        client = FakeClient()
        link = link_with(client)
        await link.connect("AA:BB")
        await link.disconnect()
        with self.assertRaises(LinkLost):
            await link.send(cmd_list_files())


class ReceiveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = FakeClient()
        self.link = link_with(self.client)
        await self.link.connect("AA:BB")
        self.notify = self.client.callbacks[NOTIFY_UUID]

    def push(self, payload: bytes) -> None:
        self.notify(None, bytearray(build_frame(payload, 0)))

    async def test_split_notifications_are_reassembled(self):
        frame = build_frame(bytes([0, 4, 85]), 0)
        self.notify(None, bytearray(frame[:4]))
        self.assertIsNone(await self.link.next_frame(0.01))
        self.notify(None, bytearray(frame[4:]))
        source, parsed = await self.link.next_frame(0.5)
        self.assertEqual(
            (source, parsed.type, parsed.cmd, parsed.params),
            ("ae22", 0, 4, bytes([85])),
        )

    async def test_frame_arriving_after_a_timeout_is_not_lost(self):
        self.assertIsNone(await self.link.next_frame(0.01))
        self.push(bytes([1, 1]) + bytes(40))
        self.assertIsNotNone(await self.link.next_frame(0.5))

    async def test_cancelled_reader_does_not_swallow_the_next_frame(self):
        reader = asyncio.create_task(self.link.next_frame(5))
        await asyncio.sleep(0.01)
        reader.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await reader
        self.push(bytes([1, 1]) + bytes(40))
        item = await self.link.next_frame(0.5)
        self.assertEqual(item[1].cmd, 1)

    async def test_frames_before_a_disconnect_are_delivered_then_link_lost(self):
        self.push(bytes([1, 1]) + bytes(40))
        self.client.is_connected = False
        self.client.disconnected_callback(self.client)
        self.assertIsNotNone(await self.link.next_frame(0.5))
        with self.assertRaises(LinkLost):
            await self.link.next_frame(0.5)
        with self.assertRaises(LinkLost):
            await self.link.next_frame(0.5)


if __name__ == "__main__":
    unittest.main()
