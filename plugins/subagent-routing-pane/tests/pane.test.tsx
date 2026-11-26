import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'subagent-routing-pane',
  component: 'Pane',
  requestId: 'subagent-routing',
  props: {
    title: 'Routing · Opus hub',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('an Agent call shows under the Opus hub with its model, and is done after it returns', async ($, on) => {
  on('command.register', () => ({ value: { command: 'routing' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'toolu_1',
    description: 'Find auth files',
    prompt: 'find them',
    subagent_type: 'research-scout',
    model: 'haiku',
    effort: 'low',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /OPUS · main/ }))?.text).toContain('OPUS')
  const row = await ui.find({ type: 'Text', text: /research-scout/ })
  expect(row?.text).toContain('haiku')
  expect(row?.text).toContain('/low')
  expect(row?.text).toContain('✓')
  expect((await ui.find({ type: 'Text', text: /Find auth files/ }))?.text).toContain('Find auth files')
  await ui.unmount()
})

test('an empty session says Opus is doing the work itself', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No subagents yet/ }))?.text).toContain('Opus')
  await ui.unmount()
})
