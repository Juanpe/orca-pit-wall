import { assert, test } from 'orca/testing'
import { buildSnapshot, flatten, type ApiWorkspace, type CliWorktree } from './model'

const NOW = 1_000_000_000

const api: ApiWorkspace[] = [
  {
    id: 'identity:wt2:local:aaa',
    kind: 'worktree',
    name: 'menu-top',
    project: 'storefront',
    branch: 'feature/menu-top',
    status: { state: 'active', lastActivityAt: NOW - 60_000 },
    agents: [
      { terminalId: 'term_1', title: 'Claude Code', agent: 'claude', state: 'waiting', stateStartedAt: NOW - 5_000 },
      { terminalId: 'term_2', title: 'Refactor', agent: 'claude', state: 'working', stateStartedAt: NOW - 1_000 }
    ]
  },
  {
    id: 'proj::/path/web',
    kind: 'folder',
    name: 'drafts',
    project: 'web',
    branch: null,
    status: { state: 'inactive', lastActivityAt: NOW - 3_600_000 },
    agents: [
      // The API lost this pane's terminal; the CLI still has it, stamped 1 ms apart.
      { terminalId: null, title: null, agent: 'claude', state: 'done', stateStartedAt: NOW - 90_000 },
      // Closed session: no terminal anywhere.
      { terminalId: null, title: null, agent: 'claude', state: 'done', stateStartedAt: NOW - 999_999 }
    ]
  },
  {
    id: 'proj::/path/web',
    kind: 'folder',
    name: 'Blog',
    project: 'web',
    branch: null,
    status: null,
    agents: []
  }
]

const cli: CliWorktree[] = [
  {
    worktreeId: 'x::/whatever',
    displayName: 'menu-top',
    identity: { key: 'wt2:local:aaa' },
    linkedPR: {
      number: 143,
      state: 'draft',
      title: 'feat: top',
      url: 'https://github.com/acme/menu/pull/143',
      checksStatus: 'success',
      checksSummary: { passed: 6, total: 6 }
    },
    agents: [
      { address: 'term_1', state: 'waiting', conversationName: 'Categoría TOP', lastAssistantMessage: '**¿Sigo** con `iOS`?\n\n| a | b |\n|---|---|' },
      { address: 'term_2', state: 'working', conversationName: 'Refactor', toolName: 'Bash', toolInput: 'npm test' }
    ]
  },
  { worktreeId: 'proj::/path/web', displayName: 'Blog', agents: [] },
  {
    worktreeId: 'proj::/path/web',
    displayName: 'drafts',
    agents: [{ address: 'term_9', state: 'done', stateStartedAt: NOW - 90_001, conversationName: 'Update drafts', lastAssistantMessage: 'Hecho.' }]
  }
]

test('sorts agents into waiting and working, enriched from the CLI', () => {
  const snap = buildSnapshot(api, cli, NOW)
  assert.deepEqual(
    snap.waiting.map((a) => [a.title, a.state, a.terminalId, a.lastMessage]),
    [
      ['Update drafts', 'done', 'term_9', 'Hecho.'], // waited longest: first
      ['Categoría TOP', 'waiting', 'term_1', '¿Sigo con iOS?']
    ]
  )
  assert.deepEqual(
    snap.working.map((a) => [a.title, a.activity]),
    [['Refactor', 'Bash · npm test']]
  )
  assert.equal(snap.enrichmentError, null)
})

test('lists every worktree with branch, PR and counts, latest activity first', () => {
  const snap = buildSnapshot(api, cli, NOW)
  assert.deepEqual(
    snap.worktrees.map((w) => [w.name, w.branch, w.pr?.number ?? null, w.pr?.checks ?? null, w.agentsWaiting, w.agentsWorking]),
    [
      ['menu-top', 'feature/menu-top', 143, 'success', 1, 1],
      ['drafts', null, null, null, 1, 0],
      ['Blog', null, null, null, 0, 0]
    ]
  )
  assert.equal(snap.worktrees[0].pr?.url, 'https://github.com/acme/menu/pull/143')
})

test('keeps only http(s) PR links', () => {
  const odd = [{ ...cli[0], linkedPR: { ...cli[0].linkedPR!, url: 'javascript:alert(1)' } }]
  assert.equal(buildSnapshot(api, odd, NOW).worktrees.find((w) => w.pr)?.pr?.url, null)
})

test('works without the CLI: API data only', () => {
  const snap = buildSnapshot(api, null, NOW, 'spawn orca ENOENT')
  assert.equal(snap.enrichmentError, 'spawn orca ENOENT')
  // The folder agent had no terminal in the API and none to borrow: it is left out.
  assert.deepEqual(
    snap.waiting.map((a) => [a.title, a.lastMessage]),
    [['Claude Code', null]]
  )
  assert.equal(snap.worktrees[0].pr, null)
})

