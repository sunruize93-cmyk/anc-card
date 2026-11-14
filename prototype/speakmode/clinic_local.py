"""Offline clinic ASR for a single 16 kHz mono PCM16 turn on Apple Silicon."""
import argparse
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import platform
import sys
from tempfile import NamedTemporaryFile
from uuid import UUID
import wave

# Only the explicitly invoked setup script downloads weights. Transcription and
# readiness checks consume a pinned local snapshot.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

MODEL = "mlx-community/Qwen3-ASR-1.7B-4bit"
REVISION = "78a389c776a5483b2d0d4ea5494e11012e0d6159"
ADAPTER = "anc-local-qwen-38-v1"
GLOSSARY_SHA256 = "187e1904ff8b6931a58071145a7779c5df1648dfb480c160d279d0b0854407e5"
REQUIRED = {"mlx-audio": "0.6.5", "mlx": "0.32.4", "numpy": "2.5.4", "transformers": "5.22.2",
            "huggingface-hub": "2.4.0"}
SNAPSHOT_FILES = ("config.json", "generation_config.json", "preprocessor_config.json", "tokenizer_config.json",
                  "chat_template.json", "merges.txt", "vocab.json", "model.safetensors.index.json")


class ClinicError(Exception):
    """An error code safe to surface to the local caller."""


def offline_model():
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise ClinicError("local_asr_platform")
    try:
        for name, version in REQUIRED.items():
            if importlib.metadata.version(name) != version:
                raise ClinicError("local_asr_dependencies")
        from huggingface_hub import snapshot_download
        path = Path(snapshot_download(MODEL, revision=REVISION, token=False, local_files_only=True))
        if (not all((path / name).stat().st_size > 0 for name in SNAPSHOT_FILES)
                or (path / "model.safetensors").stat().st_size != 1603081617):
            raise ClinicError("local_asr_snapshot")
    except (ImportError, importlib.metadata.PackageNotFoundError) as error:
        raise ClinicError("local_asr_dependencies") from error
    except (OSError, ValueError) as error:
        raise ClinicError("local_asr_snapshot") from error
    return path


def glossary():
    try:
        data = Path(__file__).with_name("clinic_terms.json").read_bytes()
    except OSError as error:
        raise ClinicError("local_asr_glossary") from error
    if hashlib.sha256(data).hexdigest() != GLOSSARY_SHA256:
        raise ClinicError("local_asr_glossary")
    return json.loads(data)


def read_audio(path):
    try:
        data = path.read_bytes()
        with wave.open(io.BytesIO(data), "rb") as wav:
            count = wav.getnframes()
            if ((wav.getframerate(), wav.getnchannels(), wav.getsampwidth(), wav.getcomptype())
                    != (16000, 1, 2, "NONE") or count <= 0):
                raise ClinicError("local_asr_invalid_audio")
            pcm = wav.readframes(count)
        if len(pcm) != count * 2:
            raise ClinicError("local_asr_invalid_audio")
    except (OSError, wave.Error, EOFError) as error:
        raise ClinicError("local_asr_invalid_audio") from error
    return hashlib.sha256(data).hexdigest(), count, pcm


def transcribe(pcm, snapshot, terms):
    import mlx.core as mx
    import numpy as np
    from mlx_audio.stt.utils import load_model

    model = load_model(str(snapshot), strict=True)
    samples = np.frombuffer(pcm, dtype="<i2").astype("float32") / 32768
    response = model.generate(samples, temperature=0, max_tokens=512, hotwords=terms)
    mx.synchronize()
    if (not isinstance(response.text, str) or not response.text.strip()
            or response.generation_tokens >= 512):
        raise ClinicError("local_asr_incomplete")
    languages = response.language
    language = languages[0] if isinstance(languages, list) and len(languages) == 1 else None
    # A valid transcript may contain several languages or no language annotation.
    return response.text, language if isinstance(language, str) and language.strip() else None


def publish_receipt(path, result):
    # Link only once the complete JSON has closed. An existing receipt cannot
    # be overwritten even when two workers finish at the same time.
    temporary = None
    try:
        with NamedTemporaryFile(dir=path.parent, prefix=".clinic-receipt-", mode="w",
                                encoding="utf-8", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(result, stream, ensure_ascii=False)
            stream.write("\n")
        os.link(temporary, path)
    except FileExistsError as error:
        raise ClinicError("local_asr_output_exists") from error
    except OSError as error:
        raise ClinicError("local_asr_output_unavailable") from error
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--wav", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--attempt")
    args = parser.parse_args()
    if args.check:
        if any((args.wav, args.out, args.attempt)):
            raise ClinicError("local_asr_arguments")
        offline_model()
        glossary()
        print(json.dumps({"ready": True, "model": MODEL, "revision": REVISION}))
        return
    if not args.wav or not args.out or not args.wav.is_absolute() or not args.out.is_absolute():
        raise ClinicError("local_asr_arguments")
    try:
        if str(UUID(args.attempt or "")) != args.attempt:
            raise ValueError("non-canonical identifier")
    except ValueError as error:
        raise ClinicError("local_asr_arguments") from error
    if os.path.lexists(args.out):
        raise ClinicError("local_asr_output_exists")
    sha, count, pcm = read_audio(args.wav)
    snapshot, terms = offline_model(), glossary()
    text, language = transcribe(pcm, snapshot, terms)
    publish_receipt(args.out, {"attemptId": args.attempt, "audioSha256": sha, "audioSamples": count,
                               "text": text, "detectedLanguage": language, "model": MODEL, "revision": REVISION,
                               "adapterVersion": ADAPTER, "glossarySha256": GLOSSARY_SHA256})


if __name__ == "__main__":
    try:
        main()
    except Exception as problem:
        code = str(problem) if isinstance(problem, ClinicError) else "local_asr_failed"
        print(json.dumps({"errorCode": code}), file=sys.stderr)
        sys.exit(1)
