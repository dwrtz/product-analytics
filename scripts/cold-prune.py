#!/usr/bin/env python3
"""Physically delete cold-tier events past retention (design.md "Cold tier: retention and pruning").

The Worker never reads cold rows older than a project's retention (every Basin SQL query it builds carries
`project_id = <id> AND ts >= <cutoff>`), but it cannot delete Iceberg data files itself. This script does, from a
machine or CI job, with PyIceberg against the Cloudflare R2 Data Catalog REST endpoint:

  1. loads the events table (default analytics.events) from the catalog;
  2. deletes rows with ts < now - retention_days (optionally only for one --project-id) via Iceberg row-level delete,
     which writes a new snapshot without those rows;
  3. optionally expires snapshots older than --expire-older-than-days so the removed files stop being referenced
     (R2 Data Catalog's own snapshot expiration and compaction then reclaim them).

The catalog token is read from the environment (R2_CATALOG_TOKEN, else CLOUDFLARE_API_TOKEN). It is never printed,
logged or written anywhere. Requires `pip install "pyiceberg[pyarrow]>=0.9"` for real runs; --help and the tests
do not need it.

  R2_CATALOG_TOKEN=... python3 scripts/cold-prune.py --warehouse <account>_<bucket> \\
      --catalog-uri https://catalog.cloudflarestorage.com/<account>/<bucket> --retention-days 365 [--project-id 3] --dry-run
"""
from __future__ import annotations

import argparse
import os
import sys
import time

DAY_MS = 86_400_000
TOKEN_VARS = ("R2_CATALOG_TOKEN", "CLOUDFLARE_API_TOKEN")


def cutoff_ms(retention_days: int, now_ms: int | None = None) -> int:
    """Epoch milliseconds before which events are past retention (same rule as the Worker: now - days * 86400000)."""
    if retention_days < 1:
        raise ValueError("retention-days must be at least 1 (0 means keep forever: nothing to prune)")
    now = int(time.time() * 1000) if now_ms is None else int(now_ms)
    return now - retention_days * DAY_MS


def describe_filter(cutoff: int, project_id: int | None) -> str:
    """Human-readable form of the delete predicate (the same one built with PyIceberg expressions)."""
    s = f"ts < {cutoff}"
    return s if project_id is None else f"project_id = {project_id} AND {s}"


def build_filter(cutoff: int, project_id: int | None):
    from pyiceberg.expressions import And, EqualTo, LessThan  # imported lazily so --help works without pyiceberg

    f = LessThan("ts", cutoff)
    return f if project_id is None else And(EqualTo("project_id", int(project_id)), f)


def read_token(env=os.environ) -> str | None:
    for k in TOKEN_VARS:
        v = env.get(k)
        if v and v.strip():
            return v.strip()
    return None


def parse_args(argv=None):
    p = argparse.ArgumentParser(prog="cold-prune.py", description="Delete cold-tier (R2 Iceberg) events older than the retention window.",
                                epilog="The catalog token comes from R2_CATALOG_TOKEN or CLOUDFLARE_API_TOKEN and is never printed.")
    p.add_argument("--warehouse", required=True, help="R2 Data Catalog warehouse name, e.g. <account id>_<bucket>")
    p.add_argument("--catalog-uri", required=True, help="R2 Data Catalog REST URI, e.g. https://catalog.cloudflarestorage.com/<account id>/<bucket>")
    p.add_argument("--retention-days", required=True, type=int, help="delete events older than this many days (same value as the project's retention)")
    p.add_argument("--project-id", type=int, default=None, help="only prune this project's rows (default: every project)")
    p.add_argument("--table", default="analytics.events", help="namespace.table of the events table (default analytics.events)")
    p.add_argument("--expire-older-than-days", type=int, default=None, help="after deleting, expire snapshots older than N days (needs pyiceberg >= 0.10)")
    p.add_argument("--dry-run", action="store_true", help="count matching data files and rows; change nothing")
    a = p.parse_args(argv)
    if a.retention_days < 1:
        p.error("--retention-days must be at least 1")
    if a.project_id is not None and a.project_id < 1:
        p.error("--project-id must be a positive integer")
    if "." not in a.table:
        p.error("--table must be namespace.table")
    return a


def main(argv=None) -> int:
    a = parse_args(argv)
    token = read_token()
    if not token:
        print(f"set {TOKEN_VARS[0]} (or {TOKEN_VARS[1]}) to an R2 Data Catalog API token", file=sys.stderr)
        return 2
    cut = cutoff_ms(a.retention_days)
    where = describe_filter(cut, a.project_id)
    try:
        from pyiceberg.catalog.rest import RestCatalog
    except ImportError:
        print('pyiceberg is not installed: pip install "pyiceberg[pyarrow]>=0.9"', file=sys.stderr)
        return 2
    catalog = RestCatalog(name="r2", warehouse=a.warehouse, uri=a.catalog_uri, token=token)
    table = catalog.load_table(a.table)
    flt = build_filter(cut, a.project_id)
    print(f"table {a.table}: deleting rows where {where} ({time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(cut / 1000))})")
    scan = table.scan(row_filter=flt, selected_fields=("project_id", "ts"))
    tasks = list(scan.plan_files())
    rows = sum(t.file.record_count for t in tasks)
    print(f"{len(tasks)} data file(s) contain matching rows; up to {rows} row(s) in those files")
    if a.dry_run:
        exact = scan.to_arrow().num_rows if tasks else 0
        print(f"dry run: {exact} row(s) would be deleted; nothing changed")
        return 0
    if not tasks:
        print("nothing to delete")
        return 0
    table.delete(delete_filter=flt)
    print(f"deleted; new snapshot {table.refresh().current_snapshot().snapshot_id}")
    if a.expire_older_than_days is not None:
        from datetime import datetime, timedelta, timezone
        older = datetime.now(timezone.utc) - timedelta(days=a.expire_older_than_days)
        maint = getattr(table, "maintenance", None)
        if maint is None or not hasattr(maint, "expire_snapshots"):
            print("this pyiceberg has no snapshot expiration; rely on R2 Data Catalog snapshot expiration", file=sys.stderr)
        else:
            maint.expire_snapshots().older_than(older).commit()
            print(f"expired snapshots older than {a.expire_older_than_days} day(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
