"""Planning brief: agent-written claims over the frozen evidence record, checked before display.

Steps 4-6 of the V2 design:
  4. write      - the model reads a bounded view of the SAME assessment record (shortlisted rows,
                  their own findings with narrative/corrective-action excerpts, same-program counts,
                  gap facts) and returns one-sentence Claims that cite record ids.
  5. fact_check - code checks every claim: rows exist, cited findings belong to those rows and
                  predate the cutoff, numbers/years/finding numbers in the sentence match the
                  cited evidence, no banned wording (incl. "peers" while peer status is unknown).
  6. quality    - a bounded LLM judge flags weak finding-to-requirement fit, unsupported
                  conclusions, unhelpful requests, missing uncertainty.
At most ONE repair call covers both hard failures and judge flags; anything still failing is
replaced by a marked, source-based fallback sentence. The model never changes rows, ranks or counts.
"""
from __future__ import annotations

import hashlib
import json
import re

from riskagent.agent import llm
from riskagent.agent.assessment import VERIFY_QUESTIONS, now
from riskagent.config import REQUIREMENTS
from riskagent.evidence.case import Case, EvidenceDB
from riskagent.evidence.scope import PROGRAM_REPORTS

WRITER_VERSION = "brief-writer-5"  # 5: short program plan sentences that do not repeat the card
JUDGE_VERSION = "brief-judge-1"
CHECK_VERSION = "claim-check-1"
MAX_FINDINGS_PER_ROW = 3
SECTIONS = ("focus", "requests", "gaps", "changes")
KINDS = ("program_focus", "history_fact", "aggregate_fact", "client_question", "gap", "change")
PEER_STATUS = {"status": "unknown",
               "reason": "The data has no source-backed organization profiles, so no verified peer set exists. "
                         "Same-program counts are a broad comparison pool, not peers."}

# ---------------------------------------------------------------------------- evidence view
def _condition(text: str | None, n: int = 600) -> str | None:
    """The 'Condition' (what went wrong) from a finding narrative, else its opening."""
    if not text:
        return None
    t = " ".join(text.split())
    m = re.search(r"Condition[^:]{0,20}:\s*(.+?)(?=\s(?:Cause|Effect|Context|Questioned costs|Recommendation|Criteria)[^:]{0,20}:|$)", t, re.I)
    body = (m.group(1) if m else t)
    return body if len(body) <= n else body[:n].rsplit(" ", 1)[0] + " …"


def finding_id(report_id: str, ref: str) -> str:
    return f"{report_id}#{ref}"


def benchmark_id(row_id: str) -> str:
    return "B" + row_id[1:]  # R:93.224:L -> B:93.224:L


