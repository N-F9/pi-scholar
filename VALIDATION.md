# Validation plan

Use a disposable vault for every destructive or failure-path check. Do not validate against a real user vault.

## Release automation

Complete the one-time setup before the first release:

1. Create a protected GitHub environment named `npm`.
2. In npm Trusted Publishers, add the GitHub Actions publisher with exactly:
   - Owner: `N-F9`
   - Repository: `pi-scholar`
   - Workflow: `release.yml`
   - Environment: `npm`
   - Allowed action: `npm publish`
3. Protect tags matching `v*`: restrict creation to release maintainers and block updates and deletion.

Trusted publishing uses GitHub OIDC, so do not create or store an npm token secret or other npm credentials. npm provenance starts automatically once the repository is public. The workflow verifies and packs in an unprivileged job, publishes that exact tarball from the protected `npm` environment, then attaches the same tarball to the GitHub release from a separate job.

Every version change must be a reviewed PR updating `package.json` and `package-lock.json`. Merge it to `main`, then tag that merged commit; never make a direct version commit, ask the release process to merge, reuse a tag, or force-push.

- **Release candidate:** Push a matching `vX.Y.Z-rc.N` tag. The release publishes npm dist-tag `next` and creates a GitHub prerelease. System-test `pi-scholar@next` in a disposable vault, using this validation plan; never use a real vault.
- **Stable release:** Only after the candidate passes this validation plan, push a matching `vX.Y.Z` tag for the reviewed, merged version. The release publishes npm dist-tag `latest` and creates a normal GitHub release.

## Package and Pi integration

Test the packed artifact rather than loading the repository directly:

1. Run `npm pack`.
2. Install the tarball under a temporary npm prefix.
3. Point `PI_CODING_AGENT_DIR` at a temporary directory.
4. Install the temporary package with `pi install <package-path>`.
5. Confirm `pi list` discovers one extension and the five declared skills: `extract`, `ingest`, `lint`, `daily`, and `quiz-grader`.
6. Start Pi in RPC mode and invoke `/scholar-add`, `/scholar-issue`, `/scholar-status`, and `/scholar-lint`.

Pass when Pi loads without startup errors, exposes all four namespaced commands, registers all five skills and package resources, and needs no file omitted from the tarball.

## End-to-end product validation

Use real Git, qmd, Docling, and a configured Pi provider with a source whose correct facts are known.

1. Initialize the disposable vault and run `pi-scholar doctor`. Require the exact schema v5, the strict OKF v0.2 wiki, regular-file path safety, and no compatibility schema or migration path.
2. Stage a representative source with `/scholar-add` or the supported inbox path. Exercise streamed or disk-backed capture with a source large enough to use those paths; verify there is no fixed product source-size cutoff, only free-space, operation-time, model/context, and transport bounds. Preserve the original bytes.
3. Run `extract` and confirm it snapshots a stable queue, processes entries sequentially, and publishes verified immutable packets. Check manifest identity/provenance/digests, the retained exact packet manifest digest in the source catalog for byte-identity verification and doctor checks, lossless complete chunk coverage, exact packet/chunk paths, and fence-aware blank-line normalization in derived Markdown while originals remain unchanged.
4. Exercise an HTTP(S) source on a destination allowed by local-user/model trust, including a local, private, or operator-routed Tailscale destination. Confirm timeout, redirect, and streaming protections still apply; the tunnel or network route is external operator context, not a Pi Scholar integration.
5. Run `ingest` from its supplied verified packet/chunk paths plus every non-retired wiki page and issue (including drifted pages). Submit guarded source-driven changes only through Scholar tools; confirm valid nearby OKF citations and textbook-depth coverage of the source's central terminology, mechanisms, equations or algorithms, examples, empirical results, assumptions, tradeoffs, and supported limitations.
6. Run `lint` once full-scope and once targeted. Confirm full scope reads every non-retired page (active or drifted) and issue, targeted scope stays bounded to its description and directly related pages, and each pass submits only guarded organizer or repair changes.
7. Find a known phrase and concept through exact, lexical, or qmd search without treating qmd or projections as canonical state.
8. Confirm every eligible page has one page-level FSRS record, stable page IDs across rename, and an acyclic prerequisite graph that blocks due pages until prerequisites reach FSRS `Review`.
9. Observe the daily flow `candidate -> evidence -> publish`: the host returns every compact due, prerequisite-unblocked, non-drifted candidate; the model chooses a varied related subset; `scholar_get_daily_evidence` retrieves authoritative evidence for the selected pages; and one `scholar_publish_daily` call publishes the proposal or an explicit skip when no candidate exists. Target 15–45 minutes of combined reading and questions with a mental median near 30 minutes, without imposing a fixed question or page count or hard timer cap.
10. Confirm daily questions use only `free-response` or `multiple-choice`, may include multiple questions for one page and connections among related pages, and bind every question to returned evidence. The host mints opaque question UUIDs and revalidates eligibility, prerequisites, drift, due state, evidence, and publication.
11. Inspect the quiz Markdown and confirm visible headings are numeric, the only comments are `<!-- pi-scholar:quiz format=1 id=<opaque> revision=<n> -->` and `<!-- pi-scholar:question id=<opaque> -->`, and no page/source/evidence/rubric/answer-key/FSRS metadata appears before grading.
12. Submit answers to seal a revision, then run `quiz-grader` independently. Confirm it settles that sealed revision, preserves question feedback separately, and writes one bundled result, rating, review, and FSRS transition per covered page regardless of how many questions mention it. Browser sealing queues grading but does not launch a Pi process.
13. Restart Pi Scholar and confirm durable page learning, prerequisites, quiz identity, results, source packets, wiki, and Git history remain available.
14. Rerun the same workflow and confirm it does not duplicate canonical artifacts, republish a completed extraction, or settle the same sealed submission twice.
15. Inspect Git history and confirm each completed durable operation produced a coherent local commit; run `pi-scholar sync` separately and verify it only pushes existing local commits to the configured remote.

