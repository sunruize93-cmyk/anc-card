"""审查后补的测试：真实连接对象配演练、异常退出的收尾、下载中断的保全、落盘不覆盖。"""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from ancrelay.cardfiles import pull_and_save
from ancrelay.drill import StreamDrill
from ancrelay.evidence import EvidenceLog
from ancrelay.filesync import load_baseline, safe_filename, save_baseline
from ancrelay.fsutil import place_without_overwriting
from ancrelay.ops import PullFailed
from ancrelay.protocol import NOTIFY_UUID, FileEntry, build_frame
from ancrelay.stream import StreamRecorder
from ancrelay.transport import CardLink
from ancrelay.workspace import Workspace, save_without_overwriting

from fakes import FakeLink, frame
from test_transport import FakeClient

PACKET = bytes(range(40))
START, STOP, STATE, LIST = bytes([1, 0]), bytes([1, 2]), bytes([3, 19]), bytes([2, 0])


class RespondingClient(FakeClient):
    """写入某条命令时，像真卡一样通过通知回帧。"""

    def __init__(self, replies: dict[bytes, list[bytes]]) -> None:
        super().__init__()
        self._replies = replies

    async def write_gatt_char(self, uuid: str, data: bytes, response: bool) -> None:
        await super().write_gatt_char(uuid, data, response)
        notify = self.callbacks[NOTIFY_UUID]
        for payload in self._replies.get(bytes(data[6:8]), []):
            notify(None, bytearray(build_frame(payload, 0)))

    def commands(self) -> list[bytes]:
        return [write[1][6:8] for write in self.writes]


class DrillCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.out = Path(folder.name)
        self.log = EvidenceLog(self.out / "log.jsonl", "S-1", echo=lambda _line: None)
        self.recorder = StreamRecorder(self.out, "S-1", now_ms=self.log.now_ms)
        self.addCleanup(self.recorder.close)
        self.commands: asyncio.Queue[str] = asyncio.Queue()

    def events(self) -> list[str]:
        lines = (self.out / "log.jsonl").read_text(encoding="utf-8").splitlines()
        return [json.loads(line)["event"] for line in lines]


class DrillOverRealLinkTests(DrillCase):
    async def test_drop_and_stop_while_the_reader_is_waiting_lose_no_audio(self):
        audio = [bytes([1, 1]) + PACKET] * 3
        first = RespondingClient({START: [bytes([1, 0]) + b"note-1.opus\x00", *audio]})
        second = RespondingClient(
            {
                START: [bytes([1, 0]) + b"note-2.opus\x00", *audio[:2]],
                STOP: [bytes([1, 1]) + PACKET, bytes([1, 4, 2])],
                LIST: [bytes([2, 1]) + (0).to_bytes(4, "big"), bytes([2, 18, 0])],
            }
        )
        clients = [first, second]

        async def connect() -> CardLink:
            client = clients.pop(0)

            def factory(_address, disconnected_callback, timeout):
                client.disconnected_callback = disconnected_callback
                return client

            link = CardLink(factory)
            await link.connect("AA:BB")
            return link

        async def operator() -> None:
            # 每条命令都在读帧任务空等的时候到达，这是假连接测不到的时序。
            # 等条件而不是等固定时间：机器忙的时候也不会抢在音频到达之前下命令。
            async def until(ready) -> None:
                while not ready(self.recorder.summary()):
                    await asyncio.sleep(0.01)

            await until(lambda summary: summary["total_packets"] >= 3)
            self.commands.put_nowait("/drop")
            await until(
                lambda summary: summary["segments"][0]["end_reason"] is not None
            )
            await asyncio.sleep(0.12)  # 保证两段之间确实有一段可以量出来的缺口
            self.commands.put_nowait("/back")
            await until(lambda summary: summary["total_packets"] >= 5)
            self.commands.put_nowait("/stop")

        drill = StreamDrill(
            connect=connect,
            recorder=self.recorder,
            log=self.log,
            commands=self.commands,
            poll_s=0.05,
            reconnect_wait_s=0.0,
        )
        operating = asyncio.create_task(operator())
        summary = await asyncio.wait_for(drill.run(), timeout=10)
        await operating

        one, two = summary["segments"]
        self.assertEqual((one["packets"], one["end_reason"]), (3, "manual_drop"))
        self.assertEqual((two["packets"], two["end_reason"]), (3, "stopped"))
        self.assertEqual(summary["stray_packets"], 0)
        self.assertEqual(first.commands(), [STATE, START])
        self.assertEqual(second.commands(), [STATE, START, STOP, LIST])
        self.assertEqual((first.disconnects, second.disconnects), (1, 1))
        self.assertGreaterEqual(summary["gaps"][0]["gap_ms"], 100)