def build_view(db: EvidenceDB, case: Case, record: dict) -> tuple[dict, dict]:
    """Bounded writer view of the record + an index of every id the writer may cite."""
    rows = {r["row_id"]: (p, r) for p in record["program_assessments"] for r in p["requirements"]}
    progs = {p["row_id"]: p for p in record["program_assessments"]}
    org = record["target_org"]["name"]
    allowed = {"rows": set(rows) | set(progs), "findings": {}, "benchmarks": {}, "gaps": {}, "programs": {}}
    leads = []
    for risk in record["risks"]:
        p, r = rows[risk["requirement_row_id"]]
        own = []
        for f in (r["own"]["findings"] if r["own"] else [])[:MAX_FINDINGS_PER_ROW]:
            d = db.finding_detail(case, f["report_id"], f["reference_number"])
            if d is None:  # not admissible at this cutoff: never offered to the writer
                continue
            fid = finding_id(f["report_id"], f["reference_number"])
            backs = [r["row_id"]] + [x["row_id"] for x in risk.get("related", [])]
            item = {"finding_id": fid, "audit_year": f["audit_year"], "public_acceptance_date": f["fac_accepted_date"],
                    "requirement_codes": d["requirement_letters"], "program_ids": d["programs"],
                    "flags": [k for k in ("material_weakness", "significant_deficiency", "questioned_costs", "repeat_finding", "blanket") if d["flags"].get(k)],
                    "text_status": "present" if d["narrative"] else "missing",
                    "condition": _condition(d["narrative"]), "corrective_action": _condition(d["corrective_action"], 300)}
            own.append(item)
            # One finding can back rows in several programs: it supports every one of them.
            prior = allowed["findings"].get(fid, {}).get("row_ids", [])
            allowed["findings"][fid] = {**item, "row_id": (prior or [r["row_id"]])[0],
                                        "row_ids": prior + [x for x in backs if x not in prior], "org": org, "scope": "program"}
        pv = r["peer"]
        bid = benchmark_id(r["row_id"])
        bench = {"benchmark_id": bid, "program_id": p["aln"], "requirement_code": r["letter"],
                 "finding_report_count": pv["k"], "eligible_report_count": pv["n"],
                 "finding_report_count_excluding_blanket": pv.get("k_excluding_blanket"),
                 "cohort_rule": p["peer"]["rule"], "audit_years": [p["peer"]["first_year"], p["peer"]["last_year"]]}
        allowed["benchmarks"][bid] = {**bench, "row_id": r["row_id"]}
        leads.append({"lead_id": risk["lead_id"], "review_rank": risk["rank"], "row_id": r["row_id"],
                      "program": f"{p['aln']} {p['program_name']}", "program_amount": p["amount"],
                      "requirement": f"{r['letter']} {REQUIREMENTS.get(r['letter'], r['letter'])}",
                      "basis": r["group"], "own_findings": own, "same_program_benchmark": bench,
                      "narrative_fit": (risk.get("evidence_check") or {}).get("status"),
                      "fit_note": ((risk.get("evidence_check") or {}).get("notes") or "")[:400],
                      "limits": r["limits"],
                      "conditional": risk.get("conditional"),
                      "related_requirements": [{"row_id": x["row_id"], "requirement": f"{x['requirement_code']} {x['requirement_name']}",
                                                "fit": x["status"], "distinct_check": x["distinct_check"]} for x in risk.get("related", [])],
                      "order_note": risk.get("order_note"),
                      "suggested_request": risk.get("verification_question")})
    for p in record["program_assessments"]:
        allowed["programs"][p["row_id"]] = p
    # Audit-wide filing findings: one engagement-level fact, never evidence about a program's reports.
    audit_wide = []
    for f in record.get("audit_wide_findings", []):
        d = db.finding_detail(case, f["report_id"], f["reference_number"])
        if d is None:
            continue
        item = {"finding_id": f["finding_id"], "audit_year": f["audit_year"], "public_acceptance_date": f["fac_accepted_date"],
                "requirement_codes": d["requirement_letters"], "program_ids": f["programs"], "flags": [],
                "text_status": "present" if d["narrative"] else "missing",
                "condition": _condition(d["narrative"]), "corrective_action": _condition(d["corrective_action"], 300)}
        allowed["findings"][f["finding_id"]] = {**item, "row_id": f["row_ids"][0], "row_ids": f["row_ids"], "org": org,
                                               "scope": "audit_filing"}
        audit_wide.append({**item, "linked_rows": f["row_ids"], "scope": f["scope_reason"]})
    gaps = []
    def gap(gid, text, **extra):
        allowed["gaps"][gid] = {"text": text, **extra}
        gaps.append({"gap_id": gid, "fact": text})
    src = record["program_source"]
    gap("GAP:program_list", {"filed_sefa_proxy": f"The program list is the filed {record['target_year']} award schedule, used as a labeled stand-in for a draft.",
                             "last_public_programs": "No current program list: programs come from the latest public report and are provisional.",
                             "manager_supplied": "The program list was corrected by the manager."}.get(src, src),
        years=[record["target_year"]] + ([record["provisional_source_report"]["audit_year"]] if record.get("provisional_source_report") else []))
    unav = [u["audit_year"] for u in record["own_history"]["unavailable_reports"]]
    if unav:
        gap("GAP:unavailable_reports", f"No report for audit year(s) {', '.join(map(str, sorted(unav)))} was public by the cutoff.", years=unav)
    latest = record["own_history"]["reports"][0]["audit_year"] if record["own_history"]["reports"] else None
    gap("GAP:latest_audit", f"The latest usable own audit is {latest}." if latest else "There is no earlier public audit of this nonprofit.",
        years=[latest] if latest else [])
    gap("GAP:peers_unknown", PEER_STATUS["reason"])
    for p in record["program_assessments"]:
        if not p["requirements"]:
            gap(f"GAP:{p['row_id']}", f"{p['aln']} is not ranked: {p['state_reason']}", row_id=p["row_id"], amount=p["amount"])
    for fid, f in allowed["findings"].items():
        if f["text_status"] == "missing":
            gap(f"GAP:no_text:{fid}", f"Finding {fid.split('#')[1]} ({f['audit_year']}) has no narrative text on file.", years=[f["audit_year"]], finding_id=fid)
    view = {"engagement": {"nonprofit": org, "audit_year": record["target_year"], "mode": record["mode"],
                           "cutoff_rule": record["data_cutoff"]["rule"], "program_list_source": src,
                           "latest_usable_own_audit": latest},
            "peer_status": PEER_STATUS,
            "programs": [{"row_id": p["row_id"], "program": f"{p['aln']} {p['program_name']}", "amount": p["amount"],
                          "state": p["state"], "n_leads": p["n_leads"]} for p in record["program_assessments"]],
            "shortlisted_rows": leads, "audit_wide_findings": audit_wide, "gap_facts": gaps}
    return view, allowed


