"""Build, explain and version a saved assessment record.

Deterministic steps (identity, cutoff, program context, own and peer evidence, candidates,
ranks) are reproducible from inputs + versions. The model step (inspect.py) adds wording, an
evidence check and uncertainties to a pool of the top distinct issues; it cannot change counts or
sources. finalize_review_order then applies a fixed, recorded rule to the saved checks to pick the
top five (review-order-1), so every move is explainable and reproducible from the record.
"""
from __future__ import annotations

import datetime as dt
import secrets

from riskagent.config import (AGENT_VERSION, BASELINE_VERSION, MODEL, RANK_PARAMS, RANKER_VERSION,
                              REQUIREMENTS, REVIEW_POOL)
from riskagent.evidence import ranking
from riskagent.evidence.case import Case, CaseEvidence, EvidenceDB, Program

VERIFY_QUESTIONS = {
    "A": "Which costs charged to this program this year fall outside its allowed activities, and who approved them?",
    "B": "For a sample of this year's charges to the program, are costs supported, allocable and approved, with a documented allocation method?",
    "C": "How are federal draws timed against actual disbursements this year, and are excess cash balances avoided?",
    "E": "For a sample of participants served this year, are eligibility determinations documented, current and supported?",
    "F": "Is the inventory of federally funded equipment complete and reconciled, with a recent physical count?",
    "G": "How is matching or level of effort tracked this year, and does the support tie to the ledger?",
    "H": "Were any costs charged before the award start or after the end of this year's periods of performance?",
    "I": "For this year's larger purchases, do procurement files show competition, cost analysis and suspension/debarment checks?",
    "J": "How is program income identified, recorded and applied to this program this year?",
    "L": "Do this year's federal financial and performance reports reconcile to the accounting records, and were they filed on time?",
    "M": "Which subawards were made this year, and what subrecipient risk assessments and monitoring are documented?",
    "N": "Which program-specific special tests apply this year (Compliance Supplement), and what records show compliance?",
    "P": "What did the earlier 'other' finding cover, and has that condition recurred this year?",
}

GENERAL_LIMITS = [
    "Rank orders areas for review; it does not estimate how likely a finding is.",
    "A missing reported finding is not evidence of low risk: auditors test only selected major "
    "programs and report only what they find.",
    "History signals where to look; it does not show what is wrong this year. Staff must verify "
    "against current-year records.",
]


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def money(x) -> str:
    return f"${x:,.0f}" if x is not None else "amount unknown"


STAGE_OF = {"resolve_case": "case", "get_program_context": "case", "get_own_history": "own_history",
            "get_peer_evidence": "comparisons", "propose_candidates": "rank", "inspect_candidate": "write",
            "explain_and_check": "fact_check", "save_assessment": "save"}


# engagement_id -> live steps for the UI while a run is in flight (read by /progress).
PROGRESS: dict[str, list] = {}
STEP_LABEL = {
    "resolve_case": "Fixed identity and data cutoff", "get_program_context": "Listed the programs",
    "get_own_history": "Read this nonprofit's earlier reports", "get_peer_evidence": "Counted same-program audits",
    "propose_candidates": "Ranked candidate areas", "finalize_review_order": "Finalized the top five from the checked pool", "inspect_candidate": "Prepared finding narratives",
    "inspect_candidate.read_finding": "Read a finding narrative", "inspect_candidate.get_peer_examples": "Read other nonprofits' findings",
    "explain_and_check": "Checked the lead wording against sources", "write_brief": "Wrote the brief",
    "fact_check": "Fact-checked every claim", "quality_check": "Judged claims against their sources",
    "repair": "Repaired flagged claims", "save_brief": "Saved the checked brief", "save_assessment": "Saved the assessment"}


