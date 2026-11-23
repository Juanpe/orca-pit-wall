// Pit Wall's worker. Read-only: it reads workspaces and agents through the plugin API and,
// for what the API does not expose (PRs, checks, session titles, last messages), runs
// `orca worktree ps --json`. The only action it takes is showing a workspace or terminal
// when the person clicks a row.
import type { OrcaWorkerApi } from 'orca/worker'
import { execFile } from 'node:child_process'
import { buildSnapshot, type ApiWorkspace, type CliWorktree } from './model'
import type { Snapshot } from './protocol'

declare const process: { env: Record<string, string | undefined> }

/** `PIT_WALL_ORCA_BIN` overrides where `orca` is looked up (the tests point it nowhere). */
function cliCandidates(): string[] {
  const override = process.env.PIT_WALL_ORCA_BIN
  return override ? [override] : ['orca', '/Applications/Orca.app/Contents/Resources/bin/orca']
}
const CLI_TIMEOUT_MS = 8000
/** The panel refreshes every few seconds; the CLI answer is reused within this window. */
const CLI_CACHE_MS = 4000
const AGENT_CALLS_IN_PARALLEL = 6

type CliResult = { worktrees: CliWorktree[] | null; error: string | null }

function runCli(bin: string): Promise<CliWorktree[]> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['worktree', 'ps', '--json'],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error)
        try {
          const parsed = JSON.parse(stdout)
          if (!parsed?.ok) return reject(new Error(parsed?.error?.message ?? 'orca worktree ps failed'))
          resolve(parsed.result?.worktrees ?? [])
        } catch (e) {
          reject(e)
        }
      }
    )
  })
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(lanes)
  return out
}

export default function activate(orca: OrcaWorkerApi): void {
  let cliCache: { at: number; result: CliResult } | null = null
  let cliInFlight: Promise<CliResult> | null = null
  let workingBin: string | null = null

  async function readCli(): Promise<CliResult> {
    let lastError = 'orca not found'
    for (const bin of workingBin ? [workingBin] : cliCandidates()) {
      try {
        const worktrees = await runCli(bin)
        workingBin = bin
        return { worktrees, error: null }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
      }
    }
    workingBin = null
    orca.log(`orca worktree ps failed: ${lastError}`)
    return { worktrees: null, error: lastError }
  }

  async function cli(): Promise<CliResult> {
    if (cliCache && Date.now() - cliCache.at < CLI_CACHE_MS) return cliCache.result
    cliInFlight ??= readCli().finally(() => (cliInFlight = null))
    const result = await cliInFlight
    cliCache = { at: Date.now(), result }
    return result
  }

  async function workspaces(): Promise<ApiWorkspace[]> {
    const { workspaces } = await orca.host.call('workspace.list', { includeStatus: true })
    return mapLimit(workspaces, AGENT_CALLS_IN_PARALLEL, async (w) => {
      const answer = await orca.host
        .call('agents.list', { workspaceId: w.id })
        .catch(() => ({ agents: [] }))
      return {
        id: w.id,
        kind: w.kind,
        name: w.name,
        project: w.project,
        branch: w.branch,
        status: w.status ?? null,
        agents: answer.agents
      }
    })
  }

  orca.panels.handle('snapshot', async (): Promise<Snapshot> => {
    const [ws, enrichment] = await Promise.all([workspaces(), cli()])
    return buildSnapshot(ws, enrichment.worktrees, Date.now(), enrichment.error)
  })

  orca.panels.handle('open', async ({ workspaceId, terminalId }) => {
    if (terminalId) {
      try {
        const { focused } = await orca.host.call('terminal.focus', { terminalId })
        if (focused) return { ok: true }
      } catch (e) {
        orca.log(`terminal.focus failed, opening the workspace: ${String(e)}`)
      }
    }
    await orca.host.call('workspace.open', { workspaceId })
    return { ok: true }
  })
}