# ---------------------------------------------------------------------------- writer
WRITER_SYSTEM = """You write the planning brief for an audit manager planning a federal Single Audit of one nonprofit. Code has already established the facts and ordered up to five review areas; you explain them from the evidence record you are given. You cannot change rows, ranks or counts.

Write one-sentence Claims. Each claim has:
- section: focus (where to look and why), requests (what to ask the client for early), gaps (where history cannot help), changes (what could change the call)
- kind: program_focus (the plan: one per shortlisted program, section focus, display_in brief; says what to examine closely in that program and why, naming the compliance area(s) and the kind of support, e.g. own findings in which years or only other nonprofits' audits; row_ids from that program only; cite its key finding_ids / benchmark_ids), history_fact (this nonprofit's own dated findings; must cite finding_ids), aggregate_fact (same-program counts; must cite a benchmark_id), client_question (a conditional current-year question or record request; cite no evidence, set derived_from_claim_ids to the fact(s) that motivate it), gap (cite gap_ids), change (what new information would change the call; may cite nothing)
- row_ids: the evidence rows the sentence is about
- evidence_refs: the exact finding_id / benchmark_id / gap_id values that support THIS sentence. Cite only findings whose narrative actually supports the sentence; if two findings share a code but describe different problems, do not combine them into one claim.
- display_in: brief, row_note (shown on that row in the evidence table), or both.
- A shortlisted row may carry related_requirements: other requirements resting only on the same findings. In that program's program_focus, name the row's requirement as the primary area and mention each related requirement as a related area that needs a distinct check (say "weakly supported" when its fit is weak_match or not_checked). Never present a related requirement as a separate issue.
- A row marked conditional is an older own finding that the latest available audit of the program did not report again. Word its claims conditionally (it may have been fixed) and lead its request with the precondition (e.g. whether there are current subrecipients).
- Requests: for every shortlisted row write one client_question (display_in both) phrased as a request a senior could send the client early: "Request ..." naming the specific records and the period. Start from the row's suggested_request and keep its specifics. Link it to that row's fact or program_focus claim.
- audit_wide_findings are findings about the organization's overall audit filing (e.g. the audit package submitted late to the Federal Audit Clearinghouse), linked to several programs' awards. They are NOT evidence that any program's own reports were late or wrong. If present: write one history_fact (section focus, display_in brief, row_ids = its linked_rows, citing it) saying what it was and that it is audit-wide, and one client_question (display_in brief) requesting the audit and FAC filing timeline. Never request program reports because of such a finding; request a program's reports only from that program's own evidence or same-program pattern, and only for a shortlisted row.
- The plan is at the program level; the evidence review is at the finding level. The manager is choosing which programs to examine closely and which compliance areas to emphasize. So: exactly one program_focus claim per shortlisted program (display_in brief). Keep it under 30 words. The app already shows the program name, amount, each area, its basis years and any conditional or related tag next to it, so do not repeat those; say why this program matters and what to look at first. Finding-level history_fact / aggregate_fact claims are the evidence review: give each shortlisted row 1-2 of them with display_in row_note. Use display_in both for a fact only when one finding applies across several programs (e.g. an organization-wide finding coded to all of them): say it once, citing all those rows. Client questions: one per program or area that needs it, display_in both.

Rules:
- Facts must be checkable against the cited evidence. Every year, count, amount and finding number in a sentence must appear in the evidence you cite.
- Same-program counts come from a broad pool of other nonprofits' audits of the same program. Peer status is unknown, so never use the word "peer" or call those organizations similar or comparable; say "other nonprofits' audits of this program" or "the same-program pool".
- Never say or imply a current-year problem, never use Low/Medium/High risk labels, probabilities or percent chances, and never treat missing history as evidence of safety.
- Questions are conditional and about current-year records ("Ask whether...", "Request..."). They must not assert this year's records are wrong.
- Say plainly when support is thin (no narrative, blanket finding, weak fit, old data).
- Plain language for a busy manager. 8-16 claims in total. claim_id values C1, C2, ... in order.
Call submit_brief exactly once."""

CLAIM_SCHEMA = {"type": "object", "additionalProperties": False, "properties": {
    "claim_id": {"type": "string"}, "section": {"type": "string", "enum": list(SECTIONS)},
    "kind": {"type": "string", "enum": list(KINDS)}, "sentence": {"type": "string"},
    "row_ids": {"type": "array", "items": {"type": "string"}},
    "evidence_refs": {"type": "array", "items": {"type": "string"}},
    "derived_from_claim_ids": {"type": "array", "items": {"type": "string"}},
    "display_in": {"type": "string", "enum": ["brief", "row_note", "both"]}},
    "required": ["claim_id", "section", "kind", "sentence", "row_ids", "evidence_refs", "derived_from_claim_ids", "display_in"]}
WRITER_TOOL = {"name": "submit_brief", "description": "Submit the planning brief as claims.", "strict": True,
               "input_schema": {"type": "object", "additionalProperties": False,
                                "properties": {"claims": {"type": "array", "items": CLAIM_SCHEMA}}, "required": ["claims"]}}


def _call_tool(system: str, content: str, tool: dict, effort: str) -> dict | None:
    msgs = [{"role": "user", "content": content}]
    for _ in range(2):
        resp = llm.create(system=system, messages=msgs, tools=[tool], effort=effort)
        if resp.stop_reason == "refusal":
            raise llm.ModelUnavailable("the model declined the request")
        use = next((b for b in resp.content if b.type == "tool_use" and b.name == tool["name"]), None)
        if use:
            return use.input
        msgs += [{"role": "assistant", "content": llm.blocks_to_params(resp.content)},
                 {"role": "user", "content": f"Please call {tool['name']} now."}]
    return None


# ---------------------------------------------------------------------------- hard checks
BANNED = [(re.compile(p, re.I), why) for p, why in [
    (r"\b(low|medium|moderate|high)[- ]risk\b", "risk label"), (r"\bprobabilit", "probability"),
    (r"\d+(\.\d+)?\s*%\s*(chance|likel)", "percent chance"), (r"\bwill (have|receive|get|report) (a |an )?finding", "predicts a finding"),
    (r"\bpeers?\b|\bsimilar (organizations|nonprofits)\b", "calls the broad pool peers"),
    (r"\b(is|are) (clean|fine|safe)\b|\bno (issues|problems) (exist|this year)\b", "treats missing history as safety"),
    (r"\bthis year['’]s [^.?]{0,60}\b(is|are|was|were) (wrong|incorrect|misstated|late|missing)\b", "asserts a current-year problem")]]
