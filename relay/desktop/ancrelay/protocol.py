"""加载厂商的协议模块。其余代码只从这里导入，不直接碰 third_party/。

厂商文件原样放在 third_party/qs668/，来源和版本见该目录的 README。
"""

from __future__ import annotations

import sys
from pathlib import Path

_VENDOR_DIR = Path(__file__).resolve().parent.parent / "third_party" / "qs668"
if str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))

from qs668_protocol import (  # noqa: E402
    KEY_NOTIFY_UUID,
    NOTIFY_UUID,
    SERVICE_UUID,
    WRITE_UUID,
    FileEntry,
    Frame,
    FrameParser,
    build_frame,
    cmd_abort_import,
    cmd_get_battery,
    cmd_get_capacity,
    cmd_get_firmware,
    cmd_get_record_state,
    cmd_import_file,
    cmd_list_files,
    cmd_start_realtime,
    cmd_stop_realtime,
    decode_text,
    fixed_text,
    hex_bytes,
    import_name_candidates,
    parse_file_list,
)
from qs668_raw_opus_to_ogg import wrap_qs668_raw_opus  # noqa: E402

IMPORT_FRAME_BYTES = 36

__all__ = [
    "IMPORT_FRAME_BYTES",
    "KEY_NOTIFY_UUID",
    "NOTIFY_UUID",
    "SERVICE_UUID",
    "WRITE_UUID",
    "FileEntry",
    "Frame",
    "FrameParser",
    "build_frame",
    "cmd_abort_import",
    "cmd_get_battery",
    "cmd_get_capacity",
    "cmd_get_firmware",
    "cmd_get_record_state",
    "cmd_import_file",
    "cmd_list_files",
    "cmd_start_realtime",
    "cmd_stop_realtime",
    "decode_text",
    "fixed_text",
    "hex_bytes",
    "import_name_candidates",
    "parse_file_list",
    "wrap_qs668_raw_opus",
]
