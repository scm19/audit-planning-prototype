"""Candidate generation, the explicit ranking policy, row states and the two baselines.

Policy (RANKER_VERSION ranker-1.0), from the agent design:
  1. own_latest  - the org reported a finding in this program x requirement in its latest
                   admissible audit of the program (latest year it was major or had a finding)
  2. own_older   - an older own finding in this program x requirement only
  3. peer_only   - other nonprofits' admissible audits of the same ALN, ordered by a smoothed
                   reported-finding share, with a minimum number of comparable reports
Within own groups: more recent finding first, then findings in more years, then specific
findings ahead of blanket ones (5+ requirement letters), then the peer share. Rank is an
ordering for review, not a calibrated chance of a finding.

ranker-1.2 adds one rule: within a program, a requirement row whose own findings ALL already
support a higher-ranked row has no separate client-specific basis (one finding record coded to
several requirements). It becomes a related tag on that issue, not a separate lead, and the slot
goes to the next distinct issue. A row with even one finding of its own stays a distinct issue.

ranker-1.3 adds: an own finding about the overall audit filing (scope.py: late audit package or
data collection form to the FAC) is kept on every row it is linked to but is not counted as that
program's own evidence. The row is ranked on what remains (other own findings, else the
same-program pattern). With nothing else, it stays visible as "audit_wide_only" and is never a lead.
"""
from __future__ import annotations

from riskagent.config import RANK_PARAMS, REQUIREMENTS
from riskagent.evidence.case import CaseEvidence, Program

GROUP_ORDER = {"own_latest": 0, "own_older": 1, "peer_only": 2, "audit_wide_only": 3}
GROUP_LABEL = {"own_latest": "Own latest audit", "own_older": "Own older audit",
               "peer_only": "Same-program pattern only",
               "audit_wide_only": "Audit-wide filing finding only"}


def smoothed(k: int, n: int, p0: float, m: float) -> float:
    return (k + m * p0) / (n + m) if (n + m) > 0 else 0.0


def peer_view(ev: CaseEvidence, aln: str, letter: str, params: dict) -> dict:
    n = ev.peer_n.get(aln, {}).get("n", 0)
    kd = ev.peer_k.get((aln, letter), {})
    k = kd.get("k", 0)
    p0 = ev.base_rates.get(letter, 0.0)
    return {"n": n, "k": k, "k_excluding_blanket": kd.get("k_excluding_blanket", 0),
            "rate": (k / n) if n else None,
            "smoothed_rate": smoothed(k, n, p0, params["smoothing_strength"]),
            "base_rate": p0}


def candidates_for(programs: list[Program], ev: CaseEvidence, params: dict | None = None,
                   use_own: bool = True, use_peer: bool = True) -> list[dict]:
    params = params or RANK_PARAMS
    out = []
    for p in programs:
        if p.aln_status == "unidentified":
            continue
        cov = ev.coverage.get(p.aln, {})
        audited = set(cov.get("years_audited_major", [])) | set(cov.get("years_with_findings", []))
        latest_audit = max(audited) if audited else None
        own_letters = sorted({l for (a, l) in ev.own_findings if a == p.aln})
        audit_wide = {}   # letter -> audit-filing findings linked to this row (kept, not counted)
        counted = []      # letters with program evidence of their own
        if use_own:
            for letter in own_letters:
                every = ev.own_findings[(p.aln, letter)]
                fs = [f for f in every if f.get("scope") != "audit_filing"]
                if len(fs) < len(every):
                    audit_wide[letter] = [f for f in every if f.get("scope") == "audit_filing"]
                if not fs:
                    continue
                counted.append(letter)
                years = sorted({f["audit_year"] for f in fs})
                latest_f = max(years)
                pv = peer_view(ev, p.aln, letter, params)
                out.append({
                    "aln": p.aln, "letter": letter,
                    "group": "own_latest" if latest_f == latest_audit else "own_older",
                    "own": {"n_reports_with_finding": len({f["report_id"] for f in fs}),
                            "years": years, "latest_year": latest_f,
                            "latest_program_audit_year": latest_audit,
                            "only_blanket": all(f["is_blanket"] for f in fs), "findings": fs},
                    "peer": pv, "audit_wide": audit_wide.get(letter, []),
                })
        placed = set(counted)
        if use_peer and ev.peer_n.get(p.aln, {}).get("n", 0) >= params["min_peer_reports"]:
            for (a, letter), kd in ev.peer_k.items():
                if a != p.aln or kd["k"] < 1 or letter in placed:
                    continue
                placed.add(letter)
                out.append({"aln": p.aln, "letter": letter, "group": "peer_only", "own": None,
                            "peer": peer_view(ev, p.aln, letter, params),
                            "audit_wide": audit_wide.get(letter, [])})
        for letter in sorted(set(audit_wide) - placed):
            out.append({"aln": p.aln, "letter": letter, "group": "audit_wide_only", "own": None,
                        "peer": peer_view(ev, p.aln, letter, params), "audit_wide": audit_wide[letter]})

    def key(c):
        g = GROUP_ORDER[c["group"]]
        if c["own"]:
            o = c["own"]
            return (g, -o["latest_year"], -len(o["years"]), o["only_blanket"],
                    -c["peer"]["smoothed_rate"], c["aln"], c["letter"])
        return (g, 0, 0, False, -c["peer"]["smoothed_rate"], -c["peer"]["k"], c["aln"],
                c["letter"])

    out.sort(key=key)
    for i, c in enumerate(out, 1):
        c["candidate_rank"] = i
    return out