YEAR = re.compile(r"\b(19|20)\d{2}\b")
REF = re.compile(r"\b(?:19|20)\d{2}-\d{3}\b")
NUM = re.compile(r"\$?\b\d[\d,]*(?:\.\d+)?\b(?:\s?(?:million|thousand|[MK])\b)?")


ALN = re.compile(r"\b\d{2}\.(?:\d{3}|[A-Z]{2,3})\b")


def _evidence_facts(refs: list, allowed: dict, record: dict, kind: str) -> tuple[set, set, set, str]:
    """Years, numbers, finding numbers and excerpt text that the cited evidence makes available."""
    years, nums, refnums, text = {record["target_year"], int(record["prediction_date"][:4])}, set(), set(), []
    for ref in refs:
        if ref in allowed["findings"]:
            f = allowed["findings"][ref]
            years |= {f["audit_year"], int(f["public_acceptance_date"][:4])}
            refnums.add(ref.split("#")[1])
            text += [f["condition"] or "", f["corrective_action"] or ""]
        elif ref in allowed["benchmarks"]:
            b = allowed["benchmarks"][ref]
            nums |= {b["finding_report_count"], b["eligible_report_count"]}
            if b.get("finding_report_count_excluding_blanket") is not None:
                k, kx = b["finding_report_count"], b["finding_report_count_excluding_blanket"]
                nums |= {kx, k - kx}
            years |= {y for y in b["audit_years"] if y}
            amt = allowed["programs"].get("P:" + b["program_id"], {}).get("amount")
            if amt:
                nums.add(round(amt))
        elif ref in allowed["gaps"]:
            g = allowed["gaps"][ref]
            years |= set(g.get("years") or [])
            if g.get("finding_id"):
                refnums.add(g["finding_id"].split("#")[1])
            if g.get("amount"):
                nums.add(round(g["amount"]))
            text.append(g["text"])
        elif ref in allowed["programs"] and allowed["programs"][ref].get("amount"):
            nums.add(round(allowed["programs"][ref]["amount"]))
    if kind == "change":  # forward-looking: may name any year the record's gap facts name
        for g in allowed["gaps"].values():
            years |= set(g.get("years") or [])
    joined = " ".join(text)
    years |= {int(y) for y in re.findall(r"\b(?:19|20)\d{2}\b", joined)}
    return years, nums, refnums, joined


def _numbers_ok(sentence: str, refs: list, allowed: dict, record: dict, kind: str) -> list[str]:
    years, nums, refnums, excerpt = _evidence_facts(refs, allowed, record, kind)
    in_excerpt = {re.sub(r"[^\d.]", "", m) for m in re.findall(r"\d[\d,]*(?:\.\d+)?", excerpt)}
    problems = []
    text = ALN.sub("", sentence)
    for m in REF.finditer(text):
        if m.group(0) not in refnums:
            problems.append(f"finding number {m.group(0)} is not among the cited findings")
    text = REF.sub("", text)
    for m in YEAR.finditer(text):
        if int(m.group(0)) not in years:
            problems.append(f"year {m.group(0)} is not in the cited evidence")
    for m in NUM.finditer(YEAR.sub("", text)):
        raw = m.group(0)
        digits = re.sub(r"[^\d.]", "", raw).strip(".")
        v = float(digits or 0)
        if re.search(r"million|M\b", raw):
            v *= 1e6
        elif re.search(r"thousand|K\b", raw):
            v *= 1e3
        if v <= 10 and "$" not in raw:  # small counts ("two findings", "one of five areas") are not audited facts
            continue
        if digits in in_excerpt:
            continue
        if not any(abs(v - n) <= max(1, 0.05 * n) for n in nums):
            problems.append(f"number {raw} does not match the cited evidence")
    return problems


ABBREV = re.compile(r"(?:\b[A-Z]|\b(?:Inc|Co|Corp|No|St|Dr|Mr|Ms|Jr|vs|etc|U\.S|e\.g|i\.e|approx|Dept))\.$")


def _sentence_count(s: str) -> int:
    parts = re.split(r"(?<=[.?!])\s+(?=[A-Z(])", s.strip())
    n = 1
    for prev in parts[:-1]:
        if not ABBREV.search(prev):
            n += 1
    return n


def _audit_wide_only(claim: dict, allowed: dict) -> bool:
    """True when every finding the claim cites is an audit-wide filing finding (and it cites one)."""
    fs = [allowed["findings"][r] for r in claim["evidence_refs"] if r in allowed["findings"]]
    return bool(fs) and all(f.get("scope") == "audit_filing" for f in fs)


