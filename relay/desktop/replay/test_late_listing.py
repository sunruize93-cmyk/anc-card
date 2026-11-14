"""G4 保存后最终可发现性（synthetic）：3-3 先到，新文件晚一到两次列表才出现。

跑的是真实的 cardfiles.watch 循环，只把蓝牙连接换成脚本卡。断言看的是结果，不只看日志：
- 工作目录里最终落盘的文件：只有一个，名字、字节、SHA-256 都和卡上的原件一致；
- 成功次数：下载请求（2-2）只发一次，「下载完成」和「新写入」各只有一次；
- 基线：新文件真正下载前，基线一直只有旧文件（不确定期间也不变）；结束时恰好是旧文件加新文件。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

import ancrelay.ops as ops
from ancrelay.cardfiles import watch
from ancrelay.evidence import EvidenceLog, sha256_bytes
from ancrelay.filesync import load_baseline, save_baseline
from ancrelay.protocol import decode_text
from ancrelay.workspace import Workspace

from replay.harness import ScriptedCard, connect_link, load_scenario
from replay.test_replay import ReplayCase

G4 = load_scenario("g4-late-listing.json")
OLD = set(G4["baseline"])
NEW = G4["new_file"]
SAMPLE_S = 0.01


class G4LateListing(ReplayCase):
    async def run_watch(self, variant: dict[str, Any]) -> dict[str, Any]:
        options = variant["watch"]
        card = ScriptedCard(variant["card"])
        original_timeout = ops.LIST_FIRST_TIMEOUT_S
        if "list_first_timeout_s" in options:
            ops.LIST_FIRST_TIMEOUT_S = options["list_first_timeout_s"]
        lines: list[str] = []
        try:
            with tempfile.TemporaryDirectory() as folder:
                workspace = Workspace(Path(folder), "A")
                save_baseline(workspace.baseline_path, sorted(OLD))
                log = EvidenceLog(
                    workspace.log_path("replay"), "replay", echo=lines.append
                )
                snapshots: list[tuple[float, frozenset[str]]] = []

                async def sample_baseline() -> None:
                    # 每 10 ms 读一次磁盘上的基线，记下每次变化的时刻和内容。
                    while True:
                        current = frozenset(
                            load_baseline(workspace.baseline_path) or set()
                        )
                        if not snapshots or snapshots[-1][1] != current:
                            snapshots.append(
                                (card.now_ms() if card._loop else 0.0, current)
                            )
                        await asyncio.sleep(SAMPLE_S)

                sampler = asyncio.create_task(sample_baseline())
                task = asyncio.create_task(
                    watch(
                        workspace,
                        None,
                        log,
                        poll_s=options["poll_s"],
                        settle_s=options["settle_s"],
                        reconnect_wait_s=options["reconnect_wait_s"],
                        connect=lambda: connect_link(card),
                    )
                )
                await asyncio.sleep(options["run_s"])
                for running in (task, sampler):
                    running.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await running
                events = [
                    json.loads(line)
                    for line in log.path.read_text(encoding="utf-8").splitlines()
                ]
                saved_files = {
                    path.name: path.read_bytes()
                    for path in workspace.card_dir.rglob("*")
                    if path.is_file()
                    and path.name != workspace.baseline_path.name
                    and path.suffix != ".jsonl"
                    and path.parent == workspace.card_dir
                }
                final_baseline = load_baseline(workspace.baseline_path)
        finally:
            ops.LIST_FIRST_TIMEOUT_S = original_timeout
            card.close()
        return {
            "card": card,
            "events": events,
            "files": saved_files,
            "baseline": final_baseline,
            "snapshots": snapshots,
            "log": "\n".join(lines),
        }

    def check(self, variant: dict[str, Any], run: dict[str, Any]) -> None:
        expect, card, events, log = (
            variant["expect"],
            run["card"],
            run["events"],
            run["log"],
        )
        wav = card._wav
        expected_name = NEW + "wav"

        # 1. 最终文件：只有新录音这一个文件，字节和哈希都对。
        self.assertEqual(
            sorted(run["files"]),
            [expected_name],
            f"落盘文件不对：{sorted(run['files'])}\n{log}",
        )
        self.assertEqual(
            sha256_bytes(run["files"][expected_name]),
            sha256_bytes(wav),
            "落盘内容和卡上原件不一致",
        )

        # 2. 成功次数：只请求下载一次，只成功、只新写入一次。
        pulls = [
            decode_text(bytes.fromhex(w["params_hex"])[4:28])
            for w in card.writes
            if w["cmd"] == "2-2"
        ]
        self.assertEqual(pulls, [expected_name], f"下载请求：{pulls}\n{log}")
        done = [e for e in events if e["event"] == "download_done"]
        written = [
            e for e in events if e["event"] == "saved" and not e["already_present"]
        ]
        self.assertEqual(len(done), 1, log)
        self.assertEqual(len(written), 1, log)
        self.assertEqual(done[0]["sha256"], sha256_bytes(wav))

        # 3. 基线：下载成功之前一直只有旧文件；结束时是旧文件加新文件；从来没出现过别的名字。
        saved_at = written[0]["t_ms"]
        before = [names for at_ms, names in run["snapshots"] if at_ms < saved_at - 50]
        self.assertTrue(before, "没有采到下载前的基线")
        self.assertTrue(
            all(names == OLD for names in before),
            f"下载前基线被改动：{run['snapshots']}",
        )
        self.assertEqual(run["baseline"], OLD | {NEW})
        self.assertTrue(all(names <= OLD | {NEW} for _at, names in run["snapshots"]))

        # 4. 新文件出现之前不可能下载；出现之后最终被发现。
        download_at = [w["at_ms"] for w in card.writes if w["cmd"] == "2-2"][0]
        self.assertGreaterEqual(download_at, expect["new_file_appears_ms"])

        # 5. 各变体自己的条件。
        saves = [e for e in events if e["event"] == "save_button"]
        self.assertEqual(
            len(saves), expect["save_button_events"], f"保存事件处理次数\n{log}"
        )
        self.assertEqual(card.connects, expect["connects"], f"连接次数\n{log}")
        if "drops" in expect:
            self.assertEqual(card.drops, expect["drops"])
            reconnected_at = [w["at_ms"] for w in card.writes if w["cmd"] == "2-0"]
            self.assertGreaterEqual(len(reconnected_at), 2, "断连后没有重新对账")
        if "lists_missing_new_after_save_min" in expect:
            save_at = saves[0]["t_ms"]
            missing = [
                e
                for e in events
                if e["event"] == "list_checked"
                and e["t_ms"] >= save_at
                and not e["new"]
            ]
            self.assertGreaterEqual(
                len(missing),
                expect["lists_missing_new_after_save_min"],
                f"保存后应当先有几次列表看不到新文件\n{log}",
            )
        if "list_uncertain_min" in expect:
            uncertain = [e for e in events if e["event"] == "list_uncertain"]
            self.assertGreaterEqual(len(uncertain), expect["list_uncertain_min"], log)
            # 不确定那次不能被当成「对账成功、没有新文件」
            first_uncertain = uncertain[0]["t_ms"]
            self.assertLess(first_uncertain, saved_at, "应当先报不确定，之后才下载")
            empty_success = [
                e
                for e in events
                if e["event"] == "list_checked"
                and not e["new"]
                and first_uncertain - 400 <= e["t_ms"] <= first_uncertain
            ]
            self.assertEqual(
                empty_success, [], f"不确定的那次对账被记成了成功的空列表\n{log}"
            )


def _case(variant: dict[str, Any]):
    async def test(self: G4LateListing) -> None:
        self.check(variant, await self.run_watch(variant))

    return test


for _index, _variant in enumerate(G4["variants"]):
    _test = _case(_variant)
    _test.__doc__ = _variant["name"]
    setattr(G4LateListing, f"test_g4_{chr(ord('a') + _index)}", _test)


if __name__ == "__main__":
    unittest.main()
