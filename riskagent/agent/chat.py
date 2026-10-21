"""Engagement-scoped chat agent: a model choosing among approved, cutoff-bounded tools.

The model never sees SQL, target outcomes, or anything outside the tool results. Questions read
the saved assessment; only `revise_assessment` (a manager correction) creates a new version.
"""
from __future__ import annotations

import json
import re

from riskagent.agent import brief, assessment as asm
from riskagent.agent import focus_note, inspect, llm
from riskagent.config import CHAT_EFFORT, MODEL, REQUIREMENTS
from riskagent.evidence.case import Case, EvidenceDB, Program

MAX_STEPS = 10
CHAT_PROMPT_VERSION = "chat-3"
TOOL_REASON = {
    "run_assessment": "Create or load the saved assessment.", "get_assessment": "Read the bound version.",
    "get_row_evidence": "Read one evidence row of the bound version.", "read_finding": "Read a pre-cutoff finding narrative.",
    "get_peer_examples": "Read other nonprofits' findings in the same program and requirement.",
    "get_peer_trend": "Count same-program audits by year.", "get_own_history": "Read this nonprofit's earlier reports.",
    "revise_assessment": "Apply a manager correction as a new version.", "get_manager_decisions": "Read the manager's decisions.",
    "draft_focus_note": "Build the staff note from the manager's decisions."}

SYSTEM_TEMPLATE = """You are the planning assistant inside a Single Audit risk brief app, working for an audit manager on ONE engagement:

- Nonprofit: {org_name} (org id {org_id})
- Audit year: {audit_year}; engagement mode: {mode}
- Data cutoff: set by the system, not the manager. {cutoff_rule}

Your job: help the manager reach a defensible testing focus faster. You propose and explain historical risk areas (federal program x compliance requirement) for staff to verify against current-year records. The manager decides; staff verify. You never declare that a finding exists this year, never decide audit procedures, and never reduce required major-program coverage.

How to work:
- Each message says which saved version the manager is viewing; tools read that version. If no assessment exists and the manager asks for risks, call run_assessment. Otherwise answer from the viewed assessment: get_assessment, get_row_evidence, read_finding, get_peer_examples, get_peer_trend, get_own_history. Look things up rather than guessing; cite what you read.
- A question never changes the saved ranking. If the manager disagrees with a lead, explain the evidence for and against it and suggest recording a disposition (Include / Set aside / Investigate) in the review table. Ranks change only through revise_assessment when the manager corrects a case fact (for example a program that is no longer received, a new program, or a changed amount). After revising, state what changed between versions.
- For a staff note, call get_manager_decisions and draft_focus_note; the note follows the manager's decisions, not your ranking alone.
- Target-year outcomes (this audit's findings, opinions, major-program selections) are hidden from you by design. If asked, say they can be compared only in Evaluation mode after the prediction is saved, and that the comparison cannot change the saved prediction.

How to write:
- Plain, compact language for a busy audit manager. Lead with the answer. Use short bullets.
- audit_wide_findings are about the organization's overall audit filing (e.g. late FAC submission of the audit package). They stay linked to program rows as sources but are not evidence that any program's own reports were late. Mention the filing-timeline request once; suggest a program's report checks only from that program's own evidence or same-program pattern. Leads are at most five, and fewer when the evidence check found weak matches; never describe a weak match as a lead.
- One underlying issue is one lead: a requirement row resting only on the same findings as a lead is a related tag of that lead (related_tags), not a separate lead. Leads marked conditional are older findings the latest audit did not repeat; frame them conditionally. The top five come from a checked pool by a fixed rule (review_order); explain moves with it.
- Refer to leads as L1-L5 and to table rows by their ids exactly as given (e.g. R:93.224:L, P:93.224) so the app can link them.
- Cite sources with report year, FAC accepted date when relevant, and finding reference (e.g. "2020 audit, finding 2020-004"). Separate this nonprofit's own reports from other nonprofits' reports. Give same-program counts as "k of n other nonprofits' audits of this program", with the cohort years if relevant. Peer status is unknown (no source-backed organization profiles), so never call those organizations peers, similar or comparable.
- The saved version includes a checked planning brief (brief_claims). Prefer its claim ids (e.g. C3) and wording when they answer the question; do not contradict a checked claim without citing new evidence.
- Never use Low/Medium/High labels, probabilities or "% chance". Rank is an ordering for review, not a likelihood. A missing reported finding is not evidence of low risk.
- Say plainly when evidence is thin, conflicting, missing narrative text, or only a peer pattern. Mention the evidence check status when it matters (supported / weak match / conflict).
- The app shows the full detail of every lead, program and source in the review pane next to the chat. Do not repeat it. Chat answers are short: lead with the answer, then only what the manager needs to decide. Use the evidence detail only when the manager asks about it.
- First risk answer: at most about 120 words. One line on scope (number of programs considered and their states, the cutoff, the program source, and the most important gap). Then one line per lead, in this form: "L1 · <short title> · R:<aln>:<letter> · <evidence check status>". Then one sentence pointing to the review pane and inviting a question about any lead. No per-lead explanations, peer counts or staff questions in this first answer.
- Follow-ups: write like a colleague in chat. Default under about 80 words: 2-4 bullets, each a bold lead-in that states the point, then one short plain sentence. Name an area in plain words first, with its row id once in brackets, e.g. "Rental assistance eligibility (R:21.023:E)". Cite a finding by year and number only where it is the reason. Do not use internal terms (candidate rank, policy rank, tiers, evidence-check mechanics) unless asked, do not restate the question, and end with at most one next step. Go longer only when the manager asks for detail or a drafted note."""

