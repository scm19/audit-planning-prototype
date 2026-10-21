"""Load the five FAC CSVs into a DuckDB database, all columns as text (keeps GSA_MIGRATION
and leading zeros intact). Each table gets source_row: the 1-based row position in its CSV,
so repeated narrative segments keep their original order.

Usage: build_duckdb.py <data_dir> <out.duckdb>
"""
import sys
from pathlib import Path

import duckdb

data_dir, out = Path(sys.argv[1]), sys.argv[2]
TABLES = ["general", "federal_awards", "findings", "findings_text", "corrective_action_plans"]

con = duckdb.connect(out)
con.execute("SET preserve_insertion_order = true")
for t in TABLES:
    path = str(data_dir / f"{t}.csv")
    con.execute(f"""
        CREATE OR REPLACE TABLE {t} AS
        SELECT row_number() OVER () AS source_row, *
        FROM read_csv('{path}', all_varchar = true, header = true, quote = '"', escape = '"',
                      strict_mode = true, parallel = false)
    """)
    n = con.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
    print(t, n)
con.close()
