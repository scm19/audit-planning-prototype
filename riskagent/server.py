"""FastAPI app: the JSON API plus the static browser app."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from riskagent.agent import assessment as asm
from riskagent.agent import focus_note, llm, reveal
from riskagent.agent.chat import ChatAgent, case_from_record
from riskagent.agent.inspect import _clip
from riskagent.config import (AGENT_VERSION, BASELINE_VERSION, MODEL, RANKER_VERSION, STATIC_DIR)
from riskagent.evidence.case import EvidenceDB
from riskagent.store import Store

app = FastAPI(title="Single Audit Risk Brief")


@app.middleware("http")
async def no_stale_assets(request, call_next):
    # Prototype: always revalidate so a refresh picks up UI changes immediately.
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache"
    return response
db = EvidenceDB()
store = Store()
agent = ChatAgent(db, store)


class NewEngagement(BaseModel):
    org_id: str
    audit_year: int
    program_mode: str = "proxy"


class ChatIn(BaseModel):
    message: str
    assessment_id: str | None = None  # the version the manager is viewing; chat reads that version


class DecisionIn(BaseModel):
    disposition: str | None = None
    note: str | None = None


class RevealIn(BaseModel):
    assessment_id: str | None = None


def _eng(eid: str) -> dict:
    e = store.engagement(eid)
    if not e:
        raise HTTPException(404, "engagement not found")
    return e


def _enrich(e: dict) -> dict:
    """Engagement plus identity and the system-set cutoff, available before any assessment."""
    import datetime as dt
    org = db.org(e["org_id"]) or {}
    targets = db.target_reports(e["org_id"], e["audit_year"])
    if targets:
        fy = targets[0]["fy_end_date"]
        pred = fy
        state = targets[0]["auditee_state"] or org.get("state")
    else:
        fy = None
        pred = dt.date.today()
        state = org.get("state")
    return {**e, "org_state": state, "org_uei": org.get("uei"),
            "fy_end_date": str(fy) if fy else None, "prediction_date": str(pred),
            "fac_snapshot_date": str(db.snapshot_date)}


def _asm(aid: str) -> dict:
    a = store.assessment(aid)
    if not a:
        raise HTTPException(404, "assessment not found")
    return a


@app.get("/api/meta")
def meta():
    return {"fac_snapshot_date": str(db.snapshot_date), "model": MODEL,
            "model_available": llm.model_available(),
            "versions": {"agent": AGENT_VERSION, "ranker": RANKER_VERSION,
                         "baseline": BASELINE_VERSION}}


@app.get("/api/orgs/search")
def search(q: str = ""):
    return db.search_orgs(q)


@app.get("/api/orgs/{org_id}/years")
def years(org_id: str):
    out = db.org_years(org_id)
    if not out:
        raise HTTPException(404, "organization not found")
    years_list = []
    for y in out:
        y["has_prior_history"] = any(o["audit_year"] < y["audit_year"] for o in out
                                     if o["mode"] == "historical")
        years_list.append(y)
    return years_list


@app.get("/api/engagements")
def list_engagements():
    return [{"engagement_id": e["engagement_id"], "org_name": e["org_name"], "org_id": e["org_id"],
             "audit_year": e["audit_year"], "mode": e["mode"], "program_mode": e["program_mode"],
             "created_at": e["created_at"], "latest_version": e["latest_version"],
             "revealed": bool(e["revealed_at"])} for e in store.engagements()]


@app.post("/api/engagements")
def create_engagement(body: NewEngagement):
    org = db.org(body.org_id)
    if not org:
        raise HTTPException(404, "organization not found")
    targets = db.target_reports(body.org_id, body.audit_year)
    mode = "historical" if targets else "live"
    pm = body.program_mode if mode == "historical" and body.program_mode in ("proxy", "history_only") \
        else "history_only"
    e = {"engagement_id": asm.new_id("eng"), "org_id": body.org_id,
         "org_name": targets[0]["auditee_name"] if targets else org["name"],
         "audit_year": body.audit_year, "mode": mode, "program_mode": pm, "created_at": asm.now()}
    store.create_engagement(e)
    return _enrich({**e, "revealed_at": None})


@app.get("/api/engagements/{eid}")
def get_engagement(eid: str):
    e = _eng(eid)
    latest = store.latest_assessment(eid)
    return {"engagement": _enrich(e), "messages": store.display_messages(eid),
            "assessments": store.assessment_list(eid),
            "latest_assessment_id": latest["assessment_id"] if latest else None,
            "reveal": store.reveal(eid)}


@app.post("/api/engagements/{eid}/chat")
def chat(eid: str, body: ChatIn):
    e = _eng(eid)
    text = body.message.strip()
    if not text:
        raise HTTPException(400, "empty message")
    return agent.handle(e, text[:4000], assessment_id=body.assessment_id)


@app.get("/api/engagements/{eid}/progress")
def progress(eid: str):
    """Live steps of the run in flight for this engagement (empty when idle)."""
    return {"steps": asm.PROGRESS.get(eid, [])}


@app.post("/api/engagements/{eid}/assess")
def assess(eid: str):
    """Create the first assessment without chat (used by tests and as a UI fallback)."""
    asm.PROGRESS[eid] = []
    try:
        rec = agent.create_initial(_eng(eid))
    finally:
        asm.PROGRESS.pop(eid, None)
    return {"assessment_id": rec["assessment_id"], "version": rec["version"]}


@app.get("/api/assessments/{aid}")
def get_assessment(aid: str):
    return _asm(aid)


@app.get("/api/assessments/{aid}/evidence/{row_id}")
def evidence(aid: str, row_id: str):
    rec = _asm(aid)
    case = case_from_record(rec)
    for p in rec["program_assessments"]:
        rows = [p] + p["requirements"]
        for r in rows:
            if r["row_id"] != row_id:
                continue
            if r is p:
                own = [{**f, "letter": rr["letter"]} for rr in p["requirements"] if rr["own"]
                       for f in rr["own"]["findings"]]
                peer = {"n": p["peer"]["n_reports"], "k": None, "rule": p["peer"]["rule"],
                        "first_year": p["peer"]["first_year"], "last_year": p["peer"]["last_year"],
                        "years": db.peer_year_counts(case, p["aln"]), "sample": []}
            else:
                # Audit-wide filing findings stay listed as sources, marked as not counted.
                own = (r["own"]["findings"] if r["own"] else []) + [
                    {**f, "audit_wide": True} for f in r.get("audit_wide", [])]
                peer = {"n": r["peer"]["n"], "k": r["peer"]["k"],
                        "k_excluding_blanket": r["peer"]["k_excluding_blanket"],
                        "rule": p["peer"]["rule"], "first_year": p["peer"]["first_year"],
                        "last_year": p["peer"]["last_year"],
                        "years": db.peer_year_counts(case, p["aln"], r["letter"]),
                        "sample": db.peer_sample(case, p["aln"], r["letter"], 8)}
            own_out = []
            for f in own[:12]:
                d = db.finding_detail(case, f["report_id"], f["reference_number"])
                own_out.append({**f, "excerpt": _clip(d["narrative"], 420) if d else None,
                                "requirement_letters": d["requirement_letters"] if d else None})
            risk = next((x for x in rec["risks"] if x["requirement_row_id"] == row_id), None)
            return {"row_id": row_id, "kind": "program" if r is p else "requirement",
                    "program": {"aln": p["aln"], "name": p["program_name"]},
                    "requirement": None if r is p else {"letter": r["letter"], "name": r["requirement"]},
                    "conclusion": p["state_reason"] if r is p else r["conclusion"],
                    "limits": [] if r is p else r["limits"],
                    "evidence_check": risk["evidence_check"] if risk else None,
                    "own": own_out, "peer": peer}
    raise HTTPException(404, f"row {row_id} not in this assessment")


@app.get("/api/assessments/{aid}/finding/{report_id}/{ref}")
def finding(aid: str, report_id: str, ref: str):
    rec = _asm(aid)
    d = db.finding_detail(case_from_record(rec), report_id, ref)
    if d is None:
        raise HTTPException(403, "Not admissible for this assessment: unknown finding, or the "
                                 "report was not public before the cutoff.")
    return d


@app.get("/api/assessments/{aid}/decisions")
def decisions(aid: str):
    _asm(aid)
    return store.decisions(aid)


@app.put("/api/assessments/{aid}/decisions/{row_id}")
def put_decision(aid: str, row_id: str, body: DecisionIn):
    rec = _asm(aid)
    ids = {p["row_id"] for p in rec["program_assessments"]} | {
        r["row_id"] for p in rec["program_assessments"] for r in p["requirements"]}
    if row_id not in ids:
        raise HTTPException(404, "row not in this assessment")
    if body.disposition not in (None, "include", "set_aside", "investigate"):
        raise HTTPException(400, "disposition must be include, set_aside, investigate or null")
    return store.set_decision(aid, row_id, body.disposition, (body.note or "")[:2000], asm.now())


@app.get("/api/assessments/{aid}/export", response_class=PlainTextResponse)
def export(aid: str):
    rec = _asm(aid)
    note = focus_note.build_note(rec, store.decisions(aid))
    fname = f"focus-note-{rec['target_org']['name'][:40].replace(' ', '_')}-{rec['target_year']}-v{rec['version']}.md"
    return PlainTextResponse(note, media_type="text/markdown",
                             headers={"Content-Disposition": f'inline; filename="{fname}"'})


@app.post("/api/engagements/{eid}/reveal")
def do_reveal(eid: str, body: RevealIn):
    e = _eng(eid)
    if e["mode"] != "historical":
        raise HTTPException(400, "Reveal is available only for historical engagements.")
    if store.reveal(eid):
        return store.reveal(eid)
    rec = store.assessment(body.assessment_id) if body.assessment_id else None
    if rec is None:
        lst = store.assessment_list(eid)
        rec = store.assessment(lst[0]["assessment_id"]) if lst else None
    if rec is None or rec["engagement_id"] != eid:
        raise HTTPException(409, "Save an assessment before revealing reported outcomes.")
    targets = db.target_reports(e["org_id"], e["audit_year"])
    out = reveal.build_reveal(db, rec, targets[0]["report_id"])
    store.save_reveal(eid, out)
    store.set_revealed(eid, out["revealed_at"])
    return out


@app.get("/api/engagements/{eid}/reveal")
def get_reveal(eid: str):
    _eng(eid)
    return store.reveal(eid)


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/", StaticFiles(directory=str(STATIC_DIR)), name="static")
