"""SQLite persistence: engagements, assessment versions, conversations, decisions, reveals."""
from __future__ import annotations

import json
import sqlite3
import threading

from riskagent.config import APP_DB

SCHEMA = """
CREATE TABLE IF NOT EXISTS engagements (
    engagement_id TEXT PRIMARY KEY, org_id TEXT, org_name TEXT, audit_year INTEGER, mode TEXT,
    program_mode TEXT, created_at TEXT, revealed_at TEXT);
CREATE TABLE IF NOT EXISTS assessments (
    assessment_id TEXT PRIMARY KEY, engagement_id TEXT, version INTEGER, created_at TEXT,
    post_reveal INTEGER, record_json TEXT);
CREATE TABLE IF NOT EXISTS api_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, engagement_id TEXT, role TEXT, content_json TEXT);
CREATE TABLE IF NOT EXISTS display_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, engagement_id TEXT, role TEXT, text TEXT,
    tool_calls_json TEXT, assessment_id TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS decisions (
    assessment_id TEXT, row_id TEXT, disposition TEXT, note TEXT, updated_at TEXT,
    PRIMARY KEY (assessment_id, row_id));
CREATE TABLE IF NOT EXISTS reveals (
    engagement_id TEXT PRIMARY KEY, assessment_id TEXT, revealed_at TEXT, record_json TEXT);
"""


class Store:
    def __init__(self, path=APP_DB):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._con = sqlite3.connect(str(path), check_same_thread=False)
        self._con.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._con.executescript(SCHEMA)
            cols = {r[1] for r in self._con.execute("PRAGMA table_info(display_messages)")}
            if "turn_json" not in cols:
                self._con.execute("ALTER TABLE display_messages ADD COLUMN turn_json TEXT")
            self._con.commit()

    def _q(self, sql, args=()):
        with self._lock:
            return self._con.execute(sql, args).fetchall()

    def _x(self, sql, args=()):
        with self._lock:
            cur = self._con.execute(sql, args)
            self._con.commit()
            return cur

    # engagements
    def create_engagement(self, e: dict):
        self._x("INSERT INTO engagements VALUES (?,?,?,?,?,?,?,NULL)",
                (e["engagement_id"], e["org_id"], e["org_name"], e["audit_year"], e["mode"],
                 e["program_mode"], e["created_at"]))

    def engagement(self, eid: str) -> dict | None:
        r = self._q("SELECT * FROM engagements WHERE engagement_id = ?", (eid,))
        return dict(r[0]) if r else None

    def engagements(self) -> list[dict]:
        rows = self._q("""
            SELECT e.*, (SELECT max(version) FROM assessments a
                         WHERE a.engagement_id = e.engagement_id) AS latest_version
            FROM engagements e ORDER BY created_at DESC""")
        return [dict(r) for r in rows]

    def set_revealed(self, eid: str, ts: str):
        self._x("UPDATE engagements SET revealed_at = ? WHERE engagement_id = ?", (ts, eid))

    # assessments
    def save_assessment(self, rec: dict):
        self._x("INSERT INTO assessments VALUES (?,?,?,?,?,?)",
                (rec["assessment_id"], rec["engagement_id"], rec["version"], rec["created_at"],
                 int(rec.get("post_reveal", False)), json.dumps(rec, default=str)))

    def assessment(self, aid: str) -> dict | None:
        r = self._q("SELECT record_json FROM assessments WHERE assessment_id = ?", (aid,))
        return json.loads(r[0]["record_json"]) if r else None

    def latest_assessment(self, eid: str) -> dict | None:
        r = self._q("SELECT record_json FROM assessments WHERE engagement_id = ? "
                    "ORDER BY version DESC LIMIT 1", (eid,))
        return json.loads(r[0]["record_json"]) if r else None

    def assessment_by_version(self, eid: str, version: int) -> dict | None:
        r = self._q("SELECT record_json FROM assessments WHERE engagement_id = ? AND version = ?",
                    (eid, version))
        return json.loads(r[0]["record_json"]) if r else None

    def assessment_list(self, eid: str) -> list[dict]:
        out = []
        for r in self._q("SELECT record_json FROM assessments WHERE engagement_id = ? "
                         "ORDER BY version", (eid,)):
            rec = json.loads(r["record_json"])
            out.append({k: rec.get(k) for k in ("assessment_id", "version", "created_at",
                                                 "change_summary", "program_source",
                                                 "post_reveal")})
        return out

    # conversation
    def api_messages(self, eid: str) -> list[dict]:
        return [{"role": r["role"], "content": json.loads(r["content_json"])}
                for r in self._q("SELECT role, content_json FROM api_messages "
                                 "WHERE engagement_id = ? ORDER BY seq", (eid,))]

    def append_api_messages(self, eid: str, msgs: list[dict]):
        with self._lock:
            for m in msgs:
                self._con.execute("INSERT INTO api_messages (engagement_id, role, content_json) "
                                  "VALUES (?,?,?)", (eid, m["role"], json.dumps(m["content"], default=str)))
            self._con.commit()

    def add_display(self, eid: str, role: str, text: str, tool_calls: list, aid: str | None,
                    ts: str, turn: dict | None = None) -> dict:
        cur = self._x("INSERT INTO display_messages (engagement_id, role, text, tool_calls_json, "
                      "assessment_id, created_at, turn_json) VALUES (?,?,?,?,?,?,?)",
                      (eid, role, text, json.dumps(tool_calls), aid, ts,
                       json.dumps(turn, default=str) if turn else None))
        return {"id": cur.lastrowid, "role": role, "text": text, "tool_calls": tool_calls,
                "assessment_id": aid, "created_at": ts, "turn": turn}

    def display_messages(self, eid: str) -> list[dict]:
        return [{"id": r["id"], "role": r["role"], "text": r["text"],
                 "tool_calls": json.loads(r["tool_calls_json"] or "[]"),
                 "assessment_id": r["assessment_id"], "created_at": r["created_at"],
                 "turn": json.loads(r["turn_json"]) if r["turn_json"] else None}
                for r in self._q("SELECT * FROM display_messages WHERE engagement_id = ? "
                                 "ORDER BY id", (eid,))]

    # decisions
    def decisions(self, aid: str) -> dict:
        return {r["row_id"]: {"disposition": r["disposition"], "note": r["note"],
                              "updated_at": r["updated_at"]}
                for r in self._q("SELECT * FROM decisions WHERE assessment_id = ?", (aid,))}

    def set_decision(self, aid: str, row_id: str, disposition, note, ts) -> dict:
        self._x("INSERT INTO decisions VALUES (?,?,?,?,?) ON CONFLICT (assessment_id, row_id) "
                "DO UPDATE SET disposition = excluded.disposition, note = excluded.note, "
                "updated_at = excluded.updated_at", (aid, row_id, disposition, note, ts))
        return {"disposition": disposition, "note": note, "updated_at": ts}

    # reveal
    def reveal(self, eid: str) -> dict | None:
        r = self._q("SELECT record_json FROM reveals WHERE engagement_id = ?", (eid,))
        return json.loads(r[0]["record_json"]) if r else None

    def save_reveal(self, eid: str, rec: dict):
        self._x("INSERT INTO reveals VALUES (?,?,?,?)",
                (eid, rec["assessment_id"], rec["revealed_at"], json.dumps(rec, default=str)))
