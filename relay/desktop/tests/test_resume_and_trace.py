import json
import tempfile
import unittest
from pathlib import Path

from ancrelay.evidence import EvidenceLog
from ancrelay.ops import pull_file, stem_of
from ancrelay.protocol import build_frame, cmd_import_file
from ancrelay.trace import Tracer

from fakes import FakeLink, frame


def serving(data: bytes, chunk: int = 4):
    """像卡一样按 offset 从 data 里切片发送。"""

    def responder(payload: bytes):
        if payload[:2] != bytes([2, 2]):
            return []
        offset = int.from_bytes(payload[2:6], "little")
        if offset > len(data):
            return [frame(2, 5, bytes([2]))]
        rest = data[offset:]
        pieces = [frame(2, 4, rest[i : i + chunk]) for i in range(0, len(rest), chunk)]
        return [frame(2, 3, payload[6:]), *pieces, frame(2, 5, bytes([0]))]

    return responder


class StemTests(unittest.TestCase):
    def test_stem_of_list_and_full_names(self):
        for name in (
            "note20261114-121309.",
            "note20261114-121309.wav",
            "note20261114-121309.OPUS",
            "note20261114-121309",
        ):
            self.assertEqual(stem_of(name), "note20261114-121309")


class PullOptionsTests(unittest.IsolatedAsyncioTestCase):
    async def test_offset_goes_into_the_36_byte_request(self):
        link = FakeLink(serving(b"0123456789"))
        pulled = await pull_file(link, "a.wav", exact=True, offset=6)
        self.assertEqual(pulled.data, b"6789")
        self.assertEqual(link.sent[0], cmd_import_file("a.wav", 6))
        self.assertEqual(len(build_frame(link.sent[0], 0)), 36)
        self.assertEqual(
            (pulled.offset, pulled.end_code, pulled.start_seen), (6, 0, True)
        )

    async def test_exact_requests_only_the_given_name(self):
        link = FakeLink(lambda payload: [frame(2, 5, bytes([1]))])
        with self.assertRaises(Exception):
            await pull_file(link, "a.opus", exact=True)
        self.assertEqual(len(link.sent), 1)
        self.assertTrue(link.sent[0][6:].rstrip(b"\x00").endswith(b".opus"))

    async def test_stop_after_returns_early_without_aborting(self):
        link = FakeLink(serving(b"0123456789abcdef", chunk=4))
        pulled = await pull_file(link, "a.wav", exact=True, stop_after=6)
        self.assertEqual(pulled.data, b"01234567")  # 按到达的整帧收，可能略超过 6
        self.assertEqual((pulled.data_frames, pulled.end_code), (2, None))
        self.assertNotIn(bytes([2, 7]), [payload[:2] for payload in link.sent])

    async def test_resume_by_offset_joins_back_to_the_whole_file(self):
        data = bytes(range(200))
        first = await pull_file(
            FakeLink(serving(data, chunk=16)), "a.wav", exact=True, stop_after=50
        )
        second = await pull_file(
            FakeLink(serving(data, chunk=16)),
            "a.wav",
            exact=True,
            offset=len(first.data),
        )
        self.assertEqual(first.data + second.data, data)

    async def test_frame_counts_and_end_code_on_a_normal_pull(self):
        pulled = await pull_file(FakeLink(serving(b"x" * 10, chunk=3)), "a.wav")
        self.assertEqual((pulled.data_frames, pulled.end_code), (4, 0))


class TracerTests(unittest.TestCase):
    def test_tx_is_logged_in_full_and_bulk_rx_is_summarised(self):
        with tempfile.TemporaryDirectory() as folder:
            log = EvidenceLog(
                Path(folder) / "log.jsonl", "S-1", echo=lambda _line: None
            )
            tracer = Tracer(log)
            request = build_frame(cmd_import_file("note20260710-162938.wav", 0), 3)
            tracer("tx", request)
            tracer("rx", "ae22", frame(2, 3, b"note.wav\x00"))
            for size in (100, 120, 80):
                tracer("rx", "ae22", frame(2, 4, bytes(size)))
            tracer("rx", "ae22", frame(2, 5, bytes([0])))
            tracer.flush("pull")
            records = [
                json.loads(line)
                for line in (Path(folder) / "log.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
        tx, start, end, bulk = records
        self.assertEqual((tx["event"], tx["bytes"], tx["gatt_writes"]), ("tx", 36, 1))
        self.assertTrue(tx["hex"].startswith("5a 03 9e 20 1e 00 02 02"))
        self.assertEqual(
            (start["cmd"], end["cmd"], end["params_hex"]), ("2-3", "2-5", "00")
        )
        self.assertEqual(
            (bulk["frames"], bulk["bytes"], bulk["min_frame"], bulk["max_frame"]),
            (3, 300, 80, 120),
        )


if __name__ == "__main__":
    unittest.main()
