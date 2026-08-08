#!/usr/bin/env bash
#
# deltacode installer
#
# Installs Delta into ~/.delta/ (runtime folders + the deltacode binary),
# builds from source with Bun, and adds ~/.delta/bin to your PATH.
#
# Usage:
#   From the cloned repo:      bash install.sh
#   Via curl (once hosted):    curl -fsSL <URL>/install.sh | bash
#   From a git repo:           DELTA_REPO_URL=https://github.com/<user>/<repo> bash install.sh
#
set -euo pipefail

# Set this to your Delta repository so the curl one-liner works.
DELTA_REPO_URL="${DELTA_REPO_URL:-https://github.com/yourname/delta.git}"

INSTALL_DIR="${DELTA_INSTALL_DIR:-$HOME/.delta}"
BIN_DIR="$INSTALL_DIR/bin"
COMMAND_NAME="deltacode"

say()  { printf "\033[1;36mdeltacode\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31mdeltacode error:\033[0m %s\n" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- bun
if ! command -v bun >/dev/null 2>&1; then
  say "Bun not found — installing it first..."
  curl -fsSL https://bun.sh/install | bash || fail "failed to install Bun"
  export PATH="$HOME/.bun/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || fail "Bun is still not on PATH; restart your terminal and rerun"

# ---------------------------------------------------------------- source
SRC_DIR=""
if [[ -f "$PWD/package.json" && -f "$PWD/src/cli.tsx" ]]; then
  say "Installing from the current directory ($PWD)"
  SRC_DIR="$PWD"
elif [[ -n "$DELTA_REPO_URL" ]]; then
  say "Cloning $DELTA_REPO_URL ..."
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  git clone --depth 1 "$DELTA_REPO_URL" "$TMP/delta" >/dev/null 2>&1 || fail "git clone failed — check DELTA_REPO_URL"
  SRC_DIR="$TMP/delta"
else
  fail "no source found. Run this from the Delta repo, or set DELTA_REPO_URL."
fi
[[ -f "$SRC_DIR/package.json" ]] || fail "source looks incomplete (no package.json)"

# ---------------------------------------------------------------- build
say "Building $COMMAND_NAME binary..."
( cd "$SRC_DIR" && bun install >/dev/null && bun run build ) || fail "build failed"

# ---------------------------------------------------------------- install
mkdir -p "$BIN_DIR"
# Replace, don't overwrite: cp-in-place keeps the old inode, and macOS
# taskgated caches per-inode "invalid signature" verdicts — a stale cache
# entry SIGKILLs the fresh binary at exec ("zsh: killed").
rm -f "$BIN_DIR/$COMMAND_NAME"
cp "$SRC_DIR/$COMMAND_NAME" "$BIN_DIR/$COMMAND_NAME"
chmod +x "$BIN_DIR/$COMMAND_NAME"
# bun --compile intermittently emits a broken ad-hoc signature; re-signing
# makes the install deterministic (harmless when the signature was fine).
codesign --force --sign - "$BIN_DIR/$COMMAND_NAME" 2>/dev/null || true

# runtime folders: config, agents, skills, sessions are created on first run too
mkdir -p "$INSTALL_DIR/agents" "$INSTALL_DIR/skills" "$INSTALL_DIR/sessions"
touch "$INSTALL_DIR/agents/.keep" "$INSTALL_DIR/skills/.keep" "$INSTALL_DIR/sessions/.keep"

# ---------------------------------------------------------------- PATH
if ! printf '%s' "$PATH" | grep -q "$BIN_DIR"; then
  LINE="export PATH=\"$BIN_DIR:\$PATH\""
  RC=""
  case "${SHELL:-}" in
    *zsh)  RC="$HOME/.zshrc" ;;
    *bash) RC="$HOME/.bashrc" ;;
    *fish) RC="$HOME/.config/fish/config.fish" ;;
  esac
  if [[ -n "$RC" ]]; then
    if [[ ! -f "$RC" ]] || ! grep -q "$BIN_DIR" "$RC"; then
      mkdir -p "$(dirname "$RC")"
      printf '\n# deltacode\n%s\n' "$LINE" >> "$RC"
      say "Added ~/.delta/bin to PATH in $RC"
    fi
  else
    say "Could not detect your shell rc — add this to your shell config:"
    echo "  $LINE"
  fi
else
  say "~/.delta/bin already on PATH"
fi

# ---------------------------------------------------------------- done
cat <<EOF

═══════════════════════════════════════════════════════
  deltacode installed ✔

  Runtime:   $INSTALL_DIR/
  Binary:    $BIN_DIR/$COMMAND_NAME

  Next:
    1. Open a terminal (or run: source ${RC:-your shell rc file})
    2. Run:  deltacode
    3. The setup screen appears inside the app — connect one API key, done.

  Inside a coding project → deltacode edits only that project.
  From your home terminal  → it can work across your whole computer
  (writes outside the current folder ask permission first).
═══════════════════════════════════════════════════════
EOF
