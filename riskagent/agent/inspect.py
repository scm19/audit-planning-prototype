"""Model-backed evidence check for the top leads (agent design steps 6-7).

For each provisional lead the model reads a bounded packet: the supporting own finding
narratives and corrective actions, or a few peer narratives for peer-only leads. It checks
whether the reported issue really matches the program and requirement, looks for contrary or
weak evidence, may request a small number of further pre-cutoff lookups, and writes the plain
language reason, verification question and uncertainties.

It cannot change ranks, counts or sources. Its text is validated; anything that fails falls
back to the deterministic template, flagged as such.
"""
from __future__ import annotations

import json
import re

from riskagent.agent import llm
from riskagent.config import INSPECT_EFFORT, REQUIREMENTS
from riskagent.evidence.case import Case, EvidenceDB

MAX_LOOKUPS = 5
OWN_TEXT_CHARS = 2400
CAP_TEXT_CHARS = 900
PEER_TEXT_CHARS = 1200

SYSTEM = """You are the evidence-checking step of a Single Audit planning assistant for an audit manager.

The manager will decide which federal programs and compliance requirements staff examine. You receive up to eight distinct provisional issues (program x compliance requirement), in the order of a fixed, auditable policy, each with evidence that was public before the engagement's data cutoff: the nonprofit's own earlier findings (narrative and corrective action text) and/or counts and examples from other nonprofits' audits of the same program. Your evidence check is used by a fixed rule to choose the final top five: issues whose evidence does not fit (weak_match, conflict) give their slot to better-supported issues. Judge each issue on its own evidence; do not refer to issues by their ids in your text.

For each lead:
1. Read the narratives. Decide whether the reported issue genuinely concerns this program and this compliance requirement (status "supported"), only loosely or partly fits (e.g. it is really about financial-statement close, Form 990 or FAC filing timeliness, a blanket finding tagged with many requirements, or a different program) ("weak_match"), or the evidence points the other way (e.g. text says the condition was resolved and later audits of the program reported nothing) ("conflict"). Explain briefly in evidence_check_notes, citing finding reference numbers and years.
2. Write short_title: 2-6 plain words naming the specific issue to check, specific to this nonprofit where the evidence allows (e.g. "Board patient-majority rule", "SEFA accuracy and filing timeliness", "Sliding fee discounts"). Then plain_language_risk: one short sentence naming the area that merits a check. Do not say a finding exists this year.
3. Write why_this_client: 1-3 sentences specific to this nonprofit, using only facts in the packet (years, reference numbers, the issue described, same-program counts as "k of n other nonprofits' audits of this program"; peer status is unknown, so never call them peers, similar or comparable). Summarize what actually went wrong if the narrative says so.
4. Write verification_question: one concrete request a senior could send the client early, naming the specific records (e.g. timecards, labor distribution reports, adjusting entries, award or subaward documents) and the period, tailored to the narrative where possible. For an issue marked conditional (an older own finding that the latest available audit of the program did not report again), start with the precondition: whether the underlying situation still exists this year (e.g. whether there are current subrecipients), then the record check. Say what corrective action was described, and that the latest audit did not repeat it.
5. List 1-3 uncertainties: what is unknown or could make the lead wrong.
6. Some issues carry related_requirements: other compliance requirements whose only evidence is these same findings (one finding record coded to several requirements). For each, give related_checks: whether the findings genuinely concern that requirement (supported) or only loosely (weak_match), and distinct_check: one sentence on the separate check staff would need for that requirement. Return an empty list when there are none.

Write for the audit manager: do not mention the packet, tools or this review step. Rules: use only the packet and lookup results. Never invent findings, numbers or report IDs. Never describe risk as low, medium or high, and never give a probability or percentage chance. Rank is an ordering for review, not a likelihood. A missing finding does not show an area is clean. You may call read_finding or get_peer_examples for at most a few extra lookups when a narrative is missing, ambiguous or conflicting; say what you looked for in the notes. When done, call submit_lead_reviews exactly once with a review for every lead."""

