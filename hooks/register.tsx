import { atom, read, update } from 'claude-code'
import type { EngineInterface, MatchedHook, Register } from 'claude-code'

import type {
  Hub,
  Review,
  Routed,
  TunerChoice as Choice,
  TunerMode as Mode,
  TunerPending as Pending,
  TunerQueue,
  TunerSettings,
} from '../types'
import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  MORE_EFFORT_OPTIONS,
  MORE_MODEL_OPTIONS,
  fieldQuestion,
  headerFor,
  mainDialog,
  readField,
  readMain,
} from './tuner/dialog'
import { INHERIT_VALUE, paneView } from './tuner/pane-view'
import {
  FORK_TYPE,
  INHERIT,
  autoPatch,
  describeChoice,
  hasOpenField,
  hasOwnDefinition,
  isJudgedByName,
  presetFor,
  recommend,
  resolveDefault,
} from './tuner/recommend'
import {
  DEFAULT_MODE,
  STORE_MODE,
  STORE_SAVED,
  asDefault,
  cycleField,
  parseChoice,
  parseMode,
  patched,
  withPending,
  without,
} from './tuner/state'
import type { Field } from './tuner/state'
import { SHELLS, probeArgv, removeArgv, waitArgv } from './tuner/shell'
import type { Shell } from './tuner/shell'
import { MIN_COLUMNS, bandView } from './tuner/view'
import type { Actions } from './tuner/view'

// This module holds every call on `$` and every atom: the loader follows `$`, and
// reads an atom's reference, only within one file. The tuner's logic, words and
// views are pure siblings in ./tuner.

const PLUGIN = 'opus-hub-routing'
const PANE = 'opus-hub-routing'
const TITLE = 'Routing · Opus hub'

// ─── Routing state ──────────────────────────────────────────────────────────

// Bump a tag when its value's fields change: an older stored value is declined.
const routed = atom({ plugin: 'opus-hub-routing', key: 'routed' } as const, [] as Routed[], { shape: 'routed-2' })
const hub = atom({ plugin: 'opus-hub-routing', key: 'hub' } as const, { activity: 'idle', inflight: 0 } as Hub, { shape: 'hub-2' })
const review = atom({ plugin: 'opus-hub-routing', key: 'review' } as const, { pending: [] } as Review, { shape: 'review-1' })

/** The three roles this plugin routes to; their own definitions set the model. */
const ROLES = ['opus-reviewer', 'sonnet-builder', 'research-scout'] as const
type Role = (typeof ROLES)[number]

