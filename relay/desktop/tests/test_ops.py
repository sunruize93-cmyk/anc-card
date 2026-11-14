import unittest

from ancrelay.ops import (
    CardError,
    PullFailed,
    list_files,
    pull_file,
    read_record_state,
    read_status,
)
from ancrelay.protocol import fixed_text

from fakes import FakeLink, frame


def list_frame(*names: str) -> bytes:
    body = len(names).to_bytes(4, "big")
    for name in names:
        body += (
            (12).to_bytes(4, "big") + (3456).to_bytes(4, "big") + fixed_text(name, 20)
        )
    return body


class StatusTests(unittest.IsolatedAsyncioTestCase):
    async def test_reads_battery_capacity_and_firmware(self):
        link = FakeLink()
        link.push(
            frame(0, 4, bytes([85])),
            frame(0, 2, (1000).to_bytes(4, "little") + (32000).to_bytes(4, "little")),
            frame(0, 11, b"V1.2.3\x00"),
        )
        status = await read_status(link)
        self.assertEqual(
            status,
            {
                "battery_percent": 85,
                "charging": False,
                "remaining_kb": 1000,
                "total_kb": 32000,
                "firmware": "V1.2.3",
            },
        )
        self.assertEqual(link.sent, [bytes([0, 3]), bytes([0, 1]), bytes([0, 10])])

    async def test_battery_110_means_charging(self):
        link = FakeLink()
        link.push(frame(0, 4, bytes([110])))
        status = await read_status(link)
        self.assertTrue(status["charging"])
        self.assertIsNone(status["battery_percent"])
        self.assertIsNone(status["firmware"])

    async def test_no_battery_reply_is_an_error(self):
        with self.assertRaises(CardError):
            await read_status(FakeLink())

    async def test_record_state(self):
        link = FakeLink()
        link.push(frame(3, 3), frame(3, 20, bytes([2])))
        self.assertEqual(await read_record_state(link), "idle")
        with self.assertRaises(CardError):
            await read_record_state(FakeLink())


class ListTests(unittest.IsolatedAsyncioTestCase):
    async def test_multi_frame_list_ends_at_2_18(self):
        link = FakeLink()
        link.push(
            frame(2, 1, list_frame("a.wav", "b.wav")),
            frame(2, 1, list_frame("c.wav")),
            frame(2, 18, bytes([0])),
            frame(2, 1, list_frame("late.wav")),
        )
        files = await list_files(link)
        self.assertEqual([item.name for item in files], ["a.wav", "b.wav", "c.wav"])
        self.assertEqual(files[0].size, 3456)

    async def test_old_firmware_without_2_18_ends_on_idle(self):
        link = FakeLink()
        link.push(frame(2, 1, list_frame("a.wav")))
        self.assertEqual([item.name for item in await list_files(link)], ["a.wav"])

    async def test_empty_card_is_an_empty_list_not_an_error(self):
        link = FakeLink()
        link.push(frame(2, 1, list_frame()), frame(2, 18, bytes([0])))
        self.assertEqual(await list_files(link), [])

    async def test_no_reply_is_an_error(self):
        with self.assertRaises(CardError):
            await list_files(FakeLink())


class PullTests(unittest.IsolatedAsyncioTestCase):
    async def test_falls_back_to_the_next_extension_when_the_file_is_missing(self):
        def responder(payload: bytes):
            if payload[:2] != bytes([2, 2]):
                return []
            if payload[6:].rstrip(b"\x00").endswith(b".wav"):
                return [frame(2, 5, bytes([1]))]
            return [
                frame(2, 3, b"note20261114-090000.opus\x00"),
                frame(2, 4, b"abc"),
                frame(2, 4, b"def"),
                frame(2, 5, bytes([0])),
            ]

        link = FakeLink(responder)
        pulled = await pull_file(link, "note20261114-090000.")
        self.assertEqual(pulled.data, b"abcdef")
        self.assertEqual(pulled.requested_name, "note20261114-090000.opus")
        self.assertEqual(pulled.reported_name, "note20261114-090000.opus")
        self.assertEqual(
            pulled.attempts, ["note20261114-090000.wav", "note20261114-090000.opus"]
        )
        self.assertEqual(len(link.sent), 2)
        self.assertTrue(
            all(len(payload) == 30 for payload in link.sent)
        )  # 加 6 字节帧头正好 36

    async def test_stall_after_data_is_an_error_and_is_not_retried_under_another_name(
        self,
    ):
        link = FakeLink(
            lambda _payload: [frame(2, 3, b"a.wav\x00"), frame(2, 4, b"abc")]
        )
        with self.assertRaises(PullFailed) as caught:
            await pull_file(link, "a.wav", idle_timeout_s=0.01)
        self.assertIn("3", str(caught.exception))
        self.assertEqual(caught.exception.partial, b"abc")  # 已收到的字节交还给调用方
        self.assertEqual(caught.exception.requested_name, "a.wav")
        # 只发了一次下载请求，然后发终止（2-7）让卡停下，没有换名字重试。
        self.assertEqual(
            [payload[:2] for payload in link.sent], [bytes([2, 2]), bytes([2, 7])]
        )

    async def test_completion_without_any_data_is_an_error(self):
        link = FakeLink(
            lambda _payload: [frame(2, 3, b"a.wav\x00"), frame(2, 5, bytes([0]))]
        )
        with self.assertRaises(CardError):
            await pull_file(link, "a.wav")

    async def test_other_end_codes_are_errors(self):
        link = FakeLink(
            lambda _payload: [frame(2, 3, b"a.wav\x00"), frame(2, 5, bytes([3]))]
        )
        with self.assertRaises(CardError):
            await pull_file(link, "a.wav")

    async def test_all_candidates_missing_is_an_error(self):
        link = FakeLink(lambda _payload: [frame(2, 5, bytes([1]))])
        with self.assertRaises(CardError):
            await pull_file(link, "a.wav")
        self.assertEqual(len(link.sent), 2)  # a.wav、a.opus

    async def test_progress_callback_sees_running_total(self):
        seen: list[int] = []
        link = FakeLink(
            lambda _payload: [
                frame(2, 3, b"a.wav\x00"),
                frame(2, 4, b"ab"),
                frame(2, 4, b"cde"),
                frame(2, 5, bytes([0])),
            ]
        )
        await pull_file(link, "a.wav", on_progress=seen.append)
        self.assertEqual(seen, [2, 5])


if __name__ == "__main__":
    unittest.main()
