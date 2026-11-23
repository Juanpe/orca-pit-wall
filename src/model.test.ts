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

test('cleanTitle drops Claude markup from session titles', async () => {
  const { cleanTitle } = await import('./model')
  assert.equal(cleanTitle('<local-command-caveat>Caveat: x</local-command-caveat> Revisar PR'), 'Revisar PR')
  assert.equal(cleanTitle('<command-name>/clear</command-name>'), null)
  assert.equal(cleanTitle('Categoría TOP'), 'Categoría TOP')
})
