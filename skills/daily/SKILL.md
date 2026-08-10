---
name: daily
description: Propose one daily quiz for the current local date through Scholar tools.
---

# Daily

When invoked directly, call `scholar_get_daily_context` for the current local date. The host expires earlier unsubmitted quizzes before returning today's candidates and initialization guard.

- If initialization is enabled, do not generate questions. Report that quiz generation is refused by the initialization guard and do not call the publish tool with a quiz.
- Review all `QuizContext.candidates`, then choose a semantically varied but related subset that supports a coherent study session. The host has already filtered for active, due, prerequisite-unblocked, non-drifted pages but has not imposed a topical ordering. Size the combined reading and quiz work for 15–45 minutes, with a mental median near 30 minutes. There is no fixed question, page, synthesis, or timer cap.
- Call `scholar_get_daily_evidence` once with the chosen page IDs in the order you want to use them. Use only the returned authoritative evidence references in `sourceRefs`; every question must bind to one or more evidence-backed page records. Multiple questions may use one page, and questions may connect multiple related pages.
- If no candidate exists, call `scholar_publish_daily` with the explicit skip result for today's date. Do not invent filler material.
- If candidates exist, call `scholar_publish_daily` once with today's proposal. Do not alter page learning or prerequisite state or publish a second revision. Proposals do not provide question IDs; the host mints opaque UUIDs.

Return concise status including the date, expiry count, and published/skipped/guarded outcome. The host revalidates eligibility, drift, prerequisites, due state, evidence, and the single durable publication. Do not write Markdown or SQLite, run Git, call network or shell commands, or put secrets, source text, or learner state in arguments.
