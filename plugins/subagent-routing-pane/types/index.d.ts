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
}

export type Hub = {
  model?: string
  /** idle, thinking, or the tool the main loop is using. */
  activity: string
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-routing-pane': {
      routed: Shaped<Routed[]>
      hub: Shaped<Hub>
    }
  }
}
