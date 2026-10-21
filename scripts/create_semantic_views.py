"""Create the derived semantic tables in fac.duckdb. Raw tables are left untouched.

  org_map             report -> resolved org_id (UEI first, EIN fallback with ambiguity checks)
  finding_narratives  one assembled narrative per (report_id, finding_ref_number)
  cap_narratives      one assembled corrective-action plan per (report_id, finding_ref_number)
  findings_rollup     one row per finding (report_id, reference_number), reviewed aggregation rule
  report_labels       one row per report: prediction timestamp, history availability, outcome labels

Usage: create_semantic_views.py <fac.duckdb>
"""
import sys

import duckdb

con = duckdb.connect(sys.argv[1])

# Identity: real UEI when present. Census rows without a UEI borrow the UEI only when their EIN
# maps to exactly one UEI elsewhere; otherwise they stay keyed on EIN and are flagged.
con.execute("""
CREATE OR REPLACE TABLE org_map AS
WITH ein_uei AS (
    SELECT auditee_ein, min(auditee_uei) AS uei, count(DISTINCT auditee_uei) AS n_ueis
    FROM general
    WHERE auditee_uei <> 'GSA_MIGRATION' AND auditee_ein NOT IN ('', 'GSA_MIGRATION')
    GROUP BY 1
)
SELECT g.report_id, g.auditee_uei, g.auditee_ein, g.auditee_name, g.audit_year,
    CASE WHEN g.auditee_uei <> 'GSA_MIGRATION' THEN 'UEI:' || g.auditee_uei
         WHEN e.n_ueis = 1 THEN 'UEI:' || e.uei
         ELSE 'EIN:' || g.auditee_ein END AS org_id,
    CASE WHEN g.auditee_uei <> 'GSA_MIGRATION' THEN 'uei'
         WHEN e.n_ueis = 1 THEN 'ein_to_unique_uei'
         WHEN e.n_ueis > 1 THEN 'ein_ambiguous'
         ELSE 'ein_only' END AS org_id_method
FROM general g LEFT JOIN ein_uei e USING (auditee_ein)
""")

# Narratives: raw rows can be line-split segments of one narrative (ordered by source_row) or
# exact duplicate copies. Exact copies collapse to one; segments are concatenated in file order.
for out, src, col in [("finding_narratives", "findings_text", "finding_text"),
                      ("cap_narratives", "corrective_action_plans", "planned_action")]:
    con.execute(f"""
    CREATE OR REPLACE TABLE {out} AS
    SELECT report_id, finding_ref_number, any_value(audit_year) AS audit_year,
        count(*) AS source_rows,
        count(DISTINCT {col}) AS distinct_segments,
        min(source_row) AS first_source_row,
        CASE WHEN count(DISTINCT {col}) = 1 THEN min({col})
             ELSE string_agg({col}, chr(10) ORDER BY source_row) END AS narrative,
        CASE WHEN count(*) = 1 THEN 'single_row'
             WHEN count(DISTINCT {col}) = 1 THEN 'exact_duplicates_collapsed'
             ELSE 'segments_concatenated' END AS assembly_method,
        bool_and({col} NOT IN ('GSA_MIGRATION', '')) AS has_text
    FROM {src}
    GROUP BY report_id, finding_ref_number
    """)

# Findings: one row per finding. Requirements = union of letters across its rows; each severity
# flag = true if any row says Y. Conflicting rows at the same (finding, award) are flagged, not dropped.
con.execute("""
CREATE OR REPLACE TABLE findings_rollup AS
WITH f AS (
    SELECT *, CASE WHEN type_requirement = 'GSA_MIGRATION' THEN []::VARCHAR[]
                   ELSE regexp_extract_all(type_requirement, '[A-NP]') END AS letters
    FROM findings
), triple_conflicts AS (
    SELECT report_id, reference_number, award_reference
    FROM findings
    GROUP BY ALL
    HAVING count(DISTINCT (is_material_weakness, is_modified_opinion, is_other_findings, is_other_matters,
        prior_finding_ref_numbers, is_questioned_costs, is_repeat_finding, is_significant_deficiency,
        type_requirement)) > 1
)
SELECT f.report_id, f.reference_number, any_value(f.audit_year) AS audit_year,
    count(*) AS source_rows,
    count(DISTINCT f.award_reference) AS n_awards,
    list_sort(list(DISTINCT f.award_reference)) AS award_references,
    list_sort(list_distinct(flatten(list(f.letters)))) AS requirement_letters,
    bool_or(f.is_material_weakness = 'Y') AS is_material_weakness,
    bool_or(f.is_significant_deficiency = 'Y') AS is_significant_deficiency,
    bool_or(f.is_questioned_costs = 'Y') AS is_questioned_costs,
    bool_or(f.is_repeat_finding = 'Y') AS is_repeat_finding,
    bool_or(f.is_modified_opinion = 'Y') AS is_modified_opinion,
    bool_or(f.is_other_findings = 'Y') AS is_other_findings,
    bool_or(f.is_other_matters = 'Y') AS is_other_matters,
    string_agg(DISTINCT nullif(f.prior_finding_ref_numbers, 'N/A'), ',') AS prior_finding_ref_numbers,
    count(DISTINCT tc.award_reference) > 0 AS has_conflicting_rows,
    list_sort(list(f.source_row)) AS source_rows_list
FROM f LEFT JOIN triple_conflicts tc
    ON tc.report_id = f.report_id AND tc.reference_number = f.reference_number
   AND tc.award_reference = f.award_reference
GROUP BY f.report_id, f.reference_number
""")

