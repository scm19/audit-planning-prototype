"""Date-filtered evidence for one or many cases (nonprofit x audit year).

Every query here is batch-shaped: it reads temp tables `cases` and `case_programs` so the app
(one case) and the evaluation (tens of thousands) run identical SQL.

Availability rule, applied to every historical report this module returns:
    fac_accepted_date < cutoff  AND  audit_year < target_year
The target report itself is read only through `target_programs_proxy`, which selects the
allowlisted identity and amount columns of `sefa_programs`. Target findings, narratives,
corrective actions, opinions and major-program flags are never read here; they live behind
riskagent.evidence.outcomes, which the prediction path does not import.
"""
from __future__ import annotations

import datetime as dt
import threading
from collections import defaultdict
from dataclasses import dataclass, field

import duckdb

from riskagent.config import EVIDENCE_DB
from riskagent.evidence.scope import finding_scope

# The only target-report columns the prediction path may read (labeled proxy for a draft SEFA).
PROXY_ALLOWLIST = ("aln", "aln_status", "program_name", "amount", "n_award_lines", "cluster_name")


@dataclass
class Case:
    case_id: str
    org_id: str
    target_year: int
    cutoff: dt.date
    target_report_id: str | None = None  # identity only; None for a live engagement


@dataclass
class Program:
    aln: str
    name: str | None
    amount: float | None
    aln_status: str  # specific | rd | unidentified
    status: str      # proxy | provisional | manager
    cluster_name: str | None = None


@dataclass
class CaseEvidence:
    own_reports: list[dict] = field(default_factory=list)
    unavailable_reports: list[dict] = field(default_factory=list)
    coverage: dict[str, dict] = field(default_factory=dict)              # aln -> coverage
    own_findings: dict[tuple[str, str], list[dict]] = field(default_factory=dict)  # (aln, letter)
    other_program_findings: list[dict] = field(default_factory=list)     # own findings off-list
    peer_n: dict[str, dict] = field(default_factory=dict)                # aln -> {n, first, last}
    peer_k: dict[tuple[str, str], dict] = field(default_factory=dict)    # (aln, letter) -> {k, ...}
    base_rates: dict[str, float] = field(default_factory=dict)           # letter -> rate


