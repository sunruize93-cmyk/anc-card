import tempfile
import unittest
from pathlib import Path

from ancrelay.stream import StreamRecorder

PACKET = bytes(range(40))


class Clock:
    def __init__(self) -> None:
        self.ms = 0

    def __call__(self) -> int:
        return self.ms


class StreamRecorderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.clock = Clock()
        self.recorder = StreamRecorder(Path(self.folder.name), "S-1", now_ms=self.clock)
        self.addCleanup(self.recorder.close)

    def test_packets_are_on_disk_as_soon_as_they_arrive(self):
        segment = self.recorder.begin_segment(connection_round=1)
        self.recorder.on_audio(PACKET)
        # 不等结束就能读到：断电或崩溃时已经收到的音频不丢。
        self.assertEqual(segment.raw_path.read_bytes(), PACKET)

    def test_two_segments_with_a_gap(self):
        self.clock.ms = 1000
        self.recorder.begin_segment(connection_round=1)
        for at in (1500, 1520, 1540):
            self.clock.ms = at
            self.recorder.on_audio(PACKET)
        self.clock.ms = 1600
        self.recorder.end_segment("manual_drop")

        self.clock.ms = 31000
        self.recorder.begin_segment(connection_round=2)
        self.clock.ms = 31400
        self.recorder.on_audio(PACKET + PACKET)
        self.clock.ms = 31500
        self.recorder.end_segment("stopped")

        summary = self.recorder.summary()
        first, second = summary["segments"]
        self.assertEqual(
            (first["packets"], first["bytes"], first["audio_ms"]), (3, 120, 60)
        )
        self.assertEqual(
            (first["started_ms"], first["first_frame_ms"], first["last_frame_ms"]),
            (1000, 1500, 1540),
        )
        self.assertEqual(first["first_frame_latency_ms"], 500)
        self.assertEqual(first["end_reason"], "manual_drop")
        self.assertEqual((second["packets"], second["connection_round"]), (2, 2))
        self.assertEqual(
            summary["gaps"],
            [{"after_segment": 1, "from_ms": 1540, "to_ms": 31400, "gap_ms": 29860}],
        )
        self.assertEqual(summary["total_packets"], 5)
        self.assertEqual(summary["total_audio_ms"], 100)

    def test_audio_outside_a_segment_is_counted_not_lost_silently(self):
        self.recorder.on_audio(PACKET)
        self.assertEqual(self.recorder.summary()["stray_packets"], 1)

    def test_odd_sized_payload_is_kept_and_flagged(self):
        segment = self.recorder.begin_segment(connection_round=1)
        self.recorder.on_audio(PACKET + b"\x01\x02")
        self.recorder.end_segment("stopped")
        self.assertEqual(segment.raw_path.stat().st_size, 42)
        self.assertEqual(self.recorder.summary()["segments"][0]["odd_payloads"], 1)
        self.assertEqual(self.recorder.wrap_ogg(), [])

    def test_markers_keep_their_time_and_text(self):
        self.clock.ms = 4200
        self.recorder.mark("断前二")
        self.assertEqual(
            self.recorder.summary()["markers"], [{"t_ms": 4200, "text": "断前二"}]
        )

    def test_wrap_ogg_writes_a_playable_container_per_segment(self):
        self.recorder.begin_segment(connection_round=1)
        for _ in range(60):
            self.recorder.on_audio(PACKET)
        self.recorder.end_segment("stopped")
        self.recorder.begin_segment(connection_round=2)
        self.recorder.end_segment("stopped")  # 空段不生成文件
        paths = self.recorder.wrap_ogg()
        self.assertEqual(len(paths), 1)
        self.assertEqual(paths[0].read_bytes()[:4], b"OggS")

    def test_ending_twice_or_without_a_segment_is_harmless(self):
        self.assertIsNone(self.recorder.end_segment("stopped"))
        self.recorder.begin_segment(connection_round=1)
        self.assertIsNotNone(self.recorder.end_segment("stopped"))
        self.assertIsNone(self.recorder.end_segment("stopped"))


if __name__ == "__main__":
    unittest.main()
