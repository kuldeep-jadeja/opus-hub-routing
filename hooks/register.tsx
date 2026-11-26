import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Hub, Review, Routed } from '../types'

const PLUGIN = 'opus-hub-routing'
const PANE = 'opus-hub-routing'
const TITLE = 'Routing · Opus hub'

// Bump a tag when its value's fields change: an older stored value is declined.
const routed = atom({ plugin: 'opus-hub-routing', key: 'routed' } as const, [] as Routed[], { shape: 'routed-2' })
const hub = atom({ plugin: 'opus-hub-routing', key: 'hub' } as const, { activity: 'idle', inflight: 0 } as Hub, { shape: 'hub-2' })
const review = atom({ plugin: 'opus-hub-routing', key: 'review' } as const, { pending: [] } as Review, { shape: 'review-1' })

/** The three roles this plugin routes to; their own definitions set the model. */
const ROLES = ['opus-reviewer', 'sonnet-builder', 'research-scout'] as const
type Role = (typeof ROLES)[number]

/** `opus-hub-routing:sonnet-builder` and a hand-copied `sonnet-builder` are the same role. */
const roleOf = (type: string): Role | undefined => {
  const base = type.split(':').pop() ?? type
  return (ROLES as readonly string[]).includes(base) ? (base as Role) : undefined
}

const RULE = `# Opus hub routing (from the opus-hub-routing plugin)

The main thread (Opus) is the hub. Every subagent reports back to it, and it checks the result before acting.

When delegating, pick the agent by job:
- Review, audit, security check, verifying finished work: \`${PLUGIN}:opus-reviewer\` (Opus).
- A clear, bounded change (known bug, tests, pattern refactor): \`${PLUGIN}:sonnet-builder\` (Sonnet).
- Finding files or symbols, codebase search, web search, fetching URLs or docs: \`${PLUGIN}:research-scout\` (Haiku).

Do not pass a \`model\` override to these three; their definitions set it.
Judge difficulty, not keywords: hard, ambiguous or cross-cutting work (unknown-cause bugs, multi-file design, architecture research) stays on the main thread.
Run \`${PLUGIN}:opus-reviewer\` on every \`${PLUGIN}:sonnet-builder\` result before you rely on it.`

const REVIEW_NOTE = `\n\n[opus-hub-routing] This came from sonnet-builder and has not been reviewed. Run opus-reviewer on these changes before relying on them.`

/** claude-opus-5-5 or "Opus 5.5" → opus; anything else passes through. */
const family = (model?: string): string | undefined => {
  if (model === undefined) return undefined
  const m = /(opus|sonnet|haiku|fable|mythos)/i.exec(model)
  return m ? m[1]!.toLowerCase() : model
}

/** How many times the current Opus price each family costs is (5.5 list prices: Opus $4/$20, Sonnet $2/$10, Haiku $0.10/$0.50 per MTok). */
const OPUS_MULTIPLE: Record<string, number> = { sonnet: 2, haiku: 40 }

const COLOR: Record<string, string> = {
  opus: 'magenta',
  fable: 'magenta',
  mythos: 'magenta',
  sonnet: 'blue',
  haiku: 'green',
}

const seconds = (ms: number): string => {
  const total = Math.round(ms / 1000)
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m${total % 60}s`
}

const tokensText = (n: number): string => (n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`)
const usd = (n: number): string => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

const patch = (id: string, fields: Partial<Routed>) => (list: Routed[]) =>
  list.map(one => (one.id === id || one.agentId === id ? { ...one, ...fields } : one))

/** Cost so far, and what the same work would have cost with every subagent on Opus. */
const totals = (list: Routed[]) => {
  let cost = 0
  let opusEquivalent = 0
  let tokens = 0
  for (const one of list) {
    tokens += one.tokens ?? 0
    if (one.costUsd === undefined) continue
    cost += one.costUsd
    opusEquivalent += one.costUsd * (OPUS_MULTIPLE[family(one.model) ?? ''] ?? 1)
  }
  return { cost, saved: opusEquivalent - cost, tokens }
}

