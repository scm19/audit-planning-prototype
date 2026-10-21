"""Paths, versions and frozen parameters shared by the app, evaluation and tests."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FAC_DB = ROOT / "data" / "fac.duckdb"            # read-only source; never written
EVIDENCE_DB = ROOT / "app_data" / "evidence.duckdb"  # derived, rebuilt by riskagent.evidence.build_derived
APP_DB = ROOT / "app_data" / "app.sqlite3"        # engagements, conversations, assessments, decisions
STATIC_DIR = ROOT / "riskagent" / "static"

AGENT_VERSION = "risk-agent-1.0"
RANKER_VERSION = "ranker-1.3"      # 1.2 + audit-wide filing findings not counted as program evidence
BASELINE_VERSION = "baselines-1.0"  # B1 repeat last report's findings; B2 same-program peer rate

MODEL = "claude-opus-5-5"
CHAT_EFFORT = "medium"
INSPECT_EFFORT = "medium"

# Frozen ranking parameters. Chosen on 2021-2022 targets only, then frozen
# for the 2023-2024 held-out evaluation. Changing them requires a new RANKER_VERSION.
RANK_PARAMS = {
    "min_peer_reports": 10,    # peer-only candidate needs at least this many comparable reports
    "smoothing_strength": 50,  # pseudo-reports pulling a peer rate toward the requirement's base rate
    "max_leads": 5,
}
# Distinct issues given the narrative evidence check before the leads are finalized
# (review-order-2, assessment.finalize_review_order). Only used when the model check runs.
REVIEW_POOL = 8

REQUIREMENTS = {
    "A": "Activities allowed or unallowed",
    "B": "Allowable costs / cost principles",
    "C": "Cash management",
    "E": "Eligibility",
    "F": "Equipment and real property management",
    "G": "Matching, level of effort, earmarking",
    "H": "Period of performance",
    "I": "Procurement and suspension & debarment",
    "J": "Program income",
    "L": "Reporting",
    "M": "Subrecipient monitoring",
    "N": "Special tests and provisions",
    "P": "Other",
}

# A finding tagged with this many requirement letters or more is a blanket finding; its letters
# are kept but flagged because the mapping to any single requirement is weak.
BLANKET_LETTERS = 5
