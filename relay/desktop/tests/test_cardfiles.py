import json
import tempfile
import unittest
from pathlib import Path

from ancrelay.cardfiles import choose_targets, pull_and_save, pull_new_files
from ancrelay.evidence import EvidenceLog, sha256_bytes
from ancrelay.filesync import save_baseline
from ancrelay.ops import CardError
from ancrelay.protocol import FileEntry, fixed_text
from ancrelay.workspace import (
    Workspace,
    WorkspaceError,
    load_cards,
    make_workspace,
    new_session_id,
    open_log,
    remember_card,
    save_without_overwriting,
)

from fakes import FakeLink, frame
from test_evidence import make_wav


def entry(name: str) -> FileEntry:
    return FileEntry(duration_or_time=0, size=1, name=name, raw_entry=bytes(28))


def list_reply(*names: str) -> list:
    body = len(names).to_bytes(4, "big")
    for name in names:
        body += bytes(8) + fixed_text(name, 20)
    return [frame(2, 1, body), frame(2, 18, bytes([0]))]


class WorkspaceCase(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.workspace = Workspace(Path(folder.name), "A")
        self.events: list[dict] = []
        self.log = EvidenceLog(
            self.workspace.log_path("S-1"), "S-1", echo=lambda _line: None
        )

    def logged(self) -> list[dict]:
        lines = self.workspace.log_path("S-1").read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines]


class WorkspaceTests(WorkspaceCase):
    def test_card_label_and_session_id_are_restricted(self):
        with self.assertRaises(WorkspaceError):
            make_workspace(None, "../A")
        with self.assertRaises(WorkspaceError):
            open_log(self.workspace, "..\\escape")
        self.assertRegex(new_session_id("A", "pull"), r"^\d{8}-\d{6}-A-pull$")

    def test_remembered_addresses_are_kept_per_label(self):
        remember_card(self.workspace, "AA:BB")
        remember_card(Workspace(self.workspace.root, "B"), "CC:DD")
        self.assertEqual(load_cards(self.workspace), {"A": "AA:BB", "B": "CC:DD"})

    def test_saving_never_overwrites(self):
        folder = self.workspace.card_dir
        first, written = save_without_overwriting(folder, "a.wav", b"one")
        self.assertTrue(written)
        same, written_again = save_without_overwriting(folder, "a.wav", b"one")
        self.assertEqual((same, written_again), (first, False))
        other, written_other = save_without_overwriting(folder, "a.wav", b"two")
        self.assertTrue(written_other)
        self.assertEqual(other.name, "a-v2.wav")
        self.assertEqual(first.read_bytes(), b"one")
        self.assertEqual(
            sorted(path.name for path in folder.iterdir()), ["a-v2.wav", "a.wav"]
        )


class ChooseTargetsTests(WorkspaceCase):
    FILES = [
        entry("note20261114-090000."),
        entry("note20261114-101500."),
        entry("note20261114-093000."),
    ]

    def pick(self, **options) -> list[str]:
        defaults = {"name": None, "newest": False, "only_new": False}
        return [
            item.name
            for item in choose_targets(
                self.FILES, self.workspace, **{**defaults, **options}
            )
        ]

    def test_by_name_prefix_newest_and_new(self):
        self.assertEqual(self.pick(name="note20261114-0930"), ["note20261114-093000."])
        self.assertEqual(self.pick(newest=True), ["note20261114-101500."])
        save_baseline(self.workspace.baseline_path, ["note20261114-090000."])
        self.assertEqual(
            self.pick(only_new=True), ["note20261114-101500.", "note20261114-093000."]
        )

    def test_errors_explain_what_to_do(self):
        with self.assertRaises(WorkspaceError):
            self.pick(name="missing")
        with self.assertRaises(WorkspaceError) as caught:
            self.pick(only_new=True)
        self.assertIn("baseline", str(caught.exception))
        with self.assertRaises(WorkspaceError):
            self.pick()


class PullAndSaveTests(WorkspaceCase, unittest.IsolatedAsyncioTestCase):
    def link_serving(self, data: bytes, lists: list[list] | None = None) -> FakeLink:
        listings = list(lists or [])

        def responder(payload: bytes):
            if payload[:2] == bytes([2, 0]):
                return listings.pop(0)
            if payload[:2] == bytes([2, 2]):
                half = len(data) // 2
                return [
                    frame(2, 3, payload[6:]),
                    frame(2, 4, data[:half]),
                    frame(2, 4, data[half:]),
                    frame(2, 5, bytes([0])),
                ]
            return []

        return FakeLink(responder)

    async def test_valid_wav_is_saved_with_hash_and_format_in_the_log(self):
        wav = make_wav(seconds=1.5)
        result = await pull_and_save(
            self.link_serving(wav),
            entry("note20261114-090000."),
            self.workspace,
            self.log,
        )
        saved = Path(result["path"])
        self.assertEqual(saved.name, "note20261114-090000.wav")
        self.assertEqual(saved.read_bytes(), wav)
        self.assertEqual(result["sha256"], sha256_bytes(wav))
        events = {event["event"]: event for event in self.logged()}
        self.assertEqual(list(events), ["download_start", "download_done", "saved"])
        self.assertEqual(
            (
                events["download_done"]["sample_rate"],
                events["download_done"]["duration_s"],
            ),
            (16000, 1.5),
        )
        self.assertFalse(events["saved"]["already_present"])

    async def test_broken_wav_is_kept_aside_and_reported(self):
        broken = make_wav()[:-50]
        with self.assertRaises(CardError):
            await pull_and_save(
                self.link_serving(broken), entry("a.wav"), self.workspace, self.log
            )
        self.assertEqual(
            [path.name for path in self.workspace.card_dir.iterdir()], ["a.wav.invalid"]
        )
        self.assertEqual(self.logged()[-1]["event"], "download_invalid")

    async def test_non_wav_is_saved_as_is(self):
        result = await pull_and_save(
            self.link_serving(b"\x01\x02\x03\x04"),
            entry("a.opus"),
            self.workspace,
            self.log,
        )
        # 卡对 a.wav 的请求回了非 RIFF 内容：不能存成 .wav。
        self.assertEqual(Path(result["path"]).name, "a.bin")
        self.assertIn("不是 RIFF", self.logged()[-2]["format"])

    async def test_first_run_only_records_the_baseline_then_new_files_are_pulled_once(
        self,
    ):
        wav = make_wav(seconds=0.5)
        link = self.link_serving(
            wav,
            lists=[
                list_reply("old.wav"),
                list_reply("old.wav", "new.wav"),
                list_reply("old.wav", "new.wav"),
            ],
        )
        self.assertEqual(await pull_new_files(link, self.workspace, self.log), [])
        pulled = await pull_new_files(link, self.workspace, self.log)
        self.assertEqual([Path(item["path"]).name for item in pulled], ["new.wav"])
        self.assertEqual(await pull_new_files(link, self.workspace, self.log), [])
        self.assertEqual(
            sum(1 for payload in link.sent if payload[:2] == bytes([2, 2])), 1
        )


if __name__ == "__main__":
    unittest.main()
