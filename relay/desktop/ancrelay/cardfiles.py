"""文件类操作的编排：连卡、列文件、下载、校验、落盘，每一步都记日志。"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from .evidence import EvidenceLog, inspect_wav, sha256_bytes
from .filesync import load_baseline, new_entries, output_name, save_baseline
from .ops import CardError, Link, ListUncertain, PullFailed, list_files, pull_file, read_status, stem_of
from .protocol import FileEntry
from .transport import CardLink, LinkLost, scan
from .workspace import (
    Workspace,
    WorkspaceError,
    load_cards,
    remember_card,
    save_without_overwriting,
)

SAVE_SETTLE_S = 1.5
SAVE_BUTTON = 3


async def resolve_address(
    workspace: Workspace, explicit: str | None, log: EvidenceLog
) -> str:
    """地址来源依次是：命令行、上次记住的、现场扫描（只扫到一张时）。"""
    if explicit:
        return explicit
    known = load_cards(workspace).get(workspace.card)
    if known:
        return known
    hits = await scan()
    log.event("scan", found=len(hits))
    if len(hits) == 1:
        return hits[0].address
    if not hits:
        raise WorkspaceError(
            "没有扫到录音卡。先拔掉数据线并唤醒卡，确认没有别的手机或浏览器连着它"
        )
    listing = "；".join(f"{hit.address} {hit.name} 信号 {hit.rssi}" for hit in hits)
    raise WorkspaceError(f"扫到 {len(hits)} 张卡，请用 --address 指定：{listing}")


async def connect_card(
    workspace: Workspace, explicit: str | None, log: EvidenceLog, trace: Any = None
) -> CardLink:
    address = await resolve_address(workspace, explicit, log)
    link = CardLink(trace=trace)
    info = await link.connect(address)
    remember_card(workspace, address)
    log.event(
        "link",
        card=workspace.card,
        address=address,
        mtu=info.mtu,
        max_write=info.max_write,
        key_events=info.key_events,
    )
    return link


async def status_and_list(
    link: Link, log: EvidenceLog
) -> tuple[dict[str, Any], list[FileEntry]]:
    status = await read_status(link)
    log.event("status", **status)
    files = await list_files(link)
    log.event("list", count=len(files), names=[entry.name for entry in files])
    return status, files


def choose_targets(
    files: Sequence[FileEntry],
    workspace: Workspace,
    *,
    name: str | None,
    newest: bool,
    only_new: bool,
) -> list[FileEntry]:
    if name:
        matches = [
            entry
            for entry in files
            if entry.name == name or entry.name.startswith(name)
        ]
        if not matches:
            raise WorkspaceError(f"卡内列表里没有以 {name} 开头的文件")
        return matches[:1]
    if newest:
        if not files:
            raise WorkspaceError("卡内没有文件")
        return [max(files, key=lambda entry: entry.name)]
    if only_new:
        baseline = load_baseline(workspace.baseline_path)
        if baseline is None:
            raise WorkspaceError(
                "还没有基线。先运行一次 baseline，把现有文件记为已存在"
            )
        return new_entries(baseline, files)
    raise WorkspaceError("要下载哪个文件？用 --name、--newest 或 --new 指定")


async def pull_and_save(
    link: Link,
    entry: FileEntry,
    workspace: Workspace,
    log: EvidenceLog,
    *,
    extension: str | None = None,
) -> dict[str, Any]:
    """下载一个文件，校验后落盘。WAV 校验不过的保留为 .invalid，不当作完整文件。

    `extension` 给定时（例如 "opus"）只请求这一种扩展名，不按 .wav → .opus 依次试。
    """
    requested = f"{stem_of(entry.name)}.{extension}" if extension else entry.name
    log.event("download_start", list_name=entry.name, list_size=entry.size, requested=requested)
    milestones = {"next": 256 * 1024}

    def progress(received: int) -> None:
        if received >= milestones["next"]:
            milestones["next"] += 256 * 1024
            log.event("download_progress", bytes=received)

    try:
        pulled = await pull_file(link, requested, on_progress=progress, exact=extension is not None)
    except PullFailed as error:
        # 中途失败：已经收到的字节留作证据，卡内原件还在，可以重新下载。
        kept = None
        if error.partial:
            partial_name = output_name(error.requested_name, b"") + ".partial"
            kept, _written = save_without_overwriting(
                workspace.card_dir, partial_name, error.partial
            )
        log.event(
            "download_failed",
            list_name=entry.name,
            error=str(error),
            partial_bytes=len(error.partial),
            partial_path=str(kept) if kept else None,
        )
        raise
    data = pulled.data
    digest = sha256_bytes(data)
    result: dict[str, Any] = {
        "list_name": entry.name,
        "requested": pulled.requested_name,
        "reported": pulled.reported_name,
        "attempts": pulled.attempts,
        "start_2_3": pulled.start_seen,
        "data_frames_2_4": pulled.data_frames,
        "end_code_2_5": pulled.end_code,
        "bytes": len(data),
        "sha256": digest,
    }
    name = output_name(pulled.requested_name, data)

    if data[:4] == b"RIFF":
        info = inspect_wav(data)
        result.update(
            wav_ok=info.ok,
            wav_reason=info.reason,
            sample_rate=info.sample_rate,
            channels=info.channels,
            bits=info.bits_per_sample,
            duration_s=round(info.duration_s, 3),
        )
        if not info.ok:
            path, _written = save_without_overwriting(
                workspace.card_dir, name + ".invalid", data
            )
            log.event("download_invalid", **result, path=str(path))
            raise CardError(
                f"{entry.name}：下载到的 WAV 校验不过（{info.reason}），已保留为 {path.name}"
            )
    else:
        asked_wav = pulled.requested_name.lower().endswith(".wav")
        result["format"] = (
            "请求了 .wav 但内容不是 RIFF，按 .bin 保存"
            if asked_wav
            else "非 WAV，原样保存待解码"
        )

    log.event("download_done", **result)
    path, written = save_without_overwriting(workspace.card_dir, name, data)
    log.event(
        "saved",
        path=str(path),
        already_present=not written,
        bytes=len(data),
        sha256=digest,
    )
    return {**result, "path": str(path)}


async def pull_new_files(
    link: Link, workspace: Workspace, log: EvidenceLog
) -> list[dict[str, Any]]:
    """列文件，下载基线之外的新录音，并把它们记进基线。"""
    files = await list_files(link)
    baseline = load_baseline(workspace.baseline_path)
    if baseline is None:
        save_baseline(workspace.baseline_path, [entry.name for entry in files])
        log.event("baseline_created", count=len(files))
        return []
    fresh = new_entries(baseline, files)
    log.event("list_checked", total=len(files), new=[entry.name for entry in fresh])
    results: list[dict[str, Any]] = []
    for entry in fresh:
        results.append(await pull_and_save(link, entry, workspace, log))
        baseline.add(entry.name)
        save_baseline(workspace.baseline_path, baseline)
    return results


async def watch(
    workspace: Workspace,
    explicit_address: str | None,
    log: EvidenceLog,
    *,
    poll_s: float,
    connect: Callable[[], Awaitable[Any]] | None = None,
    settle_s: float = SAVE_SETTLE_S,
    reconnect_wait_s: float = 3.0,
) -> None:
    """守着一张卡：机身按下保存，或者每隔一段时间，就对账并取回新录音。断线自动重连。

    `connect` 只给离线回放用：传入一个返回已连接链路的函数，代替真实蓝牙连接。
    不传时行为和以前完全一样。
    """
    while True:
        link: CardLink | None = None
        try:
            opening = connect() if connect is not None else connect_card(workspace, explicit_address, log)
            link = await opening
            await _reconcile(link, workspace, log)
            while True:
                # 机身事件和命令应答分开排队：下载、列表的等待者读不到事件，也就吞不掉。
                event = await link.next_event(poll_s)
                if event is None:
                    _drop_stale_responses(link, log)
                    await _reconcile(link, workspace, log)
                    continue
                if event.type == 3 and event.cmd == SAVE_BUTTON:
                    log.event("save_button", repeats=event.repeats)
                    await asyncio.sleep(settle_s)
                    # 等待期间又到的保存事件，会被下面这次对账一起覆盖；对账开始后才到的留给下一轮。
                    covered = link.take_events(_is_save_event)
                    if covered:
                        log.event("save_button_coalesced", count=sum(e.repeats for e in covered))
                    _drop_stale_responses(link, log)
                    await _reconcile(link, workspace, log)
                else:
                    log.event("card_event", type=event.type, cmd=event.cmd, repeats=event.repeats)
        except LinkLost as error:
            log.event("link_lost", reason=str(error))
        except (CardError, WorkspaceError, OSError, asyncio.TimeoutError) as error:
            log.event("watch_error", error=f"{type(error).__name__}: {error}")
        finally:
            if link is not None:
                await link.disconnect()
        await asyncio.sleep(reconnect_wait_s)


async def _reconcile(link: Any, workspace: Workspace, log: EvidenceLog) -> None:
    """watch 里的一次对账。列表不确定时不断开重连：记日志，等下一次轮询或事件再试。"""
    try:
        await pull_new_files(link, workspace, log)
    except ListUncertain as error:
        log.event("list_uncertain", error=str(error), report=getattr(link, "last_list_report", None))


def _is_save_event(event: Any) -> bool:
    return event.type == 3 and event.cmd == SAVE_BUTTON


def _drop_stale_responses(link: Any, log: EvidenceLog) -> None:
    """对账前清掉队列里已经到达的旧应答（例如迟到的重复 2-5）。

    以前 watch 的空闲循环会顺手读掉它们；现在空闲时等的是事件，所以显式清理。
    列表帧（2-1、2-18）不在这里清，留给 list_files 按自己的规则处理和记账。
    """
    stale = link.drain_responses(lambda _source, frame: not (frame.type == 2 and frame.cmd in (1, 18)))
    if stale:
        log.event("stale_responses_dropped", count=len(stale),
                  cmds=[f"{frame.type}-{frame.cmd}" for _source, frame in stale])


async def resume_test(
    workspace: Workspace,
    explicit_address: str | None,
    log: EvidenceLog,
    *,
    list_name: str,
    extension: str,
    cut_at: int,
    trace: Any = None,
    reconnect_wait_s: float = 3.0,
) -> dict[str, Any]:
    """断连续传测试：下到 cut_at 字节就断开连接（不发终止命令），重连后用 offset 续传；
    最后再用 offset=0 完整重下一遍做对照。每一步都记日志，结果原样保存，不替人下结论。
    """
    requested = f"{stem_of(list_name)}.{extension}"
    report: dict[str, Any] = {"requested": requested, "cut_at": cut_at}

    link = await connect_card(workspace, explicit_address, log, trace)
    try:
        log.event("resume_phase", phase="first_part", requested=requested, offset=0, stop_after=cut_at)
        first = await pull_file(link, requested, exact=True, stop_after=cut_at)
    finally:
        await link.disconnect()
    _flush(trace, "first_part")
    report.update(first_bytes=len(first.data), first_frames=first.data_frames, first_end_code=first.end_code)
    log.event("resume_cut", received_before_drop=len(first.data), data_frames=first.data_frames,
              end_code=first.end_code, note="主动断开蓝牙，没有发 2-7")
    if first.end_code == 0:
        log.event("resume_note", note="文件比 cut_at 小，第一段已经下完，续传没有被测到")

    await asyncio.sleep(reconnect_wait_s)
    link = await connect_card(workspace, explicit_address, log, trace)
    try:
        offset = len(first.data)
        log.event("resume_phase", phase="second_part", requested=requested, offset=offset)
        try:
            second = await pull_file(link, requested, exact=True, offset=offset)
            report.update(second_bytes=len(second.data), second_frames=second.data_frames,
                          second_end_code=second.end_code, second_started=second.start_seen)
            joined = first.data + second.data
            report.update(_describe_bytes("joined", joined))
            _keep(workspace, f"{stem_of(list_name)}-resumed.{extension}", joined, log, "joined")
        except CardError as error:
            partial = getattr(error, "partial", b"")
            report.update(second_error=str(error), second_partial_bytes=len(partial))
            log.event("resume_second_failed", error=str(error), partial_bytes=len(partial))
        _flush(trace, "second_part")

        log.event("resume_phase", phase="full_redownload", requested=requested, offset=0)
        full = await pull_file(link, requested, exact=True)
        report.update(full_frames=full.data_frames, full_end_code=full.end_code)
        report.update(_describe_bytes("full", full.data))
        _keep(workspace, f"{stem_of(list_name)}-redownload.{extension}", full.data, log, "full")
        _flush(trace, "full_redownload")
    finally:
        await link.disconnect()
    _keep(workspace, f"{stem_of(list_name)}-first-part.{extension}.part", first.data, log, "first_part")

    if "joined_sha256" in report:
        report["joined_equals_full"] = report["joined_sha256"] == report["full_sha256"]
    log.event("resume_result", **report)
    return report


def _describe_bytes(label: str, data: bytes) -> dict[str, Any]:
    described: dict[str, Any] = {f"{label}_bytes": len(data), f"{label}_sha256": sha256_bytes(data)}
    if data[:4] == b"RIFF":
        info = inspect_wav(data)
        described.update({f"{label}_wav_ok": info.ok, f"{label}_wav_reason": info.reason,
                          f"{label}_duration_s": round(info.duration_s, 3)})
    return described


def _keep(workspace: Workspace, name: str, data: bytes, log: EvidenceLog, label: str) -> None:
    if not data:
        return
    path, written = save_without_overwriting(workspace.card_dir / "resume-test", name, data)
    log.event("saved", label=label, path=str(path), already_present=not written, bytes=len(data),
              sha256=sha256_bytes(data))


def _flush(trace: Any, label: str) -> None:
    if trace is not None and hasattr(trace, "flush"):
        trace.flush(label)