# Report-level labels and availability. Prediction timestamp = target fy_end_date (audit planning
# point). A prior report counts as history only if FAC accepted it before that timestamp.
con.execute("""
CREATE OR REPLACE TABLE report_labels AS
WITH g AS (
    SELECT g.*, o.org_id, o.org_id_method,
        try_cast(g.fy_end_date AS DATE) AS prediction_ts,
        try_cast(g.fac_accepted_date AS DATE) AS accepted
    FROM general g JOIN org_map o USING (report_id)
), hist AS (
    SELECT t.report_id,
        count(p.report_id) AS n_prior_reports_available,
        max(p.audit_year) AS latest_prior_year_available
    FROM g t LEFT JOIN g p
      ON p.org_id = t.org_id AND p.report_id <> t.report_id
     AND p.accepted < t.prediction_ts AND p.audit_year < t.audit_year
    GROUP BY t.report_id
), fr AS (
    SELECT report_id, count(*) AS n_program_findings,
        list_sort(list_distinct(flatten(list(requirement_letters)))) AS requirement_letters,
        bool_or(is_material_weakness) AS any_material_weakness,
        bool_or(is_significant_deficiency) AS any_significant_deficiency,
        bool_or(is_questioned_costs) AS any_questioned_costs,
        bool_or(is_repeat_finding) AS any_repeat_finding
    FROM findings_rollup GROUP BY 1
), mp AS (
    SELECT report_id, bool_or(audit_report_type IN ('Q', 'A', 'D')) AS major_program_opinion_modified
    FROM federal_awards GROUP BY 1
)
SELECT g.report_id, g.org_id, g.org_id_method, g.auditee_name, g.entity_type, g.audit_year,
    g.data_source, g.prediction_ts, g.accepted AS fac_accepted_date,
    h.n_prior_reports_available, h.latest_prior_year_available,
    coalesce(fr.n_program_findings, 0) AS n_program_findings,
    coalesce(fr.n_program_findings, 0) > 0 AS has_program_finding,
    coalesce(fr.requirement_letters, []::VARCHAR[]) AS requirement_letters,
    coalesce(fr.any_material_weakness, false) AS any_program_material_weakness,
    coalesce(fr.any_significant_deficiency, false) AS any_program_significant_deficiency,
    coalesce(fr.any_questioned_costs, false) AS any_questioned_costs,
    coalesce(fr.any_repeat_finding, false) AS any_repeat_finding,
    g.is_internal_control_deficiency_disclosed = 'Yes' AS fs_significant_deficiency,
    g.is_internal_control_material_weakness_disclosed = 'Yes' AS fs_material_weakness,
    g.is_material_noncompliance_disclosed = 'Yes' AS fs_material_noncompliance,
    g.is_going_concern_included = 'Yes' AS going_concern,
    regexp_matches(g.gaap_results, 'qualified|adverse|disclaimer') AS fs_opinion_modified,
    coalesce(mp.major_program_opinion_modified, false) AS major_program_opinion_modified,
    'GSA_MIGRATION' NOT IN (g.is_internal_control_deficiency_disclosed,
        g.is_internal_control_material_weakness_disclosed, g.is_material_noncompliance_disclosed,
        g.is_going_concern_included, g.gaap_results) AS audit_flags_known
FROM g
LEFT JOIN hist h USING (report_id)
LEFT JOIN fr USING (report_id)
LEFT JOIN mp USING (report_id)
""")

# Evaluation population: complete nonprofit single audits with known audit-level flags.
# Negatives come from here (reports with no findings rows), never from the findings-only sample.
con.execute("""
CREATE OR REPLACE VIEW eval_population AS
SELECT r.*, (NOT r.has_program_finding AND NOT (r.fs_significant_deficiency OR r.fs_material_weakness
        OR r.fs_material_noncompliance OR r.going_concern OR r.fs_opinion_modified
        OR r.major_program_opinion_modified)) AS fully_clean
FROM report_labels r JOIN general g USING (report_id)
WHERE r.entity_type = 'non-profit' AND g.audit_type = 'single-audit' AND r.audit_flags_known
""")

for t in ["org_map", "finding_narratives", "cap_narratives", "findings_rollup", "report_labels", "eval_population"]:
    print(t, con.execute(f"SELECT count(*) FROM {t}").fetchone()[0])
con.close()
