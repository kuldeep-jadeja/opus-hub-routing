import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Hub, Routed } from '../types'

const PANE = 'subagent-routing'
const TITLE = 'Routing · Opus hub'

// Bump a tag when its value's fields change: an older stored value is declined.
const routed = atom({ plugin: 'subagent-routing-pane', key: 'routed' } as const, [] as Routed[], { shape: 'routed-1' })
const hub = atom({ plugin: 'subagent-routing-pane', key: 'hub' } as const, { activity: 'idle' } as Hub, { shape: 'hub-1' })

/** claude-opus-5-5 → opus; an alias passes through. */
const family = (model?: string): string | undefined => {
  if (model === undefined) return undefined
  const m = /(opus|sonnet|haiku|fable|mythos)/i.exec(model)

  return m ? m[1]!.toLowerCase() : model
}

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

const patch = (id: string, fields: Partial<Routed>) => (list: Routed[]) =>
  list.map(one => (one.id === id || one.agentId === id ? { ...one, ...fields } : one))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'routing', description: 'Show which subagent Opus routed work to, and who is working' })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'routing' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Routing pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, hub, cur => ({ ...cur, activity: 'thinking' }))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // A tool used inside a subagent: show it as that agent's activity.
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await update($, routed, patch(agentId, { activity: e.tool, status: 'running' }))

      return next(e)
    }

    if (e.tool !== 'Agent') {
      await update($, hub, cur => ({ ...cur, activity: e.tool }))
      const ran = await next(e)
      await update($, hub, cur => ({ ...cur, activity: 'thinking' }))

      return ran
    }

    const id = e.tool_use_id
    const input = e
    const entry: Routed = {
      id,
      type: input.subagent_type ?? 'general-purpose',
      description: input.description,
      model: input.model,
      effort: input.effort,
      background: false,
      status: 'starting',
      startedAt: Date.now(),
    }
    await update($, routed, list => [...list, entry].slice(-50))
    await update($, hub, cur => ({ ...cur, activity: `routing → ${entry.type}` }))

    try {
      const ran = await next(e)
      const list = await read($, routed)
      const now = list.find(one => one.id === id)
      // A background agent's call returns at once; its turn end marks it done.
      if (now !== undefined && !now.background && now.status !== 'done') {
        await update($, routed, patch(id, { status: 'done', activity: undefined, durationMs: Date.now() - entry.startedAt }))
      }

      return ran
    } catch (error) {
      await update($, routed, patch(id, { status: 'failed', activity: undefined, durationMs: Date.now() - entry.startedAt }))
      throw error
    } finally {
      await update($, hub, cur => ({ ...cur, activity: 'thinking' }))
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (e.fork || e.workflow !== undefined) return result
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
        }),
      )
    } else {
      await update($, routed, patch(e.tool_use_id, { status: 'failed' }))
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, hub, cur => ({ ...cur, activity: 'idle' }))
    } else {
      const agentId = e.agentId
      await update(
        $,
        routed,
        patch(agentId, { status: e.reason === 'answer' ? 'done' : 'failed', activity: undefined, durationMs: e.durationMs }),
      )
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, routed)
    const main = await read($, hub)
    const hubFamily = family(main.model) ?? 'opus'
    const working = list.filter(one => one.status === 'running' || one.status === 'starting')
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 8) / 2))
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
          {working.length} working · {list.length} routed this session
        </Text>
        {shown.length === 0 && <Text dimColor>No subagents yet. Opus is doing the work itself.</Text>}
        {shown.map((one, i) => {
          const fam = family(one.model) ?? 'inherit'
          const last = i === shown.length - 1
          const mark = one.status === 'done' ? '✓' : one.status === 'failed' ? '✗' : '●'
          const markColor = one.status === 'done' ? 'green' : one.status === 'failed' ? 'red' : 'yellow'
          const tail =
            one.status === 'running' || one.status === 'starting'
              ? one.activity ?? one.status
              : one.durationMs !== undefined
                ? seconds(one.durationMs)
                : one.status

          return (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                <Text dimColor>{last ? '└─' : '├─'} </Text>
                <Text color={markColor}>{mark} </Text>
                <Text bold>{one.type}</Text>
                <Text color={COLOR[fam] ?? 'gray'}> {fam}</Text>
                <Text dimColor>/{one.effort ?? 'default'}</Text>
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