class Trace:
    def __init__(self, engagement_id: str | None = None):
        self.items = []
        self.eid = engagement_id

    def note(self, label: str):
        """Live 'now doing' step for the UI; not part of the saved trace."""
        if self.eid:
            live = PROGRESS.setdefault(self.eid, [])
            if live and not live[-1]["done"]:
                live.pop()
            live.append({"label": label, "summary": "", "done": False})

    def add(self, tool: str, reason: str, args: dict, summary: str, *, stage: str | None = None,
            inputs: list | None = None, outputs: list | None = None, verdict: str = "ok",
            rule: str | None = None):
        # Each item is also a TraceEvent: stage, input/output record ids, rule version, verdict.
        self.items.append({"step": len(self.items) + 1, "tool": tool, "reason": reason,
                           "args": args, "result_summary": summary, "ts": now(),
                           "trace_event_id": f"T{len(self.items) + 1}", "stage": stage or STAGE_OF.get(tool, tool),
                           "tool_name": tool, "input_record_ids": inputs or [], "output_record_ids": outputs or [],
                           "rule_or_prompt_version": rule, "verdict": verdict})
        if self.eid:
            live = PROGRESS.setdefault(self.eid, [])
            if live and not live[-1]["done"]:
                live.pop()
            live.append({"label": STEP_LABEL.get(tool, tool), "summary": summary[:160], "done": True})


# ---------------------------------------------------------------------- case resolution
def resolve_case(db: EvidenceDB, engagement: dict, run_date: dt.date | None = None):
    org = db.org(engagement["org_id"])
    if org is None:
        raise ValueError(f"Unknown organization {engagement['org_id']}")
    year = int(engagement["audit_year"])
    targets = db.target_reports(org["org_id"], year)
    flags = []
    if org["org_id_method"] in ("ein_ambiguous", "ein_only") or org.get("any_ambiguous"):
        flags.append("ein_ambiguous" if org.get("any_ambiguous") else org["org_id_method"])
    if len(targets) > 1:
        flags.append("multiple_reports_in_year")
    if targets:
        mode = "historical"
        t = targets[0]
        cutoff = t["fy_end_date"]
        target_report_id = t["report_id"]
        name, state = t["auditee_name"], t["auditee_state"] or org["state"]
    else:
        mode = "live"
        cutoff = run_date or dt.date.today()
        target_report_id = None
        name, state = org["name"], org["state"]
    case = Case(case_id=engagement["engagement_id"], org_id=org["org_id"], target_year=year,
                cutoff=cutoff, target_report_id=target_report_id)
    target_org = {"org_id": org["org_id"], "name": name, "uei": org["uei"], "ein": org["ein"],
                  "state": state, "org_id_method": org["org_id_method"], "identity_flags": flags}
    return case, mode, target_org


def program_context(db: EvidenceDB, case: Case, mode: str, program_mode: str,
                    override: list[Program] | None):
    if override is not None:
        return override, "manager_supplied", None
    if mode == "historical" and program_mode == "proxy":
        return db.target_programs_proxy(case.target_report_id), "filed_sefa_proxy", None
    progs, src = db.last_public_programs(case)
    return progs, "last_public_programs", src


# ---------------------------------------------------------------------- record assembly
def _source_list(c: dict, peer_samples: list[dict]) -> list[dict]:
    src = []
    if c["own"]:
        for f in c["own"]["findings"][:6]:
            src.append({"kind": "own", "report_id": f["report_id"], "audit_year": f["audit_year"],
                        "fac_accepted_date": f["fac_accepted_date"],
                        "reference_number": f["reference_number"]})
    for s in peer_samples[:3]:
        src.append({"kind": "peer", "report_id": s["report_id"], "audit_year": s["audit_year"],
                    "fac_accepted_date": s["fac_accepted_date"],
                    "reference_number": s["reference_numbers"][0], "auditee_name": s["auditee_name"]})
    return src


