# Open design issues

> Notes from reviewing `pi-scholar-system-condensed.md` on 2026-08-09.
> These are not accepted decisions yet. Each item records the current implementation, the preferred direction raised in review, and any tradeoff that must be resolved before changing `pi-scholar.md` or code.

## 1. Namespace every Pi slash command

**Current:** the extension registers `/add`, `/issue`, and `/scholar-status`. Tool names already use the `scholar_` prefix.

**Preferred direction:** cleanly rename the commands to `/scholar-add`, `/scholar-issue`, and `/scholar-status`. Do not retain aliases unless compatibility becomes an explicit requirement. A single namespace is cheap and avoids collisions with Pi or other extensions.

## 2. Keep or remove `src/external/`

**Answer:** `src/external/` is the boundary around external CLI processes; it is not a reimplementation of Git, qmd, or Docling.

- `process.ts` pins executables and owns shell-free execution, environment shaping, timeouts, output bounds, and process-tree termination.
- `git.ts`, `qmd.ts`, and `docling.ts` own the allowed commands, paths, scope, and output parsing for each CLI.

Removing the directory would move or duplicate this code in domain modules. The simpler design is to keep the boundary and keep `process.ts` beside its callers. Renaming `external/` to `adapters/` may improve the name, but does not itself reduce complexity.

## 3. Split large source modules for easier navigation

“Façade” is a software-design term, not a fake implementation. It means one small public entry point that hides several internal modules. In this repository, `ScholarApplication` is the entry point used by Pi, HTTP, and the CLI. To avoid the ambiguity, call it the **application entry point** in future docs.

**Current:** the tree is mostly flat, while `application.ts` and `sources.ts` contain thousands of lines and several distinct responsibilities. That makes navigation harder for humans and LLM agents even when the runtime boundaries are sound.

**Preferred direction:** split the large files and make the directory tree describe the system. A reasonable starting shape is:

```text
src/
├── application/
│   ├── application.ts
│   ├── mutations.ts
│   ├── admission.ts
│   ├── maintenance.ts
│   └── quizzes.ts
├── sources/
│   ├── source-service.ts
│   ├── staging.ts
│   ├── fetching.ts
│   ├── extraction.ts
│   ├── packets.ts
│   └── removal.ts
├── wiki/
│   ├── wiki-service.ts
│   ├── pages.ts
│   ├── issues.ts
│   ├── projections.ts
│   └── sections.ts
├── quiz/
│   ├── quiz-service.ts
│   ├── generation.ts
│   ├── answers.ts
│   ├── grading.ts
│   └── projection.ts
├── learning/
│   └── scheduler.ts
├── storage/
│   ├── database.ts
│   └── vault.ts
├── adapters/
│   ├── process.ts
│   ├── git.ts
│   ├── qmd.ts
│   └── docling.ts
├── contracts.ts
├── workflows.ts
├── doctor.ts
├── server.ts
├── cli.ts
└── index.ts
```

This is a navigation target, not a requirement to preserve these exact names. Split by responsibility, keep the application and domain service APIs small, and avoid files that only pass arguments through. Make the move as one clean cutover so imports, exports, tests, and docs describe one tree.

## 4. Make quiz granularity explicit

**Current:** every selected page must appear in exactly one single-page question; bounded synthesis questions may also mention it. This prevents two ordinary questions from sampling different parts of the same page in one quiz.

**Preferred direction:** allow one or more questions to sample different sections or skills from the same page. A question is evidence-bound to the portion it tests and is not expected to cover the entire page. The page remains the durable FSRS unit and receives one bundled result and transition per quiz.

Example: one physics page about distance could yield:

1. “What is the SI unit of distance?” — meters.
2. “Given $v(t)=t^2+3$, compute displacement from $t=0$ to $t=10$.” — evaluate $\int_0^{10}(t^2+3)\,dt$.

**Decision needed:** define how grading a sampled portion justifies one rating for the whole page. The initial rule can remain a model-bundled page judgment over all questions that sampled that page, without claiming exhaustive page coverage.