def hard_check(claim: dict, claims_by_id: dict, allowed: dict, record: dict) -> list[str]:
    reasons = []
    s = claim["sentence"].strip()
    if not s:
        return ["empty sentence"]
    if _sentence_count(s) > 1:
        reasons.append("more than one sentence")
    bad_rows = [r for r in claim["row_ids"] if r not in allowed["rows"]]
    if bad_rows:
        reasons.append(f"unknown rows {bad_rows}")
    for ref in claim["evidence_refs"]:
        if ref in allowed["findings"]:
            backs = allowed["findings"][ref].get("row_ids") or [allowed["findings"][ref]["row_id"]]
            if not set(backs) & set(claim["row_ids"]):
                reasons.append(f"{ref} belongs to {', '.join(backs)}, which the claim does not cite")
        elif ref in allowed["benchmarks"]:
            if allowed["benchmarks"][ref]["row_id"] not in claim["row_ids"]:
                reasons.append(f"{ref} is for a row the claim does not cite")
        elif ref not in allowed["gaps"] and ref not in allowed["programs"]:
            reasons.append(f"{ref} is not an allowed source for this assessment")
    k = claim["kind"]
    if k == "program_focus":
        progs = {r.split(":")[1] for r in claim["row_ids"] if r.count(":") >= 1}
        if len(progs) != 1:
            reasons.append("program focus must be about exactly one program")
        if not any(r in allowed["findings"] or r in allowed["benchmarks"] for r in claim["evidence_refs"]):
            reasons.append("program focus cites no finding or same-program count")
    if k == "history_fact" and not any(r in allowed["findings"] for r in claim["evidence_refs"]):
        reasons.append("history fact cites no finding")
    if k == "aggregate_fact" and not any(r in allowed["benchmarks"] for r in claim["evidence_refs"]):
        reasons.append("aggregate fact cites no same-program count")
    if k == "gap" and not claim["evidence_refs"]:
        reasons.append("gap cites no gap fact")
    if k == "client_question":
        missing = [d for d in claim["derived_from_claim_ids"] if d not in claims_by_id]
        if not claim["derived_from_claim_ids"] or missing:
            reasons.append("question is not linked to a fact claim")
        elif all(_audit_wide_only(claims_by_id[d], allowed) for d in claim["derived_from_claim_ids"]) \
                and PROGRAM_REPORTS.search(s):
            reasons.append("requests program reports on the basis of an audit-wide filing finding")
    if k in ("history_fact", "program_focus") and _audit_wide_only(claim, allowed) and PROGRAM_REPORTS.search(s) \
            and not re.search(r"\bnot (evidence|about)\b", s, re.I):
        reasons.append("treats an audit-wide filing finding as evidence about program reports")
    for pat, why in BANNED:
        if pat.search(s):
            reasons.append(f"banned wording: {why}")
    if record.get("target_report_id_hint") and record["target_report_id_hint"] in s:
        reasons.append("mentions the target report")
    if k != "client_question":
        reasons += _numbers_ok(s, claim["evidence_refs"], allowed, record, k)
    return reasons


# ---------------------------------------------------------------------------- judge
JUDGE_SYSTEM = """You review claims in an audit planning brief. Each claim has passed mechanical fact checks; you judge interpretation only, using the cited source excerpts. Flag a claim when:
- weak_match: the cited finding does not really concern the program and compliance requirement it is used for, or two findings describing different problems are combined
- unsupported_conclusion: the sentence goes beyond what the cited evidence says
- unhelpful_request: a client question is vague, not tied to its motivating fact, or asserts a current-year problem
- missing_uncertainty: the claim hides that support is thin (no narrative, blanket finding, old data, broad comparison pool)
Pass claims that are fine. Be specific in reasons. You cannot change facts. Call submit_review exactly once with a verdict for every claim."""
JUDGE_TOOL = {"name": "submit_review", "description": "Verdict per claim.", "strict": True, "input_schema": {
    "type": "object", "additionalProperties": False, "properties": {"verdicts": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "properties": {
            "claim_id": {"type": "string"}, "verdict": {"type": "string", "enum": ["pass", "flag"]},
            "problems": {"type": "array", "items": {"type": "string", "enum": ["weak_match", "unsupported_conclusion", "unhelpful_request", "missing_uncertainty"]}},
            "reason": {"type": "string"}}, "required": ["claim_id", "verdict", "problems", "reason"]}}}, "required": ["verdicts"]}}


def _judge_packet(claims: list[dict], allowed: dict, by_id: dict) -> str:
    items = []
    for c in claims:
        src = []
        for r in c["evidence_refs"]:
            if r in allowed["findings"]:
                f = allowed["findings"][r]
                src.append({"id": r, "year": f["audit_year"], "codes": f["requirement_codes"], "condition": f["condition"] or "(no narrative)",
                            "corrective_action": f["corrective_action"]})
            elif r in allowed["benchmarks"]:
                b = allowed["benchmarks"][r]
                src.append({"id": r, "count": f"{b['finding_report_count']} of {b['eligible_report_count']}", "cohort_rule": b["cohort_rule"]})
            elif r in allowed["gaps"]:
                src.append({"id": r, "fact": allowed["gaps"][r]["text"]})
        motivating = [by_id[d]["sentence"] for d in c["derived_from_claim_ids"] if d in by_id]
        items.append({"claim_id": c["claim_id"], "kind": c["kind"], "sentence": c["sentence"], "rows": c["row_ids"],
                      "sources": src, "motivated_by": motivating})
    return "Claims to review (JSON):\n" + json.dumps(items)


