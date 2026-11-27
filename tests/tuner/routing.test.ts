// The tuner and the routing half of one plugin: the routed roles keep their pinned
// model, the routing record sees the call as tuned, and nothing launches twice.
import { expect, test } from 'claude-code/testing'
import { REVIEW, engine, start } from './harness'

const ROLE_CALL = (role: string) =>
  ({ tool: 'Agent', description: 'Review the diff', prompt: 'p', subagent_type: `opus-hub-routing:${role}` }) as const

const ROUTING_PANE = {
  plugin: 'opus-hub-routing',
  component: 'Pane',
  requestId: 'opus-hub-routing',
  surface: 'terminal',
  props: {
    title: 'Routing · Opus hub',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the plugin starts in Auto when nothing is stored', async ($, on) => {
  const { seen, asked } = engine(on, { store: { mode: undefined } })

  await start($)
  await $.tool.call(REVIEW)

  expect(asked).toEqual([])
  expect(seen[0]).toMatchObject({ model: 'opus', effort: 'high' })
})

test('auto: a saved default never changes a routed role’s model, only its effort', async ($, on) => {
  const { seen, toasts } = engine(on, { store: { mode: 'auto', saved: { model: 'haiku', effort: 'max' } } })

  await start($)

  for (const role of ['opus-reviewer', 'sonnet-builder', 'research-scout']) {
    await $.tool.call(ROLE_CALL(role))
    expect(seen.at(-1), role).toMatchObject({ model: undefined, effort: 'max' })
  }

  expect(toasts).toEqual([
    'opus-reviewer -> effort max (model pinned)',
    'sonnet-builder -> effort max (model pinned)',
    'research-scout -> effort max (model pinned)',
  ])
})

test('auto: a routed role with no saved effort passes untouched, quietly', async ($, on) => {
  const { seen, toasts } = engine(on, { store: { mode: 'auto', saved: { model: 'haiku', effort: null } } })

  await start($)
  await $.tool.call(ROLE_CALL('opus-reviewer'))

  expect(seen).toEqual([{ model: undefined, effort: undefined, description: 'Review the diff' }])
  expect(toasts).toEqual([])
})

test('manual: a routed role is never asked about', async ($, on) => {
  const { seen, asked } = engine(on)

  await start($)
  await $.tool.call(ROLE_CALL('sonnet-builder'))

  expect(asked).toEqual([])
  expect(seen).toEqual([{ model: undefined, effort: undefined, description: 'Review the diff' }])
})

test('the routing pane shows the model and effort the tuner settled', async ($, on) => {
  engine(on, { store: { mode: 'auto' } })

  await start($)
  await $.tool.call({ ...REVIEW, tool_use_id: 't1' } as never)

  const ui = await $.ui.mount(ROUTING_PANE)
  const row = await ui.find({ type: 'Text', text: /code-reviewer/ })

  expect(row?.text).toContain('opus')
  expect(row?.text).toContain('/high')
  await ui.unmount()
})

test('a state read that fails anywhere in the call still launches the subagent exactly once', async ($, on) => {
  const { seen, failStateReadIn } = engine(on, { store: { mode: 'auto' } })

  await start($)

  for (let step = 1; step <= 8; step += 1) {
    const before = seen.length
    failStateReadIn(step)
    await $.tool.call(REVIEW)
    expect(seen.length - before, `a read refused at step ${step}`).toBe(1)
  }
})

test('/routing reports the tuner mode and default', async ($, on) => {
  engine(on, { store: { mode: 'auto', saved: { model: 'sonnet', effort: null } } })

  await start($)

  const ran = (await $.command.run({ command: 'routing' } as never)) as { text?: string }

  expect(ran.text).toContain('Tuner: auto · default sonnet/rec.')
})
