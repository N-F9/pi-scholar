# Pi Scholar

<p align="center">
  <img src="assets/pi-scholar-readme.png" alt="A scholar writing in a book by candlelight" width="720">
</p>

Pi Scholar is a local-first, single-user, single-writer Markdown wiki and daily review application. User-owned Pi sessions run its skills; Pi Scholar never launches Pi or owns schedules. The vault, SQLite state, source originals, quiz artifacts, and Git history stay on the machine; the HTTP server is only a loopback boundary.

Learning is page-level: each eligible wiki page has one FSRS schedule and remains addressable by its stable page ID across renames. A retained page prerequisite DAG blocks a due page until every prerequisite is in FSRS `Review`; drifted or retired pages are excluded without losing history. The daily skill sees every compact due, prerequisite-unblocked, non-drifted candidate, chooses a varied related subset, and retrieves authoritative evidence for it. It targets 15–45 minutes of combined reading and questions, with a mental median near 30 minutes, but imposes no fixed question or page count. Questions are `free-response` or `multiple-choice`; multiple questions may cover one page and a question may connect related pages. Every covered page receives one bundled result, rating, review, and FSRS transition when the sealed revision is graded. The host mints opaque question UUIDs; visible Markdown headings are numeric and the only quiz comments are `<!-- pi-scholar:quiz format=1 id=<opaque> revision=<n> -->` and `<!-- pi-scholar:question id=<opaque> -->`.
Eligible pages require non-empty OKF frontmatter `description` and non-empty renderable body; candidate title and description guide selection only and never ground questions. Headings are optional evidence boundaries: a non-empty headingless page returns page-level evidence and a reading link without a fragment, while page ID remains the sole FSRS and grading unit.

Schema v5 is the only supported database schema.

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

`doctor` is read-only. It validates the schema (v5), the strict OKF v0.2 wiki, and path prerequisites. Fix reported failing prerequisites before running Pi skills; a qmd warning disables semantic search while exact and lexical paths remain available.

Source capture accepts documents, URLs, pasted text, code, directories, and repositories without a fixed product source-size limit. Handling is streamed or disk-backed and bounded by available free space, operation time, and model/context limits. Derived Markdown normalizes blank-line runs fence-aware while preserving original bytes. Direct notes use the guarded wiki mutation path and do not become source packets.
Ordinary files and directories may be copied directly into `inbox/`. `/scholar-add` instead creates an internal directory containing a `.pi-scholar-source.json` envelope and its payload; keep that directory intact while it is queued or extracting. Imperfect OCR may orient later work, but garbled or absent formulas and facts are omitted or recorded as issues until an immutable chunk from a better source supports them.

## Local server

Start the same-origin loopback API and web client only after initialization:

```sh
pi-scholar serve --vault /absolute/path/to/vault --port 4816
```

The server binds `127.0.0.1:4816` by default. It is not a public authentication or CORS boundary. If phone access is needed, use a separately managed private tunnel such as Tailscale; tunnels, reverse proxies, authentication, DNS, and network policy remain operator-owned external context, not Pi Scholar integration, identity, trust boundary, dependency, or feature. HTTP(S) source URLs may target local, private, or Tailscale destinations when allowed by local-user/model trust; timeout, redirect, and streaming protections still apply. Server output belongs in an operator-owned log outside the vault.

## Pi commands

The installed Pi extension exposes four namespaced commands:

- `/scholar-add` stages one URL, pasted `text:`, or one or more filesystem paths (including directories and native glob patterns), such as `/scholar-add books/*.pdf`, `/scholar-add books/`, or `/scholar-add books/book1.pdf books/book2.pdf`.
- `/scholar-issue` records an incorrect, unclear, missing, or badly bounded wiki item.
- `/scholar-status` reports bounded vault, workflow, learning, doctor, and Git facts.
- `/scholar-lint` requests a full or targeted final organizer/repair pass.

Commands and skills use ScholarApplication for durable operations; they do not create a second writer or scheduler.

## User-controlled cron jobs

