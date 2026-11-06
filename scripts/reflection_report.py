#!/usr/bin/env python3
"""Run isolated reflection and render auditable daily/rolling-week reports without a model.

--run invokes Pi once (10 minute timeout). Without --run this only renders a saved
run envelope. Observations are optional model judgments with source citations;
missing observations mean unknown outcomes, never a successful intervention.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from html import escape
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time


def now():
    return datetime.now(timezone.utc).isoformat()


def read_json(path, default=None):
    return json.loads(Path(path).read_text(encoding="utf-8")) if Path(path).exists() else default


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def text(value):
    return escape(str(value if value is not None else "unknown"))


def table(headers, rows):
    return "<table><thead><tr>" + "".join(f"<th>{text(h)}</th>" for h in headers) + "</tr></thead><tbody>" + "".join(
        "<tr>" + "".join(f"<td>{text(c)}</td>" for c in row) + "</tr>" for row in rows
    ) + "</tbody></table>"


def page(title, body):
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>{text(title)}</title><style>
:root{{color-scheme:light dark}}body{{font:16px/1.55 system-ui,sans-serif;max-width:1050px;margin:2rem auto;padding:0 1rem}}
h1{{font-size:1.8rem}}h2{{margin-top:2rem}}table{{border-collapse:collapse;width:100%;display:block;overflow:auto}}
th,td{{border:1px solid #8886;padding:.5rem;text-align:left;vertical-align:top}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;background:#8881}}
.warning{{border-left:4px solid #c88600;padding:.7rem 1rem;background:#c8860010}}details{{margin:1rem 0;border:1px solid #8886;padding:.8rem}}
summary{{cursor:pointer;font-weight:600}}.old{{border-left:3px solid #c44}}.new{{border-left:3px solid #299460}}a{{color:#468bea}}
</style></head><body><h1>{text(title)}</h1>{body}</body></html>'''


def validate_citations(citations, sessions_dir, after=None, user_only=False):
    """Validate literal evidence independently of the model's interpretation."""
    if not citations:
        return False, "No source citations"
    root = sessions_dir.resolve()
    for citation in citations:
        try:
            path = Path(citation["sessionFile"]).expanduser().resolve()
            if not path.is_relative_to(root) or path.suffix != ".jsonl":
                return False, "Citation outside the session archive"
            found = False
            with path.open(encoding="utf-8") as source:
                for line in source:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("id") != citation.get("messageId") or entry.get("type") != "message":
                        continue
                    message = entry.get("message", {})
                    content = message.get("content", [])
                    content = content if isinstance(content, str) else "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
                    quote = citation.get("quote", "")
                    found = bool(quote.strip()) and quote in content and message.get("role") in (("user",) if user_only else ("user", "assistant", "toolResult"))
                    if after:
                        found = found and datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00")) > datetime.fromisoformat(after.replace("Z", "+00:00"))
                    break
            if not found:
                return False, "Message ID or literal quotation did not match"
        except (OSError, KeyError, TypeError, ValueError):
            return False, "Invalid or unavailable citation"
    return True, "Literal citations verified; interpretation remains model judgment"


def verified_observations(data, sessions_dir, history, skills):
    changes = {}
    for run in history:
        if run.get("status") == "success" and not run.get("dryRun"):
            for proposal in run.get("proposals", []):
                if proposal.get("status") == "applied":
                    changes[proposal["ruleId"]] = run["timestamp"]
    skill_baselines = {s["name"]: s.get("first_observed") for s in skills.get("skills", [])}
    result = []
    for item in data.get("outcomes", []):
        baseline = changes.get(item.get("ruleId")) or skill_baselines.get(item.get("skill"))
        valid, reason = validate_citations(item.get("evidence", []), sessions_dir, after=baseline)
        if not baseline:
            valid, reason = False, "No recorded rule change or skill observation baseline"
        if item.get("result") not in ("success", "correction", "opportunity"):
            valid, reason = False, "Unknown outcome classification"
        result.append({**item, "citationValid": valid, "verification": reason, "baseline": baseline})
    return result