## 5. Explain `.pi-scholar/work/`

`.pi-scholar/work/` is private ignored scratch space, not durable knowledge. It currently holds:

- prepared admission snapshots and Docling output;
- temporary source packets before atomic publication;
- quarantined packets during reversible removal;
- wiki-maintenance rollback snapshots;
- Docling home/cache isolation.

The directory keeps temporary and rollback bytes out of `inbox/`, durable packet roots, Git, and global `/tmp`. Keep one work root, document its cleanup/recovery rules, and do not treat it as a second authority.

## 6. Make symlinks unsupported, not unexamined

**Review preference:** symlink support is not a product requirement and should not spread complexity throughout the code.

**Current:** Pi Scholar already rejects symlinks rather than supporting them. The checks prevent imported repositories, converter output, static paths, or durable writes from escaping their approved roots.

**Preferred simplification:** state one policy—“symlinks are unsupported”—and pull its implementation into the deepest shared path/I/O boundary possible. Callers should not reason about symlink cases. Deleting all checks would not define the case away; it would silently allow path escape.

## 7. Replace the linear product-flow diagram

The condensed diagram incorrectly suggests one automatic pipeline from admission through wiki maintenance, quiz generation, grading, and sync. These are independent operator-scheduled workflows that share durable state.

The replacement diagram should show:

- **admission:** inbox input → immutable source packets;
- **wiki lint/maintenance:** source packets plus current wiki → guarded wiki changes;
- **daily quiz:** current wiki plus learning state → open quiz;
- **grading:** sealed quiz plus evidence → results and FSRS transitions;
- **sync:** existing local commits → explicit push.

No arrow should imply that admitting a source automatically authors wiki pages or launches another Pi session.

## 8. Remove the fixed 100 MiB product limit

**Current:** 100 MiB is enforced across URL reads, uploads, local trees, extraction, attachments, Docling, and multipart HTTP. Several paths buffer complete inputs and derived extraction in memory.

**Preferred direction:** do not impose 100 MiB as a product-level source limit. Large books, repositories, PDFs, and EPUBs should be accepted.

This cannot safely be implemented by deleting one constant: the current whole-buffer path would become an unbounded memory/disk operation. First move large input and extraction paths to streaming or disk-backed processing, then remove the arbitrary content cap while retaining timeouts, available-space checks, and bounded model context.

## 9. Normalize redundant blank lines in derived sources

**Current:** original text/Markdown bytes and Docling output are preserved exactly. Atomization and chunking retain every newline; multi-file extraction adds only explicit file-boundary markers. Repeated blank lines from input or Docling therefore remain in `extracted.md` and chunks.

**Preferred direction:**

- always preserve accepted bytes unchanged under `original/`;
- normalize only derived `extracted.md`, once, before atomization and chunk planning;
- collapse redundant blank-line runs outside fenced code without changing meaningful code or literal content;
- record the normalization/version in packet provenance so extraction and chunk digests remain explainable.

Existing packets are immutable and should not be silently rewritten. Apply the rule to future admissions unless an explicit packet migration is designed.

## 10. Relax URL destination gating

**Current:** URL admission permits HTTP(S), pins DNS, rechecks redirects, and rejects private, loopback, link-local, metadata, multicast, and other internal ranges. The host fetches with the local machine's network privileges.

**Preferred direction:** permit user-supplied HTTP(S) URLs, including local, private, and Tailscale destinations, instead of maintaining a large destination classifier. Retain basic transport mechanics such as timeouts, redirect-loop prevention, and streaming reads.

**Tradeoff to accept explicitly:** a model or browser request could fetch local services or cloud metadata and preserve the response in a source packet. Removing the gate therefore changes the trust model from “host-enforced SSRF boundary” to “the local user and their model are trusted to choose URLs.”

## 11. Make wiki fixes an LLM lint workflow