def _judge(claims: list[dict], allowed: dict, by_id: dict, trace, reason: str) -> dict:
    """Returns {claim_id: verdict} for flagged claims. A judge failure flags nothing (fact checks still apply)."""
    trace.note(f"Judging {len(claims)} claims against their sources")
    try:
        res = _call_tool(JUDGE_SYSTEM, _judge_packet(claims, allowed, by_id), JUDGE_TOOL, "low")
    except llm.ModelUnavailable as e:
        trace.add("quality_check", reason, {}, f"judge unavailable: {e}", stage="quality_check", verdict="skipped", rule=JUDGE_VERSION)
        return {}
    ids = {c["claim_id"] for c in claims}
    flagged = {v["claim_id"]: v for v in (res or {}).get("verdicts", []) if v["claim_id"] in ids and v["verdict"] == "flag"}
    trace.add("quality_check", reason, {"rule": JUDGE_VERSION}, f"{len(ids) - len(flagged)} passed, {len(flagged)} flagged"
              + "".join(f"; {c}: {', '.join(v['problems'])}" for c, v in flagged.items()),
              stage="quality_check", inputs=sorted(ids), outputs=sorted(flagged), verdict="pass" if not flagged else "issues", rule=JUDGE_VERSION)
    return flagged


# ---------------------------------------------------------------------------- fallback
def fallback_claims(view: dict, allowed: dict, record: dict) -> list[dict]:
    """Deterministic, source-based sentences used when the model is unavailable or a claim fails."""
    out, n = [], 0
    org = view["engagement"]["nonprofit"]
    def add(section, kind, sentence, rows, refs, derived=(), display="both"):
        nonlocal n
        n += 1
        out.append({"claim_id": f"F{n}", "section": section, "kind": kind, "sentence": sentence, "row_ids": list(rows),
                    "evidence_refs": list(refs), "derived_from_claim_ids": list(derived), "display_in": display})
        return f"F{n}"
    by_prog = {}
    for lead in view["shortlisted_rows"]:
        by_prog.setdefault(lead["row_id"].split(":")[1], []).append(lead)
    for aln, ls in by_prog.items():
        areas = sorted({l["requirement"].split(" ", 1)[1] for l in ls})
        refs = [l["own_findings"][0]["finding_id"] for l in ls if l["own_findings"]]
        years = sorted({allowed["findings"][r]["audit_year"] for r in refs})
        refs = refs or [l["same_program_benchmark"]["benchmark_id"] for l in ls if l["same_program_benchmark"]["eligible_report_count"]][:1]
        if not refs:
            continue
        area_text = ", ".join(areas[:-1]) + (" and " if len(areas) > 1 else "") + areas[-1]
        why = (f"this nonprofit's own {', '.join(map(str, years))} audit{'s' if len(years) > 1 else ''} reported findings there" if years
               else "only other nonprofits' audits of this program reported findings there")
        add("focus", "program_focus", f"Give {aln} a close look for {area_text}: {why}.", [l["row_id"] for l in ls], refs, display="brief")
    for lead in view["shortlisted_rows"]:
        req = lead["requirement"].split(" ", 1)[1]
        fact = None
        if lead["own_findings"]:
            f0 = lead["own_findings"][0]
            fact = add("focus", "history_fact", f"{org}'s {f0['audit_year']} audit reported a {req} finding for {lead['program'].split(' ', 1)[0]} ({f0['finding_id'].split('#')[1]}).",
                       [lead["row_id"]], [f0["finding_id"]], display="row_note")
        b = lead["same_program_benchmark"]
        if b["eligible_report_count"]:
            bf = add("focus", "aggregate_fact", f"{b['finding_report_count']:,} of {b['eligible_report_count']:,} other nonprofits' audits of {b['program_id']} reported a {req} finding.",
                     [lead["row_id"]], [b["benchmark_id"]], display="row_note")
            fact = fact or bf
        q = lead.get("suggested_request") or VERIFY_QUESTIONS.get(lead["row_id"].rsplit(":", 1)[1])
        if q and fact:
            add("requests", "client_question", q, [lead["row_id"]], [], [fact], display="both")
    for f in view.get("audit_wide_findings", []):
        ref = f["finding_id"].split("#")[1]
        fact = add("focus", "history_fact", f"Finding {ref} ({f['audit_year']}) concerns late filing of the overall audit package "
                   f"with the Federal Audit Clearinghouse; it is linked to {len(f['program_ids'])} program(s) but is not evidence "
                   "about any program's own reports.", f["linked_rows"], [f["finding_id"]], display="brief")
        add("requests", "client_question", f"Request the planned timeline for the {record['target_year']} audit and its submission "
            "to the Federal Audit Clearinghouse.", f["linked_rows"], [], [fact], display="brief")
        break  # stated and requested once for the engagement
    for g in view["gap_facts"]:
        if g["gap_id"] in ("GAP:program_list", "GAP:unavailable_reports") or g["gap_id"].startswith("GAP:P:"):
            add("gaps", "gap", g["fact"], [allowed["gaps"][g["gap_id"]]["row_id"]] if allowed["gaps"][g["gap_id"]].get("row_id") else [], [g["gap_id"]], display="brief")
    add("changes", "change", "A corrected program list, final spending, or current-year client records could change these review areas.", [], [], display="brief")
    return out


