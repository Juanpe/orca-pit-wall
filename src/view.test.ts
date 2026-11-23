import { assert, test } from 'orca/testing'
import { sampleSnapshot } from './fixtures'
import { buildView, pruneSeen, seenKey } from './view'

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