const hubIdle = (h: Hub): Hub => ({ ...h, activity: h.inflight > 0 ? `waiting on ${h.inflight} agent${h.inflight === 1 ? '' : 's'}` : 'thinking' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'routing', description: 'Open the Opus hub routing pane and print this session’s routing summary' })
    const model = await $.session.model()
    await update($, hub, cur => ({ ...cur, model }))
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  // A /clear starts a new conversation: start the routing record over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, routed, () => [])
      await update($, review, () => ({ pending: [] }))
      await update($, hub, cur => ({ ...cur, activity: 'idle', inflight: 0 }))
    }
    return next(e)
  })

  // The routing rule rides along with the conversation's first message.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    if (result.blocks.some(b => b.name === 'opusHubRouting')) return result
    return { ...result, blocks: [...result.blocks, { name: 'opusHubRouting', text: RULE }] }
  })

  on('command.run', { command: 'routing' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    const list = await read($, routed)
    const pending = (await read($, review)).pending
    const t = totals(list)
    const lines = [
      `Routed ${list.length} subagent${list.length === 1 ? '' : 's'} this session, ${tokensText(t.tokens)} tokens, ${usd(t.cost)} (estimate).`,
      t.saved > 0 ? `About ${usd(t.saved)} saved versus running them all on Opus (estimate from list prices).` : undefined,
      pending.length > 0 ? `${pending.length} sonnet-builder result${pending.length === 1 ? '' : 's'} not reviewed yet: ${pending.join('; ')}` : undefined,
    ].filter(Boolean)
    return { text: lines.join('\n') }
  })

  on('prompt.submit', async ($, e, next) => {
    const model = await $.session.model()
    await update($, hub, cur => ({ ...cur, model, activity: 'thinking' }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    // A tool used inside a subagent: show it as that agent's activity.
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await update($, routed, patch(agentId, { activity: e.tool, status: 'running' }))

      return next(e)
    }

    if (e.tool !== 'Agent') {
      await update($, hub, cur => ({ ...cur, activity: e.tool }))
      try {
        return await next(e)
      } finally {
        await update($, hub, hubIdle)
      }
    }

    const id = e.tool_use_id
    const entry: Routed = {
      id,
      type: e.subagent_type ?? 'general-purpose',
      description: e.description,
      model: e.model,
      effort: e.effort,
      background: false,
      status: 'starting',
      startedAt: Date.now(),
    }
    await update($, routed, list => [...list, entry].slice(-50))
    await update($, hub, cur => ({ ...cur, inflight: cur.inflight + 1, activity: `routing → ${entry.type}` }))

    try {
      const ran = await next(e)
      const now = (await read($, routed)).find(one => one.id === id)
      // A background agent's call returns at once; its turn end marks it done.
      if (now !== undefined && !now.background && now.status !== 'done' && now.status !== 'failed') {
        await update($, routed, patch(id, { status: 'done', activity: undefined, durationMs: Date.now() - entry.startedAt }))
      }

      return ran
    } catch (error) {
      await update($, routed, patch(id, { status: 'failed', activity: undefined, durationMs: Date.now() - entry.startedAt }))
      throw error
    } finally {
      await update($, hub, cur => hubIdle({ ...cur, inflight: Math.max(0, cur.inflight - 1) }))
    }
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.workflow !== undefined) return next(e)

    // Enforce the rule: the three routed roles always run on their own definition's model.
    const role = roleOf(e.subagentType)
    const stripped = role !== undefined && e.model !== undefined
    if (stripped) $.ui.toast(`opus-hub-routing: dropped model "${e.model}" on ${role}; its definition picks the model`)
    const result = await next(stripped ? { ...e, model: undefined } : e)

    await update($, hub, cur => ({ ...cur, model: e.parentModel }))
    if (result.deny === undefined) {
      await update(
        $,
        routed,
        patch(e.tool_use_id, {
          agentId: result.agentId,
          model: result.model,
          background: e.background,
          type: e.subagentType,
          status: 'running',
          modelStripped: stripped || undefined,
        }),
      )
    } else {
      await update($, routed, patch(e.tool_use_id, { status: 'failed' }))
    }

    return result
  }).catch(($, e, next) => next(e))

  // Remind the hub, in the builder's own report, that the work still needs a review.
  on('agent.report', async ($, e, next) => {
    const result = await next(e)
    if (roleOf(e.subagentType) !== 'sonnet-builder' || e.status !== 'completed' || 'consumed' in result) return result
    return { ...result, text: result.text + REVIEW_NOTE }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, hub, cur => ({ ...cur, activity: 'idle' }))
      return next(e)
    }

    const agentId = e.agentId
    const done = e.reason === 'answer'
    const info = (await $.agent.list()).find(one => one.id === agentId)
    const tokens = info?.usage?.reduce((n, u) => n + u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, 0)
    const before = (await read($, routed)).find(one => one.agentId === agentId || one.id === agentId)
    await update(
      $,
      routed,
      patch(agentId, {
        status: done ? 'done' : 'failed',
        activity: undefined,
        durationMs: e.durationMs,
        tokens: tokens ?? (before?.tokens ?? 0) + (e.usage ? e.usage.input_tokens + e.usage.output_tokens : 0),
        costUsd: info?.cost?.usd ?? before?.costUsd,
        model: info?.model ?? before?.model,
      }),
    )

    if (done && before !== undefined) {
      const role = roleOf(before.type)
      if (role === 'sonnet-builder') await update($, review, cur => ({ pending: [...cur.pending, before.description].slice(-10) }))
      if (role === 'opus-reviewer') await update($, review, () => ({ pending: [] }))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, routed)
    const main = await read($, hub)
    const pending = (await read($, review)).pending
    const hubFamily = family(main.model) ?? 'opus'
    const working = list.filter(one => one.status === 'running' || one.status === 'starting')
    const t = totals(list)
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 11) / 2))
    const shown = list.slice(-room)

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={COLOR[hubFamily] ?? 'white'}>
            ◆ {hubFamily.toUpperCase()} · main (hub)
          </Text>
          <Text dimColor>  {main.activity}</Text>
          {hubFamily !== 'opus' && <Text color="yellow">  ! main loop is not on Opus: /model opus</Text>}
        </Box>
        <Text dimColor>
          {working.length} working · {list.length} routed · {tokensText(t.tokens)} tok · {usd(t.cost)}
        </Text>
        {t.saved > 0 && <Text color="green">≈ {usd(t.saved)} saved vs all-Opus (estimate)</Text>}
        {pending.length > 0 && (
          <Text color="yellow" wrap="truncate-end">
            ⚠ {pending.length} build{pending.length === 1 ? '' : 's'} not reviewed: run opus-reviewer
          </Text>
        )}
        {shown.length === 0 && <Text dimColor>No subagents yet. Opus is doing the work itself.</Text>}
        {shown.map((one, i) => {
          const fam = family(one.model) ?? 'inherit'
          const last = i === shown.length - 1
          const mark = one.status === 'done' ? '✓' : one.status === 'failed' ? '✗' : '●'
          const markColor = one.status === 'done' ? 'green' : one.status === 'failed' ? 'red' : 'yellow'
          const running = one.status === 'running' || one.status === 'starting'
          const tail = running
            ? one.activity ?? one.status
            : [one.durationMs !== undefined ? seconds(one.durationMs) : one.status, one.tokens ? `${tokensText(one.tokens)} tok` : undefined, one.costUsd !== undefined ? usd(one.costUsd) : undefined]
                .filter(Boolean)
                .join(' · ')

          return (
            <Box key={one.id} flexDirection="column">
              <Text wrap="truncate-end">
                <Text dimColor>{last ? '└─' : '├─'} </Text>
                <Text color={markColor}>{mark} </Text>
                <Text bold>{roleOf(one.type) ?? one.type}</Text>
                <Text color={COLOR[fam] ?? 'gray'}> {fam}</Text>
                <Text dimColor>/{one.effort ?? 'default'}</Text>
                {one.modelStripped && <Text color="yellow"> (override dropped)</Text>}
                <Text dimColor> · {tail}</Text>
              </Text>
              <Text dimColor wrap="truncate-end">
                {last ? '   ' : '│  '}
                {one.description}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
