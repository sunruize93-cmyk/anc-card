import hashlib
import json
import shutil
import ssl
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from ancrelay.upload import (
    Receipt,
    UploadError,
    build_headers,
    default_recording_id,
    describe_file,
    fetch_result,
    parse_receipt,
    receipt_problems,
    resend_problems,
    result_url,
    upload_once,
    validate_url,
)


class UrlTests(unittest.TestCase):
    def test_https_is_accepted_and_plain_http_only_for_this_machine(self):
        validate_url("https://192.0.2.10:4786/v1/recordings")
        validate_url("http://127.0.0.1:4785/api/recordings")
        with self.assertRaises(UploadError):
            validate_url("http://192.168.0.8:4785/api/recordings")
        validate_url("http://192.168.0.8:4785/api/recordings", allow_http=True)

    def test_other_schemes_and_embedded_credentials_are_rejected(self):
        for url in (
            "ftp://example.test/x",
            "file:///c:/x",
            "https://user:pw@example.test/x",
            "example.test/x",
        ):
            with self.assertRaises(UploadError):
                validate_url(url, allow_http=True)

    def test_result_url_stays_on_the_upload_origin(self):
        base = "https://192.0.2.10:4786/v1/recordings"
        self.assertEqual(
            result_url(base, "/v1/recordings/r1/result"),
            "https://192.0.2.10:4786/v1/recordings/r1/result",
        )
        self.assertEqual(
            result_url(base, "/v1/r?x=1"), "https://192.0.2.10:4786/v1/r?x=1"
        )
        for bad in ("https://evil.test/x", "//evil.test/x", "relative/path"):
            with self.assertRaises(UploadError):
                result_url(base, bad)


class HeaderTests(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "样本 一.wav"
        self.path.write_bytes(b"abc")

    def test_headers_follow_the_backend_spec(self):
        meta = describe_file(self.path, recording_id="A-001")
        headers = build_headers(meta, token="secret-token")
        self.assertEqual(
            headers["X-ANC-Filename"], "%E6%A0%B7%E6%9C%AC%20%E4%B8%80.wav"
        )
        self.assertEqual(headers["X-Recording-ID"], "A-001")
        self.assertEqual(
            headers["X-Content-SHA256"], hashlib.sha256(b"abc").hexdigest()
        )
        self.assertEqual(headers["Authorization"], "Bearer secret-token")
        self.assertEqual(headers["Content-Type"], "application/octet-stream")
        self.assertNotIn("x-anc-binding", {name.lower() for name in headers})

    def test_default_recording_id_is_stable_per_card_and_file(self):
        self.assertEqual(
            default_recording_id("A", Path("x/note20261114-121309.wav")),
            "A-note20261114-121309",
        )

    def test_bad_recording_id_empty_file_and_header_injection_are_rejected(self):
        for bad in ("A 001", "a\r\nb", "", "x" * 129):
            with self.assertRaises(UploadError):
                describe_file(self.path, recording_id=bad)
        empty = self.path.with_name("empty.wav")
        empty.write_bytes(b"")
        with self.assertRaises(UploadError):
            describe_file(empty, recording_id="A-1")


class ReceiptTests(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / "a.wav"
        path.write_bytes(b"abc")
        self.meta = describe_file(path, recording_id="A-001")

    def body(self, **changes) -> dict:
        base = {
            "device": "test-device-A",
            "localId": "A-001",
            "recordingId": "rec-1",
            "sha256": self.meta.sha256,
            "bytes": 3,
            "duplicate": False,
            "resultPath": "/v1/recordings/rec-1/result",
        }
        return {**base, **changes}

    def test_backend_receipt_is_parsed(self):
        receipt = parse_receipt(201, self.body())
        self.assertEqual(
            (
                receipt.recording_id,
                receipt.local_id,
                receipt.device,
                receipt.result_path,
            ),
            ("rec-1", "A-001", "test-device-A", "/v1/recordings/rec-1/result"),
        )
        self.assertEqual(receipt_problems(receipt, self.meta), [])
        self.assertEqual(receipt.raw["device"], "test-device-A")

    def test_old_prototype_shape_still_parses(self):
        receipt = parse_receipt(200, {"duplicate": True, "recording": {"id": "r2"}})
        self.assertEqual((receipt.recording_id, receipt.duplicate), ("r2", True))

    def test_mismatches_are_reported(self):
        self.assertEqual(
            len(
                receipt_problems(
                    parse_receipt(201, self.body(bytes=4, sha256="00" * 32)), self.meta
                )
            ),
            2,
        )
        self.assertEqual(
            len(
                receipt_problems(
                    parse_receipt(201, self.body(localId="A-002")), self.meta
                )
            ),
            1,
        )
        self.assertEqual(
            len(
                receipt_problems(
                    parse_receipt(201, self.body(duplicate=True)), self.meta
                )
            ),
            1,
        )
        self.assertEqual(
            len(
                receipt_problems(
                    parse_receipt(200, self.body(duplicate=False)), self.meta
                )
            ),
            1,
        )

    def test_reply_without_an_id_is_an_error(self):
        for body in ({}, {"recording": {}}, [], "ok"):
            with self.assertRaises(UploadError):
                parse_receipt(200, body)

    def test_resend_must_return_the_same_id_and_say_duplicate(self):
        first, again = (
            Receipt("r1", False, None, None, 201),
            Receipt("r1", True, None, None, 200),
        )
        self.assertEqual(resend_problems([first, again]), [])
        self.assertEqual(
            len(resend_problems([first, Receipt("r2", True, None, None, 200)])), 1
        )
        self.assertEqual(
            len(resend_problems([first, Receipt("r1", False, None, None, 201)])), 1
        )


class BackendLikeServer(BaseHTTPRequestHandler):
    """照后台接口行为做的替身：201 新导入，200 重复，resultPath 可查询。"""

    seen: dict[str, str] = {}
    requests_seen: list[dict[str, str]] = []

    def do_POST(self) -> None:  # noqa: N802 - 标准库约定的方法名
        body = self.rfile.read(int(self.headers["Content-Length"]))
        headers = {key.lower(): value for key, value in self.headers.items()}
        type(self).requests_seen.append(headers)
        if headers.get("authorization") != "Bearer good":
            return self._reply(401, {"error": "unauthorized"})
        digest = hashlib.sha256(body).hexdigest()
        if headers.get("x-content-sha256") != digest:
            return self._reply(400, {"error": "sha256 mismatch"})
        duplicate = digest in type(self).seen
        record = type(self).seen.setdefault(digest, f"rec-{len(type(self).seen) + 1}")
        self._reply(
            200 if duplicate else 201,
            {
                "device": "test-device-A",
                "localId": headers.get("x-recording-id"),
                "recordingId": record,
                "sha256": digest,
                "bytes": len(body),
                "duplicate": duplicate,
                "resultPath": f"/v1/recordings/{record}/result",
            },
        )

    def do_GET(self) -> None:  # noqa: N802
        if self.headers.get("authorization") != "Bearer good":
            return self._reply(401, {"error": "unauthorized"})
        self._reply(200, {"path": self.path, "status": "transcribed"})

    def _reply(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args) -> None:
        return


def start(server: ThreadingHTTPServer, case: unittest.TestCase) -> None:
    BackendLikeServer.seen = {}
    BackendLikeServer.requests_seen = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    case.addCleanup(server.server_close)
    case.addCleanup(server.shutdown)


class UploadRoundTripTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), BackendLikeServer)
        start(self.server, self)
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1/recordings"
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / "note20261114-121309.wav"
        path.write_bytes(b"RIFF" + bytes(400))
        self.meta = describe_file(path, recording_id="A-001")

    def test_upload_then_resend_returns_the_same_recording(self):
        first = upload_once(self.url, self.meta, token="good")
        again = upload_once(self.url, self.meta, token="good")
        self.assertEqual(
            (first.status, first.duplicate, again.status, again.duplicate),
            (201, False, 200, True),
        )
        self.assertEqual(resend_problems([first, again]), [])
        self.assertEqual(receipt_problems(first, self.meta), [])
        sent = BackendLikeServer.requests_seen[0]
        self.assertEqual(sent["x-recording-id"], "A-001")
        self.assertEqual(sent["content-length"], "404")
        status, body = fetch_result(self.url, first.result_path, "good")
        self.assertEqual((status, body["path"]), (200, "/v1/recordings/rec-1/result"))

    def test_rejected_credentials_raise_without_echoing_the_token(self):
        with self.assertRaises(UploadError) as caught:
            upload_once(self.url, self.meta, token="wrong-token-value")
        self.assertIn("401", str(caught.exception))
        self.assertNotIn("wrong-token-value", str(caught.exception))

    def test_unreachable_server_raises_upload_error(self):
        with self.assertRaises(UploadError):
            upload_once(
                "http://127.0.0.1:9/v1/recordings", self.meta, token=None, timeout_s=2
            )


