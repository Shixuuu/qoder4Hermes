#!/usr/bin/env bash
# Human or agent one-liner:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/qoder-cn-infer/main/scripts/install.sh | bash
# Agent / CI:
#   curl -fsSL .../install.sh | bash -s -- --yes
set -euo pipefail

YES=0
for a in "$@"; do
  case "$a" in
    -y|--yes|--non-interactive) YES=1 ;;
  esac
done
if [[ "${QODER_CN_YES:-}" == "1" ]]; then YES=1; fi

ROOT_HINT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || true)"
DEST="${QODER_CN_HOME:-$HOME/.local/share/qoder-cn-infer}"
REPO="${QODER_CN_REPO:-https://github.com/Shixuuu/qoder-cn-infer.git}"
NODE_MIN=18

need_cmd() { command -v "$1" >/dev/null 2>&1; }

ensure_node() {
  if need_cmd node; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]")"
    if [[ "$major" -ge "$NODE_MIN" ]]; then
      return 0
    fi
  fi
  echo "Installing Node.js ${NODE_MIN}+ into ~/.local (no sudo)…"
  local arch uname_m tarball
  uname_m="$(uname -m)"
  case "$uname_m" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "Unsupported CPU: $uname_m"; return 1 ;;
  esac
  local ver="v22.23.2"
  tarball="node-${ver}-linux-${arch}.tar.xz"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/${ver}/${tarball}" -o "$tmp/$tarball"
  mkdir -p "$HOME/.local"
  tar -xJf "$tmp/$tarball" -C "$tmp"
  cp -a "$tmp/node-${ver}-linux-${arch}/." "$HOME/.local/"
  rm -rf "$tmp"
  export PATH="$HOME/.local/bin:$PATH"
  need_cmd node
}

if [[ -f "$ROOT_HINT/qoder_cn_endpoint/server.mjs" ]]; then
  SRC="$ROOT_HINT"
else
  mkdir -p "$(dirname "$DEST")"
  if [[ -d "$DEST/.git" ]]; then
    git -C "$DEST" pull --ff-only || true
  else
    git clone --depth 1 "$REPO" "$DEST"
  fi
  SRC="$DEST"
fi

ensure_node
export PATH="$HOME/.local/bin:$PATH"
cd "$SRC"
chmod +x bin/qoder-cn-infer.mjs scripts/install.sh 2>/dev/null || true

if [[ "$YES" -eq 1 ]]; then
  exec node bin/qoder-cn-infer.mjs setup --yes
else
  exec node bin/qoder-cn-infer.mjs setup
fi
