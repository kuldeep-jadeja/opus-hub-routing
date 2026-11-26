# Opus hub routing for Claude Code

Keep Opus as the orchestrator and hand only clear-cut jobs to cheaper models:

| Job | Agent | Model |
| --- | --- | --- |
| Review, audit, security check, verify finished work | `opus-reviewer` | Opus |
| Scoped implementation: known bug, tests, pattern refactor | `sonnet-builder` | Sonnet |
| File/symbol search, web search, fetching docs | `research-scout` | Haiku |
| Hard, ambiguous or cross-cutting work | main thread | Opus |

The repo has three parts:

- `agents/`: the three subagent definitions.
- `CLAUDE.snippet.md`: the routing rule that tells Claude which agent to pick.
- `plugins/subagent-routing-pane`: a mod that opens a right-side pane showing Opus as the hub, every subagent it routed to, its model, status and current tool. It also adds a `/routing` command.

## Install

1. Copy the agents into your user agents folder:

   ```bash
   git clone https://github.com/kuldeep-jadeja/opus-hub-routing.git
   cp opus-hub-routing/agents/*.md ~/.claude/agents/
   ```

2. Append the routing rule to your global instructions:

   ```bash
   cat opus-hub-routing/CLAUDE.snippet.md >> ~/.claude/CLAUDE.md
   ```

3. Install the pane mod from inside Claude Code:

   ```
   /plugin marketplace add kuldeep-jadeja/opus-hub-routing
   /plugin install subagent-routing-pane@opus-hub-routing
   ```

Restart Claude Code. The pane opens at session start; `/routing` shows it again.

## Why the split

Sonnet and Haiku do clear-cut jobs about as well as Opus for far less cost. On hard tasks they lose quality, and every hand-off loses some detail, so hard work stays on Opus and Sonnet output always goes through `opus-reviewer`.
