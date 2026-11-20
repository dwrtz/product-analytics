"""Tests for scripts/cold-prune.py (run: python3 -m unittest scripts/test_cold_prune.py). No network, no pyiceberg needed."""
import importlib.util
import io
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "cold-prune.py"
spec = importlib.util.spec_from_file_location("cold_prune", SCRIPT)
cp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cp)


class ColdPrune(unittest.TestCase):
    def test_help(self):
        r = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True, env={"PATH": os.environ.get("PATH", "")})
        self.assertEqual(r.returncode, 0)
        for flag in ("--dry-run", "--warehouse", "--catalog-uri", "--retention-days", "--project-id"):
            self.assertIn(flag, r.stdout)

    def test_cutoff_matches_worker_rule(self):
        now = 1_795_000_000_000
        self.assertEqual(cp.cutoff_ms(30, now), now - 30 * 86_400_000)
        self.assertEqual(cp.cutoff_ms(365, now), now - 365 * 86_400_000)
        with self.assertRaises(ValueError):
            cp.cutoff_ms(0, now)

    def test_filter_text(self):
        self.assertEqual(cp.describe_filter(123, None), "ts < 123")
        self.assertEqual(cp.describe_filter(123, 7), "project_id = 7 AND ts < 123")

    def test_args(self):
        a = cp.parse_args(["--warehouse", "w", "--catalog-uri", "https://c", "--retention-days", "90", "--project-id", "3", "--dry-run"])
        self.assertEqual((a.warehouse, a.retention_days, a.project_id, a.dry_run, a.table), ("w", 90, 3, True, "analytics.events"))
        with redirect_stderr(io.StringIO()):
            for bad in (["--retention-days", "0"], ["--retention-days", "5", "--project-id", "0"], ["--retention-days", "5", "--table", "events"]):
                with self.assertRaises(SystemExit):
                    cp.parse_args(["--warehouse", "w", "--catalog-uri", "https://c", *bad])

    def test_token_from_env_never_printed(self):
        self.assertEqual(cp.read_token({"R2_CATALOG_TOKEN": " abc "}), "abc")
        self.assertEqual(cp.read_token({"CLOUDFLARE_API_TOKEN": "x"}), "x")
        self.assertIsNone(cp.read_token({}))
        secret = "tok_SHOULD_NOT_APPEAR_123"
        env = {"PATH": os.environ.get("PATH", ""), "R2_CATALOG_TOKEN": secret, "PYTHONPATH": "/nonexistent"}
        r = subprocess.run([sys.executable, "-S", str(SCRIPT), "--warehouse", "w", "--catalog-uri", "https://127.0.0.1:9", "--retention-days", "30", "--dry-run"], capture_output=True, text=True, env=env)
        self.assertNotIn(secret, r.stdout + r.stderr)

    def test_missing_token(self):
        r = subprocess.run([sys.executable, str(SCRIPT), "--warehouse", "w", "--catalog-uri", "https://c", "--retention-days", "30"], capture_output=True, text=True, env={"PATH": os.environ.get("PATH", "")})
        self.assertEqual(r.returncode, 2)
        self.assertIn("R2_CATALOG_TOKEN", r.stderr)


if __name__ == "__main__":
    unittest.main()
