# Pi Scholar

<p align="center">
  <img src="assets/pi-scholar-readme.png" alt="A scholar writing in a book by candlelight" width="720">
</p>

Pi Scholar is a local-first Markdown wiki and daily review application for Pi. The vault, SQLite state, source originals, quiz artifacts, and Git history stay on the machine; the HTTP server is only a loopback boundary.

Learning is page-level: each eligible wiki page has one FSRS schedule and remains addressable by its stable page ID across renames. A retained page prerequisite DAG blocks a due page until every prerequisite is in FSRS `Review`; drifted or retired pages are excluded without losing history. The daily quiz selects due pages and generates ephemeral questions (at most four, at most two synthesis questions), with every selected page covered by one single-page question and direct page evidence. The host mints opaque question UUIDs; visible Markdown headings are numeric and the only quiz comments are `<!-- pi-scholar:quiz format=1 id=<opaque> revision=<n> -->` and `<!-- pi-scholar:question id=<opaque> -->`. Grading preserves question feedback but applies exactly one bundled FSRS rating and page result per covered page.

## Install and initialize

Requirements:

- Node.js `>=22.19.0`.
- Pi coding agent with the `@earendil-works/pi-coding-agent` and `typebox` peer packages available to the Pi runtime.
- Git and Docling on `PATH` for the vault's required version checks and supported source extraction; qmd on `PATH` for semantic ranking.
- A provider configured through Pi's normal provider environment (for example, set only the provider key required by the selected Pi model, such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). Keep credentials in the service environment; never put them in vault files, arguments, cron text, or logs.

Install the package and initialize a vault:

```sh
npm install -g pi-scholar
pi install npm:pi-scholar
pi-scholar init /absolute/path/to/vault
pi-scholar doctor /absolute/path/to/vault
```

`doctor` is read-only. Fix reported failing prerequisites before running Pi skills; a qmd warning disables semantic search while exact and lexical paths remain available.

## Local server

Start the same-origin loopback API and web client only after initialization:

```sh
pi-scholar serve --vault /absolute/path/to/vault --port 4816
```

The server binds `127.0.0.1:4816` by default. It is not a public authentication or CORS boundary. If phone access is needed, run a separately owned private tunnel; do not expose this port directly. Server output belongs in an operator-owned log outside the vault.

## User-controlled cron jobs

Pi Scholar does not plan weekdays, launch Pi children, or edit a user's crontab. Choose the minute, hour, day-of-month, month, and weekday fields for each skill independently. The examples below are valid starting points; edit the first five fields on every line to fit the operator's schedule.

Create an operator-owned environment file such as `/absolute/path/to/pi-scholar.env`, mode `0600`, containing the provider variables Pi needs and a fixed absolute `PATH` that reaches Node.js, Git, qmd, and Docling (for example `export PATH=/absolute/path/to/node-bin:/absolute/path/to/qmd-bin:/absolute/path/to/docling-bin:/usr/bin`). Do not put secrets in these cron lines. Use the absolute path to the installed `pi` executable, package checkout/install, vault, and log directory.

For a package checkout, run `npm install && npm run build && npm run build:web` before pointing cron at it. Published npm installs run the same build during packaging.

```cron
# source-admission: choose its own minute/hour/day fields
0 6 * * * . /absolute/path/to/pi-scholar.env && cd /absolute/path/to/vault && /absolute/path/to/pi --no-extensions -e /absolute/path/to/pi-scholar/pi/extension.ts --no-skills --skill /absolute/path/to/pi-scholar/skills/source-admission/SKILL.md --no-context-files --no-session -p 'Process the current stable source queue sequentially with the source-admission skill and Scholar tools; report concise status.' >> /absolute/path/to/pi-scholar/logs/source-admission.log 2>&1

# wiki-maintenance: choose its own minute/hour/day fields
15 6 * * * . /absolute/path/to/pi-scholar.env && cd /absolute/path/to/vault && /absolute/path/to/pi --no-extensions -e /absolute/path/to/pi-scholar/pi/extension.ts --no-skills --skill /absolute/path/to/pi-scholar/skills/wiki-maintenance/SKILL.md --no-context-files --no-session -p 'Review the current maintenance context with the wiki-maintenance skill, publish only guarded proposals, and report concise status.' >> /absolute/path/to/pi-scholar/logs/wiki-maintenance.log 2>&1

# daily-quiz: choose its own minute/hour/day fields
0 7 * * * . /absolute/path/to/pi-scholar.env && cd /absolute/path/to/vault && /absolute/path/to/pi --no-extensions -e /absolute/path/to/pi-scholar/pi/extension.ts --no-skills --skill /absolute/path/to/pi-scholar/skills/daily-quiz/SKILL.md --no-context-files --no-session -p 'Use the current local-date quiz context with the daily-quiz skill, publish today's quiz or an explicit skip, and report concise status.' >> /absolute/path/to/pi-scholar/logs/daily-quiz.log 2>&1

# quiz-grader: choose its own minute/hour/day fields (usually event-driven or frequent)
*/15 * * * * . /absolute/path/to/pi-scholar.env && cd /absolute/path/to/vault && /absolute/path/to/pi --no-extensions -e /absolute/path/to/pi-scholar/pi/extension.ts --no-skills --skill /absolute/path/to/pi-scholar/skills/quiz-grader/SKILL.md --no-context-files --no-session -p 'Settle the current sealed quiz submission with the quiz-grader skill and Scholar tools; report concise status.' >> /absolute/path/to/pi-scholar/logs/quiz-grader.log 2>&1

# Optional, separately controlled Git push; choose its own minute/hour/day fields
30 7 * * * /absolute/path/to/bin/pi-scholar sync --vault /absolute/path/to/vault >> /absolute/path/to/pi-scholar/logs/sync.log 2>&1
```

The prompts are static. Source text, learner answers, vault state, and secrets travel through typed Scholar tools and the vault, never through Pi arguments or cron text. `--no-extensions`, `--no-skills`, `--no-context-files`, and `--no-session` prevent unrelated ambient state; `--skill` names exactly one installed skill. Keep logs outside the vault, owned by the service account, and rotate them without recording provider credentials or tool payloads.

Each schedule is independently user-owned; jobs may overlap without an ordering rule. The shared application facade owns the writer lock, validation, checkpoint, doctor boundary, and local commit; an overlap or revision conflict is reported rather than merged or force-written. A failed run leaves canonical inbox/SQLite state and local commits recoverable. Run `pi-scholar doctor /absolute/path/to/vault`, then rerun only the affected skill or `pi-scholar sync`; never replay opaque model transcripts. A sync failure leaves local commits intact, and diverged or non-fast-forward Git state is never reset, force-pushed, or automatically merged.

## Recovery and boundaries

Run `pi-scholar doctor /absolute/path/to/vault` after an interrupted command or dependency change. Source admission is idempotent by claimed physical identity and digest, quiz grading by sealed submission identity, and Git synchronization by the repository's own object state.

Source removal deletes current dependent artifacts only after a fresh preview and explicit confirmation. It does not erase Git history; recover a prior version from Git when necessary. Browser drafts and inbox staging are intentionally not commits until the corresponding durable operation succeeds.

Pi tools, the browser API, and the FIFO browser worker call the same application facade. No public user/auth system, arbitrary HTTP shell, second persistence layer, custom Pi runner, or alternate writer is provided.