TOOLS = [
    {"name": "read_finding",
     "description": "Read the full narrative and corrective action of one earlier finding that was public before the cutoff (own or peer).",
     "input_schema": {"type": "object", "properties": {
         "lead_id": {"type": "string", "description": "Lead this lookup is for, e.g. L2"},
         "report_id": {"type": "string"}, "reference_number": {"type": "string"},
         "reason": {"type": "string", "description": "What you are checking"}},
         "required": ["lead_id", "report_id", "reference_number", "reason"]}},
    {"name": "get_peer_examples",
     "description": "Get up to 4 more examples of other nonprofits' pre-cutoff findings in a program and requirement, with narrative excerpts.",
     "input_schema": {"type": "object", "properties": {
         "lead_id": {"type": "string"}, "program_aln": {"type": "string"},
         "requirement_code": {"type": "string"}, "reason": {"type": "string"}},
         "required": ["lead_id", "program_aln", "requirement_code", "reason"]}},
    {"name": "submit_lead_reviews",
     "description": "Submit the final review for every lead.",
     "strict": True,
     "input_schema": {"type": "object", "additionalProperties": False, "properties": {
         "reviews": {"type": "array", "items": {
             "type": "object", "additionalProperties": False,
             "properties": {
                 "lead_id": {"type": "string"},
                 "evidence_check_status": {"type": "string",
                                           "enum": ["supported", "weak_match", "conflict"]},
                 "evidence_check_notes": {"type": "string"},
                 "narratives_read": {"type": "array", "items": {"type": "string"},
                                     "description": "IDs read, formatted <report_id>#<reference_number>"},
                 "short_title": {"type": "string", "description": "2-6 words"},
                 "plain_language_risk": {"type": "string"},
                 "why_this_client": {"type": "string"},
                 "verification_question": {"type": "string"},
                 "uncertainties": {"type": "array", "items": {"type": "string"}},
                 "related_checks": {"type": "array", "items": {
                     "type": "object", "additionalProperties": False, "properties": {
                         "requirement_code": {"type": "string"},
                         "status": {"type": "string", "enum": ["supported", "weak_match"]},
                         "distinct_check": {"type": "string"}},
                     "required": ["requirement_code", "status", "distinct_check"]}}},
             "required": ["lead_id", "evidence_check_status", "evidence_check_notes",
                          "narratives_read", "short_title", "plain_language_risk", "why_this_client",
                          "verification_question", "uncertainties", "related_checks"]}}},
         "required": ["reviews"]}},
]

FORBIDDEN = [re.compile(p, re.I) for p in [
    r"\b(low|medium|moderate|high)[- ]risk\b", r"\bprobabilit", r"\b\d+(\.\d+)?\s*%\s*(chance|likel)",
    r"\bwill (have|receive|get|report) (a |an )?finding", r"\bhas a finding this year\b"]]
REPORT_ID = re.compile(r"\b\d{4}-\d{2}-(?:GSAFAC|CENSUS)-\d{10}\b")


def _clip(s: str | None, n: int) -> str | None:
    if not s:
        return None
    s = " ".join(s.split())
    return s if len(s) <= n else s[:n] + " …[truncated]"


def build_packet(db: EvidenceDB, case: Case, record: dict) -> tuple[dict, set[str], set[str]]:
    """Bounded evidence packet per lead. Returns packet, narrative ids, allowed report ids."""
    rows = {r["row_id"]: r for p in record["program_assessments"] for r in p["requirements"]}
    leads, ids, allowed = [], set(), set()
    for risk in record["risks"]:
        row = rows[risk["requirement_row_id"]]
        item = {"lead_id": risk["lead_id"], "rank": risk["rank"],
                "program": f"{risk['program_id']} {risk['program_name']}",
                "requirement": f"{risk['requirement_code']} {risk['requirement_name']}",
                "ranking_group": risk["group_label"],
                "peer_counts": {k: row["peer"][k] for k in ("n", "k", "k_excluding_blanket")},
                "limits": row["limits"], "own_findings": [], "peer_examples": [],
                "conditional": risk.get("conditional"),
                "linked_audit_wide_findings": [
                    f"{f['report_id']}#{f['reference_number']} ({f['audit_year']}): late filing of the overall audit "
                    "package with the FAC; linked to this program's awards but not evidence about its own reports"
                    for f in row.get("audit_wide", [])],
                "related_requirements": [f"{x['requirement_code']} {x['requirement_name']}" for x in risk.get("related", [])]}
        if row["own"]:
            item["own_audit_years_with_finding"] = row["own"]["years"]
            item["latest_own_audit_of_program"] = row["own"]["latest_program_audit_year"]
            for f in row["own"]["findings"][:3]:
                d = db.finding_detail(case, f["report_id"], f["reference_number"])
                if d is None:
                    continue
                nid = f"{f['report_id']}#{f['reference_number']}"
                ids.add(nid)
                allowed.add(f["report_id"])
                item["own_findings"].append({
                    "id": nid, "audit_year": f["audit_year"],
                    "fac_accepted_date": f["fac_accepted_date"],
                    "requirement_letters_on_finding": d["requirement_letters"],
                    "programs_on_finding": d["programs"],
                    "flags": {k: d["flags"][k] for k in ("material_weakness", "significant_deficiency",
                                                          "questioned_costs", "repeat_finding",
                                                          "blanket")},
                    "narrative": _clip(d["narrative"], OWN_TEXT_CHARS) or "(no narrative on file)",
                    "corrective_action": _clip(d["corrective_action"], CAP_TEXT_CHARS)})
            item["more_own_findings_not_shown"] = [
                f"{f['report_id']}#{f['reference_number']}" for f in row["own"]["findings"][3:8]]
        if not row["own"] or len(item["own_findings"]) < 2:
            for s in [x for x in risk["sources"] if x["kind"] == "peer"][:2]:
                d = db.finding_detail(case, s["report_id"], s["reference_number"])
                if d is None:
                    continue
                nid = f"{s['report_id']}#{s['reference_number']}"
                ids.add(nid)
                allowed.add(s["report_id"])
                item["peer_examples"].append({
                    "id": nid, "nonprofit": d["auditee_name"], "audit_year": d["audit_year"],
                    "requirement_letters_on_finding": d["requirement_letters"],
                    "narrative": _clip(d["narrative"], PEER_TEXT_CHARS) or "(no narrative on file)"})
        leads.append(item)
    packet = {"engagement": {"nonprofit": record["target_org"]["name"],
                             "audit_year": record["target_year"],
                             "data_cutoff": record["data_cutoff"]["rule"],
                             "program_source": record["program_source"],
                             "programs": [f"{p['aln']} {p['name']} ({p['amount']:,.0f})"
                                          if p["amount"] is not None else p["aln"]
                                          for p in record["input_programs"][:15]]},
              "leads": leads}
    for s in (x for r in record["risks"] for x in r["sources"]):
        allowed.add(s["report_id"])
    return packet, ids, allowed