def apply_skill_candidates(candidates, agent_dir, inventory):
    """Only create new low-risk skill files; never edit existing skills or execute their text."""
    known = {s["name"] for s in inventory.get("skills", [])}
    results = []
    for candidate in candidates:
        item = {**candidate, "status": "approval_required"}
        name, content = item.get("name", ""), item.get("content", "")
        valid, reason = validate_citations(item.get("evidence", []), agent_dir / "sessions", user_only=True)
        sessions = {str(Path(e.get("sessionFile", "")).expanduser().resolve()) for e in item.get("evidence", [])}
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(content) > 12000:
            reason = "Invalid skill name or excessive content"
        elif not valid or len(sessions) < 2 or len({e.get("messageId") for e in item.get("evidence", [])}) < 2:
            reason = "Requires verified user evidence in two independent sessions"
        elif not inventory or name in known:
            reason = "Usage inventory missing or skill already exists"
        elif not content.startswith("---\n") or not re.search(r"^name:\s*" + re.escape(name) + r"\s*$", content, re.M) or not re.search(r"^description:\s*\S", content, re.M):
            reason = "Missing or mismatched skill frontmatter"
        elif re.search(r"\b(?:authoriz\w*|authoris\w*|permission\w*|approv\w*|bypass\w*|ignore\w*|secret\w*|credential\w*|sudo|deploy\w*|commit\w*|push\w*|delet\w*|remov\w*|reset\w*|drop|truncate|publish\w*|send\w*|write\w*|edit\w*|creat\w*|install\w*|execut\w*)\b|rm\s+-|curl\s|wget\s|[>|]", content, re.I):
            reason = "Potential permissions, mutations or executable instructions need approval"
        elif len([r for r in results if r["status"] == "created"]) >= 2:
            reason = "Per-run skill creation limit reached"
        else:
            root = (agent_dir / "skills").resolve()
            destination = root / name
            if destination.exists() or destination.is_symlink():
                reason = "Existing skill directory is never modified"
            else:
                destination.mkdir(parents=True, exist_ok=False)
                with (destination / "SKILL.md").open("x", encoding="utf-8") as output:
                    output.write(content)
                item["status"] = "created"
                item["createdAt"] = now()
                item["path"] = str(destination / "SKILL.md")
                known.add(name)
                reason = "Two cited sessions; new file created after conservative safety screening"
        item["decisionReason"] = reason
        results.append(item)
    return results


