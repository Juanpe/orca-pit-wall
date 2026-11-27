// Pure logic: joins what the plugin API reports with what `orca worktree ps --json` adds
// (PRs, session titles, last messages), and sorts it into the panel's sections.
// No Orca calls here, so src/model.test.ts can feed it fixtures.
import type { AgentRow, AgentState, PrInfo, Snapshot, WorktreeRow } from './protocol'

/** A `workspace.list` row with its `agents.list` answer. */
export type ApiWorkspace = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  project?: string | null
  branch: string | null
  status?: { state: string; lastActivityAt: number | null } | null
  agents: ApiAgent[]
}

export type ApiAgent = {
  terminalId: string | null
  title: string | null
  agent: string | null
  state: AgentState
  stateStartedAt: number
  sessionId?: string | null
  task?: { title: string } | null
}

/** The subset of one `orca worktree ps --json` worktree this panel reads. */
export type CliWorktree = {
  worktreeId: string
  displayName?: string
  identity?: { key?: string } | null
  linkedPR?: {
    number: number
    state: string
    title?: string | null
    url?: string | null
    checksStatus?: string | null
    checksSummary?: { passed?: number; total?: number } | null
  } | null
  lastActivityAt?: number | null
  agents?: CliAgent[]
}

export type CliAgent = {
  address?: string
  state?: string
  stateStartedAt?: number
  conversationName?: string | null
  taskTitle?: string | null
  lastAssistantMessage?: string | null
  toolName?: string | null
  toolInput?: string | null
  /** The agent's own turn. Orca keeps `state` at "working" while it watches a background task, even one that has ended. */
  mainAgent?: { state?: string; stateStartedAt?: number } | null
  /** Subagents the session launched. While one works, the session is still working, whatever its own turn says. */
  subagents?: { state?: string; description?: string | null; agentType?: string | null }[] | null
}

const MESSAGE_MAX = 140
const ACTIVITY_MAX = 60
/** API and CLI stamps of the same state can differ by a few ms. */
const SAME_STATE_MS = 2000