def _fallback_for(claim: dict, view: dict, allowed: dict, record: dict) -> dict | None:
    if claim["kind"] == "gap":  # the cited gap fact itself, verbatim
        ref = next((r for r in claim["evidence_refs"] if r in allowed["gaps"]), None)
        if not ref:
            return None
        g = allowed["gaps"][ref]
        return {**claim, "sentence": g["text"], "evidence_refs": [ref],
                "row_ids": [g["row_id"]] if g.get("row_id") else [r for r in claim["row_ids"] if r in allowed["rows"]]}
    pool = [c for c in fallback_claims(view, allowed, record)
            if c["kind"] == claim["kind"] and set(c["row_ids"]) & set(claim["row_ids"])]
    if not pool and claim["kind"] in ("gap", "change"):
        pool = [c for c in fallback_claims(view, allowed, record) if c["kind"] == claim["kind"]]
    if not pool:
        return None
    fb = dict(pool[0])
    fb.update(claim_id=claim["claim_id"], section=claim["section"], display_in=claim["display_in"],
              derived_from_claim_ids=claim["derived_from_claim_ids"] if claim["kind"] == "client_question" else [])
    return fb


# ---------------------------------------------------------------------------- pipeline
def view_hash(view: dict) -> str:
    # The writer version is part of the key: a new prompt must not reuse an old brief.
    return hashlib.sha256((WRITER_VERSION + json.dumps(view, sort_keys=True, default=str)).encode()).hexdigest()[:16]


