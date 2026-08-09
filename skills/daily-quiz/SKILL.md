---
name: daily-quiz
description: Propose one bounded quiz for the current local date through Scholar tools.
---

# Daily quiz

When invoked directly, call `scholar_get_quiz_context` for the current local date. The host context expires earlier unsubmitted quizzes before returning today's eligibility and includes the initialization guard.

- If initialization is enabled, do not generate questions. Report that quiz generation is refused by the initialization guard and do not call the publish tool with a quiz.
- Otherwise select only the eligible, prerequisite-unblocked pages in `QuizContext.eligiblePages`. Produce at most four questions total, with no more than two synthesis questions; each selected page must occur in exactly one single-page question. Each prompt has one answer target, a `pages` entry with the page ID, criterion, and weight, and direct page evidence. Synthesis questions may cover related pages only within the same limits.
- If no eligible page exists, call `scholar_publish_quiz` with the explicit skip result for today's date. Do not invent filler material.
- If eligible pages exist, call `scholar_publish_quiz` once with today's bounded proposal. Do not alter page learning or prerequisite state or publish a second revision. Proposals do not provide question IDs; the host mints opaque UUIDs.

Return concise status including the date, expiry count, and published/skipped/guarded outcome. The host validates eligibility, limits, evidence, revision, and the single durable publication. Do not write Markdown or SQLite, run Git, call network or shell commands, or put secrets, source text, or learner state in arguments.
