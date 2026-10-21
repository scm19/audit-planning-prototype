"""Outcome reader: the ONLY module that reads a target report's reported findings.

Used by the offline evaluation and by the app's "Reveal reported outcomes" action, which runs
only after an assessment has been saved and compares against that frozen record. The prediction
path (case.py, ranking.py, the agent tools) must never import this module; tests enforce it.

Reported findings are an incomplete label: auditors test only major programs and only report
what they found. A pair with no reported finding is an apparent miss, not a proven negative.
"""
from __future__ import annotations

from riskagent.evidence.case import EvidenceDB


def reported_pairs(db: EvidenceDB, report_ids: list[str]) -> dict[str, dict]:
    """Per target report: {(aln, letter): {refs, only_blanket}} plus finding counts."""
    out = {r: {"pairs": {}, "n_findings": 0, "n_unmapped_findings": 0} for r in report_ids}
    cur = db.cursor()
    for rid, aln, letter, refs, only_blanket in cur.execute("""
        SELECT report_id, aln, letter, list(DISTINCT reference_number ORDER BY reference_number),
               bool_and(is_blanket)
        FROM finding_pairs WHERE report_id IN (SELECT unnest(?)) GROUP BY 1, 2, 3""",
                                                           [report_ids]).fetchall():
        out[rid]["pairs"][(aln, letter)] = {"refs": refs, "only_blanket": bool(only_blanket)}
    for rid, n, n_unmapped in cur.execute("""
        SELECT m.report_id, count(*),
               count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM finding_pairs p
                   WHERE p.report_id = m.report_id AND p.reference_number = m.reference_number))
        FROM finding_meta m WHERE m.report_id IN (SELECT unnest(?)) GROUP BY 1""",
                                          [report_ids]).fetchall():
        out[rid]["n_findings"] = n
        out[rid]["n_unmapped_findings"] = n_unmapped
    cur.close()
    return out


def tested_programs(db: EvidenceDB, report_ids: list[str]) -> dict[str, list[str]]:
    """ALNs the auditor tested as major programs in each target report (a target-year audit
    outcome). Post-reveal diagnostic only: shows how incomplete the reported-findings label is,
    since a lead in a program not tested that year rarely has a reported finding to match."""
    out = {r: [] for r in report_ids}
    cur = db.cursor()
    for rid, aln in cur.execute("SELECT report_id, aln FROM program_audits WHERE is_major AND "
                                "report_id IN (SELECT unnest(?)) ORDER BY 1, 2",
                                [report_ids]).fetchall():
        out[rid].append(aln)
    cur.close()
    return out