def write_brief(db: EvidenceDB, case: Case, record: dict, trace, previous: dict | None = None) -> None:
    """Adds record['brief'] (claims, checks, sections), row note claim ids, and trace events."""
    if not record["risks"]:
        return
    view, allowed = build_view(db, case, record)
    vh = view_hash(view)
    lead_rows = [l["row_id"] for l in view["shortlisted_rows"]]
    fids = list(allowed["findings"])
    if previous and (previous.get("brief") or {}).get("view_hash") == vh:
        record["brief"] = {**previous["brief"], "reused_from_version": previous["version"]}
        _attach_notes(record)
        trace.add("write_brief", "Evidence view unchanged since the prior version: reuse its checked brief.", {"view_hash": vh},
                  f"reused brief from v{previous['version']}", stage="write", inputs=lead_rows, outputs=_ids(record), rule=WRITER_VERSION)
        return
    status, claims, model_error = "model", None, None
    try:
        if not llm.model_available():
            raise llm.ModelUnavailable("No model credential on the server.")
        trace.note("Writing the brief from the evidence record")
        out = _call_tool(WRITER_SYSTEM, "Evidence record view (JSON):\n" + json.dumps(view, default=str), WRITER_TOOL, "medium")
        claims = (out or {}).get("claims") or None
    except llm.ModelUnavailable as e:
        model_error = str(e)
    if not claims:
        status, claims = "fallback", fallback_claims(view, allowed, record)
    trace.add("write_brief", "Write brief and row notes from the evidence record (the model cannot change rows, ranks or counts).",
              {"view_hash": vh, "shortlisted_rows": lead_rows}, f"{len(claims)} claims ({status})" + (f"; model unavailable: {model_error}" if model_error else ""),
              stage="write", inputs=lead_rows + fids, outputs=[c["claim_id"] for c in claims], rule=WRITER_VERSION if status == "model" else "fallback-template-1")

    by_id = {c["claim_id"]: c for c in claims}
    checks = {c["claim_id"]: {"claim_id": c["claim_id"], "hard_result": "pass", "quality_result": "pass", "reasons": [], "final_claim_revision": 1}
              for c in claims}
    hard = {cid: hard_check(c, by_id, allowed, record) for cid, c in by_id.items()}
    for cid, rs in hard.items():
        if rs:
            checks[cid]["hard_result"] = "fail"
            checks[cid]["reasons"] += [f"fact check: {r}" for r in rs]
    trace.add("fact_check", "Check rows, cited sources, cutoff, numbers and wording for every claim.", {"rule": CHECK_VERSION},
              f"{sum(1 for r in hard.values() if not r)} passed, {sum(1 for r in hard.values() if r)} failed",
              stage="fact_check", inputs=list(by_id), outputs=[c for c, r in hard.items() if r], verdict="pass" if not any(hard.values()) else "issues",
              rule=CHECK_VERSION)

    flagged = {}
    if status == "model":
        flagged = _judge(list(by_id.values()), allowed, by_id, trace, "Judge interpretation of every claim against its cited excerpts (cannot override fact checks).")
        for cid, v in flagged.items():
            checks[cid]["reasons"].append(f"quality: {', '.join(v['problems']) or 'flag'}: {v['reason']}")

    # One repair attempt in total, covering fact-check failures and judge flags together.
    to_fix = [cid for cid in by_id if hard[cid] or cid in flagged]
    if to_fix and status == "model":
        issues = [{"claim_id": cid, "sentence": by_id[cid]["sentence"], "problems": checks[cid]["reasons"]} for cid in to_fix]
        trace.note(f"Repairing {len(to_fix)} claim(s) once")
        try:
            fixed = _call_tool(WRITER_SYSTEM, "Evidence record view (JSON):\n" + json.dumps(view, default=str)
                               + "\n\nYour earlier claims:\n" + json.dumps(list(by_id.values()))
                               + "\n\nRevise ONLY these claims (same claim_id, kind and row_ids) to fix the problems, or make them say plainly that support is thin. Submit only the revised claims:\n"
                               + json.dumps(issues), WRITER_TOOL, "medium")
            fixed_claims = {c["claim_id"]: c for c in (fixed or {}).get("claims", []) if c["claim_id"] in to_fix}
        except llm.ModelUnavailable:
            fixed_claims = {}
        passed_hard = {}
        for cid, new in fixed_claims.items():
            rs = hard_check(new, {**by_id, cid: new}, allowed, record)
            if rs:
                checks[cid]["reasons"] += [f"repair failed fact check: {r}" for r in rs]
            else:
                passed_hard[cid] = new
        reflagged = _judge(list(passed_hard.values()), allowed, {**by_id, **passed_hard}, trace,
                           "Re-judge repaired claims once.") if passed_hard else {}
        for cid in to_fix:
            if cid in passed_hard and cid not in reflagged:
                by_id[cid] = passed_hard[cid]
                checks[cid].update(hard_result="pass", quality_result="repaired", final_claim_revision=2)
                continue
            if cid in reflagged:
                checks[cid]["reasons"].append(f"repair still flagged: {reflagged[cid]['reason']}")
            fb = _fallback_for(by_id[cid], view, allowed, record)
            if fb and not hard_check(fb, {**by_id, cid: fb}, allowed, record):
                by_id[cid] = {**fb, "fallback": True}
                checks[cid].update(hard_result="pass", quality_result="fallback", final_claim_revision=checks[cid]["final_claim_revision"] + 1)
            elif not hard[cid] and cid not in reflagged and cid in flagged:
                # Fact-checked original with only a quality flag and no safe fallback: keep, marked.
                checks[cid].update(quality_result="fallback")
                by_id[cid] = {**by_id[cid], "quality_flagged": True}
            else:
                checks[cid].update(quality_result="fallback")
                by_id[cid] = {**by_id[cid], "withheld": True}
        trace.add("repair", "One repair attempt for failed or flagged claims; otherwise a marked, source-based fallback.", {"claims": to_fix},
                  ", ".join(f"{c}: {checks[c]['quality_result']}" for c in to_fix), stage="quality_check", inputs=to_fix,
                  outputs=[c for c in to_fix if checks[c]["quality_result"] == "repaired"], rule=WRITER_VERSION)
    elif status == "fallback":
        for cid in by_id:
            checks[cid]["quality_result"] = "fallback"
            by_id[cid] = {**by_id[cid], "fallback": True}
            if hard[cid]:
                by_id[cid]["withheld"] = True

    # The audit filing timeline is requested once per engagement, whatever the writer produced.
    seen_aw = False
    for c in by_id.values():
        if c["kind"] != "client_question" or c.get("withheld") or not c["derived_from_claim_ids"]:
            continue
        if all(d in by_id and _audit_wide_only(by_id[d], allowed) for d in c["derived_from_claim_ids"]):
            if seen_aw:
                c["withheld"] = True
                checks[c["claim_id"]]["reasons"].append("withheld: the audit filing timeline is already requested once")
            seen_aw = True
    # A question whose motivating facts were all withheld has nothing behind it: withhold it too.
    for c in by_id.values():
        if c["kind"] == "client_question" and c["derived_from_claim_ids"] and all(
                by_id.get(d, {"withheld": True}).get("withheld", False) for d in c["derived_from_claim_ids"]):
            c["withheld"] = True
            checks[c["claim_id"]]["reasons"].append("withheld: its motivating fact claim was withheld")
    final = [c for c in by_id.values() if not c.get("withheld")]
    record["brief"] = {
        "status": status, "writer_version": WRITER_VERSION, "judge_version": JUDGE_VERSION, "check_version": CHECK_VERSION,
        "view_hash": vh, "created_at": now(), "peer_status": PEER_STATUS,
        "claims": final, "withheld": [c["claim_id"] for c in by_id.values() if c.get("withheld")],
        "checks": list(checks.values()),
        "sections": {s: [c["claim_id"] for c in final if c["section"] == s and c["display_in"] in ("brief", "both")] for s in SECTIONS},
        "sources": {"findings": allowed["findings"], "benchmarks": allowed["benchmarks"], "gaps": allowed["gaps"]},
    }
    _attach_notes(record)
    trace.add("save_brief", "Save the checked brief with this assessment version.", {}, f"{len(final)} claims shown, {len(record['brief']['withheld'])} withheld",
              stage="save", inputs=[c["claim_id"] for c in final], outputs=[record["assessment_id"]], rule=CHECK_VERSION)


def _ids(record):
    return [c["claim_id"] for c in record["brief"]["claims"]]


def _attach_notes(record: dict) -> None:
    claims = record["brief"]["claims"]
    for p in record["program_assessments"]:
        for r in p["requirements"]:
            r["note_claim_ids"] = [c["claim_id"] for c in claims if r["row_id"] in c["row_ids"] and c["display_in"] in ("row_note", "both")]
            r["benchmark_id"] = benchmark_id(r["row_id"])
        p["peer_set"] = PEER_STATUS
