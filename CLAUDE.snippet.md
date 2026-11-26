## Subagent routing

When delegating, pick the agent by job so each runs on the right model:
- Review, audit, security check, verifying finished work: `opus-reviewer` (Opus).
- Implementing a scoped change, bug fix, refactor, tests: `sonnet-builder` (Sonnet).
- Finding files or symbols, codebase search, web search, fetching URLs or docs: `research-scout` (Haiku).
Do not pass a `model` override on these calls; the agent definition sets it.

Opus (main thread) stays the hub: every subagent reports back to Opus, which checks the result before acting.
Hard, ambiguous or cross-cutting work (unknown-cause bugs, multi-file design, architecture research) stays on Opus in the main thread.
Always run `opus-reviewer` after `sonnet-builder` output.