def _lookup(db, case, name, args, ids, allowed) -> str:
    if name == "read_finding":
        d = db.finding_detail(case, args.get("report_id", ""), args.get("reference_number", ""))
        if d is None:
            return json.dumps({"error": "Not available: unknown finding or not public before the cutoff."})
        nid = f"{d['report_id']}#{d['reference_number']}"
        ids.add(nid)
        allowed.add(d["report_id"])
        return json.dumps({"id": nid, "nonprofit": d["auditee_name"], "audit_year": d["audit_year"],
                           "fac_accepted_date": d["fac_accepted_date"],
                           "requirement_letters": d["requirement_letters"], "programs": d["programs"],
                           "narrative": _clip(d["narrative"], OWN_TEXT_CHARS),
                           "corrective_action": _clip(d["corrective_action"], CAP_TEXT_CHARS)})
    if name == "get_peer_examples":
        sample = db.peer_sample(case, args.get("program_aln", ""), args.get("requirement_code", ""), 4)
        out = []
        for s in sample:
            d = db.finding_detail(case, s["report_id"], s["reference_numbers"][0])
            if d is None:
                continue
            nid = f"{s['report_id']}#{s['reference_numbers'][0]}"
            ids.add(nid)
            allowed.add(s["report_id"])
            out.append({"id": nid, "nonprofit": s["auditee_name"], "audit_year": s["audit_year"],
                        "narrative": _clip(d["narrative"], 700)})
        return json.dumps({"examples": out})
    return json.dumps({"error": f"unknown tool {name}"})


def validate(review: dict, ids: set[str], allowed: set[str]) -> list[str]:
    issues = []
    text = " ".join([review.get("short_title", ""), review["plain_language_risk"], review["why_this_client"],
                     review["verification_question"], review["evidence_check_notes"],
                     *review["uncertainties"], *[x["distinct_check"] for x in review.get("related_checks", [])]])
    for pat in FORBIDDEN:
        if pat.search(text):
            issues.append(f"forbidden wording: {pat.pattern}")
    for rid in REPORT_ID.findall(text):
        if rid not in allowed:
            issues.append(f"cites report {rid} not in the evidence")
    bad = [n for n in review["narratives_read"] if n not in ids]
    if bad:
        issues.append(f"claims to have read {bad} which were not provided")
    return issues


REUSED_FIELDS = ("short_title", "plain_language_risk", "why_this_client", "verification_question",
                 "uncertainties", "evidence_check", "explanation_source", "related")


def _evidence_key(risk: dict) -> tuple:
    return (risk["requirement_row_id"], risk["group"],
            tuple((s["kind"], s["report_id"], s["reference_number"]) for s in risk["sources"]),
            risk["peer"]["n"], risk["peer"]["k"])


