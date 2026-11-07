#!/bin/sh
set -eu
umask 077
revision=6ba4432d91727d300ba6f3e4b1a9e29d37064a64
install="$HOME/.local/share/anc-card/speakmode"
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
if [ ! -d "$install/source/.git" ]; then
  git clone --no-checkout https://github.com/13-pieces-teen/speakmode.git "$install/source"
fi
if ! git -C "$install/source" cat-file -e "$revision^{commit}" 2>/dev/null; then
  git -C "$install/source" fetch origin "$revision"
fi
git -C "$install/source" checkout --detach "$revision"
cp "$script_dir/../speakmode/configure.rs" "$install/source/app/src-tauri/examples/anc_config.rs"
export CARGO_TARGET_DIR="$install/target"
cargo build --locked --manifest-path "$install/source/app/src-tauri/Cargo.toml" \
  --example file_asr_lab --example anc_config
cp "$install/target/debug/examples/file_asr_lab" "$install/bin/file_asr_lab"
cp "$install/target/debug/examples/anc_config" "$install/bin/anc_config"
echo 'SpeakMode 文件转写工具已安装。接下来运行 sh prototype/scripts/configure-speakmode.sh'