def daily(envelope, skills, observations, sessions_dir, history):
    runs = envelope.get("runs", [])
    body = f'<p><strong>Run health: {text(envelope["status"])}</strong> · {text(envelope.get("startedAt"))}</p>'
    body += '<p>Automatic evidence-backed learning; risky changes await approval. No change warranted is a valid result.</p>'
    errors = envelope.get("errors", []) + observations.get("failures", [])
    errors += [reason for run in runs for reason in run.get("failureReasons", [])]
    for run in runs:
        if run.get("truncatedSessions"):
            errors.append(f'{run["truncatedSessions"]} session transcript(s) were truncated; analyzed count does not imply complete coverage.')
    if errors:
        body += '<div class="warning">' + "<br>".join(text(e) for e in errors) + '</div>'
    body += '<h2>Run health</h2>' + table(
        ["Target", "Analysis / model / reasoning", "Extracted / analyzed", "Batches OK / failed", "Duration", "Usage (provider reported)"],
        [[r.get("targetPath"), f'{r.get("status", "unverified")} / {r.get("model", "unknown")} / {r.get("reasoning", "provider default")}', f'{r.get("sessionsExtracted", "?")} / {r.get("sessionsAnalyzed", "?")}',
          f'{r.get("successfulBatches", "?")} / {r.get("failedBatches", "?")}',
          f'{r.get("durationMs", 0) / 1000:.1f}s', json.dumps(r.get("usage")) if r.get("usage") else "unavailable"] for r in runs])
    proposals = [(r, p) for r in runs for p in r.get("proposals", [])]
    approvals = [(r, p) for r, p in proposals if p.get("status") == "approval_required"]
    body += '<h2>Needs your decision</h2>'
    held_skills = [s for s in envelope.get("skillChanges", []) if s.get("status") == "approval_required"]
    decisions = [[p.get("section"), p.get("approvalReason", p.get("reason"))] for _, p in approvals] + [[s.get("name"), s.get("decisionReason")] for s in held_skills]
    body += table(["Rule / skill", "Why held"], decisions) if decisions else '<p>None.</p>'
    body += '<h2>New today</h2>'
    body += table(["Applied", "Awaiting approval", "Skipped", "Proposed only", "New / previously seen evidence"], [[
        sum(p.get("status") == state for _, p in proposals) for state in ("applied", "approval_required", "skipped", "proposed")
    ] + [f'{sum(bool(e.get("isNew")) for r in runs for e in r.get("evidence", []))} / {sum(not e.get("isNew", True) for r in runs for e in r.get("evidence", []))}']])
    for r in runs:
        body += f'<p>Analysis summary (model interpretation, not an application receipt): {text(r.get("summary", ""))}</p>'
        if r.get("backupPath"):
            body += f'<p>Rollback snapshot: <code>{text(r["backupPath"])}</code></p>'
    body += '<h2>Did earlier changes help?</h2>'
    body += '<p>Edits and shorter instructions are not outcomes. Missing corrections do not establish success. Relevant opportunities require source-backed review.</p>'
    outcomes = verified_observations(observations, sessions_dir, history, skills)
    envelope["outcomes"] = outcomes
    if outcomes:
        body += table(["Rule / skill", "Observed result", "Evidence check", "Interpretation"], [[
            o.get("ruleId", o.get("skill")), o.get("result") if o["citationValid"] else "unverified",
            o["verification"], o.get("explanation", "")
        ] for o in outcomes])
    else:
        body += '<p>Insufficient evidence: no reviewed relevant opportunities supplied.</p>'
    for r in runs:
        for o in r.get("observations", []):
            body += f'<p>Engine observation: {text(json.dumps(o))}</p>'
    body += '<h2>Skills</h2><p>Reads measure discovery/use attempts, not successful application. Low usage alone does not justify removal.</p>'
    if skills:
        body += '<details><summary>Usage inventory and observation age</summary>'
        body += table(["Skill", "First observed", "Uses 7d / 30d", "Last use", "Outcome"], [[
            s["name"], s.get("first_observed", "unknown"), f'{s.get("uses_7d", 0)} / {s.get("uses_30d", 0)}',
            s.get("last_used") or "not observed", s.get("outcome", "insufficient evidence")
        ] for s in skills.get("skills", [])]) + '</details>'
    else:
        body += '<p>Usage inventory unavailable.</p>'
    for skill in envelope.get("skillChanges", []):
        valid, reason = validate_citations(skill.get("evidence", []), sessions_dir, user_only=True)
        if len({e.get("sessionFile") for e in skill.get("evidence", [])}) < 2:
            valid, reason = False, "Requires evidence from two independent sessions"
        if not valid:
            reason = "UNVERIFIED: " + reason
        body += f'<details><summary>{text(skill.get("name"))} — {text(skill.get("status", "proposed"))}</summary><p>{text(skill.get("reason"))}</p><p>{text(reason)}</p><pre>{text(skill.get("content", ""))}</pre></details>'
    body += '<h2>Audit details</h2>'
    for r, p in proposals:
        ids = set(p.get("evidenceIds", []))
        evidence = [e for e in r.get("evidence", []) if e.get("id") in ids]
        body += f'<details><summary>{text(p.get("status"))}: {text(p.get("section"))} · {text(p.get("type"))}</summary><p>{text(p.get("reason"))}</p><p>Rule ID: {text(p.get("ruleId"))}</p><pre class="old">{text(p.get("oldText", ""))}</pre><pre class="new">{text(p.get("newText", ""))}</pre>'
        body += table(["Session / message", "Timestamp", "Quotation", "Novelty"], [[f'{e.get("sessionId")} / {e.get("messageId")}', e.get("timestamp"), e.get("quote"), "new" if e.get("isNew") else "previously seen"] for e in evidence]) + '</details>'
    body += '<details><summary>Outcome citations</summary><pre>' + text(json.dumps(outcomes, indent=2)) + '</pre></details>'
    body += '<p>Historical reports remain unchanged. See the rolling weekly summary for prior runs; old backup diffs are never presented as current changes.</p>'
    return page("Pi self-improvement — " + envelope["startedAt"][:10], body)


def weekly(envelopes, end):
    start = end - timedelta(days=7)
    selected = [e for e in envelopes if start <= datetime.fromisoformat(e["startedAt"]) <= end]
    body = '<p>Rolling seven-day operational summary. This is not a causal evaluation of learning.</p>'
    body += table(["Started", "Health", "Applied", "Held for approval", "Analyzed"], [[
        e["startedAt"], e["status"], sum(r.get("editsApplied", 0) for r in e.get("runs", [])),
        sum(p.get("status") == "approval_required" for r in e.get("runs", []) for p in r.get("proposals", [])),
        sum(r.get("sessionsAnalyzed", 0) for r in e.get("runs", []))
    ] for e in selected])
    body += '<p>Session totals overlap across runs. They are not unique sessions or relevant opportunities. Historical records without explicit health are excluded, not counted as successful.</p>'
    body += '<h2>Outcome evidence</h2><p>Citations and timing are checked; outcome interpretation remains model judgment. No success rate is inferred from edit counts or silence.</p>'
    unique = {}
    for envelope in selected:
        for observation in envelope.get("outcomes", []):
            if observation.get("citationValid"):
                key = (observation.get("ruleId", observation.get("skill")), tuple(sorted((e.get("sessionFile", ""), e.get("messageId", "")) for e in observation.get("evidence", []))))
                unique[key] = observation
    if unique:
        body += table(["Rule / skill", "Reviewed outcome", "Interpretation"], [[o.get("ruleId", o.get("skill")), o.get("result"), o.get("explanation", "")] for o in unique.values()])
    else:
        body += '<p>Insufficient evidence: no verified post-change opportunities reviewed this week.</p>'
    body += '<h2>Daily reports</h2><ul>'
    for e in selected:
        name = e.get("reportName")
        if name and Path(name).name == name:
            body += f'<li><a href="{text(name)}">{text(e["startedAt"])} — {text(e["status"])}</a></li>'
    return page("Pi reflection — weekly outcomes", body + '</ul>')


