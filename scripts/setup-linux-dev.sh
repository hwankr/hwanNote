#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APT_PACKAGES=(
  build-essential
  curl
  wget
  file
  libxdo-dev
  libssl-dev
  libayatana-appindicator3-dev
  librsvg2-dev
  libwebkit2gtk-4.1-dev
  patchelf
)

if ! command -v apt-get >/dev/null 2>&1; then
  echo "[setup-linux] apt-get not found. This script currently supports Debian/Ubuntu-based systems only."
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  SUDO=()
elif command -v sudo >/dev/null 2>&1; then
  SUDO=(sudo)
else
  echo "[setup-linux] sudo is required to install Linux system packages."
  exit 1
fi

echo "[setup-linux] Installing Linux system packages for Tauri..."
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y "${APT_PACKAGES[@]}"

if ! command -v rustup >/dev/null 2>&1; then
  echo "[setup-linux] Installing Rust toolchain via rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

echo "[setup-linux] Rust:"
rustc -V
cargo -V

echo "[setup-linux] Installing npm dependencies..."
cd "$ROOT_DIR"
npm ci

echo "[setup-linux] Running Tauri environment check..."
npm exec tauri info

echo
echo "[setup-linux] Done."
echo "[setup-linux] If you are on WSL, GUI execution of 'npm run dev' requires WSLg or another X/Wayland-capable GUI session."
