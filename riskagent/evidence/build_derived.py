"""Build app_data/evidence.duckdb from the read-only FAC database.

The FAC database is attached READ_ONLY and never modified. The derived store splits fields by
role so the prediction path can be audited:

  reports          identity and dates for every report (no outcome columns)
  org_index        one row per resolved organization, for search
  sefa_programs    ALLOWLISTED program identity + amounts per report x ALN (no is_major, no
                   findings_count, no audit_report_type). The only table the target's own
                   rows are read from, and only as a labeled proxy for a draft SEFA.
  program_audits   per report x ALN: whether it was a major program (an audit outcome; read only
                   for admissible prior reports)
  finding_meta     one row per finding (from findings_rollup) with flags and text availability
  finding_pairs    one row per finding x ALN x requirement letter (deduplicated within a program)
  peer_obs         nonprofit report x ALN observations where the ALN was a major program
  peer_letter_obs  peer_obs rows that reported a finding in a requirement letter
  narratives       assembled finding text and corrective-action text

Usage: .venv/bin/python -I riskagent/evidence/build_derived.py
"""
import sys
import time
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from riskagent.config import BLANKET_LETTERS, EVIDENCE_DB, FAC_DB  # noqa: E402

STEPS = [
    ("reports", """
    CREATE TABLE reports AS
    SELECT r.report_id, r.org_id, r.org_id_method, r.auditee_name,
        nullif(g.auditee_uei, 'GSA_MIGRATION') AS auditee_uei,
        nullif(nullif(g.auditee_ein, 'GSA_MIGRATION'), '') AS auditee_ein,
        nullif(g.auditee_state, 'GSA_MIGRATION') AS auditee_state,
        nullif(g.auditee_city, 'GSA_MIGRATION') AS auditee_city,
        r.entity_type, r.entity_type = 'non-profit' AS is_nonprofit,
        CAST(r.audit_year AS INTEGER) AS audit_year,
        r.prediction_ts AS fy_end_date, r.fac_accepted_date, r.data_source,
        nullif(g.auditor_firm_name, 'GSA_MIGRATION') AS auditor_firm_name,
        try_cast(g.total_amount_expended AS DOUBLE) AS total_expended
    FROM fac.report_labels r JOIN fac.general g USING (report_id)
    """),
    ("org_index", """
    CREATE TABLE org_index AS
    SELECT org_id, arg_max(auditee_name, (audit_year, fac_accepted_date)) AS name,
        arg_max(auditee_state, (audit_year, fac_accepted_date)) AS state,
        max(auditee_uei) AS uei, max(auditee_ein) AS ein, any_value(org_id_method) AS org_id_method,
        bool_or(org_id_method = 'ein_ambiguous') AS any_ambiguous,
        count(*) AS n_reports, min(audit_year) AS first_year, max(audit_year) AS last_year,
        bool_or(is_nonprofit) AS any_nonprofit,
        string_agg(DISTINCT upper(auditee_name), ' | ') AS all_names
    FROM reports GROUP BY org_id
    """),
    ("sefa_programs", """
    CREATE TABLE sefa_programs AS
    SELECT report_id,
        federal_agency_prefix || '.' || federal_award_extension AS aln,
        CASE WHEN regexp_full_match(federal_agency_prefix, '[0-9]{2}')
                  AND regexp_full_match(federal_award_extension, '[0-9]{3}[A-Z]?') THEN 'specific'
             WHEN federal_award_extension = 'RD' THEN 'rd'
             ELSE 'unidentified' END AS aln_status,
        mode(federal_program_name) AS program_name,
        sum(coalesce(try_cast(amount_expended AS DOUBLE), 0)) AS amount,
        count(*) AS n_award_lines,
        mode(nullif(nullif(cluster_name, 'N/A'), '')) AS cluster_name
    FROM fac.federal_awards GROUP BY ALL
    """),
    ("program_audits", """
    CREATE TABLE program_audits AS
    SELECT report_id, federal_agency_prefix || '.' || federal_award_extension AS aln,
        bool_or(is_major = 'Y') AS is_major
    FROM fac.federal_awards GROUP BY ALL
    """),
    ("finding_meta", f"""
    CREATE TABLE finding_meta AS
    SELECT f.report_id, f.reference_number, f.n_awards, f.requirement_letters,
        len(f.requirement_letters) AS n_letters,
        len(f.requirement_letters) >= {BLANKET_LETTERS} AS is_blanket,
        f.is_material_weakness, f.is_significant_deficiency, f.is_questioned_costs,
        f.is_repeat_finding, f.is_modified_opinion, f.has_conflicting_rows,
        f.prior_finding_ref_numbers,
        coalesce(n.has_text, false) AS has_text, coalesce(c.has_text, false) AS has_cap_text
    FROM fac.findings_rollup f
    LEFT JOIN fac.finding_narratives n
           ON n.report_id = f.report_id AND n.finding_ref_number = f.reference_number
    LEFT JOIN fac.cap_narratives c
           ON c.report_id = f.report_id AND c.finding_ref_number = f.reference_number
    """),
    ("finding_pairs", """
    CREATE TABLE finding_pairs AS
    WITH u AS (
        SELECT report_id, reference_number, unnest(award_references) AS award_reference
        FROM fac.findings_rollup
    ), fp AS (
        SELECT DISTINCT u.report_id, u.reference_number,
            fa.federal_agency_prefix || '.' || fa.federal_award_extension AS aln
        FROM u JOIN fac.federal_awards fa USING (report_id, award_reference)
    )
    SELECT fp.report_id, fp.reference_number, fp.aln, l.letter, m.is_blanket
    FROM fp JOIN finding_meta m USING (report_id, reference_number),
         unnest(m.requirement_letters) AS l(letter)
    """),
    ("peer_obs", """
    CREATE TABLE peer_obs AS
    SELECT pa.report_id, r.org_id, r.audit_year, r.fac_accepted_date, pa.aln
    FROM program_audits pa JOIN reports r USING (report_id)
    WHERE pa.is_major AND r.is_nonprofit
    """),
    ("peer_letter_obs", """
    CREATE TABLE peer_letter_obs AS
    SELECT po.report_id, po.org_id, po.audit_year, po.fac_accepted_date, po.aln, fp.letter,
        count(DISTINCT fp.reference_number) AS n_findings,
        bool_and(fp.is_blanket) AS only_blanket
    FROM peer_obs po JOIN finding_pairs fp USING (report_id, aln)
    GROUP BY ALL
    """),
    ("narratives", """
    CREATE TABLE narratives AS
    SELECT coalesce(n.report_id, c.report_id) AS report_id,
        coalesce(n.finding_ref_number, c.finding_ref_number) AS reference_number,
        CASE WHEN n.has_text THEN n.narrative END AS finding_text,
        CASE WHEN c.has_text THEN c.narrative END AS cap_text,
        n.assembly_method AS finding_assembly, c.assembly_method AS cap_assembly
    FROM fac.finding_narratives n
    FULL OUTER JOIN fac.cap_narratives c
      ON c.report_id = n.report_id AND c.finding_ref_number = n.finding_ref_number
    """),
]