/** `opus-hub-routing:sonnet-builder` and a hand-copied `sonnet-builder` are the same role. */
const roleOf = (type: string | undefined): Role | undefined => {
  if (type === undefined) return undefined
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
If you hand hard work to a built-in agent (general-purpose, Explore, Plan), pass \`model: "opus"\` on the call: otherwise the tuner may pick a cheaper model from the task's wording. (A default the person saved on the tuner band still wins; that is their call.)
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

/**
 * The pane's bookkeeping never fails a hook. A hook that throws before it calls
 * `next` is answered by its `.catch`, which passes the event on as it came in,
 * without this hook's changes (at spawn, without the model guard). A lost row only
 * costs the pane a line.
 */
const quietly = async (work: Promise<unknown>): Promise<void> => {
  try {
    await work
  } catch {
    // The pane misses this change; the call goes on.
  }
}

const hubIdle = (h: Hub): Hub => ({ ...h, activity: h.inflight > 0 ? `waiting on ${h.inflight} agent${h.inflight === 1 ? '' : 's'}` : 'thinking' })

// ─── Tuner state ────────────────────────────────────────────────────────────

/** How long after a launch a stalled save of the default is waited for. */
export const SAVE_WAIT_MS = 2_000

/** The longest a pick pane is waited for: `$.process.run` takes ten minutes at most. */
export const PANE_WAIT_MS = 600_000

/** Every pick pane starts with this, so a reload can find the stale ones. */
export const PANE_PREFIX = 'opus-hub-tuner-'

const PANE_ROWS = 9

const settings = atom(
  { plugin: 'opus-hub-routing', key: 'tunerSettings' } as const,
  { mode: DEFAULT_MODE, saved: null, hydrated: false } satisfies TunerSettings,
)

const queue = atom({ plugin: 'opus-hub-routing', key: 'tunerQueue' } as const, {
  items: [],
} satisfies TunerQueue)

type Host = EngineInterface
type AgentHook = MatchedHook<'tool.call', { readonly tool: 'Agent' }>
type AgentCall = Parameters<AgentHook>[1]
type AgentNext = Parameters<AgentHook>[2]
type Patch = Partial<Pick<AgentCall, 'model' | 'effort'>>

/** What the store holds; a bad stored value counts as unset. */
async function stored($: Host) {
  const [mode, saved] = await Promise.all([$.store.get(STORE_MODE), $.store.get(STORE_SAVED)])

  // An empty default (both fields inherited) is no default.
  return { mode: parseMode(mode, DEFAULT_MODE), saved: asDefault(parseChoice(saved)) }
}

// Loaded once: the reducer keeps what is already there, so a load that lost a
// race to a write (or to another load) changes nothing.
async function ensureHydrated($: Host): Promise<void> {
  if ((await read($, settings)).hydrated) {
    return
  }

  const loaded = await stored($)

  await update($, settings, current => (current.hydrated ? current : { ...loaded, hydrated: true }))
}

// Store writes are versioned per key, never queued behind one another. Each
// click bumps the version and writes the state as it stands when the write
// runs; a write that lands after a newer click writes again, so an earlier
// $.store.set that finishes late cannot leave the store disagreeing with the
// band, and one that never finishes holds nothing back. The click waits for its
// write only for SAVE_WAIT_MS and says when a save is stuck. (The versions are a
// module variable: a hot reload resets them, which only drops the repair of a
// write already in flight.)
const versions = new Map<string, number>()
const WHAT: Record<string, string> = { [STORE_MODE]: 'the mode', [STORE_SAVED]: 'the default' }

async function persistLatest($: Host, key: string, current: () => Promise<unknown>): Promise<void> {
  versions.set(key, (versions.get(key) ?? 0) + 1)

  const write = (async (): Promise<void> => {
    let written = -1

    while (written !== versions.get(key)) {
      written = versions.get(key) ?? 0

      const value = await current()

      try {
        await $.store.set(key, value)
      } catch (error) {
        $.ui.toast(`Tuner: could not save (${error instanceof Error ? error.message : 'store error'})`)

        return
      }
    }
  })()
  const stop = new AbortController()
  const isStuck = await Promise.race([
    write.then(() => false),
    $.clock.sleep(SAVE_WAIT_MS, { signal: stop.signal }).then(
      () => true,
      () => false,
    ),
  ])

  stop.abort()

  if (isStuck) {
    // Whatever the write does later, the click has been answered.
    write.catch(() => undefined)
    $.ui.toast(`Tuner: saving ${WHAT[key] ?? 'a setting'} is taking too long`)
  }
}

async function setMode($: Host, mode: Mode): Promise<void> {
  await ensureHydrated($)
  await update($, settings, current => ({ ...current, mode }))
  await persistLatest($, STORE_MODE, async () => (await read($, settings)).mode)
}

async function changeSaved($: Host, change: (saved: Choice | null) => Choice | null): Promise<void> {
  await ensureHydrated($)
  await update($, settings, current => ({ ...current, saved: asDefault(change(current.saved)) }))
  await persistLatest($, STORE_SAVED, async () => (await read($, settings)).saved)
}

const actionsFor = ($: Host): Actions => ({
  setMode: mode => setMode($, mode),
  cycle: (field: Field) => changeSaved($, saved => cycleField(saved, field)),
  reset: () => changeSaved($, () => null),
})

// The call's model and effort are the tool's own literal unions; the tuner
// holds them as plain strings it checked against the same names.
const asPatch = (p: { model?: string; effort?: string }): Patch => p as Patch
const asCall = (call: object): AgentCall => call as AgentCall

/** The call with exactly the selection's model and effort. */
function selected(e: AgentCall, choice: Choice): object {
  const { model: _model, effort: _effort, ...rest } = e

  return {
    ...rest,
    ...(choice.model === null ? {} : { model: choice.model }),
    ...(choice.effort === null ? {} : { effort: choice.effort }),
  }
}

// Manual: the selection is the whole answer, so the call's own value is replaced
// by it, and inherit removes the field from the call.
function applySelection($: Host, e: AgentCall, next: AgentNext, choice: Choice, label: string) {
  if (choice.model !== (e.model ?? null) || choice.effort !== (e.effort ?? null)) {
    $.ui.toast(`${label} -> ${describeChoice(choice)}`)
  }

  return next(asCall(selected(e, choice)))
}

// Auto: the saved default outvotes the call, so the toast says where the call's
// own choice was overridden.
function applyAuto($: Host, e: AgentCall, next: AgentNext, saved: Choice | null, rec: Choice) {
  const p = autoPatch(e, saved, rec)
  const result = { model: p.model ?? e.model ?? null, effort: p.effort ?? e.effort ?? null }
  const isOverride =
    (p.model !== undefined && e.model !== undefined && p.model !== e.model) ||
    (p.effort !== undefined && e.effort !== undefined && p.effort !== e.effort)

  if (result.model !== (e.model ?? null) || result.effort !== (e.effort ?? null)) {
    $.ui.toast(`${isOverride ? 'Subagent (overridden)' : 'Subagent'} -> ${describeChoice(result)}`)
  }

  return next({ ...e, ...asPatch(p) })
}

// The three routed roles keep the model their definition pins: the tuner never
// asks about them and never changes their model. In Auto a saved effort still applies.
async function tuneRole($: Host, e: AgentCall, next: AgentNext, role: Role) {
  const { mode, saved } = await read($, settings)
  const effort = saved?.effort ?? null

  if (mode !== 'auto' || effort === null || effort === e.effort) {
    return next(e)
  }

  $.ui.toast(`${role} -> effort ${effort} (model pinned)`)

  return next({ ...e, ...asPatch({ effort }) })
}

// A person is asked only where the band can be drawn too (the terminal and the
// desktop): on another surface (vscode, mobile) they could not change the mode or
// the default and would be asked on every call.
async function canAsk($: Host): Promise<boolean> {
  return (await $.session.surfaces()).some(surface => surface === 'terminal' || surface === 'desktop')
}

// A -p run or an SDK host draws nothing: nobody there chose a mode or a default,
// and a model changed behind its back would skew what the run measures (evals).
async function isHeadless($: Host): Promise<boolean> {
  return (await $.session.surfaces()).length === 0
}

const tuneAgent: AgentHook = async ($, e, next) => {
  // A fork ignores model and effort.
  if (e.subagent_type === FORK_TYPE || (await isHeadless($))) {
    return next(e)
  }

  await ensureHydrated($)

  const role = roleOf(e.subagent_type)

  if (role !== undefined) {
    return tuneRole($, e, next, role)
  }

  const { mode, saved } = await read($, settings)
  // A custom agent's own definition may pin a model and an effort, unseen here.
  const rec = hasOwnDefinition(e.subagent_type, offers) ? INHERIT : recommend(e)

  if (mode === 'auto' || !(await canAsk($))) {
    if (isJudgedByName(e.subagent_type, offers)) {
      judgedByName.set(e.tool_use_id, e)
    }

    return applyAuto($, e, next, saved, rec)
  }

  // Manual asks only about what the call left open.
  if (!hasOpenField(e)) {
    return next(e)
  }

  const fallback = resolveDefault(saved, rec)

  // The pane where it can be seated unasked (wide terminals); a chain of the
  // engine's own dialogs where it cannot.
  const preset = presetFor(e, fallback)
  const viaPane = await askInPane($, e, next.signal, preset)
  let reading: Outcome

  if (viaPane.kind === 'unavailable') {
    // A pane that is not placed (a narrow terminal) is the normal case: dialogs, unannounced.
    if (viaPane.reason !== NOT_PLACED) {
      $.ui.toast(`Tuner: pane unavailable: ${viaPane.reason}`)
    }

    reading = await askChain($, e, next.signal, preset)
  } else {
    reading = viaPane
  }

  // An interrupted dispatch has no one left to tell, and nothing to start.
  if (next.signal.aborted) {
    return { deny: 'interrupted' }
  }

  // A dismissed or failed question must not hold the subagent back.
  if (reading.kind === 'unanswered') {
    return applySelection($, e, next, reading.choice ?? preset, 'Subagent (no answer)')
  }

  if (reading.kind === 'unreadable') {
    $.ui.toast(reading.problem)

    return { deny: 'could not read the answer; nothing was started' }
  }

  if (reading.kind === 'cancel') {
    return { deny: 'cancelled by user' }
  }

  return reading.kind === 'save'
    ? launchAndSave($, next, asCall(selected(e, reading.choice)), reading.choice)
    : next(asCall(selected(e, reading.choice)))
}

type Outcome =
  | { kind: 'run' | 'save'; choice: Choice }
  | { kind: 'cancel' }
  /** Nothing usable came back: the launch goes on, with the selection if there was one. */
  | { kind: 'unanswered'; choice?: Choice }
  | { kind: 'unreadable'; problem: string }

/** The pane route could not be used: why, in a few words. */
type Unavailable = { kind: 'unavailable'; reason: string }

const NOT_PLACED = 'not placed'

// Where the pane cannot be seated, a chain of the engine's own dialogs (`$.ui.ask`:
// a `$` call, so the hook's time budget does not count the waits). The first
// carries the selection in its labels and what to do; Change walks the field
// dialogs and comes back to it with the new values, until Run, Run and save, or
// Cancel. A dismissed or refused dialog fails open to the selection as it stands.
async function ask1($: Host, question: string, options: readonly string[], header: string): Promise<string | undefined> {
  try {
    return await $.ui.ask(question, { options, header })
  } catch {
    return undefined
  }
}

// One field's dialog; text typed under Other that names no value is asked once
// more, then the previous value stays. `undefined`: the dialog was dismissed.
async function askField($: Host, call: AgentCall, field: Field, previous: string | null): Promise<string | null | undefined> {
  const header = field === 'model' ? 'Model' : 'Effort'
  const options = field === 'model' ? MODEL_OPTIONS : EFFORT_OPTIONS

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await ask1($, fieldQuestion(call, field), options, header)

    if (answer === undefined) {
      return undefined
    }

    const value = readField(field, answer)

    if (value === 'more') {
      const rest = await ask1($, fieldQuestion(call, field), field === 'model' ? MORE_MODEL_OPTIONS : MORE_EFFORT_OPTIONS, header)

      if (rest === undefined) {
        return undefined
      }

      const picked = readField(field, rest)

      if (picked !== undefined && picked !== 'more') {
        return picked
      }
    } else if (value !== undefined) {
      return value
    }
  }

  return previous
}

async function askChain($: Host, call: AgentCall, signal: AbortSignal, preset: Choice): Promise<Outcome> {
  let current: Choice = { ...preset }

  chain: for (;;) {
    // An interrupted dispatch asks nothing more.
    if (signal.aborted) {
      return { kind: 'unanswered', choice: current }
    }

    const dialog = mainDialog(call, current)
    const answer = await ask1($, dialog.question, dialog.options, 'Subagent')

    if (answer === undefined) {
      return { kind: 'unanswered', choice: current }
    }

    const said = readMain(dialog, answer)

    if (said.kind === 'run' || said.kind === 'save') {
      return { kind: said.kind, choice: current }
    }

    if (said.kind === 'typed') {
      return { kind: 'run', choice: said.choice }
    }

    if (said.kind === 'cancel') {
      return { kind: 'cancel' }
    }

    if (said.kind === 'unreadable') {
      return said
    }

    // A field dialog dismissed discards the whole change: back to the first
    // dialog with the selection as it was when Change was chosen.
    let changed = current

    for (const field of ['model', 'effort'] as const) {
      if (signal.aborted) {
        return { kind: 'unanswered', choice: current }
      }

      const value = await askField($, call, field, changed[field])

      if (value === undefined) {
        continue chain
      }

      changed = { ...changed, [field]: value }
    }

    current = changed
  }
}

// One pane for each launch, so each launch is bound to its pane by the pane's
// id and several at once are tabs the person moves between. What the pane's
// selectors hold is kept here too: every read of one dispatch sees one moment,
// the one before the pane opened, so the hook cannot read the selection back
// from the state. A reload drops this, and the hook it served with it.
type PickSession = {
  title: string
  choice: Choice
  /** What the person (or the dispatch) decided; absent while it waits. */
  decision?: 'run' | 'save' | 'cancel' | 'abort'
  sentinel: string
}

const sessions = new Map<string, PickSession>()

const paneIdFor = (toolUseId: string): string => `${PANE_PREFIX}${toolUseId.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64)

const pendingFor = (call: AgentCall, id: string, preset: Choice): Pending => ({
  id,
  subagentType: call.subagent_type ?? 'general-purpose',
  description: call.description,
  model: preset.model,
  effort: preset.effort,
  isCallSet: call.model !== undefined || call.effort !== undefined,
})

const removePending = ($: Host, id: string): Promise<unknown> => update($, queue, q => without(q, id))

async function pickValue($: Host, id: string, field: Field, value: string): Promise<void> {
  const session = sessions.get(id)
  const after = await update($, queue, q => patched(q, id, { [field]: value === INHERIT_VALUE ? null : value }))
  const entry = after.items.find(one => one.id === id)

  if (session !== undefined && entry !== undefined) {
    session.choice = { model: entry.model, effort: entry.effort }
  }
}

const shortReason = (error: unknown): string => (error instanceof Error ? error.message : 'error').slice(0, 60)

// Found once per load (register resets it): a reload may find another host.
let waitShell: Promise<Shell | undefined> | undefined

function shellToWaitIn($: Host): Promise<Shell | undefined> {
  waitShell ??= (async () => {
    for (const shell of SHELLS) {
      try {
        await $.process.run(probeArgv(shell))

        return shell
      } catch {
        // Not on this host: try the next.
      }
    }

    return undefined
  })()

  return waitShell
}

// Ends the wait: records the decision once, then makes the sentinel appear.
async function finish($: Host, id: string, decision: 'run' | 'save' | 'cancel' | 'abort'): Promise<void> {
  const session = sessions.get(id)

  if (session === undefined || session.decision !== undefined) {
    return
  }

  session.decision = decision

  try {
    await $.fs.write(session.sentinel, '')
  } catch {
    $.ui.toast('Tuner: could not release the pane; your choice applies when its wait ends')
  }
}

// The hook's own time budget stops while a `$` call is in flight but not for an
// await on a promise, so the wait is a child process that ends when the
// sentinel appears. The sentinel lives in the plugin's own folder, named for the
// call and the moment, so no two waits share one. A wait that ends without a
// decision (the ten minutes ran out) is no answer; one that ends with a decision
// recorded (the sentinel could not be written) honours it.
async function askInPane($: Host, call: AgentCall, signal: AbortSignal, preset: Choice): Promise<Outcome | Unavailable> {
  if (signal.aborted) {
    return { kind: 'unanswered' }
  }

  const shell = await shellToWaitIn($)

  if (shell === undefined) {
    return { kind: 'unavailable', reason: 'no shell to wait in' }
  }

  // Aborted while the shell was found: nothing was made, nothing to undo.
  if (signal.aborted) {
    return { kind: 'unanswered' }
  }

  const id = paneIdFor(call.tool_use_id)
  const entry = pendingFor(call, id, preset)
  const sentinel = `${$.plugin.root}/.waits/${id}-${await $.clock.now()}`

  // A folder that takes no write (read-only install, full disk) could never end
  // the wait: the dialogs answer at once instead of a pane that holds the launch
  // for ten minutes. The probe is a sibling the wait does not look for.
  try {
    await $.fs.write(`${sentinel}.probe`, '')
  } catch (error) {
    return { kind: 'unavailable', reason: `waits folder not writable: ${shortReason(error)}` }
  }

  await $.process.run(removeArgv(shell, `${sentinel}.probe`)).catch(() => undefined)

  // Aborted while the probe ran: nothing is open yet.
  if (signal.aborted) {
    return { kind: 'unanswered' }
  }

  const session: PickSession = {
    choice: { model: entry.model, effort: entry.effort },
    sentinel,
    title: headerFor(call).slice(0, 40),
  }
  const onAbort = (): void => {
    finish($, id, 'abort').catch(() => undefined)
  }

  sessions.set(id, session)
  signal.addEventListener('abort', onAbort)

  // Whether the waiting child ran: it removes the sentinel. Where it never ran, a
  // sentinel written for a decision made meanwhile (an abort) is removed below.
  let waited = false

  try {
    await update($, queue, q => withPending(q, entry))

    const opened = await $.ui.open({
      id,
      title: session.title,
      focus: true,
      closeOnEscape: true,
      holdToasts: true,
      rows: PANE_ROWS,
    })
    const pane = (await $.ui.panes()).find(one => one.id === id)

    // A pane that waits undrawn (a narrow terminal) cannot be answered.
    if (!opened.isPlaced || pane === undefined || !pane.isPlaced) {
      return { kind: 'unavailable', reason: NOT_PLACED }
    }

    if (!pane.isFocused) {
      $.ui.toast('Tuner: press ctrl+x then Tab to reach the pane')
    }

    waited = true

    try {
      await $.process.run(waitArgv(shell, session.sentinel), { timeoutMs: PANE_WAIT_MS })
    } catch {
      // The wait ran out; what follows reads the decision as it stands.
    }

    // A decision recorded stands, even where the sentinel could not be written.
    // A wait that ended with none (it ran out, or the shell died early) is no
    // answer: the person's live selection stands, not the preset.
    return session.decision === 'run' || session.decision === 'save'
      ? { kind: session.decision, choice: session.choice }
      : session.decision === 'cancel'
        ? { kind: 'cancel' }
        : { kind: 'unanswered', choice: session.choice }
  } catch (error) {
    return { kind: 'unavailable', reason: shortReason(error) }
  } finally {
    signal.removeEventListener('abort', onAbort)

    if (!waited && session.decision !== undefined) {
      await $.process.run(removeArgv(shell, sentinel)).catch(() => undefined)
    }

    sessions.delete(id)
    // Nothing is left behind on any path: the entry, the pane (the wait removed
    // the sentinel).
    await removePending($, id).catch(() => undefined)
    await $.ui.close({ id }).catch(() => undefined)
  }
}

// The person's choice starts the subagent whatever becomes of the save: the
// save runs beside the launch (and says when it is stuck), and a failure of it
// is said rather than lost.
async function launchAndSave($: Host, next: AgentNext, chosen: Parameters<AgentNext>[0], choice: Choice) {
  const saving = changeSaved($, () => choice).catch((error: unknown) => {
    $.ui.toast(`Tuner: could not save the default (${error instanceof Error ? error.message : 'error'})`)
  })
  const ran = await next(chosen)

  await saving

  return ran
}

// What the engine offered, per agent type: true for a built-in. Raised when the listing is built, so
// before the model can name a type at dispatch. Reset by register, like waitShell.
const offers = new Map<string, boolean>()

// The calls judged by name alone (their offer had not come) that Auto let through untouched, by
// tool_use_id: the spawn names who provides the type, which the call could not know.
const judgedByName = new Map<string, AgentCall>()

/** The band's words for the /routing summary: `auto · default sonnet/rec.`. */
const tunerLine = (s: TunerSettings): string =>
  `Tuner: ${s.mode} · default ${s.saved === null ? 'none (recommendation)' : `${s.saved.model ?? 'rec.'}/${s.saved.effort ?? 'rec.'}`}`

// ─── Hooks ──────────────────────────────────────────────────────────────────

export const register: Register = on => {
  waitShell = undefined
  offers.clear()
  judgedByName.clear()

  on('session.start', async ($, e, next) => {
    // A store that cannot be read leaves the band on what it shows unloaded; the
    // routing half below still starts.
    await ensureHydrated($).catch(() => undefined)

    // A pick pane a previous copy of this module left open has no one waiting on it.
    try {
      for (const pane of await $.ui.panes()) {
        if (pane.id.startsWith(PANE_PREFIX)) {
          await $.ui.close({ id: pane.id })
        }
      }
    } catch {
      // No panes to clear.
    }

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
    await ensureHydrated($)
    const list = await read($, routed)
    const pending = (await read($, review)).pending
    const t = totals(list)
    const lines = [
      `Routed ${list.length} subagent${list.length === 1 ? '' : 's'} this session, ${tokensText(t.tokens)} tokens, ${usd(t.cost)} (estimate).`,
      t.saved > 0 ? `About ${usd(t.saved)} saved versus running them all on Opus (estimate from list prices).` : undefined,
      pending.length > 0 ? `${pending.length} sonnet-builder result${pending.length === 1 ? '' : 's'} not reviewed yet: ${pending.join('; ')}` : undefined,
      tunerLine(await read($, settings)),
    ].filter(Boolean)
    return { text: lines.join('\n') }
  })

  on('prompt.submit', async ($, e, next) => {
    const model = await $.session.model()
    await update($, hub, cur => ({ ...cur, model, activity: 'thinking' }))

    return next(e)
  }).catch(($, e, next) => next(e))

  // Only observes: the offer goes on as it came, whatever the record does.
  on('agent.offer', (_$, e, next) => {
    try {
      // `source` tells a built-in from a user's agent of its name; any doubt counts as custom.
      offers.set(e.agent, e.source === 'built-in' && e.provider.plugin === 'engine' && e.provider.tier === 'core')
    } catch {
      // Unrecorded, the type is judged by its name.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The tuner settles the call's model and effort first, so the routing record
  // below sees the call as it will run. A broken tuner must never keep a
  // subagent from starting: whatever fails, the call goes on as the model made it.
  on('tool.call', { tool: 'Agent' }, tuneAgent).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    // A tool used inside a subagent: show it as that agent's activity.
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await quietly(update($, routed, patch(agentId, { activity: e.tool, status: 'running' })))

      return next(e)
    }

    if (e.tool !== 'Agent') {
      await quietly(update($, hub, cur => ({ ...cur, activity: e.tool })))
      try {
        return await next(e)
      } finally {
        await quietly(update($, hub, hubIdle))
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
    await quietly(update($, routed, list => [...list, entry].slice(-50)))
    await quietly(update($, hub, cur => ({ ...cur, inflight: cur.inflight + 1, activity: `routing → ${entry.type}` })))

    let failed = false
    try {
      return await next(e)
    } catch (error) {
      failed = true
      throw error
    } finally {
      const durationMs = Date.now() - entry.startedAt
      await quietly(
        update($, routed, list => {
          const now = list.find(one => one.id === id)
          // A background agent's call returns at once; its turn end marks it done.
          if (now === undefined || (!failed && (now.background || now.status === 'done' || now.status === 'failed'))) return list
          return patch(id, { status: failed ? 'failed' : 'done', activity: undefined, durationMs })(list)
        }),
      )
      await quietly(update($, hub, cur => hubIdle({ ...cur, inflight: Math.max(0, cur.inflight - 1) })))
    }
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.workflow !== undefined) return next(e)

    let spawn = e

    // Tuner: where the engine announced a built-in after the call was judged by
    // name, the recommendation the call went without applies now (the spawn
    // takes a model only).
    const call = judgedByName.get(e.tool_use_id)
    judgedByName.delete(e.tool_use_id)
    if (call !== undefined && e.provider.plugin === 'engine' && e.provider.tier === 'core' && offers.get(e.subagentType) !== false) {
      const saved = await read($, settings).then(
        one => one.saved,
        () => undefined,
      )
      const { model } = saved === undefined ? {} : autoPatch(call, saved, recommend(call))
      if (model !== undefined && model !== e.model) {
        $.ui.toast(`Subagent model -> ${model}`)
        spawn = { ...spawn, model }
      }
    }

    // Enforce the rule: the three routed roles always run on their own definition's model.
    const role = roleOf(e.subagentType)
    const stripped = role !== undefined && spawn.model !== undefined
    if (stripped) {
      $.ui.toast(`opus-hub-routing: dropped model "${spawn.model}" on ${role}; its definition picks the model`)
      spawn = { ...spawn, model: undefined }
    }

    const result = await next(spawn)

    await quietly(update($, hub, cur => ({ ...cur, model: e.parentModel })))
    await quietly(
      update(
        $,
        routed,
        result.deny === undefined
          ? patch(e.tool_use_id, {
              agentId: result.agentId,
              model: result.model,
              background: e.background,
              type: e.subagentType,
              status: 'running',
              modelStripped: stripped || undefined,
            })
          : patch(e.tool_use_id, { status: 'failed' }),
      ),
    )

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

  // The person closing a pick pane (Escape, the close mark) cancels its launch.
  on('ui.close', async ($, e, next) => {
    const session = sessions.get(e.id)

    if (e.origin.kind === 'person' && session !== undefined) {
      await finish($, e.id, 'cancel')
    }

    return next(e)
  })

  // A pick pane's body: the selectors and the buttons for the launch it holds.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId === PANE || (e.surface !== 'terminal' && e.surface !== 'desktop')) {
      return next(e)
    }

    const entry = (await read($, queue)).items.find(one => one.id === e.requestId)

    if (entry === undefined) {
      return next(e)
    }

    return paneView({
      ui: $.ui.resolve(e),
      columns: e.props.bodyColumns,
      entry,
      actions: {
        pick: (id, field, value) => pickValue($, id, field, value),
        run: id => finish($, id, 'run'),
        save: id => finish($, id, 'save'),
        cancel: id => finish($, id, 'cancel'),
      },
    })
  })

  // The tuner band: this plugin's own row above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Raised on the terminal and the desktop only. Narrower than the smallest
    // layout nothing fits, so nothing is drawn.
    if (e.props.hasSurvey || e.props.bodyColumns < MIN_COLUMNS || (e.surface !== 'terminal' && e.surface !== 'desktop')) {
      return next(e)
    }

    // Before the first load the state holds only the initial values: show
    // what the store holds rather than a default that is not the person's. A
    // state that cannot be read now falls back to the store too, so the band stays up.
    const current = await read($, settings).catch(() => undefined)
    const { mode, saved } = current?.hydrated === true ? current : await stored($)

    return bandView({ ui: $.ui.resolve(e), columns: e.props.bodyColumns, mode, saved, actions: actionsFor($) })
  })

  // The routing pane.
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
