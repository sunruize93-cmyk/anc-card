"""离线 BLE 协议回放回归。不连卡、不联网、不上传。

运行（在 relay/desktop 目录）：
    .venv\\Scripts\\python -m pytest replay -v -rxX
或者只用标准库：
    .venv\\Scripts\\python -m unittest discover -s replay -t . -v

JSON 里带 known_gap 的场景是「现有实现已知做不到」的最小失败用例，用 expectedFailure 标出：
它们失败是预期的；如果哪天意外通过，测试会报 unexpected success，提醒去更新这份说明。
设环境变量 REPLAY_SHOW_GAPS=1 可以把它们当普通测试跑，看到具体的失败信息。
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any

from ancrelay.cardfiles import watch
from ancrelay.evidence import EvidenceLog
from ancrelay.filesync import save_baseline
from ancrelay.ops import CardError, list_files, pull_file, read_record_state, read_status
from ancrelay.protocol import decode_text
from ancrelay.workspace import Workspace

from replay.harness import ScriptedCard, connect_link, frame_bytes, load_scenario

G1 = load_scenario("g1-channels-fragments.json")
G2 = load_scenario("g2-new-recording.json")
G3 = load_scenario("g3-download-tail.json")


class ReplayCase(unittest.IsolatedAsyncioTestCase):
    """IsolatedAsyncioTestCase 默认开启 asyncio 调试模式，它会给每个回调和定时器记录调用栈。
    回放场景里一次下载有几百个通知回调，调试开销会把合成时序拉长好几倍，测出来的是调试器的速度。
    所以回放统一在关闭调试模式的事件循环里跑（与生产运行时一致）。
    """

    async def asyncSetUp(self) -> None:
        asyncio.get_running_loop().set_debug(False)


def buffers_empty(link: Any) -> bool:
    return not link._ae22.buffer and not link._ae23.buffer


async def run_read_status(
    on_command: dict[str, Any],
) -> tuple[dict[str, Any], bool, ScriptedCard]:
    card = ScriptedCard(
        {"on_command": on_command, "files": [{"from_ms": 0, "names": []}]}
    )
    link = await connect_link(card)
    try:
        status = await read_status(link)
        await asyncio.sleep(0.05)
        return status, buffers_empty(link), card
    finally:
        await link.disconnect()
        card.close()


class G1ChannelsAndFragments(ReplayCase):
    """通道与分片：现有 CardLink + 厂商 FrameParser + ops.read_status。"""

    async def test_exhaustive_cut_points(self) -> None:
        combined = G1["exhaustive"]["combined_frames"]
        battery = G1["exhaustive"]["battery_frame"]
        total = len(b"".join(frame_bytes(spec, spec["seq"]) for spec in combined))
        battery_len = len(frame_bytes(battery, 0))
        failures = []
        for cut in range(1, total):
            on_command = {
                "0-3": [[{"channel": "ae23", "delay_ms": 3, "frames": [battery]}]],
                "0-1": [[]],
                "0-10": [
                    [
                        {
                            "channel": "ae22",
                            "delay_ms": 3,
                            "split_at": [cut],
                            "frames": combined,
                        }
                    ]
                ],
            }
            status, empty, _ = await run_read_status(on_command)
            if status != G1["expect"]["status"] or not empty:
                failures.append(("combined", cut, status, empty))
        for cut in range(1, battery_len):
            on_command = {
                "0-3": [
                    [
                        {
                            "channel": "ae23",
                            "delay_ms": 3,
                            "split_at": [cut],
                            "frames": [battery],
                        }
                    ]
                ],
                "0-1": [[{"channel": "ae22", "delay_ms": 3, "frames": [combined[0]]}]],
                "0-10": [[{"channel": "ae22", "delay_ms": 3, "frames": [combined[1]]}]],
            }
            status, empty, _ = await run_read_status(on_command)
            if status != G1["expect"]["status"] or not empty:
                failures.append(("battery", cut, status, empty))
        self.assertEqual(failures, [], f"共 {total - 1 + battery_len - 1} 个切点")


def _g1_case(variant: dict[str, Any]):
    async def test(self: unittest.IsolatedAsyncioTestCase) -> None:
        status, empty, card = await run_read_status(variant["on_command"])
        self.assertEqual(status, G1["expect"]["status"])
        self.assertTrue(empty, "解析缓冲里残留了半帧")
        self.assertEqual([w["cmd"] for w in card.writes], ["0-3", "0-1", "0-10"])

    return test


class G2NewRecordingDiscovery(ReplayCase):
    """新录音发现：真实的 cardfiles.watch 循环，只把蓝牙连接换成脚本卡。"""

    async def run_watch(
        self, variant: dict[str, Any]
    ) -> tuple[list[dict[str, Any]], ScriptedCard]:
        card = ScriptedCard(variant["card"])
        options = variant["watch"]
        with tempfile.TemporaryDirectory() as folder:
            workspace = Workspace(Path(folder), "A")
            save_baseline(workspace.baseline_path, G2["baseline"])
            self.watch_log: list[str] = []
            log = EvidenceLog(
                workspace.log_path("replay"), "replay", echo=self.watch_log.append
            )
            task = asyncio.create_task(
                watch(
                    workspace,
                    None,
                    log,
                    poll_s=options["poll_s"],
                    settle_s=options["settle_s"],
                    reconnect_wait_s=0.05,
                    connect=lambda: connect_link(card),
                )
            )
            await asyncio.sleep(options["run_s"])
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            card.close()
        downloads = [
            {
                "name": decode_text(bytes.fromhex(w["params_hex"])[4:28]),
                "at_ms": w["at_ms"],
            }
            for w in card.writes
            if w["cmd"] == "2-2"
        ]
        return downloads, card

    def check(self, variant: dict[str, Any], downloads: list[dict[str, Any]]) -> None:
        expect = variant["expect"]
        self.assertEqual(
            [d["name"] for d in downloads],
            expect["downloads"],
            f"实际下载：{downloads}\nwatch 日志：\n"
            + "\n".join(getattr(self, "watch_log", [])),
        )
        if "no_download_before_ms" in expect:
            early = [
                d for d in downloads if d["at_ms"] < expect["no_download_before_ms"]
            ]
            self.assertEqual(early, [], "在应当可以下载之前就发了下载请求")
        if "found_by_ms" in expect:
            late = [d for d in downloads if d["at_ms"] > expect["found_by_ms"]]
            self.assertEqual(late, [], "发现得太晚")

    def check_lists(self, variant: dict[str, Any], card: ScriptedCard) -> None:
        rule = variant["expect"].get("lists_after_ms")
        if rule is None:
            return
        lists = [
            w["at_ms"]
            for w in card.writes
            if w["cmd"] == "2-0" and w["at_ms"] >= rule["from_ms"]
        ]
        self.assertEqual(
            len(lists), rule["count"], f"{rule['why']}；实际列表请求时间：{lists}"
        )


class WatchListUncertain(ReplayCase):
    """卡只回孤立的 2-18、从不回 2-1 时，watch 记「列表不确定」并等下一轮，不断开重连。"""

    async def test_uncertain_list_backs_off_without_reconnecting(self) -> None:
        import ancrelay.ops as ops

        orphan = [[{"channel": "ae22", "delay_ms": 5, "frames": [{"type": 2, "cmd": 18, "params_hex": "00", "seq": 0}]}]]
        card = ScriptedCard({"files": [{"from_ms": 0, "names": []}], "on_command": {"2-0": orphan}})
        original = ops.LIST_FIRST_TIMEOUT_S
        ops.LIST_FIRST_TIMEOUT_S = 0.1  # 只缩短「等 2-1」的超时，让场景在一秒内跑完
        lines: list[str] = []
        try:
            with tempfile.TemporaryDirectory() as folder:
                workspace = Workspace(Path(folder), "A")
                save_baseline(workspace.baseline_path, ["note20261114-090000."])
                log = EvidenceLog(workspace.log_path("replay"), "replay", echo=lines.append)
                task = asyncio.create_task(watch(workspace, None, log, poll_s=0.2, settle_s=0.05,
                                                 reconnect_wait_s=0.05, connect=lambda: connect_link(card)))
                await asyncio.sleep(1.2)
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        finally:
            ops.LIST_FIRST_TIMEOUT_S = original
            card.close()
        uncertain = [line for line in lines if "list_uncertain" in line]
        self.assertGreaterEqual(len(uncertain), 2, chr(10).join(lines))
        self.assertEqual(card.connects, 1, "列表不确定时不应断开重连：" + chr(10).join(lines))
        self.assertEqual([w for w in card.writes if w["cmd"] == "2-2"], [], "不确定时不应下载")


def _g2_case(variant: dict[str, Any]):
    async def test(self: G2NewRecordingDiscovery) -> None:
        downloads, card = await self.run_watch(variant)
        self.check(variant, downloads)
        self.check_lists(variant, card)

    return test


class G3DownloadTail(ReplayCase):
    """下载收尾：ops.pull_file / read_status / read_record_state / list_files 的串行调用。"""

    async def run_sequence(
        self, variant: dict[str, Any]
    ) -> tuple[dict[str, Any], ScriptedCard, Any]:
        card = ScriptedCard(variant["card"])
        link = await connect_link(card)
        results: dict[str, Any] = {"lists": []}
        try:
            for step in variant["sequence"]:
                if step.startswith("pull:"):
                    results["pull"] = (await pull_file(link, step[5:])).data
                elif step == "read_status":
                    results["status"] = await read_status(link)
                elif step == "read_record_state":
                    results["record_state"] = await read_record_state(link)
                elif step == "list":
                    try:
                        results["lists"].append(
                            [entry.name for entry in await list_files(link)]
                        )
                    except CardError as error:
                        results["list_error"] = type(error).__name__
                    results["report_last"] = dict(getattr(link, "last_list_report", {}))
                    results.setdefault("reports", []).append(results["report_last"])
                elif step.startswith("sleep:"):
                    await asyncio.sleep(int(step[6:]) / 1000)
            await asyncio.sleep(0.1)
            results["buffers_empty"] = buffers_empty(link)
            results["late_list_ends"] = getattr(link, "late_list_ends", None)
            return results, card, link
        finally:
            await link.disconnect()
            card.close()


def _g3_case(variant: dict[str, Any]):
    async def test(self: G3DownloadTail) -> None:
        results, card, _link = await self.run_sequence(variant)
        expect = variant["expect"]
        if expect.get("pull_bytes") == "wav":
            self.assertEqual(results["pull"], card._wav)
        if "status_battery" in expect:
            self.assertEqual(
                results["status"]["battery_percent"], expect["status_battery"]
            )
        if "record_state" in expect:
            self.assertEqual(results["record_state"], expect["record_state"])
        if "list" in expect:
            self.assertEqual(results["lists"][0], expect["list"])
        if "lists" in expect:
            self.assertEqual(results["lists"], expect["lists"])
        if "list_error" in expect:
            self.assertEqual(
                results.get("list_error"),
                expect["list_error"],
                "应当报不确定，而不是返回空列表",
            )
            self.assertEqual(results["lists"], [], "不确定时不能有列表结果")
        for key, value in expect.get("report_last", {}).items():
            self.assertEqual(
                results["report_last"].get(key),
                value,
                f"最后一次列表的 {key}：{results['report_last']}",
            )
        for index, wanted in enumerate(expect.get("reports", [])):
            got = results["reports"][index]
            for key, value in wanted.items():
                self.assertEqual(got.get(key), value, f"第 {index + 1} 次列表的 {key}：{got}")
        if "late_list_ends_after" in expect:
            self.assertEqual(
                results["late_list_ends"],
                expect["late_list_ends_after"],
                "还挂着没对上的迟到结束帧",
            )
        if expect.get("parser_buffers_empty"):
            self.assertTrue(results["buffers_empty"], "解析缓冲里残留了半帧")

    return test


def _attach(cls: type, group: dict[str, Any], factory: Any) -> None:
    for index, variant in enumerate(group["variants"]):
        test = factory(variant)
        if "known_gap" in variant and not os.environ.get("REPLAY_SHOW_GAPS"):
            test = unittest.expectedFailure(test)
        test.__doc__ = variant["name"]
        setattr(cls, f"test_{group['id'].lower()}_{chr(ord('a') + index)}", test)


_attach(G1ChannelsAndFragments, G1, _g1_case)
_attach(G2NewRecordingDiscovery, G2, _g2_case)
_attach(G3DownloadTail, G3, _g3_case)
