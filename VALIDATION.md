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
3. Confirm published wiki claims cite valid source chunks.
4. Find a known phrase and concept through search.
5. Run guarded wiki maintenance.
6. Generate a daily quiz, submit answers, and grade it.
7. Restart Pi Scholar and confirm durable state remains available.
8. Rerun the workflow and confirm it does not duplicate canonical artifacts.
9. Inspect Git history and confirm each durable operation produced a coherent commit.

Validate meaning rather than exact model prose. Every accepted claim and quiz answer must trace to the source.

## Failure and safety validation

Confirm each boundary fails safely:

- Duplicate ingestion creates no duplicate canonical artifact.
- Source removal rejects a stale confirmation ID.
- Overlapping writers report a conflict without partial writes.
- Interrupting a workflow leaves `doctor` able to explain recovery and permits a safe rerun.
- Missing qmd disables semantic search without disabling exact or lexical search.
- Invalid quiz and grading payloads leave no partial state.
- Instructions embedded in source text remain data and cannot directly invoke tools or writes.
- Provider credentials never appear in vault files, Git commits, command arguments, or logs.

A release is valid when grounding, recovery, persistence, and safety pass with the disposable vault.