def template_text(c: dict, prog: Program) -> dict:
    """Deterministic wording used for tests and as a flagged fallback when the model fails."""
    req = REQUIREMENTS.get(c["letter"], c["letter"])
    pname = prog.name or c["aln"]
    pv = c["peer"]
    peer_bit = (f"{pv['k']} of {pv['n']} audits of this program at other nonprofits "
                f"also reported a {req.lower()} finding." if pv["n"] else
                "No other nonprofits' audits of this program were public by the cutoff.")
    if c["own"] and c["group"] == "own_older":
        o = c["own"]
        refs = ", ".join(sorted({f["reference_number"] for f in o["findings"]}))
        why = (f"Conditional: own {req.lower()} findings in {', '.join(map(str, o['years']))} ({refs}) "
               f"were not reported in the latest available audit of this program "
               f"({o['latest_program_audit_year']}). {peer_bit}")
    elif c["own"]:
        o = c["own"]
        last = [f for f in o["findings"] if f["audit_year"] == o["latest_year"]]
        refs = ", ".join(sorted({f["reference_number"] for f in last}))
        why = (f"Its {o['latest_year']} audit reported a {req.lower()} finding in this program "
               f"({refs}); own findings in this area appear in {len(o['years'])} admissible "
               f"audit year(s) ({', '.join(map(str, o['years']))}). {peer_bit}")
    else:
        why = (f"No own finding in this area. {peer_bit}")
    q = VERIFY_QUESTIONS.get(c["letter"], "What records show compliance this year?")
    if c["group"] == "own_older":
        q = "First confirm the earlier condition still applies this year; if it does: " + q[0].lower() + q[1:]
    return {"short_title": req,
            "plain_language_risk": f"{req} for {pname} ({c['aln']}) merits a check.",
            "why_this_client": why,
            "verification_question": q,
            "uncertainties": ["A past finding, here or at another nonprofit, does not show a current-year problem."]}


