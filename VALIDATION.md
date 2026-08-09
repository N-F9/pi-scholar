# Validation plan

Use a disposable vault for every destructive or failure-path check. Do not validate against a real user vault.

## Package and Pi integration

Test the packed artifact rather than loading the repository directly:

1. Run `npm pack`.
2. Install the tarball under a temporary npm prefix.
3. Point `PI_CODING_AGENT_DIR` at a temporary directory.
4. Install the temporary package with `pi install <package-path>`.
5. Confirm `pi list` discovers one extension and the four declared skills.
6. Start Pi in RPC mode and invoke `/scholar-status`.

Pass when Pi loads without startup errors, recognizes the Scholar command, registers all package resources, and needs no file omitted from the tarball.

## End-to-end product validation

Use real Git, qmd, Docling, and a configured Pi provider with a small source whose correct facts are known.

1. Initialize the disposable vault and run `pi-scholar doctor`.
2. Add the source and run source admission.
3. Confirm a multi-section source is chunked at coherent section or topic boundaries with lossless full coverage.
4. Run guarded wiki maintenance and confirm each model-authored page teaches the source's central terminology, mechanisms, equations or algorithms, concrete examples, empirical results, and supported limitations at textbook depth rather than restating the abstract.
5. Confirm published wiki claims cite valid source chunks near the claims they support.
6. Find a known phrase and concept through search.
7. Confirm schema v3 has the page-oriented learning, prerequisite, review, question-page, page-result, and quiz-evidence authorities with no compatibility views or migrations; every eligible page has one `page_learning` FSRS record, page IDs remain stable across rename, and prerequisite edges form an acyclic graph that blocks due pages until prerequisites reach FSRS `Review`.
8. Generate a daily quiz and confirm it selects due pages, covers each selected page in exactly one single-page question, permits no more than four questions or two synthesis questions, snapshots direct page evidence, and mints opaque question UUIDs without accepting proposal IDs.
9. Inspect the quiz Markdown and confirm visible headings are numeric, the only comments are `<!-- pi-scholar:quiz format=1 id=<opaque> revision=<n> -->` and `<!-- pi-scholar:question id=<opaque> -->`, and no page/source/evidence/rubric/answer-key/FSRS metadata appears before grading.
10. Submit answers and grade the sealed revision. Confirm question feedback is retained separately while exactly one bundled rating, page result, and page review transition are written per covered page regardless of question count.
11. Restart Pi Scholar and confirm durable page learning, prerequisites, quiz identity, results, and history remain available.
12. Rerun the workflow and confirm it does not duplicate canonical artifacts or settle the same submission twice.
13. Inspect Git history and confirm each durable operation produced a coherent commit.

Validate meaning and source coverage rather than exact model prose or a fixed word count. Every accepted claim and quiz answer must trace to the source, and a source-grounded page fails validation when it omits central technical content or reduces the source to an abstract-style summary.

## Failure and safety validation

Confirm each boundary fails safely:

- Duplicate ingestion creates no duplicate canonical artifact.
- Source removal rejects a stale confirmation ID.
- Invalid page prerequisite updates reject self-edges, dangling pages, and cycles without partial writes.
- Overlapping writers report a conflict without partial writes.
- Interrupting a workflow leaves `doctor` able to explain recovery and permits a safe rerun.
- Missing qmd disables semantic search without disabling exact or lexical search.
- Stale or unauthorized direct page evidence rejects quiz generation or grading without changing page learning.
- Invalid quiz and grading payloads, including incomplete page coverage or multiple page ratings, leave no partial state.
- Repeated sealed-submission settlement is idempotent and never applies a second page transition.
- Instructions embedded in source text remain data and cannot directly invoke tools or writes.
- Provider credentials never appear in vault files, Git commits, command arguments, or logs.

A release is valid when grounding, recovery, persistence, and safety pass with the disposable vault.