def finding_ids(c: dict) -> set[str]:
    return {f"{f['report_id']}#{f['reference_number']}" for f in (c["own"] or {}).get("findings", [])}


def group_issues(cands: list[dict]) -> list[dict]:
    """Attach rows with no separate own finding to the higher-ranked row they duplicate, then
    renumber candidate_rank over distinct issues only. Input must be in policy order."""
    primaries: dict[str, list[dict]] = {}
    issues = []
    for c in cands:
        c["related"] = []
        fids = finding_ids(c)
        prim = next((p for p in primaries.get(c["aln"], []) if fids and fids <= finding_ids(p)), None)
        if prim is not None:
            c["issue_of"] = f"R:{prim['aln']}:{prim['letter']}"
            c["candidate_rank"] = None
            prim["related"].append(c)
            continue
        c["issue_of"] = None
        primaries.setdefault(c["aln"], []).append(c)
        issues.append(c)
    for i, c in enumerate(issues, 1):
        c["candidate_rank"] = i
    return issues


def rank_case(programs: list[Program], ev: CaseEvidence, params: dict | None = None) -> dict:
    """Ranked candidates plus a state for every program and requirement row considered."""
    params = params or RANK_PARAMS
    cands = candidates_for(programs, ev, params)
    issues = group_issues(cands)
    max_leads = params["max_leads"]
    by_prog: dict[str, list[dict]] = {}
    for c in cands:
        if c["issue_of"]:
            c["rank"], c["state"] = None, "related"
        elif c["group"] == "audit_wide_only":  # visible, never a lead
            c["rank"], c["state"] = None, "candidate"
        else:
            c["rank"] = c["candidate_rank"] if c["candidate_rank"] <= max_leads else None
            c["state"] = "lead" if c["rank"] else "candidate"
        by_prog.setdefault(c["aln"], []).append(c)

    rows = []
    for p in programs:
        cov = ev.coverage.get(p.aln, {"years_present": [], "years_audited_major": [],
                                      "years_with_findings": []})
        peer = ev.peer_n.get(p.aln, {"n": 0, "first_year": None, "last_year": None})
        reqs = by_prog.get(p.aln, [])  # policy order; related rows follow their position
        n_leads = sum(1 for c in reqs if c["state"] == "lead")
        if p.aln_status == "unidentified":
            state = "could_not_assess"
            reason = (f"Program number {p.aln} is not a specific Assistance Listing (unknown or "
                      "placeholder extension), so no reliable comparison is possible.")
        elif n_leads:
            top = reqs[0]
            state = "lead"
            reason = f"{n_leads} requirement lead(s); top: {_why_short(top)}"
        elif reqs:
            state = "candidate"
            best = min(c["candidate_rank"] for c in reqs if c["candidate_rank"])
            reason = (f"{len(reqs)} historical signal(s), all ranked below the top five "
                      f"(best candidate #{best}).")
        elif cov["years_audited_major"] or peer["n"] >= params["min_peer_reports"]:
            state = "no_reported_signal"
            parts = []
            if cov["years_audited_major"]:
                parts.append("audited as a major program in " +
                             ", ".join(map(str, cov["years_audited_major"])) +
                             " with no reported finding")
            if peer["n"]:
                parts.append(f"{peer['n']} comparable peer audits reported no finding in it")
            reason = ("No reported historical signal: " + "; ".join(parts) +
                      ". This is not evidence of low risk.")
        else:
            state = "too_little_evidence"
            own_bit = ("never audited as a major program in admissible own reports"
                       if not cov["years_audited_major"] else "")
            reason = (f"Too little evidence: {own_bit or 'no own findings'}, and only "
                      f"{peer['n']} comparable peer audit(s) (minimum "
                      f"{params['min_peer_reports']}).")
        rows.append({"program": p, "state": state, "state_reason": reason, "n_leads": n_leads,
                     "coverage": cov, "peer": peer, "requirements": reqs})
    leads = [c for c in cands if c["state"] == "lead"]
    eligible = [c for c in issues if c["group"] != "audit_wide_only"]
    return {"candidates": cands, "issues": issues, "eligible": eligible, "leads": leads,
            "program_rows": rows, "params": params}