def build_record(db: EvidenceDB, engagement: dict, *, override: list[Program] | None = None,
                 parent: dict | None = None, change_summary: str = "Initial assessment",
                 post_reveal: bool = False, run_date: dt.date | None = None,
                 inspector=None) -> dict:
    """Run the full assessment for an engagement and return the record (not yet saved)."""
    trace = Trace(engagement["engagement_id"])
    case, mode, target_org = resolve_case(db, engagement, run_date)
    trace.add("resolve_case", "Fix the nonprofit identity and the system-set data cutoff.",
              {"org_id": case.org_id, "audit_year": case.target_year},
              f"{target_org['name']}; mode {mode}; cutoff {case.cutoff}; flags "
              f"{target_org['identity_flags'] or 'none'}")

    programs, program_source, prov_src = program_context(
        db, case, mode, engagement.get("program_mode", "proxy"), override)
    trace.add("get_program_context", "List the programs to assess.",
              {"program_source": program_source},
              f"{len(programs)} program(s) from {program_source}"
              + (f" (report {prov_src['report_id']}, {prov_src['audit_year']})" if prov_src else ""))

    trace.note("Reading earlier reports and same-program audits")
    ev: CaseEvidence = db.gather([case], {case.case_id: programs})[case.case_id]
    trace.add("get_own_history", "Earlier public reports for this organization.",
              {"rule": "accepted < cutoff and audit_year < target"},
              f"{len(ev.own_reports)} admissible report(s); {len(ev.unavailable_reports)} "
              "earlier audit year(s) with no public report at the cutoff; "
              f"{sum(len(v) for v in ev.own_findings.values())} program-requirement finding rows")
    trace.add("get_peer_evidence", "Same-program audits at other nonprofits (major programs only).",
              {"alns": [p.aln for p in programs]},
              "; ".join(f"{a}: {v['n']} reports" for a, v in sorted(ev.peer_n.items())) or "none")

    ranked = ranking.rank_case(programs, ev, RANK_PARAMS)
    trace.add("propose_candidates", "Apply the frozen ranking policy (own latest > own older > peer).",
              {"ranker": RANKER_VERSION, **RANK_PARAMS},
              f"{len(ranked['candidates'])} candidate(s); {len(ranked['leads'])} lead(s)")

    prog_by_aln = {p.aln: p for p in programs}
    # With the narrative check, a wider pool of distinct issues is checked before the top five
    # are finalized; without it, the policy's top five are the leads.
    pool = ranked["eligible"][:REVIEW_POOL if inspector is not None else RANK_PARAMS["max_leads"]]
    peer_samples = {}
    for c in pool:
        peer_samples[(c["aln"], c["letter"])] = db.peer_sample(case, c["aln"], c["letter"], 5)

    program_assessments = []
    for row in ranked["program_rows"]:
        p: Program = row["program"]
        reqs = []
        for c in row["requirements"]:
            reqs.append({
                "row_id": f"R:{c['aln']}:{c['letter']}", "letter": c["letter"],
                "requirement": REQUIREMENTS.get(c["letter"], c["letter"]),
                "state": c["state"], "rank": c["rank"], "candidate_rank": c["candidate_rank"],
                "issue_of": c.get("issue_of"),
                "audit_wide": [{k: f[k] for k in ("report_id", "reference_number", "audit_year",
                                                  "fac_accepted_date", "scope_reason")}
                               for f in c.get("audit_wide", [])],
                "related_row_ids": [f"R:{x['aln']}:{x['letter']}" for x in c.get("related", [])],
                "group": c["group"], "group_label": ranking.GROUP_LABEL[c["group"]],
                "own": ({k: v for k, v in c["own"].items()} if c["own"] else None),
                "peer": c["peer"],
                "conclusion": ranking.conclusion(c),
                "limits": ranking.row_limits(c, ev),
            })
        program_assessments.append({
            "row_id": f"P:{p.aln}", "aln": p.aln, "program_name": p.name, "amount": p.amount,
            "cluster_name": p.cluster_name, "aln_status": p.aln_status,
            "program_source": program_source, "status": p.status,
            "state": row["state"], "state_reason": row["state_reason"], "n_leads": row["n_leads"],
            "own_coverage": row["coverage"],
            "peer": {"n_reports": row["peer"]["n"], "first_year": row["peer"]["first_year"],
                     "last_year": row["peer"]["last_year"],
                     "rule": (f"Other nonprofits' reports where {p.aln} was a major program, "
                              f"FAC-accepted before {case.cutoff} and audit year before "
                              f"{case.target_year}")},
            "requirements": reqs,
        })

    risks = []
    for c in pool:
        prog = prog_by_aln[c["aln"]]
        t = template_text(c, prog)
        risks.append({
            "lead_id": f"L{c['candidate_rank']}", "rank": c["candidate_rank"], "policy_rank": c["candidate_rank"],
            "program_row_id": f"P:{c['aln']}",
            "requirement_row_id": f"R:{c['aln']}:{c['letter']}", "program_id": c["aln"],
            "program_name": prog.name, "requirement_code": c["letter"],
            "requirement_name": REQUIREMENTS.get(c["letter"], c["letter"]),
            "group": c["group"], "group_label": ranking.GROUP_LABEL[c["group"]],
            **t,
            "sources": _source_list(c, peer_samples[(c["aln"], c["letter"])]),
            "peer": c["peer"],
            "own_summary": ({"years": c["own"]["years"], "latest_year": c["own"]["latest_year"],
                             "n_reports_with_finding": c["own"]["n_reports_with_finding"]}
                            if c["own"] else None),
            "evidence_check": {"status": "not_checked", "notes": "", "narratives_read": []},
            "explanation_source": "template",
            "limits": ranking.row_limits(c, ev),
            "conditional": (f"Older finding ({', '.join(map(str, c['own']['years']))}); not reported in the "
                            f"latest available audit of this program ({c['own']['latest_program_audit_year']}). "
                            "Confirm the condition still applies before testing it."
                            if c["group"] == "own_older" else None),
            "related": [{"row_id": f"R:{x['aln']}:{x['letter']}", "requirement_code": x["letter"],
                         "requirement_name": REQUIREMENTS.get(x["letter"], x["letter"]),
                         "status": "not_checked",
                         "distinct_check": (f"The same findings are also coded to "
                                            f"{REQUIREMENTS.get(x['letter'], x['letter']).lower()}; check "
                                            "separately whether that requirement is actually affected.")}
                        for x in c.get("related", [])],
        })

    # Audit-wide filing findings, once each, with every row they are linked to (kept, not counted).
    audit_wide = {}
    for pa in program_assessments:
        for q in pa["requirements"]:
            for f in q["audit_wide"]:
                fid = f"{f['report_id']}#{f['reference_number']}"
                e = audit_wide.setdefault(fid, {**f, "finding_id": fid, "row_ids": [], "programs": []})
                e["row_ids"].append(q["row_id"])
                if pa["aln"] not in e["programs"]:
                    e["programs"].append(pa["aln"])

    states = [r["state"] for r in program_assessments]
    summary = {"n_programs": len(program_assessments), "n_lead": states.count("lead"),
               "n_candidate": states.count("candidate"),
               "n_no_reported_signal": states.count("no_reported_signal"),
               "n_too_little_evidence": states.count("too_little_evidence"),
               "n_could_not_assess": states.count("could_not_assess"), "n_leads": len(risks)}

    record = {
        "assessment_id": new_id("asm"), "engagement_id": engagement["engagement_id"],
        "version": (parent["version"] + 1) if parent else 1,
        "parent_assessment_id": parent["assessment_id"] if parent else None,
        "change_summary": change_summary, "created_at": now(), "post_reveal": post_reveal,
        "mode": mode, "target_org": target_org, "target_year": case.target_year,
        "prediction_date": str(case.cutoff),
        "data_cutoff": {"date": str(case.cutoff),
                        "rule": (f"FAC accepted before {case.cutoff} and audit year before "
                                 f"{case.target_year}"),
                        "basis": ("target fiscal year-end (historical)" if mode == "historical"
                                  else "run date (live)"),
                        "fac_snapshot_date": str(db.snapshot_date)},
        "program_source": program_source,
        "provisional_source_report": prov_src,
        "input_programs": [{"aln": p.aln, "name": p.name, "amount": p.amount, "status": p.status,
                            "aln_status": p.aln_status} for p in programs],
        "versions": {"agent": AGENT_VERSION, "ranker": RANKER_VERSION,
                     "baseline": BASELINE_VERSION, "model": MODEL},
        "params": dict(RANK_PARAMS),
        "limitations": limitations(case, mode, target_org, program_source, prov_src, programs, ev,
                                   db.snapshot_date),
        "summary": summary,
        "own_history": {"reports": ev.own_reports, "unavailable_reports": ev.unavailable_reports,
                        "unmapped_findings": 0,
                        "off_list_findings": ev.other_program_findings[:20]},
        "program_assessments": program_assessments,
        "risks": risks,
        "audit_wide_findings": list(audit_wide.values()),
        "tool_trace": trace.items,
    }
    if audit_wide:
        record["limitations"].append(
            "Own finding(s) " + ", ".join(f"{f['reference_number']} ({f['audit_year']})" for f in audit_wide.values())
            + " concern late filing of the overall audit package with the FAC. They stay linked to their "
            "program rows as sources but are not counted as evidence about any program's own reports.")
    if inspector is not None and risks:
        trace.note("Reading finding narratives for the top leads")
        inspector(db, case, record, trace)
    else:
        finalize_review_order(record, trace)
    trace.add("save_assessment", "Persist inputs, cutoff, evidence, ranks, trace and versions.",
              {"version": record["version"]}, f"assessment {record['assessment_id']}")
    record["tool_trace"] = trace.items
    return record


