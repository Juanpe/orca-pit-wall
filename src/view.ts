// What the visual panel draws, worked out from a snapshot and the sessions already seen.
// Pure, so src/view.test.ts can check it without a browser.
import type { AgentRow, RowState, Snapshot, WorktreeRow } from './protocol'

export type Seen = Record<string, true>

/** Changes when the agent changes state, so a seen session that moves again is new again. */
export const seenKey = (a: AgentRow): string => `${a.terminalId}|${a.state}|${a.since}`

/** Only finished or idle sessions can be put aside; a question or a permission still waits. */
export const canBeSeen = (a: AgentRow): boolean => a.state === 'done' || a.state === 'idle'

/** Most urgent first within a project: permission, question, idle, done, working. */
const URGENCY: Record<RowState, number> = { blocked: 0, waiting: 1, idle: 2, done: 3, working: 4 }

export type Office = {
  project: string
  sessions: AgentRow[]
  fresh: number
  working: number
  seen: number
}

export type View = {
  fresh: AgentRow[]
  looked: AgentRow[]
  working: AgentRow[]
  offices: Office[]
  prs: PrSections
  kpis: { fresh: number; working: number; idle: number; sessions: number; projects: number; worktrees: number }
}

export function buildView(snap: Snapshot, seen: Seen): View {
  const isSeen = (a: AgentRow) => canBeSeen(a) && seen[seenKey(a)] === true
  const fresh = snap.waiting.filter((a) => !isSeen(a))
  const looked = snap.waiting.filter(isSeen)

  const byProject = new Map<string, Office>()
  for (const a of [...snap.waiting, ...snap.working]) {
    let office = byProject.get(a.project)
    if (!office) {
      office = { project: a.project, sessions: [], fresh: 0, working: 0, seen: 0 }
      byProject.set(a.project, office)
    }
    office.sessions.push(a)
    if (a.state === 'working') office.working++
    else if (isSeen(a)) office.seen++
    else office.fresh++
  }
  const offices = [...byProject.values()]
  for (const o of offices) {
    o.sessions.sort((a, b) => {
      const seenA = isSeen(a) ? 1 : 0
      const seenB = isSeen(b) ? 1 : 0
      return seenA - seenB || URGENCY[a.state] - URGENCY[b.state] || a.since - b.since
    })
  }
  // Projects that need you first, then busy ones, then the rest; ties by name.
  offices.sort(
    (a, b) =>
      Number(b.fresh > 0) - Number(a.fresh > 0) ||
      Number(b.working > 0) - Number(a.working > 0) ||
      b.sessions.length - a.sessions.length ||
      a.project.localeCompare(b.project)
  )

  return {
    fresh,
    looked,
    working: snap.working,
    offices,
    prs: groupPrs(snap.worktrees),
    kpis: {
      fresh: fresh.length,
      working: snap.working.length,
      idle: snap.waiting.filter((a) => a.state === 'idle').length,
      sessions: snap.waiting.length + snap.working.length,
      projects: offices.length,
      worktrees: snap.worktrees.length
    }
  }
}

/** Drops keys of sessions that moved or closed, so the record does not grow forever. */
export function pruneSeen(snap: Snapshot, seen: Seen): Seen | null {
  const live = new Set(snap.waiting.map(seenKey))
  const keys = Object.keys(seen)
  const kept = keys.filter((k) => live.has(k))
  if (kept.length === keys.length) return null
  const next: Seen = {}
  for (const k of kept) next[k] = true
  return next
}

export type ProjectWorktrees = {
  project: string
  worktrees: WorktreeRow[]
  waiting: number
  working: number
}

/** Worktrees grouped by project: the most recently active project first, keeping the snapshot's order inside each. */
export function groupWorktrees(worktrees: WorktreeRow[]): ProjectWorktrees[] {
  const groups = new Map<string, ProjectWorktrees & { last: number }>()
  for (const w of worktrees) {
    let g = groups.get(w.project)
    if (!g) {
      g = { project: w.project, worktrees: [], waiting: 0, working: 0, last: 0 }
      groups.set(w.project, g)
    }
    g.worktrees.push(w)
    g.waiting += w.agentsWaiting
    g.working += w.agentsWorking
    g.last = Math.max(g.last, w.lastActivityAt ?? 0)
  }
  return [...groups.values()]
    .sort((a, b) => b.last - a.last || a.project.localeCompare(b.project))
    .map(({ last: _last, ...g }) => g)
}

export type PrRow = WorktreeRow & { pr: NonNullable<WorktreeRow['pr']> }

export type PrSections = {
  /** Checks failed: someone has to look. */
  failing: PrRow[]
  /** Checks still running. */
  pending: PrRow[]
  /** Open with checks green (or none): waiting for review or merge. */
  ready: PrRow[]
  drafts: PrRow[]
  /** Merged or closed: kept out of the count, collapsed in the panel. */
  finished: PrRow[]
  /** PRs still alive: every section but `finished`. */
  active: number
}

/**
 * The worktrees that have a PR, sorted by what they need from you. A PR linked from several
 * worktrees of one project shows once, on the most recently active (the snapshot's order).
 */
export function groupPrs(worktrees: WorktreeRow[]): PrSections {
  const out: PrSections = { failing: [], pending: [], ready: [], drafts: [], finished: [], active: 0 }
  const shown = new Set<string>()
  for (const w of worktrees) {
    if (!w.pr) continue
    const id = `${w.project}#${w.pr.number}`
    if (shown.has(id)) continue
    shown.add(id)
    const row = w as PrRow
    const state = w.pr.state.toLowerCase()
    if (state === 'merged' || state === 'closed') out.finished.push(row)
    else if (w.pr.checks === 'failure') out.failing.push(row)
    else if (w.pr.checks === 'pending') out.pending.push(row)
    else if (state === 'draft') out.drafts.push(row)
    else out.ready.push(row)
  }
  out.active = out.failing.length + out.pending.length + out.ready.length + out.drafts.length
  return out
}
