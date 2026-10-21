#!/usr/bin/env bash
# One-command local start: ./run.sh  (then open http://127.0.0.1:8000)
# Needs ANTHROPIC_API_KEY in the environment for the chat agent; never commit it.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
if ! .venv/bin/python -I -c "import duckdb, fastapi, uvicorn, anthropic" 2>/dev/null; then
  .venv/bin/python -I -m pip install -q -r requirements.txt
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Warning: ANTHROPIC_API_KEY is not set; the table, evidence and export work, chat will not." >&2
fi
exec .venv/bin/python -I run.py "$@"
