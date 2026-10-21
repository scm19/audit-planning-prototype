"""Evaluation-mode reveal: compare a frozen saved assessment with reported outcomes.

Runs only after an assessment is saved, only for historical engagements, and only reads the
saved record plus the outcome reader. It never modifies or reruns the assessment.
"""
from __future__ import annotations

from riskagent.agent.assessment import now
from riskagent.evidence import outcomes
from riskagent.evidence.case import EvidenceDB

CAVEAT = ("Reported findings are an incomplete measure: auditors test only selected major "
          "programs and report what they find. An unmatched lead is an apparent false lead, not "
          "proof that no problem existed; a matched lead does not mean the tool caused the finding.")


def build_reveal(db: EvidenceDB, record: dict, target_report_id: str) -> dict:
    truth = outcomes.reported_pairs(db, [target_report_id])[target_report_id]
    pairs = truth["pairs"]
    on_list = {p["aln"] for p in record["input_programs"]}
    lead_matches = []
    for r in record["risks"]:
        hit = pairs.get((r["program_id"], r["requirement_code"]))
        lead_matches.append({"lead_id": r["lead_id"], "rank": r["rank"], "aln": r["program_id"],
                             "letter": r["requirement_code"], "matched": bool(hit),
                             "reference_numbers": hit["refs"] if hit else []})
    lead_pairs = {(r["program_id"], r["requirement_code"]) for r in record["risks"]}
    rows = {rr["row_id"]: rr for p in record["program_assessments"] for rr in p["requirements"]}
    reported = []
    for (aln, letter), v in sorted(pairs.items()):
        row = rows.get(f"R:{aln}:{letter}")
        reported.append({"aln": aln, "letter": letter, "reference_numbers": v["refs"],
                         "only_blanket": v["only_blanket"], "in_input_programs": aln in on_list,
                         "captured_by_lead": (aln, letter) in lead_pairs,
                         "assessment_state": row["state"] if row else "not a candidate",
                         "candidate_rank": row["candidate_rank"] if row else None})
    # Post-cutoff context, shown only after reveal: earlier-year reports that were filed late.
    late = [{"report_id": r[0], "audit_year": r[1], "fac_accepted_date": str(r[2])}
            for r in db.cursor().execute("""
                SELECT report_id, audit_year, fac_accepted_date FROM reports
                WHERE org_id = ? AND audit_year < ? AND fac_accepted_date >= ?
                ORDER BY audit_year""", [record["target_org"]["org_id"], record["target_year"],
                                         record["prediction_date"]]).fetchall()]
    return {
        "assessment_id": record["assessment_id"], "version": record["version"],
        "revealed_at": now(), "target_report_id": target_report_id,
        "reports_filed_after_cutoff": late,
        "reported_pairs": reported, "lead_matches": lead_matches,
        "summary": {"n_leads": len(lead_matches),
                    "n_matched": sum(m["matched"] for m in lead_matches),
                    "n_reported_pairs": len(reported),
                    "n_reported_pairs_captured": sum(p["captured_by_lead"] for p in reported),
                    "n_findings": truth["n_findings"],
                    "has_program_finding": truth["n_findings"] > 0},
        "caveat": CAVEAT,
    }
