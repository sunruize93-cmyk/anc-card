"""把磁盘上的原件上传到后台，并核对回执。

按后台负责人 2026-11-14 给出的接口：
- POST，请求体是文件原始字节（不用 multipart），64 MiB 以内。
- 请求头：Content-Length（自动）、X-ANC-Filename（UTF-8 百分号编码）、
  X-Recording-ID（同一录音保持不变）、X-Content-SHA256（完整文件小写哈希）、
  Authorization: Bearer 凭证。
- 回执：device、localId、recordingId、sha256、bytes、duplicate、resultPath。新导入 201，重复 200。
- 结果查询：GET 同一来源 + resultPath，用同一凭证。
- 测试后台用自己的 CA 签发证书：用 --ca 指定 CA 文件，不关闭证书验证。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

import requests

from .evidence import sha256_file

LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_HEADER_SAFE = re.compile(r"^[\x20-\x7e]*$")
_RECORDING_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


class UploadError(RuntimeError):
    """上传没有成功，或者地址、回执不符合约定。"""


@dataclass(frozen=True)
class UploadMeta:
    path: Path
    filename: str
    size: int
    sha256: str
    recording_id: str


@dataclass(frozen=True)
class Receipt:
    recording_id: str
    duplicate: bool
    size: int | None
    sha256: str | None
    status: int
    local_id: str | None = None
    device: str | None = None
    result_path: str | None = None
    raw: dict | None = field(
        default=None, compare=False
    )  # 后台返回的完整 JSON，原样保留


def validate_url(url: str, *, allow_http: bool = False) -> str:
    """只接受 https；明文 http 只允许本机，或者显式放行（同一个局域网里临时联调）。"""
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise UploadError("上传地址要以 https:// 开头（本机联调可用 http://127.0.0.1）")
    if parts.username or parts.password:
        raise UploadError(
            "不要把账号或口令写在上传地址里，凭证用环境变量 ANC_UPLOAD_TOKEN 提供"
        )
    if parts.scheme == "http" and parts.hostname not in LOCAL_HOSTS and not allow_http:
        raise UploadError(
            "明文 http 只允许发往本机；要在局域网里临时使用请加 --allow-http"
        )
    return url


def default_recording_id(card: str, path: Path) -> str:
    """没指定时，用「卡标签-文件主名」：同一张卡的同一个文件每次都得到同一个 ID。"""
    return f"{card}-{path.stem}"


def describe_file(path: Path, *, recording_id: str) -> UploadMeta:
    if not _RECORDING_ID.match(recording_id):
        raise UploadError("录音 ID 只能用字母、数字和 . _ : -，最长 128 个字符")
    size = path.stat().st_size
    if size == 0:
        raise UploadError("文件是空的")
    if size > MAX_UPLOAD_BYTES:
        raise UploadError(f"文件 {size} 字节，超过后台的 64 MiB 上限")
    return UploadMeta(
        path=path,
        filename=path.name,
        size=size,
        sha256=sha256_file(path),
        recording_id=recording_id,
    )


def build_headers(meta: UploadMeta, token: str | None) -> dict[str, str]:
    headers = {
        "Content-Type": "application/octet-stream",
        "X-ANC-Filename": quote(meta.filename, safe=""),
        "X-Recording-ID": meta.recording_id,
        "X-Content-SHA256": meta.sha256,
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    for name, value in headers.items():
        if not _HEADER_SAFE.match(value):
            raise UploadError(
                f"{name} 里有不能放进请求头的字符（只能用可见的 ASCII 字符）"
            )
    return headers


def parse_receipt(status: int, body: Any) -> Receipt:
    """认后台的回执，也兼容原型旧接口的 {duplicate, recording:{id}}。"""
    if not isinstance(body, dict):
        raise UploadError(f"后台返回的不是 JSON 对象（HTTP {status}）")
    recording = body.get("recording") if isinstance(body.get("recording"), dict) else {}
    recording_id = body.get("recordingId") or recording.get("id")
    if not recording_id:
        raise UploadError(f"回执里没有录音 ID（HTTP {status}）")
    size = body.get("bytes")
    digest = body.get("sha256")

    def text(key: str) -> str | None:
        value = body.get(key)
        return str(value) if value is not None else None

    return Receipt(
        recording_id=str(recording_id),
        duplicate=bool(body.get("duplicate")),
        size=size if isinstance(size, int) else None,
        sha256=digest.lower() if isinstance(digest, str) else None,
        status=status,
        local_id=text("localId"),
        device=text("device"),
        result_path=text("resultPath"),
        raw=body,
    )


def receipt_problems(receipt: Receipt, meta: UploadMeta) -> list[str]:
    problems: list[str] = []
    if receipt.size is not None and receipt.size != meta.size:
        problems.append(f"字节数不一致：本地 {meta.size}，回执 {receipt.size}")
    if receipt.sha256 is not None and receipt.sha256 != meta.sha256:
        problems.append(f"SHA-256 不一致：本地 {meta.sha256}，回执 {receipt.sha256}")
    if receipt.local_id is not None and receipt.local_id != meta.recording_id:
        problems.append(
            f"回执的 localId 是 {receipt.local_id}，发送的 X-Recording-ID 是 {meta.recording_id}"
        )
    if receipt.status not in {200, 201, 202}:
        problems.append(f"意外的状态码 {receipt.status}")
    if receipt.status == 201 and receipt.duplicate:
        problems.append("状态码 201（新导入）却标记为重复")
    if (
        receipt.status == 200
        and receipt.raw is not None
        and "resultPath" in receipt.raw
        and not receipt.duplicate
    ):
        problems.append("状态码 200（重复）却没有标记为重复")
    looks_like_hash = _SHA256.match(receipt.recording_id.lower()) is not None
    if (
        receipt.sha256 is None
        and looks_like_hash
        and receipt.recording_id.lower() != meta.sha256
    ):
        problems.append(
            f"录音 ID 看起来是哈希，但和本地 SHA-256 不一致：{receipt.recording_id}"
        )
    return problems


def resend_problems(receipts: list[Receipt]) -> list[str]:
    """同一个文件发多次：每次都应得到同一个 ID，第二次起应标记为重复。"""
    problems: list[str] = []
    if len(receipts) < 2:
        return problems
    first = receipts[0]
    for number, receipt in enumerate(receipts[1:], start=2):
        if receipt.recording_id != first.recording_id:
            problems.append(
                f"第 {number} 次得到的 ID 不同：{receipt.recording_id}（第 1 次是 {first.recording_id}）"
            )
        if not receipt.duplicate:
            problems.append(f"第 {number} 次的回执没有标记为重复")
    return problems


def _verify(ca_file: Path | None) -> str | bool:
    if ca_file is None:
        return True
    if not ca_file.is_file():
        raise UploadError(f"找不到 CA 文件：{ca_file}")
    return str(ca_file)


def upload_once(
    url: str,
    meta: UploadMeta,
    token: str | None,
    *,
    ca_file: Path | None = None,
    timeout_s: float = 120.0,
) -> Receipt:
    headers = build_headers(meta, token)
    verify = _verify(ca_file)
    try:
        with meta.path.open("rb") as handle:
            response = requests.post(
                url,
                data=handle,
                headers=headers,
                timeout=timeout_s,
                allow_redirects=False,
                verify=verify,
            )
    except requests.exceptions.SSLError:
        raise UploadError(
            "证书校验失败：检查 --ca 指定的 CA 是否正确，地址是否和证书一致"
        ) from None
    except requests.RequestException as error:
        # 异常文本可能带着请求细节，只报类型，避免把凭证带进日志。
        raise UploadError(f"连不上后台或请求中断：{type(error).__name__}") from None
    if response.status_code not in {200, 201, 202}:
        raise UploadError(
            f"后台拒绝了上传：HTTP {response.status_code}{_error_detail(response)}"
        )
    try:
        body = response.json()
    except ValueError:
        raise UploadError(
            f"后台返回的不是 JSON（HTTP {response.status_code}）"
        ) from None
    return parse_receipt(response.status_code, body)


def result_url(upload_url: str, result_path: str) -> str:
    """结果地址只允许是上传地址同一来源下的路径，不跟随回执里的完整 URL。"""
    if not result_path.startswith("/") or result_path.startswith("//"):
        raise UploadError(f"回执里的 resultPath 不是本站路径：{result_path!r}")
    parts = urlsplit(upload_url)
    path, _, query = result_path.partition("?")
    return urlunsplit((parts.scheme, parts.netloc, path, query, ""))


def fetch_result(
    upload_url: str,
    result_path: str,
    token: str | None,
    *,
    ca_file: Path | None = None,
    timeout_s: float = 30.0,
) -> tuple[int, Any]:
    url = result_url(upload_url, result_path)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        response = requests.get(
            url,
            headers=headers,
            timeout=timeout_s,
            allow_redirects=False,
            verify=_verify(ca_file),
        )
    except requests.exceptions.SSLError:
        raise UploadError("查询结果时证书校验失败") from None
    except requests.RequestException as error:
        raise UploadError(f"查询结果失败：{type(error).__name__}") from None
    try:
        return response.status_code, response.json()
    except ValueError:
        return response.status_code, response.text[:2000]


def _error_detail(response: requests.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return ""
    if isinstance(body, dict):
        message = body.get("error") or body.get("message")
        if isinstance(message, str):
            return f"（{message[:200]}）"
    return ""
