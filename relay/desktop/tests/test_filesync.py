import tempfile
import unittest
from pathlib import Path

from ancrelay.filesync import (
    load_baseline,
    new_entries,
    output_name,
    safe_filename,
    save_baseline,
)
from ancrelay.protocol import FileEntry


def entry(name: str, size: int = 10) -> FileEntry:
    return FileEntry(duration_or_time=0, size=size, name=name, raw_entry=bytes(28))


class NewEntriesTests(unittest.TestCase):
    def test_only_names_missing_from_the_baseline_are_new(self):
        listed = [
            entry("note20261114-090000."),
            entry("note20261114-091500."),
            entry("note20261114-093000."),
        ]
        fresh = new_entries({"note20261114-090000."}, listed)
        self.assertEqual(
            [item.name for item in fresh],
            ["note20261114-091500.", "note20261114-093000."],
        )

    def test_repeated_names_in_one_listing_are_reported_once(self):
        listed = [entry("a.wav"), entry("a.wav"), entry("b.wav")]
        self.assertEqual(
            [item.name for item in new_entries(set(), listed)], ["a.wav", "b.wav"]
        )

    def test_empty_names_are_ignored(self):
        self.assertEqual(new_entries(set(), [entry("")]), [])


class NamingTests(unittest.TestCase):
    def test_card_supplied_names_cannot_escape_the_output_folder(self):
        self.assertEqual(safe_filename("..\\..\\evil.wav"), "evil.wav")
        self.assertEqual(safe_filename("../../etc/passwd"), "passwd")
        self.assertEqual(safe_filename("C:\\Windows\\x.wav"), "x.wav")
        self.assertEqual(safe_filename("a b?.wav"), "a_b_.wav")
        self.assertEqual(safe_filename("..."), "unnamed")
        self.assertEqual(safe_filename(""), "unnamed")

    def test_riff_data_is_saved_as_wav_whatever_was_requested(self):
        self.assertEqual(
            output_name("note20261114-090000.opus", b"RIFF....WAVE"),
            "note20261114-090000.wav",
        )

    def test_other_data_keeps_the_requested_extension_or_falls_back_to_bin(self):
        self.assertEqual(
            output_name("note20261114-090000.opus", b"\x4f\x70"),
            "note20261114-090000.opus",
        )
        self.assertEqual(
            output_name("note20261114-090000.", b"\x00\x01"), "note20261114-090000.bin"
        )
        self.assertEqual(
            output_name("note20261114-090000", b"\x00\x01"), "note20261114-090000.bin"
        )


class BaselineTests(unittest.TestCase):
    def test_round_trip_and_missing_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state" / "baseline-A.json"
            self.assertIsNone(load_baseline(path))
            save_baseline(path, {"b.wav", "a.wav"})
            self.assertEqual(load_baseline(path), {"a.wav", "b.wav"})


if __name__ == "__main__":
    unittest.main()
