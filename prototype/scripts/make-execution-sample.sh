#!/bin/sh
set -eu
output=${1:-anc-execution-sample.wav}
if [ -e "$output" ]; then
  echo '输出文件已存在。' >&2
  exit 1
fi
scratch=$(mktemp -d)
trap 'rm -r "$scratch"' EXIT
say -v Tingting -r 150 -o "$scratch/meeting.aiff" \
  '由小王负责接口示例和调用说明，接口遇到四二九时只重试一次，并用测试验证成功恢复和再次失败，截止时间是本周五。'
afconvert -f WAVE -d LEI16@16000 -c 1 "$scratch/meeting.aiff" "$output"
printf '%s\n' "$output"
