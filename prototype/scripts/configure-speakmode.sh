#!/bin/sh
set -eu
umask 077
install="$HOME/.local/share/anc-card/speakmode"
config=${ANC_SPEAKMODE_CONFIG_DB:-"$install/config.sqlite"}
if [ ! -x "$install/bin/anc_config" ]; then
  echo '请先运行 sh prototype/scripts/setup-speakmode.sh' >&2
  exit 1
fi
case "$config" in /*) ;; *) echo '配置数据库必须使用绝对路径。' >&2; exit 1 ;; esac
mkdir -p "$(dirname -- "$config")"
echo '选择阿里云 Key 所属地域，1 为北京，2 为新加坡。'
printf '地域 [1/2]: '
read -r selection
case "$selection" in
  1) region=beijing ;;
  2) region=singapore ;;
  *) echo '地域选择无效。' >&2; exit 1 ;;
esac
echo '在此终端粘贴阿里云百炼 API Key，输入内容会隐藏。'
terminal_state=$(stty -g)
trap 'stty "$terminal_state"' EXIT HUP INT TERM
stty -echo
IFS= read -r anc_api_key
stty "$terminal_state"
printf '\n'
printf '%s' "$anc_api_key" | "$install/bin/anc_config" "$config" "$region"
unset anc_api_key