TOOLS = [
    {"name": "run_assessment",
     "description": "Create the first saved assessment for this engagement (identity, cutoff, programs, own and peer evidence, frozen ranking, evidence check of the top leads). If one already exists, returns the latest version instead. Takes about a minute.",
     "input_schema": {"type": "object", "properties": {}, "required": []}},
    {"name": "get_assessment",
     "description": "Compact view of the viewed saved assessment (or a given version number), including the checked brief claims: scope, limitations, the ranked leads with evidence checks, and every program row with its state and requirement rows.",
     "input_schema": {"type": "object", "properties": {
         "version": {"type": "integer", "description": "Optional earlier version number"}},
         "required": []}},
    {"name": "get_row_evidence",
     "description": "Full evidence behind one table row: a requirement row id like R:93.224:L or a program row id like P:93.224. Returns own findings with flags, peer counts by year, limits and the conclusion.",
     "input_schema": {"type": "object", "properties": {"row_id": {"type": "string"}},
                      "required": ["row_id"]}},
    {"name": "read_finding",
     "description": "Read the narrative and corrective action of one earlier finding (this nonprofit's or another nonprofit's). Only reports public before the cutoff are available.",
     "input_schema": {"type": "object", "properties": {
         "report_id": {"type": "string"}, "reference_number": {"type": "string"}},
         "required": ["report_id", "reference_number"]}},
    {"name": "get_peer_examples",
     "description": "Examples of other nonprofits' pre-cutoff findings in a program and requirement, with narrative excerpts.",
     "input_schema": {"type": "object", "properties": {
         "program_aln": {"type": "string"}, "requirement_code": {"type": "string"},
         "limit": {"type": "integer"}}, "required": ["program_aln", "requirement_code"]}},
    {"name": "get_peer_trend",
     "description": "By audit year: other nonprofits' audits where the program was major (n) and how many reported a finding in a requirement (k).",
     "input_schema": {"type": "object", "properties": {
         "program_aln": {"type": "string"}, "requirement_code": {"type": "string"}},
         "required": ["program_aln", "requirement_code"]}},
    {"name": "get_own_history",
     "description": "This nonprofit's earlier reports: which were admissible, which were excluded as not yet public, auditors, programs, finding counts, and own findings in programs not on the current list.",
     "input_schema": {"type": "object", "properties": {}, "required": []}},
    {"name": "revise_assessment",
     "description": "Apply a manager correction to the program list and rerun the assessment as a new saved version (the prior version is kept). Use only for corrected case facts, not for opinions about ranking.",
     "input_schema": {"type": "object", "properties": {
         "remove_programs": {"type": "array", "items": {"type": "string"},
                             "description": "ALNs no longer received, e.g. 93.498"},
         "add_programs": {"type": "array", "items": {"type": "object", "properties": {
             "aln": {"type": "string"}, "amount": {"type": "number"}}, "required": ["aln"]}},
         "change_amounts": {"type": "array", "items": {"type": "object", "properties": {
             "aln": {"type": "string"}, "amount": {"type": "number"}},
             "required": ["aln", "amount"]}},
         "reason": {"type": "string", "description": "The manager's stated correction"}},
         "required": ["reason"]}},
    {"name": "get_manager_decisions",
     "description": "The manager's recorded dispositions (include / set_aside / investigate) and notes for the latest version.",
     "input_schema": {"type": "object", "properties": {}, "required": []}},
    {"name": "draft_focus_note",
     "description": "Build the staff testing-focus note from the latest version and the manager's decisions (same text as the app's export).",
     "input_schema": {"type": "object", "properties": {}, "required": []}},
]

