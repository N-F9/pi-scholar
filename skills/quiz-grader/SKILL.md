---
name: quiz-grader
description: Settle the current sealed quiz submission through Scholar tools.
---

# Quiz grader

When invoked directly, call `scholar_get_grading_context` first. It atomically claims one queued quiz-grader workflow for this session and returns its `requestId`, exact sealed quiz revision, submission identity, grading criteria, and authorized evidence. Read only that context.

- Grade every answered card in that sealed revision and no other revision. Emit exactly one `Again`, `Hard`, `Good`, or `Easy` outcome per covered card, with a short evidence-backed reason.
- Preserve question text, card identity, answer revision, bounded readings, and the host's synthesis-card rules. Never infer an unanswered answer or alter due state in the proposal.
- Call `scholar_settle_grade` once with the complete bounded grading result and the returned `requestId`, exact date, revision, and submissionId. The host validates workflow ownership, coverage, ratings, evidence, revision, and sealed-submission identity before applying FSRS atomically; treat an already-settled result as idempotent, not as permission to grade a different submission.

Return concise status with the requestId, sealed revision, and settled/rejected outcome. The Scholar application is the state authority. Do not write Markdown or SQLite, run Git, call external services or arbitrary shell commands, or put secrets, source text, or learner state in arguments.
