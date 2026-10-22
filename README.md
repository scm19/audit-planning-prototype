# Audit planning prototype: Single Audit risk brief

A working prototype that helps an audit manager plan a federal **Single Audit** of a nonprofit. For one organization and audit year, it reads the public [Federal Audit Clearinghouse](https://www.fac.gov) history that was available **before** planning. It then:
- proposes up to five federal program × compliance areas to verify, each citing the exact prior findings
- writes a checked planning brief and an early client-request list
- lets the manager record Include, Investigate or Set aside decisions

It proposes where to look; it does not decide audit procedures or predict this year's findings.

## Run it

You need Python 3.10 or newer, about 2 GB of free disk, and internet access for the first run. The first run downloads the demo data (about 300 MB) automatically.

**macOS or Linux**
```bash
git clone https://github.com/scm19/audit-planning-prototype.git
cd audit-planning-prototype
./run.sh
```

**Windows (PowerShell)**
```powershell
git clone https://github.com/scm19/audit-planning-prototype.git
cd audit-planning-prototype
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python run.py
```

Then open http://127.0.0.1:8000.

**No API key is needed to explore the saved engagements.** Their briefs, citations, Inspect trace, the review table, decisions and the export all work offline. **To run new assessments and chat,** set `ANTHROPIC_API_KEY` before starting (`export ANTHROPIC_API_KEY=...`, or `$env:ANTHROPIC_API_KEY = "..."` on Windows). A new assessment takes about 3 minutes with the model; chat answers take a few seconds. The model is set in `riskagent/config.py`. Without a key, **New engagement → Assess** still builds the ranking with source-based sentences.

If port 8000 is busy, start with `./run.sh --port 8010` (or `python run.py --port 8010`).

## What to open
Click **Engagements** in the left rail. Where a nonprofit appears more than once, open the newest entry.
- **Family Services of Tulare County, 2024:**
  - one issue with several compliance tags
  - a conditional older finding
  - weak matches not promoted
  - early client requests
- **SupportWorks Housing, 2024:** an audit-wide filing finding (late FAC submission) kept as a source but not counted as program evidence.
- **Gateway Community Health Centers, 2023 or 2026.**

In any engagement:
- **Planning brief** opens the plan.
- **A program name** opens the program review.
- **A citation pill** shows its source, and **Inspect trace** shows how each claim was built and checked.

## Where things are in the code
- **Agent and checks:** `riskagent/agent/`
  - `assessment.py` builds the evidence record and final ordering.
  - `inspect.py` runs the narrative evidence check.
  - `brief.py` holds the writer, fact checks and judge.
  - `chat.py` holds the chat agent and its tools.
- **Evidence and ranking:** `riskagent/evidence/`
  - `case.py` applies the cutoff-bounded queries.
  - `ranking.py` holds the fixed ordering rule.
  - `scope.py` holds the audit-wide filing rule.
- **App:**
  - `riskagent/server.py` is the API.
  - `riskagent/store.py` holds the saved versions and decisions.
  - `riskagent/static/` is the browser UI.

## Documents
- `docs/problem-memo.md`: the user, the planning decision, and what must be proven
- `docs/rollout-plan.md`: how to introduce the tool, measure it, and decide

## Data
- **What gets downloaded:** the first run fetches `audit-planning-data.zip` from this repo's latest release into `app_data/`. It contains:
  - `evidence.duckdb`, derived from public FAC data
  - `app.sqlite3`, the saved demo engagements (delete it to start empty)
- **Outcome boundary:** target-year audit outcomes are kept out of every prediction path. Historical outcomes appear only in a separate reveal, after a prediction is saved.
- **Rebuild from raw FAC data instead:**
  1. Download `general`, `federal_awards`, `findings`, `findings_text` and `corrective_action_plans` as CSV from https://www.fac.gov/data/download/ into `data/`.
  2. Run `python scripts/build_duckdb.py data data/fac.duckdb`.
  3. Run `python scripts/create_semantic_views.py data/fac.duckdb`.
  4. Delete `app_data/evidence.duckdb` if present.

  The next start rebuilds the evidence store.

## Known limitations
- **Peers:** the comparison pool is other nonprofits audited on the same program, not a verified peer group.
- **Program list:** without a manager-supplied program list, the programs come from the latest public report and are provisional.
- **Deployment:** a local, single-user prototype, with no hosting or login.