**Current:** `/issue` records a bounded problem for later `wiki-maintenance`. Direct filesystem edits are treated as drift and can only be restored or recorded as an issue and then restored. `WikiService.lintSync` is a deterministic structural check, not an LLM review. There is no lint command.

**Preferred direction:** add `/scholar-lint [description]` as the human-facing semantic maintenance command.

- With a description, create a targeted lint scope such as “this claim looks wrong in the distance note.”
- Without a description, inspect the whole current wiki for incorrect, stale, missing, duplicated, unclear, or badly bounded knowledge.
- In both cases, the LLM may apply authorized page and structural changes through the shared guarded wiki mutation API; it never directly blesses arbitrary edited bytes.

This becomes the public entry to the `lint` capability. Source-driven authoring remains `ingest`; deterministic structural lint, qmd refresh, revision checks, and doctor remain host postconditions rather than another model workflow.

## 12. Size daily work by time, not four pages

**Current:** the host selects the first four due pages by due time and page ID. There is no time estimate or topical selection.

**Preferred direction:** remove the four-page product cap. Give the LLM eligible due candidates and ask it to size the combined reading and quizzing session around 15–45 minutes, with roughly 30 minutes as a mental median—not a hard requirement or timer.

The host should still enforce due state, prerequisites, drift, evidence, revisions, and payload safety. The unresolved implementation question is how to expose a large due set without overflowing model context; candidate summaries followed by evidence retrieval is preferable to another arbitrary pedagogical page cap.

## 13. Remove hard question and synthesis caps

**Current:** a quiz has at most four questions and at most two synthesis questions. The transport/UI recognizes only `short-answer` and `multiple-choice`.

**Preferred direction:** let the LLM choose question count and mix as part of the daily time budget. Do not add a large taxonomy of question types unless a type changes answer controls or grading semantics. Unit recall, derivation, worked application, explanation, and cross-page synthesis can all be expressed through a general free-response mode; selection questions need a choice mode.

A technical request/context bound may still exist, but it should not masquerade as a learning-policy limit.

## 14. Split and rename model capabilities

**Current:** `source-admission` owns source chunk planning and publication, while `wiki-maintenance` combines page creation, page repair, restructuring, prerequisite changes, issue resolution, and semantic diagnosis. Deterministic lint, qmd refresh, and doctor checks also run around those writes. The broad `wiki-maintenance` name hides several different model jobs.

**Preferred capability split:**

- **`extract`:** turn staged source material into verified immutable packets and semantically coherent chunks. The model chooses chunk boundaries; the host owns capture, provenance, validation, and publication.
- **`ingest`:** turn admitted evidence plus the current wiki and recorded issues into guarded source-driven page and prerequisite changes.
- **`lint`:** inspect the completed wiki for incorrect, stale, missing, duplicated, unclear, badly bounded, or poorly organized knowledge, then apply authorized repairs and structural improvements. It may create, update, move, rename, split, merge, or retire pages and adjust links or prerequisites through the same guarded host mutation API used by `ingest`; findings it cannot safely fix remain durable issues.

A source-driven knowledge-update cycle should be:

```text
extract, when the inbox is nonempty
→ ingest admitted evidence and existing issues
→ refresh qmd
→ lint and restructure the resulting whole wiki
→ refresh qmd
→ doctor
```

An empty-source cycle may skip `extract` and `ingest` but still run `lint`. Deterministic structural validation, revision checks, qmd scope checks, and doctor remain host postconditions; they are not the semantic `lint` capability.

These are separate Pi skills and separately understandable model contexts, sequenced by the user-owned workflow rather than by Pi Scholar launching Pi. The `/scholar-lint [description]` command from issue 11 is the human-facing entry: it runs targeted or full lint and may apply authorized repairs or structural improvements directly through the shared guarded wiki mutation API.

**Related skill rename:** rename `daily-quiz` to `daily`. That skill owns the complete learner-facing session—selecting due material, supplying reading, and generating the quiz inside one shared time budget—so `daily` is more accurate than a quiz-only name. Keep those responsibilities together rather than splitting them merely to mirror Cribrum-lite.