Pi Scholar never plans weekdays, launches Pi, or edits a user's crontab. Choose the minute, hour, day-of-month, month, and weekday fields for each skill independently. The examples below are valid starting points; edit the first five fields on every line to fit the operator's schedule.

Create an operator-owned environment file such as `/absolute/path/to/pi-scholar.env`, mode `0600`, containing the provider variables Pi needs and a fixed absolute `PATH` that reaches Node.js, Git, qmd, and Docling (for example `export PATH=/absolute/path/to/node-bin:/absolute/path/to/qmd-bin:/absolute/path/to/docling-bin:/usr/bin`). Do not put secrets in these cron lines. Use the absolute path to the installed `pi` executable, package checkout/install, vault, and log directory.

For a package checkout, run `npm install && npm run build && npm run build:web` before pointing cron at it. Published npm installs run the same build during packaging.

Each `extract` invocation claims the next three stable inbox entries at most
and processes the entire claimed batch. Additional entries remain queued for
the next invocation; if the agent tries to stop before every claimed entry has
a publication attempt, the extension automatically continues it. A bounded
caller such as lint research may pass up to three exact `pendingSourceIds`;
that selection is validated before claiming and does not drain unrelated
backlog.
The extraction batch size is unrelated to ingest breadth. Ordinary `ingest`
has no fixed page or source cap: it receives every published verified packet,
every active or drifted page, and every current issue record, while excluding
pending or unpublished sources and retired pages. Its optional `sourceIds`
context filter narrows packets to a complete validated published selection
without narrowing pages or issues; omission preserves ordinary uncapped
ingest. Coherent topic boundaries and teaching depth determine page count.

```cron
# extract: choose its own minute/hour/day fields
0 6 * * * . /absolute/path/to/pi-scholar.env && cd /absolute/path/to/vault && /absolute/path/to/pi --no-extensions -e /absolute/path/to/pi-scholar/pi/extension.ts --no-skills --skill /absolute/path/to/pi-scholar/skills/extract/SKILL.md --no-context-files --no-session -p "Process every source in the current extract batch of at most three and publish each verified immutable source packet through Scholar tools; do not stop early." >> /absolute/path/to/pi-scholar/logs/extract.log 2>&1

# ingest: choose its own minute/hour/day fields
15 6 * * * . /absolute/path/to/pi-scholar.env && cd /absolute/path/to/vault && /absolute/path/to/pi --no-extensions -e /absolute/path/to/pi-scholar/pi/extension.ts --no-skills --skill /absolute/path/to/pi-scholar/skills/ingest/SKILL.md --no-context-files --no-session -p "Read verified packet and chunk paths plus every non-retired wiki page and issue, submit guarded source-driven changes through Scholar tools, and report concise status." >> /absolute/path/to/pi-scholar/logs/ingest.log 2>&1

# lint: choose its own minute/hour/day fields
30 6 * * * . /absolute/path/to/pi-scholar.env && cd /absolute/path/to/vault && /absolute/path/to/pi --no-extensions -e /absolute/path/to/pi-scholar/pi/extension.ts --no-skills --skill /absolute/path/to/pi-scholar/skills/lint/SKILL.md --no-context-files --no-session -p "Inspect the final wiki with lint and submit guarded organizer or repair changes through Scholar tools; report concise status." >> /absolute/path/to/pi-scholar/logs/lint.log 2>&1

# daily: choose its own minute/hour/day fields
0 7 * * * . /absolute/path/to/pi-scholar.env && cd /absolute/path/to/vault && /absolute/path/to/pi --no-extensions -e /absolute/path/to/pi-scholar/pi/extension.ts --no-skills --skill /absolute/path/to/pi-scholar/skills/daily/SKILL.md --no-context-files --no-session -p "Read today's daily context. If initialization is enabled, stop and report the date, expiry count, and guarded outcome without requesting evidence or publishing a quiz or skip. Otherwise review every compact due, prerequisite-unblocked, non-drifted candidate by title and OKF description; choose a varied related subset, retrieve its evidence, and publish today's 15–45-minute daily review with a mental median near 30 minutes, any number of free-response or multiple-choice questions, and multiple questions per page when useful, or an explicit skip when no candidate exists; report concise status." >> /absolute/path/to/pi-scholar/logs/daily.log 2>&1

# quiz-grader: choose its own minute/hour/day fields (usually event-driven or frequent)
*/15 * * * * . /absolute/path/to/pi-scholar.env && cd /absolute/path/to/vault && /absolute/path/to/pi --no-extensions -e /absolute/path/to/pi-scholar/pi/extension.ts --no-skills --skill /absolute/path/to/pi-scholar/skills/quiz-grader/SKILL.md --no-context-files --no-session -p "Settle the current sealed quiz submission with quiz-grader and Scholar tools; report concise status." >> /absolute/path/to/pi-scholar/logs/quiz-grader.log 2>&1

# Optional, separately controlled Git push; choose its own minute/hour/day fields. Sync pushes existing local commits to the configured remote only; it does not run another skill.
30 7 * * * /absolute/path/to/bin/pi-scholar sync --vault /absolute/path/to/vault >> /absolute/path/to/pi-scholar/logs/sync.log 2>&1
```

