// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'
/**
 * What the panel shows. `idle`: Orca's API still says "working" but `orca worktree ps` sees no
 * working agent there (the session was cut off without telling Orca): it is waiting on you.
 */
export type RowState = AgentState | 'idle'

/** One agent session, ready to draw. */
export type AgentRow = {
  key: string
  state: RowState
  /** Since when it has been in `state` (ms epoch). */
  since: number
  project: string
  workspace: string
  workspaceId: string
  title: string
  /** Last thing the agent said, flattened to one line and cut. */
  lastMessage: string | null
  /** For working agents: the tool it is running now, e.g. "Bash · npm test". */
  activity: string | null
  /** Terminal to focus on click; null when Orca no longer has one. */
  terminalId: string | null
}

export type PrInfo = {
  number: number
  state: string
  title: string
  checks: 'success' | 'failure' | 'pending' | 'neutral' | null
  passed: number
  total: number
}

export type WorktreeRow = {
  key: string
  workspaceId: string
  project: string
  name: string
  branch: string | null
  kind: 'worktree' | 'folder'
  pr: PrInfo | null
  lastActivityAt: number | null
  agentsWaiting: number
  agentsWorking: number
}

export type Snapshot = {
  generatedAt: number
  waiting: AgentRow[]
  working: AgentRow[]
  worktrees: WorktreeRow[]
  /** Set when `orca worktree ps` could not run: PRs and last messages are missing. */
  enrichmentError: string | null
}

declare module 'orca' {
  interface PluginRequests {
    /** Everything the panel draws, read fresh from Orca. */
    snapshot: { output: Snapshot }
    /** Shows a terminal (when given and still open) or else the workspace. */
    open: {
      input: { workspaceId: string; terminalId?: string | null }
      output: { ok: boolean }
    }
  }
}
