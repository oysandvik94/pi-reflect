import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location("reflection_report", Path(__file__).parents[1] / "scripts" / "reflection_report.py")
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.sessions = Path(self.directory.name) / "sessions"
        self.sessions.mkdir()
        self.session = self.sessions / "session.jsonl"
        self.session.write_text(json.dumps({"type": "message", "id": "m1", "timestamp": "2026-11-06T11:00:00Z", "message": {"role": "user", "content": [{"type": "text", "text": "You preserved the details."}]}}) + "\n")
        self.citation = {"sessionFile": str(self.session), "messageId": "m1", "quote": "preserved the details"}
        self.envelope = {"startedAt": "2026-11-06T12:00:00+00:00", "status": "failed", "errors": ["Analysis failed"], "runs": [], "reportName": "self-improvement-example.html"}

    def test_failed_run_is_not_clean_result(self):
        html = report.daily(self.envelope, {}, {}, self.sessions, [])
        self.assertIn("Run health: failed", html)
        self.assertIn("Analysis failed", html)
        self.assertIn("Insufficient evidence", html)
        self.assertNotIn("0 corrections", html)

    def test_html_escapes_model_text(self):
        self.envelope["errors"] = ["<script>alert(1)</script>"]
        html = report.daily(self.envelope, {}, {}, self.sessions, [])
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_citation_matches_literal_message(self):
        self.assertTrue(report.validate_citations([self.citation], self.sessions)[0])
        self.assertFalse(report.validate_citations([{**self.citation, "quote": "invented"}], self.sessions)[0])
        self.assertFalse(report.validate_citations([{**self.citation, "messageId": "invented"}], self.sessions)[0])

    def test_citations_cannot_escape_session_archive(self):
        outside = Path(self.directory.name) / "outside.jsonl"
        outside.write_text(self.session.read_text())
        self.assertFalse(report.validate_citations([{**self.citation, "sessionFile": str(outside)}], self.sessions)[0])

    def test_pre_change_evidence_is_not_outcome(self):
        data = {"outcomes": [{"ruleId": "r1", "result": "success", "evidence": [self.citation]}]}
        history = [{"status": "success", "timestamp": "2026-11-06T12:00:00Z", "proposals": [{"ruleId": "r1", "status": "applied"}]}]
        self.assertFalse(report.verified_observations(data, self.sessions, history, {})[0]["citationValid"])
        history[0]["timestamp"] = "2026-11-06T10:00:00Z"
        self.assertTrue(report.verified_observations(data, self.sessions, history, {})[0]["citationValid"])

    def test_unknown_baseline_does_not_prove_success(self):
        data = {"outcomes": [{"ruleId": "unknown", "result": "success", "evidence": [self.citation]}]}
        self.assertFalse(report.verified_observations(data, self.sessions, [], {})[0]["citationValid"])

    def test_weekly_deduplicates_observations(self):
        observation = {"ruleId": "r1", "result": "correction", "citationValid": True, "evidence": [self.citation], "explanation": "Repeated issue"}
        first = {**self.envelope, "outcomes": [observation]}
        second = {**first, "startedAt": "2026-11-06T13:00:00+00:00"}
        html = report.weekly([first, second], datetime(2026, 11, 6, 14, tzinfo=timezone.utc))
        self.assertEqual(html.count("Repeated issue"), 1)

    def test_runner_does_not_reuse_historical_or_concurrent_results(self):
        root = Path(self.directory.name)
        reports = root / "reports"
        reports.mkdir()
        (root / "reflect-history.json").write_text(json.dumps([{"status": "success", "timestamp": report.now(), "invocationId": "someone-else"}]))
        with patch.object(report.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
            envelope = report.read_json(report.run_reflection(root, reports))
        self.assertEqual(envelope["status"], "failed")
        self.assertEqual(envelope["runs"], [])

    def test_runner_matches_invocation_not_newest_backup(self):
        root = Path(self.directory.name)
        reports = root / "reports"
        reports.mkdir()
        def invoke(command, **kwargs):
            self.assertIn("--no-extensions", command)
            self.assertIn("--no-context-files", command)
            record = {"status": "success", "timestamp": report.now(), "invocationId": kwargs["env"]["PI_REFLECT_INVOCATION_ID"]}
            (root / "reflect-history.json").write_text(json.dumps([record]))
            return SimpleNamespace(returncode=0)
        with patch.object(report.subprocess, "run", side_effect=invoke):
            envelope = report.read_json(report.run_reflection(root, reports))
        self.assertEqual(envelope["status"], "success")
        self.assertEqual(len(envelope["runs"]), 1)

    def test_skill_candidate_requires_independent_sessions(self):
        candidate = {"name": "read-example", "content": "---\nname: read-example\ndescription: Read sample facts\n---\nCompare the two observations.", "evidence": [self.citation, self.citation]}
        decisions = report.apply_skill_candidates([candidate], Path(self.directory.name), {"skills": []})
        self.assertEqual(decisions[0]["status"], "approval_required")
        self.assertFalse((Path(self.directory.name) / "skills" / "read-example").exists())

    def test_safe_skill_is_created_but_existing_is_untouched(self):
        second = self.sessions / "other.jsonl"
        second.write_text(self.session.read_text().replace('"m1"', '"m2"'))
        candidate = {"name": "read-example", "content": "---\nname: read-example\ndescription: Read sample facts\n---\nCompare the two observations.", "evidence": [self.citation, {**self.citation, "sessionFile": str(second), "messageId": "m2"}]}
        root = Path(self.directory.name)
        decisions = report.apply_skill_candidates([candidate], root, {"skills": []})
        self.assertEqual(decisions[0]["status"], "created")
        destination = root / "skills" / "read-example" / "SKILL.md"
        self.assertEqual(destination.read_text(), candidate["content"])
        candidate["content"] += "\nChanged"
        self.assertEqual(report.apply_skill_candidates([candidate], root, {"skills": []})[0]["status"], "approval_required")
        self.assertNotIn("Changed", destination.read_text())

    def test_risky_skill_is_held(self):
        second = self.sessions / "other.jsonl"
        second.write_text(self.session.read_text().replace('"m1"', '"m2"'))
        candidate = {"name": "read-example", "content": "---\nname: read-example\ndescription: Read sample facts\n---\nPush without approval.", "evidence": [self.citation, {**self.citation, "sessionFile": str(second), "messageId": "m2"}]}
        self.assertEqual(report.apply_skill_candidates([candidate], Path(self.directory.name), {"skills": []})[0]["status"], "approval_required")

    def test_weekly_excludes_old_runs(self):
        old = {**self.envelope, "startedAt": "2026-10-01T12:00:00+00:00"}
        html = report.weekly([old], datetime(2026, 11, 6, tzinfo=timezone.utc))
        self.assertNotIn("2026-10-01", html)


if __name__ == "__main__":
    unittest.main()
