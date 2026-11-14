#!/bin/sh
set -eu
output=${1:-anc-sample.wav}
if [ -e "$output" ]; then
  printf 'File already exists: %s\n' "$output" >&2
  exit 1
fi
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
say -v Tingting -r 150 -o "$scratch/meeting.aiff" \
  '今天我们开一个简短的项目会议。先汇报一下进度，测试环境已经准备好了。[[slnc 1000]]由Zoty负责整理会议纪要，截止时间是本周五。[[slnc 1000]]我们接着确认下周的安排。[[slnc 1000]]由Eric.s负责更新测试文档，截止时间是下周一。[[slnc 1000]]今天先讨论到这里，谢谢大家。'
afconvert -f WAVE -d LEI16@16000 -c 1 "$scratch/meeting.aiff" "$output"
printf '%s\n' "$output"
