"""发给录音卡的每条命令都先过这里。

只放行联调用得到的命令：读状态、列文件、下载、实时音频的开始和结束。
删除类命令永远拒绝；其余会改变卡内状态的命令（同步时间、开始或保存录音、
设置增益）也不放行，需要时由人按机身按键。
"""

from __future__ import annotations

ALLOWED: dict[tuple[int, int], str] = {
    (0, 1): "读容量",
    (0, 3): "读电量",
    (0, 10): "读固件版本",
    (1, 0): "开始实时音频",
    (1, 2): "结束实时音频",
    (2, 0): "列文件",
    (2, 2): "下载文件",
    (2, 7): "终止下载",
    (3, 19): "读录音状态",
    (3, 21): "读录音时长和大小",
    (3, 23): "读当前文件名",
}

FORBIDDEN: dict[tuple[int, int], str] = {
    (2, 8): "删除单个文件",
    (2, 9): "删除全部文件",
}


class ForbiddenCommand(RuntimeError):
    """这条命令不允许发给录音卡。"""


def describe(payload: bytes) -> str:
    if len(payload) < 2:
        return "空命令"
    key = (payload[0], payload[1])
    label = ALLOWED.get(key) or FORBIDDEN.get(key) or "未知命令"
    return f"{key[0]}-{key[1]} {label}"


def assert_safe(payload: bytes) -> None:
    if len(payload) < 2:
        raise ForbiddenCommand("命令太短，没有 TYPE 和 CMD")
    key = (payload[0], payload[1])
    if key in FORBIDDEN:
        raise ForbiddenCommand(f"拒绝发送 {describe(payload)}：本工具永不删除卡内文件")
    if key not in ALLOWED:
        raise ForbiddenCommand(f"拒绝发送 {describe(payload)}：不在允许的命令清单里")
