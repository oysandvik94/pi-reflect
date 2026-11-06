<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://github.com/jo-inc/pi-reflect/stargazers"><img src="https://img.shields.io/github/stars/jo-inc/pi-reflect" alt="GitHub stars" /></a>
</p>
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo-dark.png" width="300">
    <img src="logo.png" alt="pi-reflect" width="300">
  </picture>
</p>

# pi-reflect

Iterative self-improvement for [pi](https://github.com/badlogic/pi-mono) coding agents.

Define a target — how your agent should behave, what it should remember, who it should be — and reflect iterates toward it. Each run reads recent conversations and reference material, compares the agent's actual behavior against the target, and makes surgical edits to close the gap.

**define the target → inspect evidence → apply safe additions or hold proposals → evaluate later outcomes.**

Works on any markdown file: behavioral rules (`AGENTS.md`), long-term memory (`MEMORY.md`), personality (`SOUL.md`), or anything else.

## Install

```bash
pi install git:github.com/oysandvik94/pi-reflect
```

Requires Pi with model authentication configured. Large transcript sets use multiple calls. Run records report actual provider usage when available; subscription usage is not an exact bill.

## Usage

```
/reflect ./AGENTS.md        # run reflection on a file
/reflect                    # use saved default target
/reflect-config             # show configured targets
/reflect-history            # show recent runs
/reflect-stats              # run health, descriptive rates, and rule churn
/reflect-backfill           # bootstrap stats for all historical sessions
```

First run asks if you want to save the target. After that, just `/reflect`.

## How it works

1. Collects evidence: conversation transcripts, daily logs, reference files — from any combination of sources
2. Sends the evidence + the target file + a prompt describing the desired end state to an LLM
3. The LLM identifies gaps between actual behavior and the target, proposes surgical edits
4. Proposals cite literal user messages with stable evidence identifiers. Automatic additions require independent new evidence from at least two sessions. Previously applied evidence is not reused as a new correction.
5. Replacements, removals, merges, and potentially sensitive additions are held for human approval. Safety screening is conservative, not a proof of semantic correctness. Pending proposals retain their exact text and reasons in history; approval means reviewing and manually applying the specific change, not disabling the gate.
6. All batches are staged in memory. Any analysis failure prevents the run from applying changes. Successful writes verify the target has not changed and create a rollback snapshot first. Dry runs never edit targets or create backups. Reflection never commits or pushes.

Improvement is a hypothesis to evaluate against subsequent relevant tasks, not a consequence of editing instructions. No change warranted is a successful analysis. File size and edit counts are descriptive only.

## Data sources

Each target has two input channels — `transcripts` (what happened) and `context` (reference material). Both accept an array of sources:

| Type | Description | Example |
|------|-------------|---------|
| `files` | Glob patterns or file paths, pruned by date and size | Daily logs, notes, other markdown files |
| `command` | Shell command, stdout captured | API calls, database queries, custom scripts |
| `url` | HTTP GET, response body captured | REST endpoints, health checks |

All sources support `{lookbackDays}` interpolation and per-source `maxBytes` caps. File sources are automatically pruned to only include files within the `lookbackDays` window (matched by date in filename).

```json
{
  "targets": [{
    "path": "/data/me/MEMORY.md",
    "model": "anthropic/claude-sonnet-4-5",
    "lookbackDays": 1,
    "transcripts": [
      { "type": "command", "label": "conversations", "command": "curl -s http://localhost:3001/conversation/recent?days={lookbackDays}", "maxBytes": 400000 }
    ],
    "context": [
      { "type": "files", "label": "daily logs", "paths": ["/data/me/daily/*.md"], "maxBytes": 50000 },
      { "type": "files", "label": "notes", "paths": ["/data/me/notes/*.md"], "maxBytes": 50000 }
    ],
    "prompt": "..."
  }]
}
```

For the common case of local pi sessions, just use `transcriptSource`:

```json
{ "transcriptSource": { "type": "pi-sessions" } }
```

## Prompts define the target

Each target has an optional `prompt` field that tells reflect *what to optimize for*. The same engine drives very different behaviors depending on the prompt:

| Target | Prompt goal | What reflect does |
|--------|------------|-------------------|
| `AGENTS.md` | Behavioral correctness | Strengthens violated rules, adds rules for recurring patterns |
| `MEMORY.md` | Factual completeness | Extracts durable facts from conversations, removes stale entries |
| `SOUL.md` | Identity convergence | Sharpens personality from generic to specific based on interaction patterns |

Prompts use `{fileName}`, `{targetContent}`, `{transcripts}`, and `{context}` as placeholders:

```json
{
  "prompt": "You are evolving an AI identity file ({fileName})...\n\n## Current\n{targetContent}\n\n## Conversations\n{transcripts}\n\n## Reference\n{context}"
}
```

If no prompt is set, the default targets behavioral corrections (the original use case).

## Run health and outcomes

`/reflect-stats` shows successful-analysis correction counts and rule churn. It does **not** infer improvement from corrections/session or resolution from a section being edited once. Rolling windows overlap, task mix changes, and missing corrections do not prove success.

Run history distinguishes `success`, `partial`, `failed`, and `no_data`, extracted versus analyzed sessions, successful/failed batches, proposed/applied/skipped/held changes, duration, and available provider usage. Failed and partial runs have no correction rate. Historical entries without explicit health remain unverified; they are not rewritten or promoted to successful results.

`/reflect-backfill` analyzes historical sessions without changing targets or marking evidence handled. It still records its dry-run analysis in history.

### Daily and weekly reports

Python 3 renders standalone HTML with no network assets or model call:

```sh
python3 scripts/reflection_report.py --run
# Output JSON identifies the new run envelope, daily HTML, and rolling-week HTML.
python3 scripts/reflection_report.py --run-file /path/to/run.json \
  --skills /path/to/skill-usage.json --observations /path/to/observations.json
```

`--run` executes only this extension, without other extensions, skills, tools, templates, or context files, with a ten-minute timeout. Current-run records, not the newest backup, determine today's changes. Historical HTML is preserved. Reports lead with health, decisions, new changes, and outcomes; full diffs and citations are collapsible.

Optional observation JSON has `outcomes`, `skills`, and `failures` arrays. Outcomes contain a `ruleId` or `skill`, `result` (`opportunity`, `success`, or `correction`), `explanation`, and `evidence`: objects with `sessionFile`, `messageId`, and literal `quote`. The renderer checks archive boundaries, message IDs, quotations, and that evidence follows the recorded rule change or skill observation baseline. Interpretation remains model judgment. Skill first-observed dates are not creation dates. Unknown opportunities and outcomes remain unknown.

New skill candidates use `name`, complete `content` (including frontmatter), `reason`, and the same evidence shape. `--apply-skills` creates at most two new low-risk skills with verified user evidence from independent sessions. It never alters existing skills, executes skill content, or treats inactivity as grounds for removal. Potential permissions, mutations, and executable instructions are held for approval. Read existing skill descriptions before proposing a candidate; the mechanical validator cannot establish semantic novelty.

Rolling weekly reports deduplicate reviewed outcome citations and link daily details. They do not compute a success rate from overlapping session counts or infer savings. Run costs cover nested reflection only; scheduler, digest review, and skill analysis overhead are separate.

## Configuration

`~/.pi/agent/reflect.json`:

```json
{
  "targets": [{
    "path": "/path/to/AGENTS.md",
    "model": "anthropic/claude-sonnet-4-5",
    "lookbackDays": 1,
    "maxSessionBytes": 614400,
    "backupDir": "~/.pi/agent/reflect-backups",
    "transcriptSource": { "type": "pi-sessions" }
  }]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `path` | *(required)* | Target markdown file to iterate on |
| `model` | *(required)* | LLM to use (e.g. `anthropic/claude-sonnet-4-5`) |
| `reasoning` | provider default | Explicit supported reasoning level; set this for models that reject the provider default |
| `lookbackDays` | `1` | How far back to look for evidence |
| `maxSessionBytes` | `614400` | Max transcript bytes per run |
| `transcripts` | — | Array of `ContextSource` for transcript data |
| `transcriptSource` | `pi-sessions` | Legacy single source (use `transcripts` for multiple) |
| `context` | — | Array of `ContextSource` for reference material |
| `prompt` | *(default)* | Custom prompt with `{fileName}`, `{targetContent}`, `{transcripts}`, `{context}` |
| `backupDir` | `~/.pi/agent/reflect-backups` | Where to store pre-edit backups |

## Related

- **[pi-mem](https://github.com/jo-inc/pi-mem)** — Memory system for pi agents. Manages MEMORY.md, daily logs, notes, and scratchpad with context injection and keyword search. Pairs naturally with pi-reflect.

## Scheduling

```bash
pi -p --no-session "/reflect /path/to/AGENTS.md"
```

Works with cron, launchd, or any scheduler. Ask your pi to set it up for you — there's a [setup guide for agents](SETUP.md).

## Development

```bash
git clone https://github.com/jo-inc/pi-reflect && cd pi-reflect
npm install && npm test
python3 -m unittest discover -s tests -p '*_test.py'
pi -e ./extensions/index.ts   # test locally without installing
```

## License

MIT

## Pi Ecosystem

| Package | Description |
|---------|-------------|
| [pi-mem](https://github.com/jo-inc/pi-mem) | Persistent markdown memory for coding agents |
| [pi-boss](https://github.com/skyfallsin/pi-boss) | Multi-agent orchestration via tmux |
| [pi-room](https://github.com/skyfallsin/pi-room) | Multi-agent awareness and coordination |
| [pi-vertex-anthropic](https://github.com/skyfallsin/pi-vertex-anthropic) | Claude via Google Cloud Vertex AI |
| [pi-skill-posthog](https://github.com/skyfallsin/pi-skill-posthog) | PostHog analytics skill for pi agents |
