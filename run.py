"""Start the Single Audit Risk Brief locally.

    ./run.sh            (installs dependencies on first run, gets the data, starts)
    python run.py [--port 8000]

First run: downloads the demo data (derived evidence store + saved engagements) from the
latest GitHub release, or builds the evidence store from data/fac.duckdb if that exists.
"""
import argparse
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from riskagent.config import EVIDENCE_DB, FAC_DB  # noqa: E402

DATA_URL = ("https://github.com/scm19/audit-planning-prototype/releases/latest/download/"
            "audit-planning-data.zip")


def fetch_data():
    dest = EVIDENCE_DB.parent
    dest.mkdir(parents=True, exist_ok=True)
    tmp = dest / "data.zip"
    print(f"Downloading demo data (~300 MB) from {DATA_URL}")
    if shutil.which("curl"):
        subprocess.run(["curl", "-fL", "--progress-bar", "-o", str(tmp), DATA_URL], check=True)
    else:
        urllib.request.urlretrieve(DATA_URL, tmp)
    with zipfile.ZipFile(tmp) as z:
        z.extractall(dest)
    tmp.unlink()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    if not EVIDENCE_DB.exists():
        if FAC_DB.exists():
            from riskagent.evidence import build_derived
            build_derived.main()
        else:
            fetch_data()
    import uvicorn
    from riskagent.server import app
    print(f"Single Audit Risk Brief: http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
