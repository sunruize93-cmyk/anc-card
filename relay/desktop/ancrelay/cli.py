"""命令行入口。用法见 relay/desktop/README.md。"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import threading
from pathlib import Path
from typing import Any

from .trace import Tracer
from .cardfiles import (
    resume_test,
    choose_targets,
    connect_card,
    pull_and_save,
    status_and_list,
    watch,
)
from .drill import StreamDrill
from .evidence import inspect_wav, sha256_file
from .filesync import save_baseline
from .ops import CardError
from .safety import ForbiddenCommand
from .stream import StreamRecorder
from .transport import FrameTooLarge, LinkLost, scan
from .upload import (
    UploadError,
    default_recording_id,
    fetch_result,
    describe_file,
    receipt_problems,
    resend_problems,
    upload_once,
    validate_url,
)
from .workspace import WorkspaceError, make_workspace, new_session_id, open_log

TOKEN_ENV = "ANC_UPLOAD_TOKEN"


def say(text: str = "") -> None:
    print(text, flush=True)


def _session(args: argparse.Namespace, kind: str) -> tuple[Any, Any]:
    workspace = make_workspace(args.out, args.card)
    log = open_log(workspace, args.session or new_session_id(args.card, kind))
    return workspace, log


async def cmd_scan(args: argparse.Namespace) -> int:
    say(f"扫描 {args.seconds:g} 秒……")
    hits = await scan(args.seconds)
    for hit in hits:
        say(f"  {hit.address}  {hit.name}  信号 {hit.rssi}")
    if not hits:
        say("没有扫到录音卡。先拔掉数据线并唤醒卡，确认没有别的手机或浏览器连着它。")
    return 0 if hits else 1


async def cmd_status(args: argparse.Namespace) -> int:
    workspace, log = _session(args, "status")
    link = await connect_card(workspace, args.address, log)
    try:
        await status_and_list(link, log)
    finally:
        await link.disconnect()
    say(f"日志：{log.path}")
    return 0


async def cmd_baseline(args: argparse.Namespace) -> int:
    workspace, log = _session(args, "baseline")
    link = await connect_card(workspace, args.address, log)
    try:
        _status, files = await status_and_list(link, log)
    finally:
        await link.disconnect()
    save_baseline(workspace.baseline_path, [entry.name for entry in files])
    log.event("baseline_saved", count=len(files), path=str(workspace.baseline_path))
    return 0


def _tracer(args: argparse.Namespace, log: Any) -> Any:
    return Tracer(log) if getattr(args, "trace", False) else None


async def cmd_pull(args: argparse.Namespace) -> int:
    workspace, log = _session(args, "pull")
    trace = _tracer(args, log)
    link = await connect_card(workspace, args.address, log, trace)
    try:
        _status, files = await status_and_list(link, log)
        targets = choose_targets(
            files, workspace, name=args.name, newest=args.newest, only_new=args.new
        )
        if not targets:
            say("没有新录音。")
        for entry in targets:
            result = await pull_and_save(
                link, entry, workspace, log, extension=args.ext
            )
            started = "收到" if result["start_2_3"] else "没收到"
            say(f"已保存 {result['path']}")
            say(f"  字节数 {result['bytes']}  SHA-256 {result['sha256']}")
            say(
                f"  2-3 开始：{started}　2-4 数据帧：{result['data_frames_2_4']}　2-5 结束码：{result['end_code_2_5']}"
            )
    finally:
        await link.disconnect()
        if trace is not None:
            trace.flush("pull")
    say(f"日志：{log.path}")
    return 0


async def cmd_resume_test(args: argparse.Namespace) -> int:
    workspace, log = _session(args, "resume")
    report = await resume_test(
        workspace,
        args.address,
        log,
        list_name=args.name,
        extension=args.ext,
        cut_at=args.cut_at,
        trace=_tracer(args, log),
    )
    for key, value in report.items():
        say(f"  {key}: {value}")
    say(f"日志：{log.path}")
    return 0


async def cmd_watch(args: argparse.Namespace) -> int:
    workspace, log = _session(args, "watch")
    say("守着这张卡，按 Ctrl+C 结束。")
    await watch(workspace, args.address, log, poll_s=args.every)
    return 0


def _feed_console(
    loop: asyncio.AbstractEventLoop, commands: asyncio.Queue[str]
) -> None:
    for line in sys.stdin:
        loop.call_soon_threadsafe(commands.put_nowait, line.strip())


async def cmd_stream(args: argparse.Namespace) -> int:
    workspace, log = _session(args, "stream")
    session_id = log.path.stem
    recorder = StreamRecorder(workspace.card_dir, session_id, now_ms=log.now_ms)
    commands: asyncio.Queue[str] = asyncio.Queue()
    threading.Thread(
        target=_feed_console, args=(asyncio.get_running_loop(), commands), daemon=True
    ).start()

    async def connect() -> Any:
        return await connect_card(workspace, args.address, log)

    say(
        "推流开始后：直接输入文字回车＝记一个口令标记；/drop 主动断开；/back 重新连接；/stop 结束。"
    )
    drill = StreamDrill(
        connect=connect,
        recorder=recorder,
        log=log,
        commands=commands,
        max_seconds=args.minutes * 60 if args.minutes else None,
    )
    try:
        await drill.run()
    finally:
        # 不管正常结束、出错还是 Ctrl+C，都把已经收到的音频整理出来。
        recorder.close()
        _finish_stream(recorder, workspace.card_dir, session_id, log.path)
    return 0


def _finish_stream(
    recorder: StreamRecorder, card_dir: Path, session_id: str, log_path: Path
) -> None:
    summary = recorder.summary()
    ogg_files = recorder.wrap_ogg()
    summary_path = card_dir / f"{session_id}-summary.json"
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    first = summary["segments"][0] if summary["segments"] else {}
    gaps = "、".join(f"{gap['gap_ms'] / 1000:.1f}" for gap in summary["gaps"]) or "无"
    say()
    say(
        f"会话 ID {session_id}　发送端 Windows　开始至首帧 {_seconds(first.get('first_frame_latency_ms'))} 秒　"
        f"中断至恢复 {gaps} 秒"
    )
    for segment in summary["segments"]:
        say(
            f"  第 {segment['index']} 段：{segment['packets']} 包，{segment['audio_ms'] / 1000:.1f} 秒，"
            f"结束原因 {segment['end_reason']}，{segment['raw_file']}"
        )
    say(f"  本轮卡内文件名：{'、'.join(summary['stream_names']) or '卡没有上报'}")
    say(f"  可播放文件：{'、'.join(path.name for path in ogg_files) or '无'}")
    say(f"摘要：{summary_path}")
    say(f"日志：{log_path}")


def _seconds(milliseconds: int | None) -> str:
    return "无" if milliseconds is None else f"{milliseconds / 1000:.2f}"


def cmd_verify(args: argparse.Namespace) -> int:
    path = Path(args.file)
    data = path.read_bytes()
    say(f"文件 {path}")
    say(f"字节数 {len(data)}")
    say(f"SHA-256 {sha256_file(path)}")
    if data[:4] != b"RIFF":
        say("不是 WAV，只核对了大小和哈希。")
        return 0
    info = inspect_wav(data)
    if not info.ok:
        say(f"WAV 校验不过：{info.reason}")
        return 1
    say(
        f"WAV 正常：{info.sample_rate} Hz，{info.channels} 声道，{info.bits_per_sample} 位，"
        f"格式码 {info.audio_format}，时长 {info.duration_s:.2f} 秒"
    )
    return 0


def cmd_upload(args: argparse.Namespace) -> int:
    workspace, log = _session(args, "upload")
    url = validate_url(args.url, allow_http=args.allow_http)
    token = os.environ.get(TOKEN_ENV)
    if not token:
        raise UploadError(f"没有凭证：先把上传凭证放进环境变量 {TOKEN_ENV}")
    ca_file = Path(args.ca) if args.ca else None
    path = Path(args.file)
    meta = describe_file(
        path, recording_id=args.recording_id or default_recording_id(args.card, path)
    )
    log.event(
        "upload_file",
        file=meta.filename,
        bytes=meta.size,
        sha256=meta.sha256,
        recording_id=meta.recording_id,
        ca=str(ca_file) if ca_file else None,
        has_token=True,
    )
    receipts = []
    problems: list[str] = []
    for attempt in range(1, args.repeat + 1):
        receipt = upload_once(url, meta, token, ca_file=ca_file)
        receipts.append(receipt)
        problems.extend(receipt_problems(receipt, meta))
        label = "首传" if attempt == 1 else "重传"
        log.event(
            "receipt",
            attempt=attempt,
            label=label,
            status=receipt.status,
            response_json=receipt.raw,
        )
        say(
            f"第 {attempt} 次（{label}）HTTP {receipt.status}：{json.dumps(receipt.raw, ensure_ascii=False)}"
        )
    if args.fetch_result and receipts and receipts[-1].result_path:
        status, body = fetch_result(
            url, receipts[-1].result_path, token, ca_file=ca_file
        )
        log.event("result", status=status, response_json=body)
        say(f"结果查询 HTTP {status}：{json.dumps(body, ensure_ascii=False)[:4000]}")
    problems.extend(resend_problems(receipts))
    for problem in dict.fromkeys(problems):
        log.event("receipt_problem", problem=problem)
    say(
        "回执核对通过。"
        if not problems
        else f"回执有 {len(set(problems))} 个问题，见上。"
    )
    say(f"日志：{log.path}")
    return 1 if problems else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ancrelay", description="ANC Card 桌面中转工具（只读卡，永不删除卡内文件）"
    )
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--card", default="A", help="卡的标签，例如 A（默认 A）")
    common.add_argument("--address", help="蓝牙地址；省略时用上次记住的，或现场扫描")
    common.add_argument(
        "--out",
        help="私有工作目录（默认是仓库根目录下的 .anc-field/，已被 git 忽略；也可用环境变量 ANC_FIELD_DIR）",
    )
    common.add_argument("--session", help="会话 ID；两个人对同一轮测试时用同一个")
    commands = parser.add_subparsers(dest="command", required=True)

    scan_parser = commands.add_parser("scan", help="扫描附近的录音卡")
    scan_parser.add_argument("--seconds", type=float, default=8.0)
    scan_parser.set_defaults(handler=cmd_scan)

    commands.add_parser(
        "status", parents=[common], help="读电量、容量、固件和文件列表"
    ).set_defaults(handler=cmd_status)
    commands.add_parser(
        "baseline", parents=[common], help="把卡内现有文件记为已存在"
    ).set_defaults(handler=cmd_baseline)

    pull_parser = commands.add_parser("pull", parents=[common], help="下载文件并校验")
    which = pull_parser.add_mutually_exclusive_group(required=True)
    which.add_argument("--name", help="列表里的文件名或它的开头")
    which.add_argument("--newest", action="store_true", help="文件名最新的一条")
    which.add_argument("--new", action="store_true", help="基线之外的全部新录音")
    pull_parser.add_argument(
        "--ext",
        choices=["wav", "opus"],
        help="只请求这一种扩展名（默认先试 wav 再试 opus）",
    )
    pull_parser.add_argument(
        "--trace", action="store_true", help="把每个发出的命令和收到的非音频帧写进日志"
    )
    pull_parser.set_defaults(handler=cmd_pull)

    resume_parser = commands.add_parser(
        "resume-test",
        parents=[common],
        help="断连续传测试：下一部分断开，重连后按 offset 续传，再完整重下对照",
    )
    resume_parser.add_argument("--name", required=True, help="列表里的文件名或它的开头")
    resume_parser.add_argument("--ext", choices=["wav", "opus"], default="wav")
    resume_parser.add_argument(
        "--cut-at", type=int, required=True, help="收到这么多字节后断开"
    )
    resume_parser.add_argument("--trace", action="store_true", help="记录 TX/RX")
    resume_parser.set_defaults(handler=cmd_resume_test)

    watch_parser = commands.add_parser(
        "watch", parents=[common], help="守着卡，自动取回新录音"
    )
    watch_parser.add_argument(
        "--every", type=float, default=30.0, help="没有按键事件时每隔多少秒对账一次"
    )
    watch_parser.set_defaults(handler=cmd_watch)

    stream_parser = commands.add_parser(
        "stream", parents=[common], help="实时推流与断连恢复演练"
    )
    stream_parser.add_argument(
        "--minutes", type=float, help="到时间自动结束；省略则等 /stop"
    )
    stream_parser.set_defaults(handler=cmd_stream)

    verify_parser = commands.add_parser(
        "verify", help="核对一个本地文件的大小、哈希和 WAV 头"
    )
    verify_parser.add_argument("file")
    verify_parser.set_defaults(handler=cmd_verify)

    upload_parser = commands.add_parser(
        "upload",
        parents=[common],
        help=f"上传原件并核对回执（凭证放环境变量 {TOKEN_ENV}）",
    )
    upload_parser.add_argument("file")
    upload_parser.add_argument("--url", required=True, help="后台的上传地址")
    upload_parser.add_argument(
        "--repeat",
        type=int,
        default=2,
        choices=range(1, 6),
        help="发几次（默认 2，用来验证重传）",
    )
    upload_parser.add_argument(
        "--recording-id",
        help="X-Recording-ID，同一录音保持不变（默认「卡标签-文件主名」）",
    )
    upload_parser.add_argument(
        "--ca", help="后台测试 CA 证书文件（PEM）；不关闭证书验证"
    )
    upload_parser.add_argument(
        "--fetch-result",
        action="store_true",
        help="上传后按回执里的 resultPath 查询一次结果",
    )
    upload_parser.add_argument(
        "--allow-http",
        action="store_true",
        help="允许向局域网地址发明文 http（仅临时联调）",
    )
    upload_parser.set_defaults(handler=cmd_upload)
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    try:
        if asyncio.iscoroutinefunction(args.handler):
            return asyncio.run(args.handler(args))
        return args.handler(args)
    except KeyboardInterrupt:
        say("已中止。")
        return 130
    except (
        CardError,
        LinkLost,
        UploadError,
        WorkspaceError,
        ForbiddenCommand,
        FrameTooLarge,
        OSError,
        asyncio.TimeoutError,
        ValueError,  # 包括工作目录里的 JSON 文件被写坏的情况
    ) as error:
        print(f"失败：{error}", file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 - 蓝牙库的异常类型随平台变化，统一成一行可读的失败信息
        if type(error).__module__.startswith("bleak"):
            print(f"蓝牙失败：{type(error).__name__}: {error}", file=sys.stderr)
            return 1
        raise