ALN_RE = re.compile(r"^\d{2}\.(\d{3}[A-Z]?|RD)$")


def case_from_record(rec: dict) -> Case:
    import datetime as dt
    return Case(case_id=rec["engagement_id"], org_id=rec["target_org"]["org_id"],
                target_year=rec["target_year"],
                cutoff=dt.date.fromisoformat(rec["prediction_date"]))


def compact(rec: dict, decisions: dict | None = None) -> dict:
    decisions = decisions or {}
    return {
        "assessment_id": rec["assessment_id"], "version": rec["version"],
        "change_summary": rec["change_summary"], "mode": rec["mode"],
        "cutoff": rec["data_cutoff"], "program_source": rec["program_source"],
        "summary": rec["summary"], "limitations": rec["limitations"],
        "brief_claims": [{k: c[k] for k in ("claim_id", "section", "kind", "sentence", "row_ids", "evidence_refs")}
                         for c in (rec.get("brief") or {}).get("claims", [])],
        "peer_status": (rec.get("brief") or {}).get("peer_status", {"status": "unknown"}),
        "leads": [{k: r.get(k) for k in (
            "lead_id", "requirement_row_id", "program_id", "program_name", "requirement_code",
            "requirement_name", "group_label", "short_title", "plain_language_risk", "why_this_client",
            "verification_question", "uncertainties", "evidence_check", "explanation_source")}
                  | {"sources": [f"{s['kind']}: {s['report_id']} ({s['audit_year']}) {s['reference_number']}"
                                 for s in r["sources"]],
                     "same_program_count": f"{r['peer']['k']} of {r['peer']['n']} other nonprofits' audits of this program",
                     "decision": decisions.get(r["requirement_row_id"]),
                     "related_tags": [{k: x[k] for k in ("row_id", "requirement_name", "status", "distinct_check")}
                                      for x in r.get("related", [])],
                     "conditional": r.get("conditional"), "policy_rank": r.get("policy_rank"),
                     "order_note": r.get("order_note")}
                  for r in rec["risks"]],
        "review_order": {k: (rec.get("review_order") or {}).get(k) for k in ("rule", "description", "entries")},
        "audit_wide_findings": [{k: f[k] for k in ("finding_id", "audit_year", "programs", "row_ids", "scope_reason")}
                                for f in rec.get("audit_wide_findings", [])],
        "programs": [{
            "row_id": p["row_id"], "aln": p["aln"], "name": p["program_name"], "amount": p["amount"],
            "status": p["status"], "state": p["state"], "state_reason": p["state_reason"],
            "own_coverage": p["own_coverage"], "peer_reports": p["peer"]["n_reports"],
            "requirements": [{"row_id": r["row_id"], "state": r["state"], "rank": r["rank"],
                              "candidate_rank": r["candidate_rank"], "group": r["group_label"],
                              "own_years": r["own"]["years"] if r["own"] else [],
                              "peer": f"{r['peer']['k']} of {r['peer']['n']}"}
                             for r in p["requirements"][:8]],
            "more_requirement_rows": max(0, len(p["requirements"]) - 8)}
            for p in rec["program_assessments"]],
    }



def narrate(previous: dict | None = None):
    """Model stages after ranking: narrative review of leads, then the checked brief."""
    def run(db, case, record, trace):
        inspect.inspect_leads(db, case, record, trace, previous=previous)
        asm.finalize_review_order(record, trace)
        brief.write_brief(db, case, record, trace, previous=previous)
    return run