test('flatten keeps one readable line and cuts it', () => {
  assert.equal(flatten('# Hecho\n\n- uno\n- [dos](http://x)'), 'Hecho uno dos')
  assert.equal(flatten(''), null)
  const long = flatten('a'.repeat(500))
  assert.equal(long?.length, 140)
  assert.ok(long?.endsWith('…'))
})

test('an agent the API still calls working, but the CLI does not, is idle and waits on you', () => {
  const stuck: ApiWorkspace[] = [
    {
      id: 'identity:wt2:local:bbb',
      kind: 'worktree',
      name: 'voice-to-order',
      project: 'storefront',
      branch: 'feature/voice-to-order',
      status: null,
      agents: [{ terminalId: 'term_5', title: 'Voz', agent: 'claude', state: 'working', stateStartedAt: NOW - 86_400_000 }]
    }
  ]
  const seen: CliWorktree[] = [{ worktreeId: 'x', identity: { key: 'wt2:local:bbb' }, agents: [] }]
  const snap = buildSnapshot(stuck, seen, NOW)
  assert.deepEqual(snap.working, [])
  assert.deepEqual(snap.waiting.map((a) => [a.title, a.state]), [['Voz', 'idle']])
  // Without the CLI there is nothing to contradict the API: it stays working.
  assert.equal(buildSnapshot(stuck, null, NOW).working.length, 1)
})

test('an agent whose own turn is over shows that turn, though Orca still watches a background task', () => {
  const watched: ApiWorkspace[] = [
    {
      id: 'identity:wt2:local:ccc',
      kind: 'worktree',
      name: 'menu-subcategories',
      project: 'storefront',
      branch: 'feature/menu-subcategories',
      status: null,
      agents: [{ terminalId: 'term_7', title: 'Subcategorías', agent: 'claude', state: 'working', stateStartedAt: NOW - 1_700_000 }]
    }
  ]
  const cliFor = (main: string): CliWorktree[] => [
    {
      worktreeId: 'x',
      identity: { key: 'wt2:local:ccc' },
      agents: [{ address: 'term_7', state: 'working', toolName: 'Bash', mainAgent: { state: main, stateStartedAt: NOW - 30_000 } }]
    }
  ]
  const done = buildSnapshot(watched, cliFor('done'), NOW)
  assert.deepEqual(done.working, [])
  // It answered 30 s ago: done since then, not idle since the watch began.
  assert.deepEqual(done.waiting.map((a) => [a.title, a.state, a.since]), [['Subcategorías', 'done', NOW - 30_000]])
  assert.equal(buildSnapshot(watched, cliFor('waiting'), NOW).waiting[0].state, 'waiting')
  // While the agent itself works, it stays working.
  assert.equal(buildSnapshot(watched, cliFor('working'), NOW).working.length, 1)
})

test('an agent waiting on a working subagent stays working, though its own turn is over', () => {
  const api: ApiWorkspace[] = [
    {
      id: 'identity:wt2:local:ddd',
      kind: 'worktree',
      name: 'floorplan',
      project: 'waiter',
      branch: 'feature/floorplan',
      status: null,
      agents: [{ terminalId: 'term_8', title: 'Floorplan', agent: 'claude', state: 'working', stateStartedAt: NOW - 60_000 }]
    }
  ]
  const cliWith = (sub: string): CliWorktree[] => [
    {
      worktreeId: 'x',
      identity: { key: 'wt2:local:ddd' },
      agents: [
        {
          address: 'term_8',
          state: 'working',
          mainAgent: { state: 'done', stateStartedAt: NOW - 20_000 },
          subagents: [{ state: sub, agentType: 'general-purpose', description: 'Review the plan' }]
        }
      ]
    }
  ]
  const busy = buildSnapshot(api, cliWith('working'), NOW)
  assert.deepEqual(busy.waiting, [])
  assert.deepEqual(busy.working.map((a) => [a.state, a.activity]), [['working', 'Subagent · Review the plan']])
  // Once the subagent ends, the session's own turn shows again.
  assert.equal(buildSnapshot(api, cliWith('done'), NOW).waiting[0].state, 'done')
})

test('cleanTitle drops Claude markup from session titles', async () => {
  const { cleanTitle } = await import('./model')
  assert.equal(cleanTitle('<local-command-caveat>Caveat: x</local-command-caveat> Revisar PR'), 'Revisar PR')
  assert.equal(cleanTitle('<command-name>/clear</command-name>'), null)
  assert.equal(cleanTitle('Categoría TOP'), 'Categoría TOP')
})
