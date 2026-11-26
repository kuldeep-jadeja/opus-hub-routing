import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'opus-hub-routing',
  component: 'Pane',
  requestId: 'opus-hub-routing',
  props: {
    title: 'Routing · Opus hub',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

const spawnInput = (over: Record<string, unknown>) => ({
  tool_use_id: 'toolu_1',
  prompt: 'do it',
  description: 'Fix login bug',
  subagentType: 'opus-hub-routing:sonnet-builder',
  provider: { plugin: 'opus-hub-routing', tier: 'user' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
  ...over,
})

test('an Agent call shows under the Opus hub with its model, and is done after it returns', async ($, on) => {
  on('command.register', () => ({ value: { command: 'routing' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'toolu_1',
    description: 'Find auth files',
    prompt: 'find them',
    subagent_type: 'opus-hub-routing:research-scout',
    model: 'haiku',
    effort: 'low',
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /OPUS · main/ }))?.text).toContain('OPUS')
    const row = await ui.find({ type: 'Text', text: /research-scout/ })
    expect(row?.text).toContain('haiku')
    expect(row?.text).toContain('/low')
    expect(row?.text).toContain('✓')
    expect((await ui.find({ type: 'Text', text: /Find auth files/ }))?.text).toContain('Find auth files')
    await ui.unmount()
  }
})

test('the main model is read at session start, so a non-Opus hub is flagged before any delegation', async ($, on) => {
  on('command.register', () => ({ value: { command: 'routing' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /SONNET · main/ }))?.text).toContain('SONNET')
  expect((await ui.find({ type: 'Text', text: /not on Opus/ }))?.text).toContain('/model opus')
  await ui.unmount()
})

test('a model override on a routed role is dropped', async ($, on) => {
  let seen: string | undefined = 'unset'
  on('agent.spawn', (_, e) => {
    seen = e.model
    return { model: 'claude-sonnet-5-5', agentId: 'a1' }
  })

  await $.agent.spawn(spawnInput({ model: 'opus' }) as never)
  expect(seen).toBe(undefined)
})

test('a model override on another agent type is left alone', async ($, on) => {
  let seen: string | undefined
  on('agent.spawn', (_, e) => {
    seen = e.model
    return { model: 'claude-opus-5-5', agentId: 'a2' }
  })

  await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', model: 'opus' }) as never)
  expect(seen).toBe('opus')
})

test("a builder's report carries a review reminder; other reports do not", async ($, on) => {
  on('agent.report', (_, e) => ({ text: e.text, review: 'none' as const }))

  const base = { agentId: 'a1', provider: { plugin: 'opus-hub-routing', tier: 'user' }, status: 'completed', text: 'Changed auth.ts' }
  const built = await $.agent.report({ ...base, subagentType: 'opus-hub-routing:sonnet-builder' } as never)
  expect(built.text).toContain('Run opus-reviewer')

  const scouted = await $.agent.report({ ...base, subagentType: 'opus-hub-routing:research-scout' } as never)
  expect(scouted.text).toBe('Changed auth.ts')
})

test('an unreviewed build shows in the pane until opus-reviewer finishes', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', (_, e) => ({ model: e.subagentType.includes('reviewer') ? 'claude-opus-5-5' : 'claude-sonnet-5-5', agentId: e.tool_use_id === 't1' ? 'a1' : 'a2' }))
  on('agent.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))

  const agentCall = (id: string, type: string, description: string) =>
    $.tool.call({ tool: 'Agent', tool_use_id: id, description, prompt: 'go', subagent_type: type })

  await agentCall('t1', 'opus-hub-routing:sonnet-builder', 'Fix login bug')
  await $.agent.spawn(spawnInput({ tool_use_id: 't1' }) as never)
  await $.turn.complete({ answer: 'done', durationMs: 1200, isAborted: false, turnId: 'r1', agentId: 'a1', reason: 'answer', usage: { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' } } as never)

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /not reviewed/ }))?.text).toContain('1 build')
  expect((await ui.find({ type: 'Text', text: /sonnet-builder/ }))?.text).toContain('1.2k tok')
  await ui.unmount()

  await agentCall('t2', 'opus-hub-routing:opus-reviewer', 'Review login fix')
  await $.agent.spawn(spawnInput({ tool_use_id: 't2', subagentType: 'opus-hub-routing:opus-reviewer', description: 'Review login fix' }) as never)
  await $.turn.complete({ answer: 'ok', durationMs: 800, isAborted: false, turnId: 'r2', agentId: 'a2', reason: 'answer' } as never)

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /not reviewed/ })).toBe(undefined)
  await ui.unmount()
})

test('cost and the all-Opus savings estimate come from the agent ledger', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('agent.list', () => ({
    value: [{ id: 'a1', model: 'claude-haiku-5-5', cost: { usd: 0.01 }, usage: [{ input_tokens: 5000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' }] }] as never,
  }))
  on('turn.complete', () => ({ text: '' }))

  await $.tool.call({ tool: 'Agent', tool_use_id: 't1', description: 'Find config', prompt: 'go', subagent_type: 'opus-hub-routing:research-scout' })
  await $.agent.spawn(spawnInput({ tool_use_id: 't1', subagentType: 'opus-hub-routing:research-scout' }) as never)
  await $.turn.complete({ answer: 'found', durationMs: 500, isAborted: false, turnId: 'r1', agentId: 'a1', reason: 'answer' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /research-scout/ }))?.text).toContain('6.0k tok')
  // Haiku 5.5 is 1/40 of Opus 5.5's price: $0.01 on Haiku is about $0.40 on Opus.
  expect((await ui.find({ type: 'Text', text: /saved vs all-Opus/ }))?.text).toContain('$0.39')
  await ui.unmount()
})

test('a /clear starts the routing record over', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await $.tool.call({ tool: 'Agent', tool_use_id: 't1', description: 'Find config', prompt: 'go', subagent_type: 'Explore' })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No subagents yet/ }))?.text).toContain('Opus')
  await ui.unmount()
})

test('the routing rule is added to the first message context once', async ($, on) => {
  on('prompt.context', (_, e) => ({ blocks: e.blocks }))

  const result = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] } as never)
  const rule = result.blocks.filter(b => b.name === 'opusHubRouting')
  expect(rule.length).toBe(1)
  expect(rule[0]!.text).toContain('opus-hub-routing:sonnet-builder')
})