INDEXES = [
    "CREATE INDEX reports_org ON reports (org_id)",
    "CREATE INDEX reports_id ON reports (report_id)",
    "CREATE INDEX sefa_report ON sefa_programs (report_id)",
    "CREATE INDEX pa_report ON program_audits (report_id)",
    "CREATE INDEX fm_report ON finding_meta (report_id)",
    "CREATE INDEX fp_report ON finding_pairs (report_id)",
    "CREATE INDEX po_aln ON peer_obs (aln)",
    "CREATE INDEX plo_aln ON peer_letter_obs (aln)",
    "CREATE INDEX narr_report ON narratives (report_id)",
]


def main() -> None:
    EVIDENCE_DB.parent.mkdir(parents=True, exist_ok=True)
    tmp = EVIDENCE_DB.with_suffix(".building.duckdb")
    tmp.unlink(missing_ok=True)
    con = duckdb.connect(str(tmp))
    con.execute(f"ATTACH '{FAC_DB}' AS fac (READ_ONLY)")
    for name, sql in STEPS:
        t = time.time()
        con.execute(sql)
        n = con.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
        print(f"{name:16s} {n:>10,d} rows  {time.time() - t:5.1f}s", flush=True)
    for sql in INDEXES:
        con.execute(sql)
    snapshot = con.execute("SELECT max(fac_accepted_date) FROM reports").fetchone()[0]
    con.execute("CREATE TABLE build_info AS SELECT ? AS fac_snapshot_date, now() AS built_at",
                [snapshot])
    con.execute("DETACH fac")
    con.close()
    tmp.replace(EVIDENCE_DB)
    print(f"wrote {EVIDENCE_DB} (FAC snapshot {snapshot})")


if __name__ == "__main__":
    main()