class EvidenceDB:
    """Read-only access to app_data/evidence.duckdb. One cursor per call (thread-safe)."""

    def __init__(self, path=EVIDENCE_DB):
        self._con = duckdb.connect(str(path), read_only=True)
        self._lock = threading.Lock()
        self.snapshot_date = self._con.execute(
            "SELECT fac_snapshot_date FROM build_info").fetchone()[0]

    def cursor(self) -> duckdb.DuckDBPyConnection:
        with self._lock:
            return self._con.cursor()

    # ------------------------------------------------------------------ lookup / identity
    def search_orgs(self, q: str, limit: int = 20) -> list[dict]:
        q = (q or "").strip()
        if len(q) < 2:
            return []
        cur = self.cursor()
        rows = cur.execute("""
            SELECT org_id, name, state, n_reports, first_year, last_year, org_id_method, uei, ein
            FROM org_index
            WHERE any_nonprofit AND (all_names ILIKE '%' || ? || '%' OR uei = upper(?) OR ein = ?
                                     OR org_id = ?)
            ORDER BY (upper(name) LIKE upper(?) || '%') DESC, n_reports DESC, name
            LIMIT ?""", [q, q, q, q, q, limit]).fetchall()
        cols = ["org_id", "name", "state", "n_reports", "first_year", "last_year",
                "org_id_method", "uei", "ein"]
        return [dict(zip(cols, r)) for r in rows]

    def org(self, org_id: str) -> dict | None:
        r = self.cursor().execute(
            "SELECT org_id, name, state, uei, ein, org_id_method, any_ambiguous, n_reports "
            "FROM org_index WHERE org_id = ?", [org_id]).fetchone()
        if not r:
            return None
        return dict(zip(["org_id", "name", "state", "uei", "ein", "org_id_method",
                         "any_ambiguous", "n_reports"], r))

    def org_years(self, org_id: str) -> list[dict]:
        """Audit years with a filed report (historical), plus the next year (live)."""
        rows = self.cursor().execute("""
            SELECT audit_year, max(fy_end_date), count(*) FROM reports
            WHERE org_id = ? GROUP BY 1 ORDER BY 1""", [org_id]).fetchall()
        out = [{"audit_year": y, "fy_end_date": str(fy), "mode": "historical",
                "n_reports": n} for y, fy, n in rows]
        if rows:
            last_year, last_fy, _ = rows[-1]
            nxt = last_fy.replace(year=last_fy.year + 1) if not (
                last_fy.month == 2 and last_fy.day == 29) else last_fy.replace(
                year=last_fy.year + 1, day=28)
            out.append({"audit_year": last_year + 1, "fy_end_date": str(nxt), "mode": "live",
                        "n_reports": 0})
        return out

    def target_reports(self, org_id: str, audit_year: int) -> list[dict]:
        """Identity and dates of the org's filed report(s) for the year. No outcome columns."""
        rows = self.cursor().execute("""
            SELECT report_id, auditee_name, auditee_uei, auditee_ein, auditee_state,
                   org_id_method, fy_end_date, fac_accepted_date, total_expended
            FROM reports WHERE org_id = ? AND audit_year = ?
            ORDER BY fy_end_date DESC, fac_accepted_date DESC""", [org_id, audit_year]).fetchall()
        cols = ["report_id", "auditee_name", "auditee_uei", "auditee_ein", "auditee_state",
                "org_id_method", "fy_end_date", "fac_accepted_date", "total_expended"]
        return [dict(zip(cols, r)) for r in rows]

    # ------------------------------------------------------------------ program context
    def target_programs_proxy(self, target_report_id: str) -> list[Program]:
        """Filed target SEFA as a labeled proxy for a draft: allowlisted columns only."""
        cols = ", ".join(PROXY_ALLOWLIST)
        rows = self.cursor().execute(
            f"SELECT {cols} FROM sefa_programs WHERE report_id = ? ORDER BY amount DESC, aln",
            [target_report_id]).fetchall()
        return [Program(aln=r[0], aln_status=r[1], name=r[2], amount=r[3], status="proxy",
                        cluster_name=r[5]) for r in rows]

    def last_public_programs(self, case: Case) -> tuple[list[Program], dict | None]:
        """Programs on the latest admissible own report, marked provisional."""
        cur = self.cursor()
        latest = cur.execute("""
            SELECT report_id, audit_year, fac_accepted_date FROM reports
            WHERE org_id = ? AND audit_year < ? AND fac_accepted_date < ?
            ORDER BY audit_year DESC, fac_accepted_date DESC, report_id DESC LIMIT 1""",
                             [case.org_id, case.target_year, case.cutoff]).fetchone()
        if not latest:
            return [], None
        cols = ", ".join(PROXY_ALLOWLIST)
        rows = cur.execute(
            f"SELECT {cols} FROM sefa_programs WHERE report_id = ? ORDER BY amount DESC, aln",
            [latest[0]]).fetchall()
        progs = [Program(aln=r[0], aln_status=r[1], name=r[2], amount=r[3], status="provisional",
                         cluster_name=r[5]) for r in rows]
        return progs, {"report_id": latest[0], "audit_year": latest[1],
                       "fac_accepted_date": str(latest[2])}

    def proxy_programs_batch(self, report_ids: list[str]) -> dict[str, list[Program]]:
        """Batch form of target_programs_proxy (same allowlist) for the evaluation."""
        cols = ", ".join(PROXY_ALLOWLIST)
        out: dict[str, list[Program]] = {r: [] for r in report_ids}
        for row in self.cursor().execute(
                f"SELECT report_id, {cols} FROM sefa_programs WHERE report_id IN "
                f"(SELECT unnest(?)) ORDER BY report_id, amount DESC, aln", [report_ids]).fetchall():
            out[row[0]].append(Program(aln=row[1], aln_status=row[2], name=row[3], amount=row[4],
                                       status="proxy", cluster_name=row[6]))
        return out

    def last_public_programs_batch(self, cases: list[Case]) -> dict[str, list[Program]]:
        """Batch form of last_public_programs: latest admissible own report's programs."""
        cur = self.cursor()
        cur.execute("CREATE TEMP TABLE lp_cases (case_id VARCHAR, org_id VARCHAR, "
                    "target_year INTEGER, cutoff DATE)")
        cur.executemany("INSERT INTO lp_cases VALUES (?, ?, ?, ?)",
                        [(c.case_id, c.org_id, c.target_year, c.cutoff) for c in cases])
        cols = ", ".join("s." + c for c in PROXY_ALLOWLIST)
        out: dict[str, list[Program]] = {c.case_id: [] for c in cases}
        for row in cur.execute(f"""
            WITH latest AS (
                SELECT c.case_id, arg_max(r.report_id, (r.audit_year, r.fac_accepted_date, r.report_id)) AS rid
                FROM lp_cases c JOIN reports r ON r.org_id = c.org_id
                 AND r.audit_year < c.target_year AND r.fac_accepted_date < c.cutoff
                GROUP BY 1)
            SELECT l.case_id, {cols} FROM latest l JOIN sefa_programs s ON s.report_id = l.rid
            ORDER BY l.case_id, s.amount DESC, s.aln""").fetchall():
            out[row[0]].append(Program(aln=row[1], aln_status=row[2], name=row[3], amount=row[4],
                                       status="provisional", cluster_name=row[6]))
        cur.close()
        return out

    def program_names(self, alns: list[str]) -> dict[str, str]:
        if not alns:
            return {}
        rows = self.cursor().execute("""
            SELECT aln, mode(program_name) FROM sefa_programs WHERE aln IN (SELECT unnest(?))
            GROUP BY 1""", [alns]).fetchall()
        return dict(rows)

    # ------------------------------------------------------------------ batch evidence
    def gather(self, cases: list[Case], programs: dict[str, list[Program]]) -> dict[str, CaseEvidence]:
        """Own history and peer evidence for every case and its input programs."""
        cur = self.cursor()
        cur.execute("CREATE TEMP TABLE cases (case_id VARCHAR, org_id VARCHAR, target_year INTEGER,"
                    " cutoff DATE, target_report_id VARCHAR)")
        cur.execute("CREATE TEMP TABLE case_programs (case_id VARCHAR, aln VARCHAR)")
        cur.executemany("INSERT INTO cases VALUES (?, ?, ?, ?, ?)",
                        [(c.case_id, c.org_id, c.target_year, c.cutoff, c.target_report_id)
                         for c in cases])
        cp_rows = [(cid, p.aln) for cid, ps in programs.items() for p in ps
                   if p.aln_status != "unidentified"]
        if cp_rows:
            cur.executemany("INSERT INTO case_programs VALUES (?, ?)", sorted(set(cp_rows)))
        out = {c.case_id: CaseEvidence() for c in cases}

        # Admissible own reports, and own reports that exist but were not yet public.
        cur.execute("""
            CREATE TEMP TABLE own_reports AS
            SELECT c.case_id, r.report_id, r.audit_year, r.fac_accepted_date, r.fy_end_date,
                   r.auditor_firm_name
            FROM cases c JOIN reports r
              ON r.org_id = c.org_id AND r.audit_year < c.target_year
             AND r.fac_accepted_date < c.cutoff""")
        for row in cur.execute("""
            SELECT o.case_id, o.report_id, o.audit_year, o.fac_accepted_date, o.fy_end_date,
                   o.auditor_firm_name,
                   (SELECT count(*) FROM finding_meta m WHERE m.report_id = o.report_id),
                   (SELECT list(aln ORDER BY amount DESC) FROM sefa_programs s
                     WHERE s.report_id = o.report_id),
                   (SELECT list(aln ORDER BY aln) FROM program_audits p
                     WHERE p.report_id = o.report_id AND p.is_major)
            FROM own_reports o
            ORDER BY o.case_id, o.audit_year DESC, o.fac_accepted_date DESC, o.report_id DESC
        """).fetchall():
            out[row[0]].own_reports.append({
                "report_id": row[1], "audit_year": row[2], "fac_accepted_date": str(row[3]),
                "fy_end_date": str(row[4]), "auditor": row[5], "n_findings": row[6],
                "programs": row[7] or [], "major_programs": row[8] or []})
        # Audit years with no public report at the cutoff, between the earliest admissible own
        # report and the target. Only absence is stated: whether or when a late report was
        # later filed is post-cutoff information and is shown only after reveal.
        for c in cases:
            ev = out[c.case_id]
            have = {r["audit_year"] for r in ev.own_reports}
            if have:
                ev.unavailable_reports = [
                    {"audit_year": y, "reason": "No report for this audit year was public in FAC "
                                                "by the cutoff."}
                    for y in range(c.target_year - 1, min(have) - 1, -1) if y not in have]

        # Own coverage per input program.
        for case_id, aln, present, major, with_f in cur.execute("""
            SELECT cp.case_id, cp.aln,
                list(DISTINCT o.audit_year ORDER BY o.audit_year)
                    FILTER (WHERE s.report_id IS NOT NULL),
                list(DISTINCT o.audit_year ORDER BY o.audit_year) FILTER (WHERE pa.is_major),
                list(DISTINCT o.audit_year ORDER BY o.audit_year)
                    FILTER (WHERE fp.report_id IS NOT NULL)
            FROM case_programs cp
            JOIN own_reports o USING (case_id)
            LEFT JOIN sefa_programs s ON s.report_id = o.report_id AND s.aln = cp.aln
            LEFT JOIN program_audits pa ON pa.report_id = o.report_id AND pa.aln = cp.aln
            LEFT JOIN (SELECT DISTINCT report_id, aln FROM finding_pairs) fp
                   ON fp.report_id = o.report_id AND fp.aln = cp.aln
            GROUP BY 1, 2""").fetchall():
            out[case_id].coverage[aln] = {"years_present": present or [],
                                          "years_audited_major": major or [],
                                          "years_with_findings": with_f or []}

        # Own findings by program x requirement (one entry per finding, per program), each with
        # its scope (scope.py): an audit-wide filing finding is kept but not counted as program evidence.
        scope_cache: dict = {}
        for row in cur.execute("""
            SELECT o.case_id, fp.aln, fp.letter, o.report_id, o.audit_year, o.fac_accepted_date,
                   fp.reference_number, m.is_repeat_finding, m.is_material_weakness,
                   m.is_significant_deficiency, m.is_questioned_costs, m.n_letters, m.is_blanket,
                   m.has_text, m.has_conflicting_rows,
                   EXISTS (SELECT 1 FROM case_programs cp
                           WHERE cp.case_id = o.case_id AND cp.aln = fp.aln) AS on_list,
                   n.finding_text
            FROM own_reports o JOIN finding_pairs fp USING (report_id)
            JOIN finding_meta m USING (report_id, reference_number)
            LEFT JOIN narratives n USING (report_id, reference_number)
            ORDER BY o.case_id, o.audit_year DESC, o.report_id, fp.reference_number""").fetchall():
            ev = out[row[0]]
            fscope, why = scope_cache.setdefault((row[3], row[6]), finding_scope(row[16]))
            item = {"report_id": row[3], "audit_year": row[4], "fac_accepted_date": str(row[5]),
                    "reference_number": row[6], "is_repeat": bool(row[7]),
                    "material_weakness": bool(row[8]), "significant_deficiency": bool(row[9]),
                    "questioned_costs": bool(row[10]), "n_letters": row[11],
                    "is_blanket": bool(row[12]), "has_text": bool(row[13]),
                    "conflicting_rows": bool(row[14]), "scope": fscope, "scope_reason": why}
            if row[15]:
                ev.own_findings.setdefault((row[1], row[2]), []).append(item)
            else:
                ev.other_program_findings.append({"aln": row[1], "letter": row[2], **item})

        # Peer denominators: other nonprofits' admissible reports where the ALN was major.
        for case_id, aln, n, first, last in cur.execute("""
            SELECT cp.case_id, cp.aln, count(*), min(p.audit_year), max(p.audit_year)
            FROM case_programs cp JOIN cases c USING (case_id)
            JOIN peer_obs p ON p.aln = cp.aln AND p.audit_year < c.target_year
             AND p.fac_accepted_date < c.cutoff AND p.org_id <> c.org_id
            GROUP BY 1, 2""").fetchall():
            out[case_id].peer_n[aln] = {"n": n, "first_year": first, "last_year": last}

        # Peer numerators: distinct peer reports with a finding in the program and requirement.
        for case_id, aln, letter, k, k_specific in cur.execute("""
            SELECT cp.case_id, cp.aln, p.letter, count(*),
                   count(*) FILTER (WHERE NOT p.only_blanket)
            FROM case_programs cp JOIN cases c USING (case_id)
            JOIN peer_letter_obs p ON p.aln = cp.aln AND p.audit_year < c.target_year
             AND p.fac_accepted_date < c.cutoff AND p.org_id <> c.org_id
            GROUP BY 1, 2, 3""").fetchall():
            out[case_id].peer_k[(aln, letter)] = {"k": k, "k_excluding_blanket": k_specific}

        # Requirement base rates per target year, from reports public before Jan 1 of that
        # year (always before any cutoff in the year): the prior for smoothing.
        years = sorted({c.target_year for c in cases})
        rates = {}
        for y in years:
            start = dt.date(y, 1, 1)
            n = cur.execute("SELECT count(*) FROM peer_obs WHERE audit_year < ? AND "
                            "fac_accepted_date < ?", [y, start]).fetchone()[0]
            ks = cur.execute("SELECT letter, count(*) FROM peer_letter_obs WHERE audit_year < ? "
                             "AND fac_accepted_date < ? GROUP BY 1", [y, start]).fetchall()
            rates[y] = {letter: (k / n if n else 0.0) for letter, k in ks}
        for c in cases:
            out[c.case_id].base_rates = rates[c.target_year]
        cur.close()
        return out

    # ------------------------------------------------------------------ drill-down
    def admissible(self, case: Case, report_id: str) -> dict | None:
        """Report identity if it satisfies the availability rule for this case, else None."""
        r = self.cursor().execute("""
            SELECT report_id, org_id, auditee_name, audit_year, fac_accepted_date, fy_end_date
            FROM reports WHERE report_id = ? AND audit_year < ? AND fac_accepted_date < ?""",
                                  [report_id, case.target_year, case.cutoff]).fetchone()
        if not r:
            return None
        return dict(zip(["report_id", "org_id", "auditee_name", "audit_year",
                         "fac_accepted_date", "fy_end_date"], r))

    def finding_detail(self, case: Case, report_id: str, reference_number: str) -> dict | None:
        rep = self.admissible(case, report_id)
        if rep is None:
            return None
        cur = self.cursor()
        m = cur.execute("""
            SELECT requirement_letters, n_awards, is_material_weakness, is_significant_deficiency,
                   is_questioned_costs, is_repeat_finding, is_modified_opinion,
                   has_conflicting_rows, prior_finding_ref_numbers, is_blanket
            FROM finding_meta WHERE report_id = ? AND reference_number = ?""",
                        [report_id, reference_number]).fetchone()
        if m is None:
            return None
        alns = [a for (a,) in cur.execute(
            "SELECT DISTINCT aln FROM finding_pairs WHERE report_id = ? AND reference_number = ? "
            "ORDER BY 1", [report_id, reference_number]).fetchall()]
        n = cur.execute("SELECT finding_text, cap_text FROM narratives WHERE report_id = ? AND "
                        "reference_number = ?", [report_id, reference_number]).fetchone()
        return {
            **{k: (str(v) if isinstance(v, dt.date) else v) for k, v in rep.items()},
            "reference_number": reference_number,
            "own_report": rep["org_id"] == case.org_id,
            "programs": alns,
            "requirement_letters": m[0],
            "flags": {"n_awards": m[1], "material_weakness": m[2], "significant_deficiency": m[3],
                      "questioned_costs": m[4], "repeat_finding": m[5], "modified_opinion": m[6],
                      "conflicting_rows": m[7], "prior_finding_refs": m[8], "blanket": m[9]},
            "narrative": n[0] if n else None,
            "corrective_action": n[1] if n else None,
        }

    def peer_sample(self, case: Case, aln: str, letter: str, limit: int = 8) -> list[dict]:
        """Most recent admissible peer reports with a finding in (aln, letter), text first."""
        rows = self.cursor().execute("""
            SELECT p.report_id, r.auditee_name, r.auditee_state, p.audit_year,
                   p.fac_accepted_date, list(fp.reference_number ORDER BY fp.reference_number),
                   bool_or(m.has_text)
            FROM peer_letter_obs p JOIN reports r USING (report_id)
            JOIN finding_pairs fp ON fp.report_id = p.report_id AND fp.aln = p.aln
                                 AND fp.letter = p.letter
            JOIN finding_meta m ON m.report_id = fp.report_id
                               AND m.reference_number = fp.reference_number
            WHERE p.aln = ? AND p.letter = ? AND p.audit_year < ? AND p.fac_accepted_date < ?
              AND p.org_id <> ?
            GROUP BY ALL
            ORDER BY bool_or(m.has_text) DESC, p.audit_year DESC, p.fac_accepted_date DESC,
                     p.report_id
            LIMIT ?""", [aln, letter, case.target_year, case.cutoff, case.org_id, limit]).fetchall()
        return [{"report_id": r[0], "auditee_name": r[1], "state": r[2], "audit_year": r[3],
                 "fac_accepted_date": str(r[4]), "reference_numbers": r[5], "has_text": r[6]}
                for r in rows]

    def peer_year_counts(self, case: Case, aln: str, letter: str | None = None) -> list[dict]:
        cur = self.cursor()
        n_rows = cur.execute("""
            SELECT audit_year, count(*) FROM peer_obs WHERE aln = ? AND audit_year < ?
              AND fac_accepted_date < ? AND org_id <> ? GROUP BY 1 ORDER BY 1""",
                             [aln, case.target_year, case.cutoff, case.org_id]).fetchall()
        k_rows = dict(cur.execute("""
            SELECT audit_year, count(*) FROM peer_letter_obs WHERE aln = ? AND letter = ?
              AND audit_year < ? AND fac_accepted_date < ? AND org_id <> ? GROUP BY 1""",
                                  [aln, letter, case.target_year, case.cutoff,
                                   case.org_id]).fetchall()) if letter else {}
        return [{"audit_year": y, "n": n, "k": k_rows.get(y, 0)} for y, n in n_rows]


def group_by_case(rows, key=0):
    d = defaultdict(list)
    for r in rows:
        d[r[key]].append(r)
    return d