The prompts are static. Source text, learner answers, vault state, and secrets travel through typed Scholar tools and the vault, never through Pi arguments or cron text. `--no-extensions`, `--no-skills`, `--no-context-files`, and `--no-session` prevent unrelated ambient state; `--skill` names exactly one installed skill. Keep logs outside the vault, owned by the service account, and rotate them without recording provider credentials or tool payloads.

Each schedule is independently user-owned and scheduled workflows do not launch
one another. The sole optional exception is lint's documented, host-capability-
gated, one isolated blocking child for an evidence gap, started only after the
initial lint finish and quiescence check; the parent waits, and the child
cannot launch Pi or another child. This is not generic workflow chaining or a
scheduler. The scheduler must still serialize Pi skill sessions for a vault.
At Pi session startup, pre-existing running workflows fail as interrupted before
tool work begins; queued and terminal workflows remain unchanged. The loopback
server and explicit CLI operations may still contend on the shared
`ScholarApplication` writer lock; an overlap or revision conflict is reported
rather than merged or force-written. Browser sealing queues quiz-grader but does
not launch it. A failed run leaves canonical inbox/SQLite state and local
commits recoverable. Run `pi-scholar doctor /absolute/path/to/vault`, then rerun
only the affected skill or `pi-scholar sync`; never replay opaque model output.

## Storage, recovery, and boundaries

Run `pi-scholar doctor /absolute/path/to/vault` after an interrupted command or dependency change. Before retrying a skill after a crash, start no competing Pi session for that vault; the retry first records abandoned running workflows as interrupted. Source extraction is idempotent by claimed physical identity and digest, quiz grading by sealed submission identity, and Git synchronization by the repository's own object state.

`.pi-scholar/work/` is ignored private transient storage for request files, rollback data, and Docling scratch. It is never Git content or authority. `sources/` contains immutable published packets and must not be hand-edited. Successful operations clean their scratch; failures use rollback data; crash remnants do not override SQLite or durable packets, wiki, or quiz artifacts. Recovery stays behind ScholarApplication: use `doctor`, then retry the affected operation rather than treating work files as state. Shared I/O accepts regular files and directories only; symlinks are unsupported at that boundary.

Source removal begins with an explicit operator request, a fresh preview, and confirmation. It deletes current dependent artifacts without erasing Git history; recover a prior version from Git when necessary. Browser drafts and inbox staging are intentionally not commits until the corresponding durable operation succeeds. The wiki is strict OKF v0.2, and qmd remains derived rather than canonical.

Pi tools, the browser API, and the FIFO browser worker call the same `ScholarApplication` application entry point. No public user/auth system, arbitrary HTTP shell, second persistence layer, custom Pi runner, or alternate writer is provided. Private tunnels, including Tailscale, remain external operator context.