REVIEW_ORDER_VERSION = "review-order-2"
TIER_LABEL = {0: "evidence fits", 1: "weak match or conflict"}


def _tier(r: dict) -> int:
    # Conditional (older, not repeated) issues keep their policy position, below current own
    # findings, and are worded conditionally; one whose text shows the fix is judged a conflict.
    return 1 if r["evidence_check"]["status"] in ("weak_match", "conflict") else 0


def finalize_review_order(record: dict, trace) -> None:
    """Pick the top five from the checked pool with a fixed rule and record why.

    review-order-2: when the narrative check ran, leads are the checked issues whose evidence fits
    (not weak_match or conflict), in policy order, at most five. Five is a maximum, not a quota:
    weak or conflicting issues are never promoted to fill slots; they stay visible as checked
    candidates with the reason. Conditional older findings are labeled and worded conditionally
    but keep their policy position.
    Without the check, the policy order stands. Issues moved out stay visible as candidates.
    """
    pool = record["risks"]
    n = RANK_PARAMS["max_leads"]
    checked = any(r["evidence_check"]["status"] != "not_checked" for r in pool)
    order = sorted(pool, key=lambda r: ((_tier(r) if checked else 0), r["policy_rank"]))
    fits = [r for r in order if not checked or _tier(r) == 0]
    keep = fits[:n]
    out = [r for r in order if r not in keep]
    for i, r in enumerate(keep, 1):
        r["rank"], r["lead_id"] = i, f"L{i}"
        r["review_tier"] = _tier(r) if checked else None
        moved = r["policy_rank"] != i
        r["order_note"] = (f"Policy rank {r['policy_rank']} → review rank {i}: " + (
            "moved up because higher-ranked issues have weaker or conditional support." if r["policy_rank"] > i
            else f"moved down: {TIER_LABEL[_tier(r)]}.")) if checked and moved else None
    entries = []
    for r in order:
        ec = r["evidence_check"]
        entries.append({"row_id": r["requirement_row_id"], "policy_rank": r["policy_rank"],
                        "review_rank": r["rank"] if r in keep else None,
                        "tier": _tier(r) if checked else None, "check": ec["status"],
                        "reason": (r["order_note"] if r in keep else
                                   ("Not a lead: " if _tier(r) else "Ranked below the leads: ") + TIER_LABEL[_tier(r)]
                                   + (f" ({ec['notes'][:220]})" if ec.get("notes") else "") + ".")})
    for r in out:
        r["lead_id"], r["rank"] = None, None
    record["risks"] = keep
    record["review_order"] = {
        "rule": REVIEW_ORDER_VERSION, "applied": checked,
        "description": ("Checked pool: leads are the issues whose evidence fits, in policy order, at most five. "
                        "Weak matches and conflicts are not promoted to fill slots." if checked
                        else "Narrative check unavailable: the policy's top five are kept in policy order."),
        "entries": entries, "moved_out_risks": out}

    # Rows, program states and summary follow the final order. Candidate numbers continue after
    # the five (checked issues moved out first, then the rest in policy order); policy rank is kept.
    reqs = [q for p in record["program_assessments"] for q in p["requirements"]]
    seq = [r["requirement_row_id"] for r in keep + out]
    seq += [q["row_id"] for q in sorted((q for q in reqs if q["candidate_rank"] and q["row_id"] not in seq),
                                        key=lambda q: q["candidate_rank"])]
    pos = {rid: i for i, rid in enumerate(seq, 1)}
    for q in reqs:
        if q["candidate_rank"]:
            q["policy_rank"], q["candidate_rank"] = q.get("policy_rank", q["candidate_rank"]), pos[q["row_id"]]
    final = {r["requirement_row_id"]: r for r in keep}
    out_ids = {r["requirement_row_id"]: e for r, e in ((r, next(e for e in entries if e["row_id"] == r["requirement_row_id"])) for r in out)}
    lead_of = {r["requirement_row_id"]: r["lead_id"] for r in keep}
    for p in record["program_assessments"]:
        for q in p["requirements"]:
            if q["state"] == "related":
                q["related_to_lead"] = lead_of.get(q["issue_of"])
                continue
            if q["row_id"] in final:
                q["state"], q["rank"] = "lead", final[q["row_id"]]["rank"]
                q["conclusion"] = (f"Lead #{q['rank']}" + (f" (policy #{q['policy_rank']})" if q["rank"] != q["policy_rank"] else "")
                                   + ": " + q["conclusion"].split(": ", 1)[-1])
            else:
                q["state"], q["rank"] = "candidate", None
                if q["row_id"] in out_ids:
                    q["review_note"] = out_ids[q["row_id"]]["reason"]
                q["conclusion"] = (f"Candidate #{q['candidate_rank']}" + (f" (policy #{q['policy_rank']})" if q["candidate_rank"] != q["policy_rank"] else "")
                                   + ": " + q["conclusion"].split(": ", 1)[-1])
        n_leads = sum(1 for q in p["requirements"] if q["state"] == "lead")
        if p["state"] in ("lead", "candidate"):
            p["n_leads"] = n_leads
            if n_leads:
                p["state"] = "lead"
                top = min((q for q in p["requirements"] if q["state"] == "lead"), key=lambda q: q["rank"])
                p["state_reason"] = f"{n_leads} requirement lead(s); top: L{top['rank']} {top['requirement']}"
            else:
                p["state"] = "candidate"
                p["state_reason"] = ("Historical signals, none a lead after the evidence check"
                                     + (" (weak match or conflict)" if any(q.get("review_note", "").startswith("Not a lead") for q in p["requirements"]) else "") + ".")
    states = [p["state"] for p in record["program_assessments"]]
    record["summary"].update(n_lead=states.count("lead"), n_candidate=states.count("candidate"), n_leads=len(keep))
    trace.add("finalize_review_order", "Pick the top five from the checked pool with a fixed rule.",
              {"rule": REVIEW_ORDER_VERSION, "pool": [r["requirement_row_id"] for r in order]},
              (f"{len(keep)} leads; moved out: " + (", ".join(f"{r['requirement_row_id']} ({r['evidence_check']['status']})" for r in out) or "none")
               + "; reordered: " + (", ".join(f"{r['requirement_row_id']} {r['policy_rank']}→{r['rank']}" for r in keep if r["policy_rank"] != r["rank"]) or "none"))
              if checked else "narrative check unavailable; policy order kept",
              stage="rank", inputs=[r["requirement_row_id"] for r in order],
              outputs=[r["requirement_row_id"] for r in keep], rule=REVIEW_ORDER_VERSION)