class DrillAbortTests(DrillCase):
    async def test_unexpected_error_still_stops_the_card_and_closes_the_segment(self):
        link = FakeLink(
            lambda payload: (
                [frame(1, 1, PACKET), ValueError("boom")] if payload == START else []
            )
        )

        async def connect() -> FakeLink:
            return link

        drill = StreamDrill(
            connect=connect,
            recorder=self.recorder,
            log=self.log,
            commands=self.commands,
            poll_s=0.01,
        )
        with self.assertRaises(ValueError):
            await asyncio.wait_for(drill.run(), timeout=5)
        self.assertIn(STOP, link.sent)
        self.assertEqual(link.disconnect_calls, 1)
        segment = self.recorder.summary()["segments"][0]
        self.assertEqual((segment["packets"], segment["end_reason"]), (1, "aborted"))
        self.assertIn("stop_sent_on_abort", self.events())

    async def test_failure_while_starting_the_stream_releases_the_link(self):
        class RefusingLink(FakeLink):
            async def send(self, payload: bytes) -> None:
                raise OSError("write failed")

        link = RefusingLink()

        async def connect() -> FakeLink:
            return link

        drill = StreamDrill(
            connect=connect,
            recorder=self.recorder,
            log=self.log,
            commands=self.commands,
            poll_s=0.01,
        )
        with self.assertRaises(OSError):
            await drill.run()
        self.assertEqual(link.disconnect_calls, 1)


class SavingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.workspace = Workspace(Path(folder.name), "A")
        self.log = EvidenceLog(
            self.workspace.log_path("S-1"), "S-1", echo=lambda _line: None
        )

    async def test_interrupted_download_keeps_what_arrived(self):
        link = FakeLink(
            lambda payload: (
                [frame(2, 3, b"a.wav\x00"), frame(2, 4, b"RIFFabc")]
                if payload[:2] == bytes([2, 2])
                else []
            )
        )
        entry = FileEntry(
            duration_or_time=0, size=100, name="a.wav", raw_entry=bytes(28)
        )
        with self.assertRaises(PullFailed):
            await pull_and_save(link, entry, self.workspace, self.log)
        kept = list(self.workspace.card_dir.iterdir())
        self.assertEqual([path.name for path in kept], ["a.bin.partial"])
        self.assertEqual(kept[0].read_bytes(), b"RIFFabc")
        lines = self.workspace.log_path("S-1").read_text(encoding="utf-8").splitlines()
        last = json.loads(lines[-1])
        self.assertEqual((last["event"], last["partial_bytes"]), ("download_failed", 7))

    def test_placing_never_replaces_an_existing_file(self):
        folder = self.workspace.card_dir
        folder.mkdir(parents=True)
        target, temporary = folder / "a.wav", folder / "a.wav.part"
        target.write_bytes(b"old")
        temporary.write_bytes(b"new")
        self.assertFalse(place_without_overwriting(temporary, target))
        self.assertEqual(target.read_bytes(), b"old")
        fresh = folder / "b.wav"
        self.assertTrue(place_without_overwriting(temporary, fresh))
        self.assertEqual(fresh.read_bytes(), b"new")
        self.assertFalse(temporary.exists())

    def test_saving_leaves_no_temporary_files_behind(self):
        folder = self.workspace.card_dir
        save_without_overwriting(folder, "a.wav", b"one")
        save_without_overwriting(folder, "a.wav", b"one")
        save_without_overwriting(folder, "a.wav", b"two")
        self.assertEqual(
            sorted(path.name for path in folder.iterdir()), ["a-v2.wav", "a.wav"]
        )

    def test_windows_device_names_are_defused(self):
        self.assertEqual(safe_filename("CON.wav"), "_CON.wav")
        self.assertEqual(safe_filename("nul"), "_nul")
        self.assertEqual(safe_filename("com1.opus"), "_com1.opus")
        self.assertEqual(safe_filename("console.wav"), "console.wav")

    def test_baseline_survives_rewrites_and_bad_content_is_a_value_error(self):
        path = self.workspace.baseline_path
        save_baseline(path, ["a"])
        save_baseline(path, ["a", "b"])
        self.assertEqual(load_baseline(path), {"a", "b"})
        self.assertEqual(
            [item.name for item in path.parent.iterdir()], ["baseline.json"]
        )
        path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(ValueError):
            load_baseline(path)


if __name__ == "__main__":
    unittest.main()