## Independent scheduling and recovery

Schedule `extract`, `ingest`, `lint`, `daily`, and `quiz-grader` independently under the operator's cron or other scheduler, while serializing Pi skill sessions for each vault. Verify that no skill launches another, Pi Scholar never launches Pi or edits the scheduler, daily and grading remain separate, and `sync` is separately invoked or scheduled. The loopback server and explicit CLI operations may contend with a Pi session; conflicts must be reported rather than merged or force-written.

Verify `.pi-scholar/work/` is ignored private transient storage for request files, rollback data, and Docling scratch, never Git content or authority. Successful operations clean scratch; failures use rollback data; crash remnants cannot override SQLite or durable packets, wiki, or quizzes. Recovery must go through ScholarApplication, `doctor`, and a safe retry rather than reading work files as state.

## Failure and safety validation

Confirm each boundary fails safely:

- Duplicate extraction creates no duplicate canonical artifact.
- Source removal starts from an explicit operator request, requires a fresh preview and confirmation, rejects a stale confirmation, and preserves Git history.
- Invalid page prerequisite updates reject self-edges, dangling pages, and cycles without partial writes.
- Overlapping writers report a conflict without partial writes.
- After interrupting or crashing a Pi session, start the next serialized Pi session and confirm it marks pre-existing running workflows failed as interrupted before accepting tool work, leaves queued and terminal rows unchanged, stops the Workflows UI from polling abandoned rows, and permits a safe operation-specific retry.
- Missing qmd disables semantic search without disabling exact or lexical search.
- Symlinks at the shared I/O boundary are unsupported and cannot enter canonical state.
- Stale or unauthorized direct page evidence rejects quiz generation or grading without changing page learning.
- Invalid quiz and grading payloads, including incomplete page coverage or conflicting page ratings, leave no partial state.
- Repeated sealed-submission settlement is idempotent and never applies a second page transition.
- Instructions embedded in source text remain data and cannot directly invoke tools or writes.
- Provider credentials never appear in vault files, Git commits, command arguments, or logs.
- Tailscale, private tunnels, reverse proxies, authentication, DNS, and network policy remain operator-owned external context rather than product integration, identity, trust boundary, dependency, or feature.

A release is valid when grounding, streamed source handling, URL trust, strict OKF v0.2, daily candidate/evidence/publication behavior, independent scheduling, work-directory recovery, persistence, and safety pass with the disposable vault.
