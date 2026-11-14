#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
    echo '本机门诊转写需要 Apple Silicon Mac。' >&2
    exit 1
fi
uv_bin=$(command -v uv || true)
if [ -z "$uv_bin" ] && [ -x "$HOME/.local/bin/uv" ]; then uv_bin="$HOME/.local/bin/uv"; fi
if [ -z "$uv_bin" ]; then
    echo '缺少 uv，请先安装 https://docs.astral.sh/uv/getting-started/installation/ 。' >&2
    exit 1
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install="$HOME/.local/share/anc-card/local-asr"
mkdir -p "$install"
if [ ! -x "$install/venv/bin/python" ]; then
    "$uv_bin" venv --python 3.12 "$install/venv"
fi
python="$install/venv/bin/python"
if ! "$python" -c 'import sys; sys.exit(sys.version_info[:2] != (3,12))'; then
    echo '已有的门诊转写环境不是 Python 3.12，请检查 local-asr/venv。' >&2
    exit 1
fi
"$uv_bin" pip install --python "$python" 'mlx-audio[stt]==0.6.5' 'mlx==0.32.4' 'numpy==2.5.4' 'transformers==5.22.2' 'huggingface-hub==2.4.0'
if ! "$python" "$script_dir/../speakmode/clinic_local.py" --check >/dev/null 2>&1; then
    # Public, pinned, read-only weights. Reuse complete files in the standard Hub cache.
    HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_DISABLE_IMPLICIT_TOKEN=1 "$python" - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download("mlx-community/Qwen3-ASR-1.7B-4bit",
                  revision="78a389c776a5483b2d0d4ea5494e11012e0d6159", token=False)
PY
fi
"$python" "$script_dir/../speakmode/clinic_local.py" --check