def _why_short(c: dict) -> str:
    req = f"{REQUIREMENTS.get(c['letter'], c['letter'])} ({c['letter']})"
    if c["group"] == "own_latest":
        return f"own finding in {req} in {c['own']['latest_year']}, the latest available audit of this program"
    if c["group"] == "own_older":
        return f"older own finding in {req} ({', '.join(map(str, c['own']['years']))})"
    if c["group"] == "audit_wide_only":
        refs = ", ".join(sorted({f["reference_number"] for f in c["audit_wide"]}))
        return (f"only an audit-wide filing finding is linked here ({refs}: late filing of the overall "
                f"audit package with the FAC); it is not evidence about this program's own {req.lower()}")
    pv = c["peer"]
    return f"same-program pattern in {req}: {pv['k']} of {pv['n']} other nonprofits' audits of this program reported one"


def conclusion(c: dict) -> str:
    if c.get("state") == "related":
        return (f"Related tag of {c['issue_of']}: rests only on the same findings, so it is not a "
                f"separate lead; {_why_short(c)}.")
    head = f"Lead #{c['rank']}" if c["state"] == "lead" else f"Candidate #{c['candidate_rank']}"
    return f"{head}: {_why_short(c)}."


def row_limits(c: dict, ev: CaseEvidence) -> list[str]:
    lim = []
    if c.get("audit_wide"):
        refs = ", ".join(sorted({f"{f['reference_number']} ({f['audit_year']})" for f in c["audit_wide"]}))
        lim.append(f"Linked finding {refs} concerns late filing of the overall audit package with the "
                   "FAC. It is kept here as a source but not counted as evidence about this program.")
    if c["own"]:
        fs = c["own"]["findings"]
        if c["own"]["only_blanket"]:
            lim.append("Every own finding here lists 5+ requirements; the link to this requirement is weak.")
        if not any(f["has_text"] for f in fs):
            lim.append("No finding narrative available (older Census-era record).")
        if any(f["conflicting_rows"] for f in fs):
            lim.append("Source finding rows disagree; merged flags are less certain.")
        if c["group"] == "own_older":
            lim.append(f"Not reported in the latest available audit of this program "
                       f"({c['own']['latest_program_audit_year']}).")
    pv = c["peer"]
    if pv["n"] and pv["k"] and pv["k_excluding_blanket"] < pv["k"]:
        lim.append(f"{pv['k'] - pv['k_excluding_blanket']} of the {pv['k']} peer reports count "
                   "only through blanket findings.")
    if pv["n"] < RANK_PARAMS["min_peer_reports"]:
        lim.append(f"Only {pv['n']} comparable peer audits.")
    return lim


# ---------------------------------------------------------------------- baselines
def baseline_repeat_last(programs: list[Program], ev: CaseEvidence, max_leads: int = 5) -> list[dict]:
    """B1: repeat the program x requirement findings of the latest admissible own report."""
    if not ev.own_reports:
        return []
    latest = ev.own_reports[0]["report_id"]
    on_list = {p.aln for p in programs}
    pairs = {}
    for (aln, letter), fs in ev.own_findings.items():
        if aln not in on_list:
            continue
        n = sum(1 for f in fs if f["report_id"] == latest)
        if n:
            pairs[(aln, letter)] = n
    ranked = sorted(pairs.items(), key=lambda kv: (-kv[1], kv[0]))
    return [{"aln": a, "letter": l, "rank": i} for i, ((a, l), _) in
            enumerate(ranked[:max_leads], 1)]


def baseline_peer_rate(programs: list[Program], ev: CaseEvidence, params: dict | None = None) -> list[dict]:
    """B2: rank the input programs' requirements by same-program peer reported-finding share."""
    params = params or RANK_PARAMS
    cands = candidates_for(programs, ev, params, use_own=False, use_peer=True)
    return [{"aln": c["aln"], "letter": c["letter"], "rank": i}
            for i, c in enumerate(cands[:params["max_leads"]], 1)]


def ranked_pairs(programs: list[Program], ev: CaseEvidence, params: dict | None = None,
                 use_own: bool = True, use_peer: bool = True) -> list[dict]:
    params = params or RANK_PARAMS
    cands = candidates_for(programs, ev, params, use_own=use_own, use_peer=use_peer)
    return [{"aln": c["aln"], "letter": c["letter"], "rank": i, "group": c["group"]}
            for i, c in enumerate(cands[:params["max_leads"]], 1)]
