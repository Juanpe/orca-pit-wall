import { assert, test } from 'orca/testing'
import { sampleSnapshot } from './fixtures'
import { buildView, groupPrs, groupWorktrees, pruneSeen, seenKey } from './view'

const NOW = 2_000_000_000_000

test('groups open sessions by project, the ones that need you first', () => {
  const view = buildView(sampleSnapshot(NOW), {})
  assert.deepEqual(
    view.offices.map((o) => [o.project, o.fresh, o.working]),
    [
      ['api', 1, 0],
      ['storefront', 1, 0],
      ['web', 0, 1]
    ]
  )
  assert.deepEqual(view.kpis, { fresh: 2, working: 1, idle: 0, sessions: 3, projects: 3, worktrees: 3 })
})

test('a seen finished session leaves "waiting on you"; a permission prompt never does', () => {
  const snap = sampleSnapshot(NOW)
  const [permission, done] = snap.waiting
  const view = buildView(snap, { [seenKey(permission)]: true, [seenKey(done)]: true })
  assert.deepEqual(view.fresh.map((a) => a.key), [permission.key])
  assert.deepEqual(view.looked.map((a) => a.key), [done.key])
  assert.equal(view.kpis.fresh, 1)
  const office = view.offices.find((o) => o.project === 'storefront')!
  assert.deepEqual([office.fresh, office.seen], [0, 1])
})

test('a seen session that changes state is new again', () => {
  const snap = sampleSnapshot(NOW)
  const done = snap.waiting[1]
  const view = buildView(snap, { [`${done.terminalId}|done|${done.since - 1}`]: true })
  assert.equal(view.fresh.length, 2)
})

test('pruneSeen forgets sessions that moved or closed', () => {
  const snap = sampleSnapshot(NOW)
  const live = seenKey(snap.waiting[1])
  assert.deepEqual(pruneSeen(snap, { [live]: true, 'term_gone|done|1': true }), { [live]: true })
  assert.equal(pruneSeen(snap, { [live]: true }), null)
})

test('groups worktrees by project, the most recently active project first', () => {
  const snap = sampleSnapshot(NOW)
  const extra = { ...snap.worktrees[0], key: 'w9', name: 'old', lastActivityAt: NOW - 86_400_000 }
  const groups = groupWorktrees([...snap.worktrees, extra])
  assert.deepEqual(groups.map((g) => g.project), ['storefront', 'api', 'notes'])
  assert.deepEqual(groups[0].worktrees.map((w) => w.key), ['w1', 'w9'])
  assert.deepEqual([groups[0].waiting, groups[0].working], [2, 0])
})

test('sorts PRs by what they need: failing checks, running, ready, drafts; merged apart', () => {
  const [draft, failing, folder] = sampleSnapshot(NOW).worktrees
  const pr = (key: string, project: string, number: number, state: string, checks: 'success' | 'pending' | null) => ({
    ...folder,
    key,
    project,
    pr: { number, state, title: key, checks, passed: 0, total: 0 }
  })
  const sections = groupPrs([
    draft,
    failing,
    folder,
    pr('ready', 'api', 1, 'open', 'success'),
    pr('running', 'api', 2, 'open', 'pending'),
    pr('merged', 'api', 3, 'merged', 'success'),
    pr('same-pr', 'api', 1, 'open', 'success'),
    pr('other-repo', 'web', 1, 'open', null)
  ])
  const keys = (rows: { key: string }[]) => rows.map((r) => r.key)
  assert.deepEqual(keys(sections.failing), ['w2'])
  assert.deepEqual(keys(sections.pending), ['running'])
  assert.deepEqual(keys(sections.ready), ['ready', 'other-repo'])
  assert.deepEqual(keys(sections.drafts), ['w1'])
  assert.deepEqual(keys(sections.finished), ['merged'])
  assert.equal(sections.active, 5)
})
