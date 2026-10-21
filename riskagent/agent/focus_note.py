"""Staff focus note assembled from the saved assessment version and the manager's decisions."""
from __future__ import annotations

import datetime as dt

DISPOSITION_ORDER = [("include", "Include in testing focus"), ("investigate", "Investigate further"),
                     ("set_aside", "Set aside")]


def _rows(record: dict) -> dict:
    out = {}
    for p in record["program_assessments"]:
        out[p["row_id"]] = {"kind": "program", "program": p, "req": None}
        for r in p["requirements"]:
            out[r["row_id"]] = {"kind": "requirement", "program": p, "req": r}
    return out


def _evidence_line(req: dict) -> str:
    bits = []
    if req.get("own"):
        o = req["own"]
        refs = ", ".join(sorted({f["reference_number"] for f in o["findings"]})[:8])
        bits.append(f"own findings in {', '.join(map(str, o['years']))} audits ({refs})")
    pv = req["peer"]
    if pv["n"]:
        bits.append(f"{pv['k']:,} of {pv['n']:,} other nonprofits' audits of this program reported one")
    return "; ".join(bits) or "no supporting history"


def build_note(record: dict, decisions: dict) -> str:
    rows = _rows(record)
    risks = {r["requirement_row_id"]: r for r in record["risks"]}
    org = record["target_org"]["name"]
    lines = [
        f"# Staff testing focus: {org}, audit year {record['target_year']}",
        "",
        f"Assessment v{record['version']} ({record['assessment_id']}). Public FAC reports filtered "
        f"as of {record['data_cutoff']['date']} ({record['data_cutoff']['basis']}); local FAC "
        f"snapshot {record['data_cutoff']['fac_snapshot_date']}. Note generated "
        f"{dt.date.today().isoformat()} from the manager's decisions.",
        "",
        "> Proposed focus for human verification, based on public audit history. It is not an "
        "audit procedure, a finding, or a substitute for required major-program coverage. Staff "
        "verify every item against current-year records.",
        "",
    ]
    prog_decided = [(rid, d) for rid, d in decisions.items()
                    if rid in rows and rows[rid]["kind"] == "program" and d.get("disposition")]
    if prog_decided:
        label = {"include": "Close look", "investigate": "Investigate", "set_aside": "Set aside"}
        lines += ["## Program focus", ""]
        for rid, d in sorted(prog_decided, key=lambda x: ["include", "investigate", "set_aside"].index(x[1]["disposition"])):
            p = rows[rid]["program"]
            lines.append(f"- {label[d['disposition']]}: {p['program_name'] or p['aln']} ({p['aln']})"
                         + (f". {d['note']}" if d.get("note") else ""))
        lines.append("")
    used = set()
    for disp, title in DISPOSITION_ORDER:
        items = [(rid, d) for rid, d in decisions.items()
                 if d.get("disposition") == disp and rid in rows and rows[rid]["kind"] == "requirement"]
        items.sort(key=lambda x: (rows[x[0]]["req"]["candidate_rank"] or 999))
        if not items:
            continue
        lines += [f"## {title}", ""]
        for i, (rid, d) in enumerate(items, 1):
            used.add(rid)
            p, req = rows[rid]["program"], rows[rid]["req"]
            risk = risks.get(rid)
            tag = f"lead {risk['lead_id']}" if risk else f"candidate #{req['candidate_rank']}"
            lines.append(f"### {i}. {p['program_name'] or p['aln']} ({p['aln']}): "
                         f"{req['requirement']} ({req['letter']}), {tag}")
            if disp != "set_aside":
                if risk:
                    lines.append(f"- **Why:** {risk['why_this_client']}")
                lines.append(f"- **Evidence:** {_evidence_line(req)}.")
                q = risk["verification_question"] if risk else None
                if q:
                    lines.append(f"- **Verify:** {q}")
                if risk and risk.get("uncertainties"):
                    lines.append(f"- **Open questions:** " + " ".join(risk["uncertainties"]))
            if d.get("note"):
                lines.append(f"- **Manager note:** {d['note']}")
            elif disp == "set_aside":
                lines.append("- **Manager note:** (no reason recorded)")
            lines.append("")
    undecided = [r for r in record["risks"] if r["requirement_row_id"] not in used]
    if undecided:
        lines += ["## Leads without a manager decision", ""]
        for r in undecided:
            lines.append(f"- {r['lead_id']}: {r['program_name']} ({r['program_id']}), "
                         f"{r['requirement_name']}. {r['plain_language_risk']}")
        lines.append("")
    prog_notes = [(rid, d) for rid, d in decisions.items()
                  if rid in rows and rows[rid]["kind"] == "program" and d.get("note") and not d.get("disposition")]
    if prog_notes:
        lines += ["## Program notes", ""]
        for rid, d in prog_notes:
            p = rows[rid]["program"]
            lines.append(f"- {p['program_name'] or p['aln']} ({p['aln']}): {d['note']}")
        lines.append("")
    s = record["summary"]
    lines += ["## Coverage and limits", "",
              f"- {s['n_programs']} program(s) considered: {s['n_lead']} with leads, "
              f"{s['n_candidate']} with lower-ranked signals only, {s['n_no_reported_signal']} with "
              f"no reported historical signal, {s['n_too_little_evidence']} with too little "
              f"evidence, {s['n_could_not_assess']} not assessable."]
    lines += [f"- {l}" for l in record["limitations"]]
    return "\n".join(lines) + "\n"
