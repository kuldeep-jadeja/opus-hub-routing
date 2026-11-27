export type Routed = {
  /** The Agent tool call that started it. */
  id: string
  /** The loop id once spawned, used to match its tool calls and its turn end. */
  agentId?: string
  type: string
  description: string
  model?: string
  effort?: string
  background: boolean
  status: 'starting' | 'running' | 'done' | 'failed'
  /** The tool the subagent is using right now. */
  activity?: string
  startedAt: number
  durationMs?: number
  /** Input + output tokens over all its turns. */
  tokens?: number
  /** What /cost credited for it, in US dollars (an estimate). */
  costUsd?: number
  /** True when the plugin removed a `model` override the call passed. */
  modelStripped?: boolean
}

export type Hub = {
  model?: string
  /** idle, thinking, or the tool the main loop is using. */
  activity: string
  /** Agent tool calls of the main loop still waiting on their result. */
  inflight: number
}

export type Review = {
  /** Descriptions of sonnet-builder runs that no opus-reviewer run has checked yet. */
  pending: string[]
}

// The tuner band and its pick pane. A model or effort is null where the
// subagent inherits the parent's (shown as `rec.` in the band).

export type TunerMode = 'manual' | 'auto'

export type TunerChoice = {
  model: string | null
  effort: string | null
}

export type TunerSettings = {
  mode: TunerMode
  /** The saved default; null while none is set. */
  saved: TunerChoice | null
  /** True once the persisted mode and default were loaded into this state. */
  hydrated: boolean
}

/** A subagent launch waiting for the person in its pane. */
export type TunerPending = {
  /** The pane's id: one pane for each launch. */
  id: string
  subagentType: string
  description: string
  /** The current selection, which Run applies; it starts at the preset. */
  model: string | null
  effort: string | null
  /** True where the call itself set a model or an effort (the preset may differ from it). */
  isCallSet: boolean
}

export type TunerQueue = {
  items: TunerPending[]
}

declare module 'claude-code' {
  interface PluginState {
    'opus-hub-routing': {
      routed: Shaped<Routed[]>
      hub: Shaped<Hub>
      review: Shaped<Review>
      tunerSettings: TunerSettings
      tunerQueue: TunerQueue
    }
  }
}