def inspect_leads(db: EvidenceDB, case: Case, record: dict, trace, previous: dict | None = None) -> None:
    """Mutates record['risks'] in place with model wording and evidence checks.

    With `previous` (the prior version), a lead whose row, sources and counts are unchanged keeps
    its earlier model review instead of being re-inspected.
    """
    if not record["risks"]:
        return
    if previous:
        checked = previous.get("risks", []) + (previous.get("review_order") or {}).get("moved_out_risks", [])
        prior = {_evidence_key(r): r for r in checked if r.get("explanation_source") == "model"}
        reused = []
        for risk in record["risks"]:
            old = prior.get(_evidence_key(risk))
            if old:
                risk.update({k: old[k] for k in REUSED_FIELDS if k in old})
                risk["reused_from_version"] = previous["version"]
                reused.append(risk["lead_id"])
        if reused:
            trace.add("inspect_candidate", "Reuse unchanged evidence checks from the prior version.",
                      {"from_version": previous["version"]}, f"reused {reused}")
        todo = [r for r in record["risks"] if "reused_from_version" not in r]
        if not todo:
            return
        full = record["risks"]
        record["risks"] = todo
        try:
            inspect_leads(db, case, record, trace)
        finally:
            record["risks"] = full
        return
    if not llm.model_available():
        trace.add("inspect_candidate", "Model unavailable; template wording kept.", {}, "skipped")
        return
    packet, ids, allowed = build_packet(db, case, record)
    trace.add("inspect_candidate", "Read bounded narratives for each top lead.",
              {"leads": [r["lead_id"] for r in record["risks"]]},
              f"{len(ids)} narrative(s) in packet")
    messages = [{"role": "user", "content":
                 "Review these provisional leads. Evidence packet (JSON):\n" + json.dumps(packet)}]
    lookups = 0
    reviews = None
    try:
        for _ in range(6):
            resp = llm.create(system=SYSTEM, messages=messages, tools=TOOLS, effort=INSPECT_EFFORT)
            if resp.stop_reason == "refusal":
                raise llm.ModelUnavailable("model declined the request")
            messages.append({"role": "assistant", "content": llm.blocks_to_params(resp.content)})
            uses = [b for b in resp.content if b.type == "tool_use"]
            if not uses:
                messages.append({"role": "user", "content":
                                 "Please call submit_lead_reviews with a review for every lead."})
                continue
            results = []
            for u in uses:
                if u.name == "submit_lead_reviews":
                    reviews = u.input.get("reviews", [])
                    results.append({"type": "tool_result", "tool_use_id": u.id, "content": "received"})
                elif lookups >= MAX_LOOKUPS:
                    results.append({"type": "tool_result", "tool_use_id": u.id, "is_error": True,
                                    "content": "Lookup budget used. Submit your reviews now."})
                else:
                    lookups += 1
                    out = _lookup(db, case, u.name, u.input, ids, allowed)
                    trace.add(f"inspect_candidate.{u.name}", u.input.get("reason", ""),
                              {k: v for k, v in u.input.items() if k != "reason"},
                              out[:160])
                    results.append({"type": "tool_result", "tool_use_id": u.id, "content": out})
            if reviews is not None:
                break
            messages.append({"role": "user", "content": results})
    except llm.ModelUnavailable as e:
        trace.add("explain_and_check", "Model step failed; template wording kept.", {}, str(e))
        return

    by_id = {r["lead_id"]: r for r in (reviews or [])}
    checked, rejected = 0, []
    for risk in record["risks"]:
        rv = by_id.get(risk["lead_id"])
        if not rv:
            rejected.append(f"{risk['lead_id']}: no review returned")
            continue
        issues = validate(rv, ids, allowed)
        if issues:
            rejected.append(f"{risk['lead_id']}: " + "; ".join(issues))
            risk["evidence_check"] = {"status": "not_checked",
                                      "notes": "Model text rejected by validation: " + "; ".join(issues),
                                      "narratives_read": []}
            continue
        title = " ".join((rv.get("short_title") or "").split()[:8]).strip().rstrip(".")
        risk.update({"short_title": title or risk.get("short_title") or risk["requirement_name"],
                     "plain_language_risk": rv["plain_language_risk"].strip(),
                     "why_this_client": rv["why_this_client"].strip(),
                     "verification_question": rv["verification_question"].strip(),
                     "uncertainties": [u.strip() for u in rv["uncertainties"] if u.strip()][:4]
                     or risk["uncertainties"],
                     "evidence_check": {"status": rv["evidence_check_status"],
                                        "notes": rv["evidence_check_notes"].strip(),
                                        "narratives_read": rv["narratives_read"]},
                     "explanation_source": "model"})
        rc = {x["requirement_code"]: x for x in rv.get("related_checks", [])}
        for x in risk.get("related", []):
            if x["requirement_code"] in rc:
                x.update(status=rc[x["requirement_code"]]["status"],
                         distinct_check=rc[x["requirement_code"]]["distinct_check"].strip())
        checked += 1
    trace.add("explain_and_check", "Validate model wording against the evidence records.",
              {"lookups_used": lookups},
              f"{checked} lead(s) explained by the model; rejected: {rejected or 'none'}")
    record["inspection"] = {"lookups_used": lookups, "rejected": rejected,
                            "requirements_reference": {k: REQUIREMENTS[k] for k in sorted(
                                {r['requirement_code'] for r in record['risks']})}}