@unittest.skipUnless(shutil.which("openssl"), "需要 openssl 生成测试证书")
class PrivateCaTests(unittest.TestCase):
    """后台用自己的测试 CA：指定 CA 时能连上；不指定时证书校验失败，而不是悄悄放过。"""

    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.dir = Path(folder.name)
        self.ca = self.dir / "ca.crt"
        self._make_certificates()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.dir / "server.crt", self.dir / "server.key")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), BackendLikeServer)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        start(self.server, self)
        self.url = f"https://127.0.0.1:{self.server.server_port}/v1/recordings"
        path = self.dir / "a.wav"
        path.write_bytes(b"RIFF" + bytes(40))
        self.meta = describe_file(path, recording_id="A-001")

    def _make_certificates(self) -> None:
        def run(*args: str) -> None:
            subprocess.run(
                ["openssl", *args], cwd=self.dir, check=True, capture_output=True
            )

        (self.dir / "ext.cnf").write_text(
            "subjectAltName=IP:127.0.0.1\n", encoding="ascii"
        )
        run(
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            "ca.key",
            "-out",
            "ca.crt",
            "-days",
            "1",
            "-subj",
            "/CN=test ca",
        )
        run(
            "req",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            "server.key",
            "-out",
            "server.csr",
            "-subj",
            "/CN=127.0.0.1",
        )
        run(
            "x509",
            "-req",
            "-in",
            "server.csr",
            "-CA",
            "ca.crt",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-out",
            "server.crt",
            "-days",
            "1",
            "-extfile",
            "ext.cnf",
        )

    def test_upload_succeeds_with_the_private_ca(self):
        receipt = upload_once(self.url, self.meta, token="good", ca_file=self.ca)
        self.assertEqual((receipt.status, receipt.duplicate), (201, False))

    def test_without_the_ca_the_certificate_is_rejected(self):
        with self.assertRaises(UploadError) as caught:
            upload_once(self.url, self.meta, token="good")
        self.assertIn("证书", str(caught.exception))

    def test_missing_ca_file_is_an_error(self):
        with self.assertRaises(UploadError):
            upload_once(
                self.url, self.meta, token="good", ca_file=self.dir / "nope.crt"
            )


if __name__ == "__main__":
    unittest.main()
