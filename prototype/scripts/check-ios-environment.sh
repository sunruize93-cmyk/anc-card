#!/bin/bash
# Read-only readiness check. No installation, signing changes or secret output.
set -u
printf 'macOS: '; /usr/bin/sw_vers -productVersion
printf 'Architecture: '; /usr/bin/uname -m
printf 'Active developer directory: '; /usr/bin/xcode-select -p 2>/dev/null || true
/bin/df -h /Applications

anc_developer_dir="${DEVELOPER_DIR:-}"
if [ -z "$anc_developer_dir" ]; then
  anc_selected=$(/usr/bin/xcode-select -p 2>/dev/null || true)
  if [ -f "$anc_selected/../Info.plist" ] && [ -x "$anc_selected/usr/bin/xcodebuild" ]; then
    anc_developer_dir="$anc_selected"
  elif [ -x /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild ]; then
    anc_developer_dir=/Applications/Xcode.app/Contents/Developer
  fi
fi
if [ -z "$anc_developer_dir" ] || [ ! -x "$anc_developer_dir/usr/bin/xcodebuild" ]; then
  printf '\nBLOCKED: full Xcode is not installed or selected.\n'
  printf 'If installed elsewhere, run with DEVELOPER_DIR=/path/Xcode.app/Contents/Developer.\n'
  exit 2
fi
export DEVELOPER_DIR="$anc_developer_dir"
printf '\nSelected for this check: %s\n' "$DEVELOPER_DIR"
/usr/bin/xcodebuild -version || exit 2
if ! /usr/bin/xcodebuild -checkFirstLaunchStatus; then
  printf 'BLOCKED: open Xcode and finish its first-launch setup.\n'
  exit 2
fi
/usr/bin/xcodebuild -showsdks || exit 2
if ! /usr/bin/xcrun --sdk iphoneos --show-sdk-path; then
  printf 'BLOCKED: iOS SDK unavailable.\n'; exit 2
fi
if ! /usr/bin/xcrun --find devicectl >/dev/null 2>&1; then
  printf 'BLOCKED: device-management tool unavailable.\n'; exit 2
fi
# Device identifiers are deliberately omitted from terminal output.
anc_temp=$(/usr/bin/mktemp -d /tmp/anc-ios-check.XXXXXX)
[ -n "$anc_temp" ] && [ -d "$anc_temp" ] || exit 2
trap '/bin/rm -rf "$anc_temp"' EXIT
if /usr/bin/xcrun devicectl list devices --json-output "$anc_temp/devices.json" >"$anc_temp/device-command.log" 2>&1; then
  node --input-type=module - "$anc_temp/devices.json" <<'NODE'
import { readFileSync } from 'node:fs';
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const devices = result.result?.devices;
if (!Array.isArray(devices)) {
  console.log('Device list schema not recognized; inspect Xcode device window.');
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({ discoveredDevices: devices.length, devices: devices.map(d => ({
    platform: d.hardwareProperties?.platform,
    osVersion: d.deviceProperties?.osVersionNumber,
    developerMode: d.deviceProperties?.developerModeStatus,
    pairingState: d.connectionProperties?.pairingState,
    transport: d.connectionProperties?.transportType,
    tunnelState: d.connectionProperties?.tunnelState,
  })) }, null, 2));
  console.log('Discovery alone is not acceptance: a signed app must install and launch on iPhone.');
  const ready = devices.some(d => d.hardwareProperties?.platform === 'iOS'
    && d.deviceProperties?.developerModeStatus === 'enabled'
    && d.connectionProperties?.pairingState === 'paired'
    && d.connectionProperties?.tunnelState === 'connected');
  if (!ready) {
    console.log('BLOCKED: no connected, paired iOS device with Developer Mode enabled.');
    process.exitCode = 2;
  }
}
NODE
else
  printf 'BLOCKED: device enumeration failed; inspect Xcode device window.\n'
  exit 2
fi
