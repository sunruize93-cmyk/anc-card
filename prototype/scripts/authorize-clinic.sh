#!/bin/sh
set -eu

tool_dir="$HOME/.local/share/anc-card/speakmode"
session_bin=${ANC_CLINIC_SESSION_BIN:-"$tool_dir/bin/clinic_session"}
if [ -n "${ANC_CLINIC_TURNS_BIN:-}${ANC_CLINIC_ASR_BIN:-}" ]; then
  echo '当前使用自定义分段和转写程序，请在这些程序自己的设置中授权。' >&2
  exit 1
fi
if [ ! -x "$session_bin" ]; then
  echo '请先运行 sh prototype/scripts/setup-speakmode.sh --clinic-only 安装门诊工具。' >&2
  exit 1
fi
echo '请在 macOS 的 SpeakMode.Cloud.v1 提示中核对 clinic_session，选择「始终允许」。'
exec "$session_bin" --authorize --config-db "${ANC_SPEAKMODE_CONFIG_DB:-$tool_dir/config.sqlite}"
