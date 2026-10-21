"""What a prior finding is evidence of (scope-1).

A finding about the organization's overall Single Audit filing (the audit reporting package or
data collection form submitted late to the Federal Audit Clearinghouse) is often linked to every
award and coded Reporting (L) for each program. Those links are real, but the finding says
nothing about the programs' own reports or compliance. It is "audit_filing": kept on every row it
is linked to, with its source, but never counted as that program's own evidence.

The rule reads the Condition (what went wrong) when the narrative has one, else the opening of
the text. A finding is audit_filing only if that text describes audit-package / FAC filing AND
does not describe program reports (financial, performance, reimbursement, FFATA ...). Anything
else, including findings with no narrative, is "program": counted as before. Deterministic, so a
saved assessment reproduces exactly; the model's evidence check still judges fit separately.
"""
from __future__ import annotations

import re

SCOPE_VERSION = "scope-1"

FILING = re.compile(
    r"federal (audit )?clearing ?house|\bFAC\b|data collection form|reporting package|audit package"
    r"|single audit (report|package|submission)|200\.512|(nine|9) months (after|following|of)", re.I)
PROGRAM_REPORTS = re.compile(
    r"performance report|financial report|\bSF[- ]?(425|270|271|429)\b|annual (performance |program )?report"
    r"|\bAPR\b|\bCAPER\b|\bSage\b|\bHMIS\b|quarterly report|monthly report|progress report|close-?out report"
    r"|\bFFATA\b|\bFSRS\b|\bFFR\b|draw ?down request|reimbursement request|expenditure report|cost report"
    r"|claims? for reimbursement|subaward (information|report)", re.I)
CONDITION = re.compile(
    r"Condition[^:]{0,20}:\s*(.+?)(?=\s(?:Cause|Effect|Context|Questioned costs|Recommendation|Criteria)[^:]{0,20}:|$)",
    re.I | re.S)


def condition_text(narrative: str | None) -> str:
    t = " ".join((narrative or "").split())
    m = CONDITION.search(t)
    return m.group(1) if m else t[:700]


def finding_scope(narrative: str | None) -> tuple[str, str]:
    """('audit_filing' | 'program', short reason)."""
    if not narrative:
        return "program", "no narrative on file; counted as program evidence"
    cond = condition_text(narrative)
    if FILING.search(cond) and not PROGRAM_REPORTS.search(cond):
        return "audit_filing", ("the finding describes late or missing filing of the overall audit package "
                                "with the Federal Audit Clearinghouse, not this program's own reports")
    return "program", "program-specific condition"
