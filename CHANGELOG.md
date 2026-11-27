# Changelog

## 0.3.0

- **Tuner band.** A row above the prompt sets how every subagent's model and effort are picked: `Auto` (the default) applies a recommendation by task kind or your saved default, `Manual` asks before each launch in a pick pane or a short chain of dialogs. Click the model or effort to cycle the saved default, `Reset` to clear it. Mode and default are kept across sessions.
- **The routed roles stay pinned.** The tuner never changes the model of `opus-reviewer`, `sonnet-builder` or `research-scout`, and Manual never asks about them. A saved effort still applies in Auto.
- **`/routing`** now prints the tuner's mode and default.
- **Routing rule:** hard work handed to a built-in agent should carry `model: "opus"`, so the tuner can't guess a cheaper model from the wording.
- **Sturdier hooks:** the pane's bookkeeping can no longer fail a hook, so a state hiccup can't skip the model guard at spawn.
- **Pick pane wait:** Windows paths with curly quotes are quoted correctly; a wait that ends early keeps the selection you made; a sentinel file left by an aborted wait is removed.
- **Fix:** the band stays drawn when the session state can't be read for a moment.
- Tests: 9 → 209.

## 0.2.0

- Agents, routing rule and pane bundled as one plugin. Model-override guardrail, review reminders, cost and savings tracking, `/routing`.

## 0.1.0

- First release: three routing agents, the CLAUDE.md rule, the routing pane.
