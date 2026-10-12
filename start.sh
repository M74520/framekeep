#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  echo 'Please install Python 3.12 or later, then run this script again.'
  exit 1
fi
if [ ! -d .venv ]; then python3 -m venv .venv; fi
if ! .venv/bin/python -c 'import PIL, rawpy' >/dev/null 2>&1; then
  .venv/bin/python -m pip install --only-binary=:all: -r local/requirements.txt
fi
exec .venv/bin/python local/server.py