def run_reflection(agent_dir, reports):
    started = now()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S-%f")
    stem = f"self-improvement-{stamp}"
    log = reports / (stem + ".log")
    errors = []
    before = time.monotonic()
    command = ["pi", "--no-extensions", "-e", str(Path(__file__).resolve().parents[1] / "extensions" / "index.ts"),
               "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
               "-p", "--no-session", "/reflect"]
    try:
        with log.open("w", encoding="utf-8") as output:
            result = subprocess.run(command, cwd="/tmp", stdout=output, stderr=subprocess.STDOUT, timeout=600,
                                    env={**os.environ, "PI_REFLECT_INVOCATION_ID": stamp})
        if result.returncode:
            errors.append(f"Reflection process exited {result.returncode}; see {log.name}.")
    except (OSError, subprocess.TimeoutExpired) as error:
        errors.append(f"Reflection invocation failed ({type(error).__name__}); see {log.name}.")
    try:
        history = read_json(agent_dir / "reflect-history.json", [])
        runs = [r for r in history if r.get("invocationId") == stamp]
    except (OSError, ValueError, KeyError, TypeError):
        runs = []
        errors.append("Current history could not be read; no success is inferred.")
    if not runs:
        errors.append("No current run record was produced. Prior history is not a result for this invocation.")
    states = [r.get("status", "unverified") for r in runs]
    status = "failed" if errors or not states or all(s == "failed" for s in states) else (
        "partial" if any(s not in ("success", "no_data") for s in states) else "success")
    envelope = {"startedAt": started, "status": status, "durationMs": round((time.monotonic() - before) * 1000),
                "runs": runs, "errors": errors, "reportName": stem + ".html"}
    path = reports / (stem + ".json")
    save_json(path, envelope)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent-dir", type=Path, default=Path.home() / ".pi" / "agent")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--run", action="store_true")
    source.add_argument("--run-file", type=Path)
    parser.add_argument("--skills", type=Path)
    parser.add_argument("--observations", type=Path)
    parser.add_argument("--apply-skills", action="store_true", help="Validate and create low-risk new skill candidates; hold risky candidates for approval")
    args = parser.parse_args()
    agent_dir = args.agent_dir.expanduser().resolve()
    reports = agent_dir / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    if args.run and agent_dir != (Path.home() / ".pi" / "agent").resolve():
        parser.error("--run uses Pi's normal agent directory; --agent-dir overrides are render-only")
    run_file = run_reflection(agent_dir, reports) if args.run else args.run_file
    envelope = read_json(run_file)
    if not envelope or Path(envelope["reportName"]).name != envelope["reportName"]:
        parser.error("Invalid run envelope or report filename")
    skills = read_json(args.skills, {}) if args.skills else {}
    observations = read_json(args.observations, {}) if args.observations else {}
    if args.apply_skills:
        if envelope.get("skillChanges"):
            parser.error("Skill candidates already processed for this run; inspect the existing decisions")
        envelope["skillChanges"] = apply_skill_candidates(observations.get("skills", []), agent_dir, skills)
        save_json(run_file, envelope)
    elif observations.get("skills") and not envelope.get("skillChanges"):
        envelope["skillChanges"] = [{**s, "status": "proposed"} for s in observations["skills"]]
    html = reports / envelope["reportName"]
    history = read_json(agent_dir / "reflect-history.json", [])
    html.write_text(daily(envelope, skills, observations, agent_dir / "sessions", history), encoding="utf-8")
    save_json(run_file, envelope)
    envelopes = []
    for path in reports.glob("self-improvement-*.json"):
        data = read_json(path, {})
        if "startedAt" in data and "runs" in data:
            envelopes.append(data)
    week = reports / ("reflection-weekly-" + envelope["startedAt"][:10] + ".html")
    week.write_text(weekly(envelopes, datetime.fromisoformat(envelope["startedAt"])), encoding="utf-8")
    print(json.dumps({"status": envelope["status"], "runFile": str(run_file), "report": str(html), "weekly": str(week)}))
    return 0 if envelope["status"] == "success" else 1


if __name__ == "__main__":
    sys.exit(main())
