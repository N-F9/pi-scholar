---
name: wiki-maintenance
description: Propose bounded wiki maintenance from the current Scholar context.
---

# Wiki maintenance

When invoked directly, call `scholar_get_maintenance_context` before making any judgment. Work only from the pages, source evidence, card bindings, issue records, drift facts, and revisions in that response.

- Identify stale, missing, duplicated, unclear, or incorrectly bounded claims without widening the supplied scope.
- Prepare guarded operations with exact page IDs, paths, headings, source/card IDs, expected digests or revisions, evidence, and a reason. Preserve authored content and provenance; report ambiguity as an issue instead of guessing.
- Resolve an issue only with one composite proposal containing the exact issue ID, a real guarded correction to its referenced page, a related create/revise/retire/split/merge card mutation, and one resolution string. Never submit a resolve-only proposal or model-supplied check/commit booleans.
- Submit each bounded operation through `scholar_apply_maintenance`. When there are no proposals, or after all proposals are submitted, call `scholar_finish_maintenance` exactly once. The host validates every guard and may reject a stale proposal; never edit Markdown or state directly and never treat a rejected operation as applied.

Return concise status for each proposal and a final applied/rejected count. Scholar tools and the application facade are the state authority. Do not open SQLite, run Git, call external services, use arbitrary shell commands, or put secrets or learner state in arguments.
