#!/bin/sh
set -eu
umask 077
revision=6ba4432d91727d300ba6f3e4b1a9e29d37064a64
install="$HOME/.local/share/anc-card/speakmode"
mode=${1:-all}
case "$mode" in all|--clinic-turns-only|--clinic-only|--clinic-session-only) ;; *) echo 'usage: setup-speakmode.sh [--clinic-only]' >&2; exit 1 ;; esac
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# A locally installed minimal toolchain can be used without changing shell PATH.
if ! command -v cargo >/dev/null 2>&1; then
  toolchain="$HOME/.local/share/anc-card/rust"
  if [ -x "$toolchain/cargo/bin/cargo" ]; then
    export CARGO_HOME="$toolchain/cargo" RUSTUP_HOME="$toolchain/rustup"
    export PATH="$CARGO_HOME/bin:$PATH"
  else
    echo '请先安装 Rust stable 和 Xcode Command Line Tools，再重跑此命令。https://rustup.rs/' >&2
    exit 1
  fi
fi
mkdir -p "$install/bin"
if [ "$mode" != "all" ]; then
  # Add the adapter without changing the installed revision or the original executables.
  if [ "$(git -C "$install/source" rev-parse HEAD 2>/dev/null)" != "$revision" ]; then
    echo '未找到匹配的 SpeakMode 源码，请先完成完整安装。' >&2; exit 1
  fi
else
  if [ ! -d "$install/source/.git" ]; then
    git clone --no-checkout https://github.com/13-pieces-teen/speakmode.git "$install/source"
  fi
  if ! git -C "$install/source" cat-file -e "$revision^{commit}" 2>/dev/null; then
    git -C "$install/source" fetch origin "$revision"
  fi
  git -C "$install/source" checkout --detach "$revision"
fi

# Never replace a conflicting personal copy. Future builds can update a file that
# still matches the digest recorded by this installer.
install_managed() {
  origin=$1 dest=$2 stamp="$2.anc-managed-sha256"
  if [ -L "$dest" ] || [ -L "$stamp" ]; then echo "安装目标不能是符号链接: $dest" >&2; return 1; fi
  if [ -e "$dest" ] && ! cmp -s "$origin" "$dest"; then
    actual=$(shasum -a 256 "$dest" | cut -d' ' -f1)
    if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$actual" ]; then
      echo "保留现有的本机文件，未覆盖: $dest" >&2; return 1
    fi
  fi
  if ! cmp -s "$origin" "$dest"; then cp -p "$origin" "$dest.anc-new-$$" && mv -f "$dest.anc-new-$$" "$dest"; fi
  shasum -a 256 "$dest" | cut -d' ' -f1 > "$stamp"
}
export CARGO_TARGET_DIR="$install/target"
source_dir="$install/source/app/src-tauri"
mkdir -p "$source_dir/examples/anc_clinic"
install_managed "$script_dir/../speakmode/clinic_keychain.rs" "$source_dir/examples/anc_clinic/keychain.rs"
install_managed "$script_dir/../speakmode/clinic_turns.rs" "$source_dir/examples/clinic_turns.rs"
# Recreate the second pass from the exact upstream commit and a small local patch.
build_dir=$(mktemp -d "$install/.clinic-build.XXXXXXXX")
trap 'rm -rf "$build_dir"' EXIT
git -C "$install/source" show "$revision:app/src-tauri/examples/file_asr_lab.rs" > "$build_dir/clinic_asr.rs"
patch -s -p0 -d "$build_dir" < "$script_dir/../speakmode/clinic_asr.patch"
install_managed "$build_dir/clinic_asr.rs" "$source_dir/examples/clinic_asr.rs"
install_managed "$script_dir/../speakmode/clinic_session.rs" "$source_dir/examples/clinic_session.rs"
if [ "$mode" = "--clinic-only" ] || [ "$mode" = "--clinic-session-only" ]; then
  # Keep separately authorized legacy binaries intact when installing the single clinic identity.
  cargo build --locked --manifest-path "$source_dir/Cargo.toml" --example clinic_session
elif [ "$mode" = "--clinic-turns-only" ]; then
  cargo build --locked --manifest-path "$source_dir/Cargo.toml" --example clinic_turns --example clinic_asr --example clinic_session
else
  cp "$script_dir/../speakmode/configure.rs" "$source_dir/examples/anc_config.rs"
  cargo build --locked --manifest-path "$source_dir/Cargo.toml" --example file_asr_lab --example anc_config --example clinic_turns --example clinic_asr --example clinic_session
  cp "$install/target/debug/examples/file_asr_lab" "$install/bin/file_asr_lab"
  cp "$install/target/debug/examples/anc_config" "$install/bin/anc_config"
fi
if [ "$mode" = "all" ] || [ "$mode" = "--clinic-turns-only" ]; then
  install_managed "$install/target/debug/examples/clinic_turns" "$install/bin/clinic_turns"
  install_managed "$install/target/debug/examples/clinic_asr" "$install/bin/clinic_asr"
fi
install_managed "$install/target/debug/examples/clinic_session" "$install/bin/clinic_session"
echo 'SpeakMode 门诊工具 clinic_session 已安装。'