Make this an unreleased clean cutover: remove `source-admission`, `wiki-maintenance`, and `daily-quiz` rather than retaining aliases. The existing mismatch between what wiki maintenance claims it can read and what its context actually exposes must be fixed in the new `ingest` contract.

## 15. Resolved: `lint` owns final wiki organization

**Resolution:** the `extract → ingest → lint` split in issue 14 removes the need for a separate initial-wiki planning workflow.

Admission may still publish sources sequentially for failure isolation. `ingest` turns the admitted evidence into useful wiki content. After all current inputs are available, `lint` sees the complete wiki and may explicitly reorganize it: create, update, move, rename, split, merge, or retire pages; remove duplication; repair links; and improve prerequisite structure through guarded host operations.

Because `lint` runs over the final corpus, the first source or first page does not permanently determine the hierarchy. The same cycle works for a new vault and for later incremental sources. Do not add a separate bootstrap planner or batch API unless this workflow proves insufficient.

## 16. Treat Tailscale as external context only

**Context:** the operator may choose to access the browser through Tailscale or another private tunnel. This explains the expected single-user deployment; it is not a Pi Scholar feature or trust boundary.

**Decision:** do not implement Tailscale integration. Pi Scholar must not call Tailscale commands or APIs, manage Serve/Funnel/ACLs, add a Tailscale dependency or settings, detect tailnet identity, trust proxy-specific headers, or claim responsibility for remote-access configuration.

Pi Scholar defines only its own local HTTP behavior. Any tunnel, reverse proxy, authentication, DNS, or network policy is configured independently by the operator. Browser protections should be judged against Pi Scholar's local single-user threat model, not justified by speculative Tailscale code.

## 17. Decision: require OKF v0.2 conformance

**Current gap:** the emitted `wiki/` is only partially compatible with OKF v0.2.

- Concept pages have YAML frontmatter and non-empty `type: note`.
- `wiki/index.md` is close to the optional index convention.
- Generated `wiki/log.md` is not grouped under required `## YYYY-MM-DD` headings.
- The frontmatter parser supports only flat scalar fields, and serialization drops unknown or nested fields.
- Pi Scholar's inline chunk-ID citations do not use OKF's standard `sources` and keyed-footnote provenance convention.

**Decision:** `wiki/` must be a conformant OKF v0.2 bundle, not merely “OKF-shaped” Markdown.

Implementation must:

1. emit valid YAML frontmatter with a non-empty `type` for every concept page;
2. declare `okf_version: "0.2"` in the root `index.md`;
3. generate conformant reserved `index.md` and date-grouped, newest-first `log.md` files;
4. parse and preserve valid unknown and nested OKF frontmatter during round trips;
5. map Pi Scholar source provenance into OKF v0.2 `sources` and per-claim footnotes while retaining immutable packet/chunk identity;
6. validate the generated bundle in doctor and automated tests against the [official OKF v0.2 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

The OKF bundle is `wiki/`, not the whole vault. Source packets, extracted Markdown, chunks, and quiz sheets remain separate Pi Scholar artifacts and are not OKF concept documents. Make this a clean unreleased cutover with no legacy parser, projection, or citation format.

## 18. Accepted: model-directed interleaving

**Current gap:** prerequisite rules filter eligibility, then scheduling takes due pages in deterministic `due_at, page_id` order. There is no semantic interleaving, and a cross-page synthesis question is possible only among the pages already selected.

**Decision:** after deterministic host eligibility filtering, let the LLM choose a varied but related set from the due candidates and create cross-page questions when useful. The host validates that every chosen page was due and every claim has authorized evidence; it does not encode a topical-similarity heuristic.

Example: interleave distance and velocity pages, then ask the learner to integrate a velocity function to find displacement. Each covered page still receives at most one bundled result and FSRS transition for the quiz, even if several questions mention it.