class ChatAgent:
    def __init__(self, db: EvidenceDB, store):
        self.db = db
        self.store = store

    # ------------------------------------------------------------------ assessments
    def create_initial(self, eng: dict) -> dict:
        existing = self.store.latest_assessment(eng["engagement_id"])
        if existing:
            return existing
        rec = asm.build_record(self.db, eng, inspector=narrate(),
                               post_reveal=bool(eng.get("revealed_at")))
        self.store.save_assessment(rec)
        return rec

    def revise(self, eng: dict, args: dict) -> dict:
        prev = self.store.latest_assessment(eng["engagement_id"])
        if prev is None:
            prev = self.create_initial(eng)
        progs = {p["aln"]: Program(aln=p["aln"], name=p["name"], amount=p["amount"],
                                   aln_status=p.get("aln_status", "specific"), status=p["status"])
                 for p in prev["input_programs"]}
        changes, problems = [], []
        for a in args.get("remove_programs") or []:
            if a in progs:
                progs.pop(a)
                changes.append(f"removed {a}")
            else:
                problems.append(f"{a} was not on the program list")
        new = [x for x in (args.get("add_programs") or [])]
        names = self.db.program_names([x["aln"] for x in new])
        for x in new:
            a = x["aln"].strip()
            if not ALN_RE.match(a):
                problems.append(f"{a} is not a valid Assistance Listing number")
                continue
            progs[a] = Program(aln=a, name=names.get(a, "(name not found in FAC history)"),
                               amount=x.get("amount"),
                               aln_status="rd" if a.endswith("RD") else "specific", status="manager")
            changes.append(f"added {a}" + (f" ({asm.money(x['amount'])})" if x.get("amount") else ""))
        for x in args.get("change_amounts") or []:
            if x["aln"] in progs:
                progs[x["aln"]].amount = x["amount"]
                changes.append(f"set {x['aln']} amount to {asm.money(x['amount'])}")
            else:
                problems.append(f"{x['aln']} was not on the program list")
        if not changes:
            return {"error": "No valid change to apply.", "problems": problems}
        reason = re.sub(r"^(manager )?correction:\s*", "", (args.get("reason") or "").strip(), flags=re.I)
        summary = "Manager correction: " + "; ".join(changes) + (f". Reason: {reason}" if reason else ".")
        rec = asm.build_record(self.db, {**eng}, override=list(progs.values()), parent=prev,
                               change_summary=summary, post_reveal=bool(eng.get("revealed_at")),
                               inspector=narrate(prev))
        self.store.save_assessment(rec)
        # Carry forward decisions on rows that still exist.
        old = self.store.decisions(prev["assessment_id"])
        row_ids = {p["row_id"] for p in rec["program_assessments"]} | {
            r["row_id"] for p in rec["program_assessments"] for r in p["requirements"]}
        for rid, d in old.items():
            if rid in row_ids:
                self.store.set_decision(rec["assessment_id"], rid, d["disposition"], d["note"], asm.now())
        before = [(r["lead_id"], r["requirement_row_id"]) for r in prev["risks"]]
        after = [(r["lead_id"], r["requirement_row_id"]) for r in rec["risks"]]
        return {"new_version": rec["version"], "assessment_id": rec["assessment_id"],
                "change_summary": summary, "problems": problems,
                "leads_before": before, "leads_after": after,
                "assessment": compact(rec)}

    # ------------------------------------------------------------------ tools
    def run_tool(self, eng: dict, name: str, args: dict, bound: dict | None = None) -> tuple[str, str]:
        """Execute one approved tool against the bound (viewed) version, else the latest.
        Returns (json result, short summary for the UI)."""
        eid = eng["engagement_id"]
        rec = bound or self.store.latest_assessment(eid)
        if name == "run_assessment":
            existed = rec is not None
            rec = self.create_initial(eng)
            return (json.dumps(compact(rec, self.store.decisions(rec["assessment_id"])), default=str),
                    f"{'Loaded' if existed else 'Created'} assessment v{rec['version']}: "
                    f"{rec['summary']['n_leads']} leads across {rec['summary']['n_programs']} programs")
        if name == "revise_assessment":
            out = self.revise(eng, args)
            return (json.dumps(out, default=str),
                    out.get("change_summary") or out.get("error", "revision failed"))
        if rec is None:
            return (json.dumps({"error": "No assessment saved yet. Call run_assessment first."}),
                    "No assessment yet")
        case = case_from_record(rec)
        if name == "get_assessment":
            v = args.get("version")
            r = self.store.assessment_by_version(eid, int(v)) if v else rec
            if r is None:
                return json.dumps({"error": f"No version {v}"}), f"No version {v}"
            return (json.dumps(compact(r, self.store.decisions(r["assessment_id"])), default=str),
                    f"Read assessment v{r['version']}")
        if name == "get_row_evidence":
            rid = args.get("row_id", "")
            return json.dumps(self.row_evidence(rec, case, rid), default=str), f"Evidence for {rid}"
        if name == "read_finding":
            d = self.db.finding_detail(case, args.get("report_id", ""), args.get("reference_number", ""))
            if d is None:
                return (json.dumps({"error": "Not available: unknown finding, or the report was not "
                                    "public before the cutoff (or is the target-year report)."}),
                        "Finding not available")
            return (json.dumps(d, default=str),
                    f"Read finding {d['reference_number']} ({d['audit_year']}, {d['auditee_name']})")
        if name == "get_peer_examples":
            aln, letter = args.get("program_aln", ""), args.get("requirement_code", "")
            lim = max(1, min(int(args.get("limit") or 5), 8))
            out = []
            for s in self.db.peer_sample(case, aln, letter, lim):
                d = self.db.finding_detail(case, s["report_id"], s["reference_numbers"][0])
                out.append({**s, "excerpt": inspect._clip(d["narrative"], 600) if d else None})
            return (json.dumps({"program": aln, "requirement": letter, "examples": out}, default=str),
                    f"{len(out)} peer example(s) for {aln} × {letter}")
        if name == "get_peer_trend":
            aln, letter = args.get("program_aln", ""), args.get("requirement_code", "")
            return (json.dumps({"program": aln, "requirement": letter,
                                "by_year": self.db.peer_year_counts(case, aln, letter)}),
                    f"Peer trend for {aln} × {letter}")
        if name == "get_own_history":
            return json.dumps(rec["own_history"], default=str), "Read own report history"
        if name == "get_manager_decisions":
            d = self.store.decisions(rec["assessment_id"])
            return (json.dumps({"version": rec["version"], "decisions": d}),
                    f"{len(d)} decision(s) recorded")
        if name == "draft_focus_note":
            note = focus_note.build_note(rec, self.store.decisions(rec["assessment_id"]))
            return json.dumps({"version": rec["version"], "note_markdown": note}), "Drafted focus note"
        return json.dumps({"error": f"Unknown tool {name}"}), f"Unknown tool {name}"

    def row_evidence(self, rec: dict, case: Case, row_id: str) -> dict:
        for p in rec["program_assessments"]:
            if p["row_id"] == row_id:
                return {"row_id": row_id, "kind": "program",
                        **{k: p[k] for k in ("aln", "program_name", "amount", "status", "state",
                                             "state_reason", "own_coverage", "peer")},
                        "requirement_rows": [r["row_id"] for r in p["requirements"]]}
            for r in p["requirements"]:
                if r["row_id"] == row_id:
                    risk = next((x for x in rec["risks"] if x["requirement_row_id"] == row_id), None)
                    return {"row_id": row_id, "kind": "requirement", "program": p["aln"],
                            "program_name": p["program_name"], **r,
                            "peer_by_year": self.db.peer_year_counts(case, p["aln"], r["letter"]),
                            "peer_rule": p["peer"]["rule"],
                            "lead": ({k: risk[k] for k in ("lead_id", "why_this_client",
                                                           "evidence_check", "uncertainties",
                                                           "verification_question")}
                                     if risk else None)}
        return {"error": f"No row {row_id} in assessment v{rec['version']}"}

    # ------------------------------------------------------------------ conversation
    def system_prompt(self, eng: dict) -> str:
        if eng["mode"] == "historical":
            rule = ("Historical engagement: only reports FAC-accepted before the target fiscal "
                    "year-end and with an earlier audit year are used.")
        else:
            rule = ("Live engagement: only reports public by the run date, from a local FAC "
                    f"snapshot dated {self.db.snapshot_date}.")
        return SYSTEM_TEMPLATE.format(org_name=eng["org_name"], org_id=eng["org_id"],
                                      audit_year=eng["audit_year"], mode=eng["mode"],
                                      cutoff_rule=rule)

    def handle(self, eng: dict, text: str, assessment_id: str | None = None) -> dict:
        eid = eng["engagement_id"]
        history = self.store.api_messages(eid)
        ts = asm.now()
        bound = self.store.assessment(assessment_id) if assessment_id else None
        if bound and bound["engagement_id"] != eid:
            bound = None
        bound = bound or self.store.latest_assessment(eid)
        user_disp = self.store.add_display(eid, "user", text, [], bound["assessment_id"] if bound else None, ts)
        live = asm.Trace(eid)
        asm.PROGRESS[eid] = []
        live.note("Reading your question")
        view_note = (f"[The manager is viewing assessment v{bound['version']} ({bound['assessment_id']}). "
                     "Answer from that version; tools read it.]\n\n" if bound else "")
        new_msgs = [{"role": "user", "content": [{"type": "text", "text": view_note + text}]}]
        tool_calls, final_text, events = [], "", []
        try:
            for _ in range(MAX_STEPS):
                resp = llm.create(system=self.system_prompt(eng), messages=history + new_msgs,
                                  tools=TOOLS, effort=CHAT_EFFORT)
                if resp.stop_reason == "refusal":
                    final_text = ("The model declined this request. Please rephrase the question "
                                  "about the engagement's risk areas.")
                    break
                new_msgs.append({"role": "assistant", "content": llm.blocks_to_params(resp.content)})
                uses = [b for b in resp.content if b.type == "tool_use"]
                if not uses:
                    final_text = llm.text_of(resp.content)
                    break
                results = []
                for u in uses:
                    args = dict(u.input or {})
                    verdict = "ok"
                    live.note(TOOL_REASON.get(u.name, u.name).rstrip("."))
                    try:
                        out, summary = self.run_tool(eng, u.name, args, bound)
                        results.append({"type": "tool_result", "tool_use_id": u.id, "content": out})
                        if u.name in ("run_assessment", "revise_assessment"):
                            bound = self.store.latest_assessment(eid)
                    except Exception as e:  # tool failure is reported to the model and the user
                        summary, verdict = f"{u.name} failed: {e}", "error"
                        results.append({"type": "tool_result", "tool_use_id": u.id,
                                        "is_error": True, "content": summary})
                    tool_calls.append({"tool": u.name, "summary": summary})
                    done = asm.PROGRESS.setdefault(eid, [])
                    if done and not done[-1]["done"]:
                        done.pop()
                    done.append({"label": TOOL_REASON.get(u.name, u.name).rstrip("."), "summary": summary[:160], "done": True})
                    live.note("Writing the answer")
                    events.append(self.turn_event(len(events) + 1, u.name, args, summary, verdict, bound))
                new_msgs.append({"role": "user", "content": results})
            else:
                final_text = llm.text_of(resp.content) or "I ran out of steps; please ask again more narrowly."
        except llm.ModelUnavailable as e:
            final_text = (f"**Model unavailable:** {e} The saved assessment, table and export still "
                          "work; set ANTHROPIC_API_KEY in the server environment for chat.")
            new_msgs = new_msgs[:1]
            new_msgs.append({"role": "assistant", "content": [{"type": "text", "text": final_text}]})
        if new_msgs[-1]["role"] != "assistant":
            new_msgs.append({"role": "assistant", "content": [{"type": "text", "text": final_text or "…"}]})
        self.store.append_api_messages(eid, new_msgs)
        latest = self.store.latest_assessment(eid)
        aid = bound["assessment_id"] if bound else (latest["assessment_id"] if latest else None)
        turn = {"turn_id": asm.new_id("turn"), "assessment_id": aid,
                "assessment_version": bound["version"] if bound else None, "question": text,
                "model": MODEL, "prompt_version": CHAT_PROMPT_VERSION, "created_at": ts,
                "record_ids_read": sorted({i for ev in events for i in ev["input_record_ids"]}),
                "trace": events}
        asst = self.store.add_display(eid, "assistant", final_text or "(no reply)", tool_calls, aid,
                                      asm.now(), turn)
        asm.PROGRESS.pop(eid, None)
        return {"messages": [user_disp, asst], "latest_assessment_id": latest["assessment_id"] if latest else None}

    @staticmethod
    def turn_event(n: int, tool: str, args: dict, summary: str, verdict: str, bound: dict | None) -> dict:
        ids = [v for k, v in args.items() if k in ("row_id",) and isinstance(v, str)]
        if args.get("report_id"):
            ids.append(f"{args['report_id']}#{args.get('reference_number', '')}")
        if args.get("program_aln"):
            ids.append(f"B:{args['program_aln']}:{args.get('requirement_code', '')}")
        if bound and not ids:
            ids.append(bound["assessment_id"])
        return {"step": n, "trace_event_id": f"T{n}", "stage": "chat_lookup", "tool": tool, "tool_name": tool,
                "reason": TOOL_REASON.get(tool, ""), "args": args, "result_summary": summary, "ts": asm.now(),
                "input_record_ids": ids,
                "output_record_ids": [bound["assessment_id"]] if bound and tool in ("run_assessment", "revise_assessment") else [],
                "rule_or_prompt_version": CHAT_PROMPT_VERSION, "verdict": verdict}


def requirement_name(letter: str) -> str:
    return REQUIREMENTS.get(letter, letter)
