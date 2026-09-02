#!/usr/bin/env bash
# Walkthrough 2: https://docs.terminal3.io/developers/adk/get-started/walkthrough/build-contract.md
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"

if ! command -v rustup >/dev/null 2>&1; then
  echo "rustup is required. https://docs.terminal3.io/developers/adk/get-started/prerequisites/set-up-dev-env.md"
  exit 1
fi

rustup target add wasm32-wasip2
cargo build --target wasm32-wasip2 --release

WASM="$ROOT/contracts/target/wasm32-wasip2/release/z_invoice_pay.wasm"
if [[ ! -f "$WASM" ]]; then
  echo "expected $WASM"
  exit 1
fi
ls -lh "$WASM"

if command -v wasm-tools >/dev/null 2>&1; then
  wasm-tools component wit "$WASM" | head -n 40
else
  echo "wasm-tools not installed (optional). cargo install wasm-tools"
fi
