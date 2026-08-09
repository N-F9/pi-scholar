---
name: daily-quiz
description: Propose one bounded quiz for the current local date through Scholar tools.
---

# Daily quiz

When invoked directly, call `scholar_get_quiz_context` for the current local date. The host context expires earlier unsubmitted quizzes before returning today's eligibility and includes the initialization guard.

- If initialization is enabled, do not generate questions. Report that quiz generation is refused by the initialization guard and do not call the publish tool with a quiz.
- Otherwise select only the eligible, prerequisite-unblocked cards in the returned context. Produce at most four prompts total, with no more than two synthesis prompts; each prompt has one answer target, supplied source/page evidence, card IDs, and a bounded rubric.
- If no eligible card exists, call `scholar_publish_quiz` with the explicit skip result for today's date. Do not invent filler material.
- If eligible cards exist, call `scholar_publish_quiz` once with today's bounded proposal. Do not alter card scheduling state or publish a second revision.

Return concise status including the date, expiry count, and published/skipped/guarded outcome. The host validates eligibility, limits, evidence, revision, and the single durable publication. Do not write Markdown or SQLite, run Git, call network or shell commands, or put secrets, source text, or learner state in arguments.
