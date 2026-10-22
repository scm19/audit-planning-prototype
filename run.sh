#!/usr/bin/env bash
# One-command local start: ./run.sh  (then open http://127.0.0.1:8000)
# Needs ANTHROPIC_API_KEY in the environment for the chat agent; never commit it.
set -euo pipefail
cd "$(dirname "$0")"
# Needs Python 3.10+. Use the newest one on PATH (macOS's built-in python3 is 3.9).
PY=""
for c in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done
if [ -z "$PY" ]; then
  echo "This app needs Python 3.10 or newer (found: $(python3 -V 2>&1 || echo none))." >&2
  echo "Install it from https://www.python.org/downloads/ or with Homebrew (brew install python), then rerun ./run.sh." >&2
  exit 1
fi
if [ -x .venv/bin/python ] && ! .venv/bin/python -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  rm -rf .venv   # made with an older Python
fi
if [ ! -x .venv/bin/python ]; then
  "$PY" -m venv .venv
fi
if ! .venv/bin/python -I -c "import duckdb, fastapi, uvicorn, anthropic" 2>/dev/null; then
  .venv/bin/python -I -m pip install -q -r requirements.txt
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Warning: ANTHROPIC_API_KEY is not set; the table, evidence and export work, chat will not." >&2
fi
exec .venv/bin/python -I run.py "$@"
