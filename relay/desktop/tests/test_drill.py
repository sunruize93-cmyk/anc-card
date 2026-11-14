import asyncio
import tempfile
import unittest
from pathlib import Path

from ancrelay.drill import StreamDrill
from ancrelay.evidence import EvidenceLog
from ancrelay.stream import StreamRecorder
from ancrelay.transport import LinkLost

from fakes import FakeLink, frame

PACKET = bytes(range(40))
START, STOP, STATE, LIST = bytes([1, 0]), bytes([1, 2]), bytes([3, 19]), bytes([2, 0])


class DrillTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.out = Path(folder.name)
        self.events: list[dict] = []
        self.log = EvidenceLog(self.out / "log.jsonl", "S-1", echo=lambda _line: None)
        original = self.log.event
        self.log.event = lambda *args, **fields: self.events.append(
            original(*args, **fields)
        )  # type: ignore[method-assign]
        self.recorder = StreamRecorder(self.out, "S-1", now_ms=self.log.now_ms)
        self.addCleanup(self.recorder.close)
        self.commands: asyncio.Queue[str] = asyncio.Queue()

    def drill(self, links: list[FakeLink], **options) -> StreamDrill:
        remaining = list(links)

        async def connect() -> FakeLink:
            if not remaining:
                raise RuntimeError("card not found")
            return remaining.pop(0)

        return StreamDrill(
            connect=connect,
            recorder=self.recorder,
            log=self.log,
            commands=self.commands,
            poll_s=0.01,
            reconnect_wait_s=0.0,
            **options,
        )

    def names(self) -> list[str]:
        return [event["event"] for event in self.events]

    async def test_stream_drop_reconnect_and_stop(self):
        def push(*commands: str):
            return lambda: [self.commands.put_nowait(command) for command in commands]

        first = FakeLink(
            lambda payload: (
                [
                    frame(1, 0, b"note20261114-100000.opus\x00"),
                    frame(1, 1, PACKET),
                    frame(1, 1, PACKET),
                    frame(1, 1, PACKET),
                    push("断前二", "/drop", "断中三", "/back"),
                ]
                if payload == START
                else ([frame(3, 20, bytes([2]))] if payload == STATE else [])
            )
        )
        second = FakeLink(
            lambda payload: {
                START: [
                    frame(1, 0, b"note20261114-100500.opus\x00"),
                    frame(1, 1, PACKET),
                    frame(1, 1, PACKET),
                    push("恢复四", "/stop"),
                ],
                STATE: [frame(3, 20, bytes([1]))],
                STOP: [frame(1, 1, PACKET), frame(1, 4, bytes([2]))],
                LIST: [frame(2, 1, (0).to_bytes(4, "big")), frame(2, 18, bytes([0]))],
            }.get(payload, [])
        )

        summary = await asyncio.wait_for(self.drill([first, second]).run(), timeout=5)

        one, two = summary["segments"]
        self.assertEqual(
            (one["packets"], one["end_reason"], one["connection_round"]),
            (3, "manual_drop", 1),
        )
        self.assertEqual(
            (two["packets"], two["end_reason"], two["connection_round"]),
            (3, "stopped", 2),
        )
        self.assertEqual(len(summary["gaps"]), 1)
        self.assertEqual(
            [marker["text"] for marker in summary["markers"]],
            ["断前二", "断中三", "恢复四"],
        )
        self.assertEqual(
            summary["stream_names"],
            ["note20261114-100000.opus", "note20261114-100500.opus"],
        )
        self.assertEqual(
            first.sent, [STATE, START]
        )  # 主动断开时不发结束命令，模拟真实掉线
        self.assertEqual(second.sent, [STATE, START, STOP, LIST])
        self.assertEqual((first.disconnect_calls, second.disconnect_calls), (1, 1))
        for expected in (
            "connected",
            "stream_start_sent",
            "stream_name",
            "first_frame",
            "drop_requested",
            "segment_end",
            "reconnected",
            "record_state",
            "stop_sent",
            "card_files",
            "summary",
        ):
            self.assertIn(expected, self.names())
        states = [
            event["state"] for event in self.events if event["event"] == "record_state"
        ]
        self.assertEqual(states, ["idle", "recording"])

    async def test_unexpected_loss_reconnects_by_itself(self):
        first = FakeLink(
            lambda payload: (
                [frame(1, 1, PACKET), LinkLost("gone")] if payload == START else []
            )
        )
        second = FakeLink(
            lambda payload: (
                [frame(1, 1, PACKET), lambda: self.commands.put_nowait("/stop")]
                if payload == START
                else []
            )
        )
        summary = await asyncio.wait_for(self.drill([first, second]).run(), timeout=5)
        self.assertEqual(
            [segment["end_reason"] for segment in summary["segments"]],
            ["link_lost", "stopped"],
        )
        self.assertIn("link_lost", self.names())
        self.assertIn("reconnected", self.names())

    async def test_time_limit_stops_the_stream(self):
        link = FakeLink(
            lambda payload: [frame(1, 1, PACKET)] if payload == START else []
        )
        summary = await asyncio.wait_for(
            self.drill([link], max_seconds=0.05).run(), timeout=5
        )
        self.assertEqual(summary["segments"][0]["end_reason"], "stopped")
        self.assertIn(STOP, link.sent)

    async def test_reconnect_failure_is_logged_and_retried_until_stop(self):
        first = FakeLink(lambda payload: [LinkLost("gone")] if payload == START else [])
        drill = self.drill([first], max_seconds=0.1)
        summary = await asyncio.wait_for(drill.run(), timeout=5)
        self.assertEqual(len(summary["segments"]), 1)
        self.assertIn("reconnect_failed", self.names())
        self.assertIn("stopped_while_disconnected", self.names())

    async def test_first_connection_failure_is_raised(self):
        with self.assertRaises(RuntimeError):
            await self.drill([]).run()


if __name__ == "__main__":
    unittest.main()
