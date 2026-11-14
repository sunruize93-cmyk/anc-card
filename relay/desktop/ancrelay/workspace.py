"""私有工作目录：原音、日志、卡的蓝牙地址都放在仓库之外。"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .evidence import EvidenceLog, sha256_bytes, sha256_file
from .fsutil import place_without_overwriting, write_text_atomic

# 数据跟着项目走，不放 C 盘用户目录：
# - 在仓库里运行时，放仓库根目录的 .anc-field/（根目录 .gitignore 忽略它）；
# - 从源码包单独解压运行时，放工具目录自己的 .anc-field/（工具目录的 .gitignore 忽略它）。
TOOL_ROOT = Path(__file__).resolve().parents[1]
_CHECKOUT_ROOT = Path(__file__).resolve().parents[3]
REPO_ROOT = _CHECKOUT_ROOT if (_CHECKOUT_ROOT / ".git").exists() and (_CHECKOUT_ROOT / "relay" / "desktop").is_dir() else TOOL_ROOT
DEFAULT_ROOT = REPO_ROOT / ".anc-field"
ROOT_ENV = "ANC_FIELD_DIR"
_LABEL = re.compile(r"^[A-Za-z0-9_-]{1,16}$")


class WorkspaceError(RuntimeError):
    """工作目录或参数有问题。"""


@dataclass(frozen=True)
class Workspace:
    root: Path
    card: str

    @property
    def card_dir(self) -> Path:
        return self.root / f"card-{self.card}"

    @property
    def baseline_path(self) -> Path:
        return self.card_dir / "baseline.json"

    @property
    def cards_path(self) -> Path:
        return self.root / "cards.json"

    def log_path(self, session_id: str) -> Path:
        return self.root / "logs" / f"{session_id}.jsonl"


def make_workspace(root: str | None, card: str) -> Workspace:
    if not _LABEL.match(card):
        raise WorkspaceError("卡标签只能用字母、数字、下划线和连字符，例如 A")
    chosen = root or os.environ.get(ROOT_ENV)
    return Workspace(Path(chosen).expanduser().resolve() if chosen else DEFAULT_ROOT, card)


def new_session_id(card: str, kind: str, now: datetime | None = None) -> str:
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    return f"{stamp}-{card}-{kind}"


def open_log(workspace: Workspace, session_id: str) -> EvidenceLog:
    if not re.match(r"^[A-Za-z0-9_.-]{1,64}$", session_id):
        raise WorkspaceError("会话 ID 只能用字母、数字、点、下划线和连字符")
    return EvidenceLog(workspace.log_path(session_id), session_id)


def load_cards(workspace: Workspace) -> dict[str, str]:
    if not workspace.cards_path.exists():
        return {}
    cards = json.loads(workspace.cards_path.read_text(encoding="utf-8"))
    if not isinstance(cards, dict):
        raise WorkspaceError(f"卡地址文件格式不对：{workspace.cards_path}")
    return {str(label): str(address) for label, address in cards.items()}


def remember_card(workspace: Workspace, address: str) -> None:
    cards = {**load_cards(workspace), workspace.card: address}
    write_text_atomic(
        workspace.cards_path, json.dumps(cards, ensure_ascii=False, indent=2) + "\n"
    )


def save_without_overwriting(folder: Path, name: str, data: bytes) -> tuple[Path, bool]:
    """把数据存进目录。同名同内容不重复写（返回 False）；同名不同内容另起名字，绝不覆盖。"""
    folder.mkdir(parents=True, exist_ok=True)
    digest = sha256_bytes(data)
    stem, suffix = Path(name).stem, Path(name).suffix
    temporary = folder / f"{name}.part"
    temporary.write_bytes(data)
    try:
        for counter in range(1, 1000):
            target = folder / (name if counter == 1 else f"{stem}-v{counter}{suffix}")
            if target.exists():
                if sha256_file(target) == digest:
                    return target, False
                continue
            if place_without_overwriting(temporary, target):
                return target, True
        raise WorkspaceError(f"同名文件太多，没有保存：{name}")
    finally:
        temporary.unlink(missing_ok=True)
