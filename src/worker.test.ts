import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

// Keep the test away from the real `orca` CLI: enrichment fails and the API data still shows.
;(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.PIT_WALL_ORCA_BIN =
  '/nonexistent/orca'

const workspaces = {
  workspaces: [
    {
      id: 'identity:wt2:local:aaa',
      kind: 'worktree',
      name: 'menu-top',
      project: 'storefront',
      projectId: 'p1',
      path: '/w/menu-top',
      branch: 'feature/menu-top',
      hostId: 'local',
      status: { state: 'active', unread: false, terminalCount: 1, lastActivityAt: 5 }
    }
  ],
  truncated: false
}

const agents = {
  agents: [
    { terminalId: 'term_1', title: 'Tarea', agent: 'claude', state: 'blocked', stateStartedAt: 1 }
  ]
}

test('snapshot reads workspaces and their agents through the API', async () => {
  const host = mockHost({ results: { 'workspace.list': workspaces, 'agents.list': agents } })
  const worker = await mountWorker(main, { host })
  const snap = await worker.request('snapshot')
  assert.deepEqual(
    snap.waiting.map((a) => [a.project, a.workspace, a.title, a.state, a.terminalId]),
    [['storefront', 'menu-top', 'Tarea', 'blocked', 'term_1']]
  )
  assert.equal(snap.worktrees.length, 1)
  assert.ok(snap.enrichmentError)
  assert.deepEqual(host.callsOf('workspace.list')[0], { includeStatus: true })
  assert.deepEqual(host.callsOf('agents.list')[0], { workspaceId: 'identity:wt2:local:aaa' })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('open focuses the terminal when there is one', async () => {
  const host = mockHost({ results: { 'terminal.focus': { focused: true } } })
  const worker = await mountWorker(main, { host })
  await worker.request('open', { workspaceId: 'w1', terminalId: 'term_1' })
  assert.equal(host.callsOf('terminal.focus').length, 1)
  assert.equal(host.callsOf('workspace.open').length, 0)
  await worker.deactivate()
})

test('open falls back to the workspace when the terminal is gone', async () => {
  const host = mockHost({
    results: { 'terminal.focus': hostError('action_failed'), 'workspace.open': { opened: true } }
  })
  const worker = await mountWorker(main, { host })
  await worker.request('open', { workspaceId: 'w1', terminalId: 'term_x' })
  assert.deepEqual(host.callsOf('workspace.open')[0], { workspaceId: 'w1' })
  await worker.deactivate()
})
