import io
import json
import tempfile
import unittest
import wave
from datetime import datetime, timezone
from pathlib import Path

from ancrelay.evidence import EvidenceLog, inspect_wav, sha256_bytes, sha256_file


def make_wav(seconds: float = 1.0, rate: int = 16000, channels: int = 1) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(bytes(int(seconds * rate) * channels * 2))
    return buffer.getvalue()


class WavTests(unittest.TestCase):
    def test_valid_wav_reports_format_and_duration(self):
        info = inspect_wav(make_wav(seconds=2.5))
        self.assertTrue(info.ok, info.reason)
        self.assertEqual(
            (info.channels, info.sample_rate, info.bits_per_sample), (1, 16000, 16)
        )
        self.assertEqual(info.audio_format, 1)
        self.assertEqual(info.data_bytes, 80000)
        self.assertAlmostEqual(info.duration_s, 2.5)

    def test_truncated_wav_is_rejected_with_both_lengths(self):
        data = make_wav()[:-100]
        info = inspect_wav(data)
        self.assertFalse(info.ok)
        self.assertIn(str(len(data)), info.reason)

    def test_non_wav_is_rejected(self):
        self.assertFalse(inspect_wav(b"OggS" + bytes(60)).ok)
        self.assertFalse(inspect_wav(b"").ok)

    def test_chunk_running_past_the_end_is_rejected(self):
        data = bytearray(make_wav())
        data_at = data.index(b"data")
        data[data_at + 4 : data_at + 8] = (10**6).to_bytes(4, "little")
        self.assertFalse(inspect_wav(bytes(data)).ok)

    def test_missing_data_chunk_is_rejected(self):
        body = b"WAVE" + b"fmt " + (16).to_bytes(4, "little") + bytes(16)
        data = b"RIFF" + len(body).to_bytes(4, "little") + body
        info = inspect_wav(data)
        self.assertFalse(info.ok)
        self.assertIn("data", info.reason)


class HashTests(unittest.TestCase):
    def test_known_vector(self):
        expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        self.assertEqual(sha256_bytes(b"abc"), expected)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "abc.bin"
            path.write_bytes(b"abc")
            self.assertEqual(sha256_file(path), expected)


class EvidenceLogTests(unittest.TestCase):
    def test_events_carry_elapsed_ms_wall_time_and_session(self):
        ticks = iter([100.0, 100.25, 101.5])
        lines: list[str] = []
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "nested" / "log.jsonl"
            log = EvidenceLog(
                path,
                "S-1",
                clock=lambda: next(ticks),
                wall=lambda: datetime(2026, 11, 14, 9, 0, 0, tzinfo=timezone.utc),
                echo=lines.append,
            )
            first = log.event("connected", card="A", bytes=12)
            log.event("saved", path="x.wav")
            records = [
                json.loads(line)
                for line in path.read_text(encoding="utf-8").splitlines()
            ]
        self.assertEqual(first["t_ms"], 250)
        self.assertEqual([record["t_ms"] for record in records], [250, 1500])
        self.assertEqual(records[0]["session"], "S-1")
        self.assertEqual(records[0]["event"], "connected")
        self.assertEqual(records[0]["card"], "A")
        self.assertTrue(records[0]["wall"].startswith("2026-11-14T09:00:00"))
        self.assertEqual(len(lines), 2)

    def test_secret_fields_are_never_written(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "log.jsonl"
            log = EvidenceLog(path, "S-1", echo=lambda _line: None)
            log.event(
                "upload",
                token="abc123",
                Authorization="Bearer abc123",
                url="https://example.test/x",
            )
            text = path.read_text(encoding="utf-8")
        self.assertNotIn("abc123", text)
        self.assertIn("example.test", text)


if __name__ == "__main__":
    unittest.main()