def limitations(case, mode, org, program_source, prov_src, programs, ev, snapshot) -> list[str]:
    lim = []
    if program_source == "filed_sefa_proxy":
        lim.append(f"Programs come from the filed {case.target_year} SEFA (program identities and "
                   "amounts only), used as a labeled stand-in for a draft SEFA a manager could have "
                   f"at planning. The {case.target_year} audit's findings, major-program "
                   "selections and opinions are hidden.")
    elif program_source == "last_public_programs":
        if prov_src:
            lim.append(f"No current program list: using programs from the {prov_src['audit_year']} "
                       f"report (FAC accepted {prov_src['fac_accepted_date']}) as provisional "
                       "candidates. New or discontinued programs may be missed.")
        else:
            lim.append("No current program list and no earlier public report: no programs could "
                       "be assessed. Supply the draft program list in chat.")
    else:
        lim.append("Program list corrected by the manager in chat.")
    if ev.unavailable_reports:
        yrs = ", ".join(str(r["audit_year"]) for r in sorted(ev.unavailable_reports,
                                                              key=lambda r: r["audit_year"]))
        latest = ev.own_reports[0]["audit_year"] if ev.own_reports else None
        lim.append(f"No report for audit year(s) {yrs} was public in FAC by the cutoff"
                   + (f", so the latest usable own audit is {latest}." if latest else "."))
    if not ev.own_reports:
        lim.append("No earlier public report for this organization: any leads are same-program patterns only.")
    if "ein_ambiguous" in org["identity_flags"] or "ein_only" in org["identity_flags"]:
        lim.append("Organization history is linked partly by EIN; older reports may belong to a "
                   "related entity. Check names and periods in the source reports.")
    if "multiple_reports_in_year" in org["identity_flags"]:
        lim.append("The organization filed more than one report for this audit year; the "
                   "assessment uses the latest fiscal year-end.")
    off = sorted({(f["aln"], f["audit_year"]) for f in ev.other_program_findings})
    if off:
        lim.append("Own findings in programs not on the current list were not assessed: " +
                   ", ".join(f"{a} ({y})" for a, y in off[:6]) + (" …" if len(off) > 6 else "") + ".")
    unid = [p.aln for p in programs if p.aln_status == "unidentified"]
    if unid:
        lim.append(f"{len(unid)} program line(s) have no specific Assistance Listing number and "
                   "could not be assessed.")
    if mode == "live":
        lim.append(f"Live engagement: public reports as of the run date {case.cutoff}, read from a "
                   f"local FAC snapshot dated {snapshot}. Reports accepted after the snapshot are "
                   "missing.")
    lim.append("Same-program counts are other nonprofits' audits where the program was a major "
               "program; requirements were checked only where some history exists, not every "
               "requirement the audit must test.")
    return lim + GENERAL_LIMITS