/** One readable line from an agent's markdown answer. */
export function flatten(text: string | null | undefined, max = MESSAGE_MAX): string | null {
  if (!text) return null
  const line = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ') // table rows
    .replace(/^\s*#+\s*/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return null
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

function cliWorktreeFor(ws: ApiWorkspace, cli: CliWorktree[]): CliWorktree | undefined {
  // Git worktrees: the API id is `identity:<identity.key>`.
  const byKey = cli.find((c) => c.identity?.key && `identity:${c.identity.key}` === ws.id)
  if (byKey) return byKey
  // Folders share `<projectId>::<path>` when several point at one path; the name tells them apart.
  const sameId = cli.filter((c) => c.worktreeId === ws.id)
  return sameId.find((c) => c.displayName === ws.name) ?? (sameId.length === 1 ? sameId[0] : undefined)
}

function matchAgent(agent: ApiAgent, pool: CliAgent[]): CliAgent | undefined {
  if (agent.terminalId) {
    const exact = pool.find((c) => c.address === agent.terminalId)
    if (exact) return exact
  }
  let best: CliAgent | undefined
  let bestDelta = SAME_STATE_MS
  for (const c of pool) {
    if (c.state !== agent.state || typeof c.stateStartedAt !== 'number') continue
    const delta = Math.abs(c.stateStartedAt - agent.stateStartedAt)
    if (delta <= bestDelta) {
      best = c
      bestDelta = delta
    }
  }
  return best
}

/** A main-agent state that means its turn is over: it finished, asks, or waits for a permission. */
function isSettled(state: string | undefined): state is 'done' | 'waiting' | 'blocked' {
  return state === 'done' || state === 'waiting' || state === 'blocked'
}

/** The first subagent still working, if any. */
function workingSubagent(cli: CliAgent | undefined) {
  return cli?.subagents?.find((s) => s.state === 'working')
}

function prInfo(pr: CliWorktree['linkedPR']): PrInfo | null {
  if (!pr) return null
  const checks = pr.checksStatus
  return {
    number: pr.number,
    state: pr.state,
    // Orca can retain just { number, state } while PR details are unavailable.
    // Undefined is not a valid panel response, and the UI needs a string title.
    title: pr.title ?? `PR #${pr.number}`,
    url: pr.url && /^https?:\/\//.test(pr.url) ? pr.url : null,
    checks:
      checks === 'success' || checks === 'failure' || checks === 'pending' || checks === 'neutral'
        ? checks
        : null,
    passed: pr.checksSummary?.passed ?? 0,
    total: pr.checksSummary?.total ?? 0
  }
}

function activityOf(cli: CliAgent | undefined): string | null {
  const sub = workingSubagent(cli)
  if (sub) {
    const what = flatten(sub.description ?? sub.agentType, ACTIVITY_MAX)
    return what ? `Subagent · ${what}` : 'Subagent'
  }
  if (!cli?.toolName) return null
  const input = flatten(cli.toolInput, ACTIVITY_MAX)
  return input ? `${cli.toolName} · ${input}` : cli.toolName
}

/** Session titles can carry Claude's internal markup (`<local-command-caveat>…`): drop it. */
export function cleanTitle(title: string | null | undefined): string | null {
  if (!title) return null
  const text = title
    .replace(/<([a-z-]+)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?[a-z-]+>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

const isTerminal = (id: string | null | undefined): id is string => !!id && id.startsWith('term_')

export function buildSnapshot(
  workspaces: ApiWorkspace[],
  cli: CliWorktree[] | null,
  now: number,
  enrichmentError: string | null = null
): Snapshot {
  const waiting: AgentRow[] = []
  const working: AgentRow[] = []
  const worktrees: WorktreeRow[] = []

  for (const ws of workspaces) {
    const cw = cli ? cliWorktreeFor(ws, cli) : undefined
    const pool = [...(cw?.agents ?? [])]
    const project = ws.project ?? cw?.displayName ?? ws.name
    let agentsWaiting = 0
    let agentsWorking = 0

    ws.agents.forEach((agent, index) => {
      const match = matchAgent(agent, pool)
      if (match) pool.splice(pool.indexOf(match), 1)
      // The API sometimes loses the terminal of a pane that is still open; the CLI keeps it.
      const terminalId = isTerminal(agent.terminalId)
        ? agent.terminalId
        : isTerminal(match?.address)
          ? match.address
          : null
      // An agent with no open terminal is a closed session: nobody is waiting there.
      if (!terminalId) return
      const genericTitle = !agent.title || agent.title === 'Claude Code' || agent.title === agent.agent
      const title =
        agent.task?.title ??
        cleanTitle(match?.taskTitle) ??
        cleanTitle(match?.conversationName) ??
        (genericTitle ? null : agent.title) ??
        agent.title ??
        agent.agent ??
        'Agente'
      // Orca keeps "working" while it watches a background task (`workingMode: "monitoring"`), even
      // one that never ends, such as an artifact watch. The agent's own turn says what it is doing:
      // done, asking, or waiting for a permission. A subagent still working keeps it working.
      const main = match?.mainAgent
      const settled =
        agent.state === 'working' &&
        !!cw &&
        match?.state === 'working' &&
        isSettled(main?.state) &&
        !workingSubagent(match)
          ? { state: main.state, since: main.stateStartedAt }
          : null
      // The API can also keep "working" after a session is cut off (Esc, Ctrl-C, a crash). When the
      // CLI answered for this workspace and does not see it working, it is idle at its prompt.
      const stale = agent.state === 'working' && !!cw && match?.state !== 'working'
      const row: AgentRow = {
        key: `${ws.id}|${ws.name}|${terminalId}|${index}`,
        state: settled ? settled.state : stale ? 'idle' : agent.state,
        since: settled?.since ?? agent.stateStartedAt,
        project,
        workspace: ws.name,
        workspaceId: ws.id,
        title,
        lastMessage: flatten(match?.lastAssistantMessage),
        activity: agent.state === 'working' && !stale && !settled ? activityOf(match) : null,
        terminalId
      }
      if (row.state === 'working') {
        agentsWorking++
        working.push(row)
      } else {
        agentsWaiting++
        waiting.push(row)
      }
    })

    worktrees.push({
      key: `${ws.id}|${ws.name}`,
      workspaceId: ws.id,
      project,
      name: ws.name,
      branch: ws.branch ? ws.branch.replace(/^refs\/heads\//, '') : null,
      kind: ws.kind,
      pr: prInfo(cw?.linkedPR),
      lastActivityAt: ws.status?.lastActivityAt ?? cw?.lastActivityAt ?? null,
      agentsWaiting,
      agentsWorking
    })
  }

  // Longest wait first.
  waiting.sort((a, b) => a.since - b.since)
  // Most recently started first.
  working.sort((a, b) => b.since - a.since)
  worktrees.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))

  return { generatedAt: now, waiting, working, worktrees, enrichmentError }
}
