// Unit tests for the merge algorithm (lib/index.js `mergeEvents`).
// Run: node test/merge.test.mjs
//
// mergeEvents is a pure function: it takes source event groups and returns one
// continuous stream. The host persistence service is not involved here, so the
// test runs offline.

import assert from 'node:assert/strict'
import { mergeEvents } from '../lib/index.js'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok   ' + name)
  } catch (err) {
    console.error('FAIL ' + name)
    console.error('     ' + String((err && err.message) || err))
    process.exitCode = 1
  }
}

const header = (id) => ({ type: 'session', version: 4, id, createdAt: 1, cwd: 'C:\\x' })
const ev = (type, seq, extra = {}) => ({ type, seq, time: 1000 + seq, data: {}, ...extra })

test('header events are dropped, other events preserved', () => {
  const A = [header('A'), ev('user/message', 0), ev('assistant/message', 1)]
  const { events } = mergeEvents([{ id: 'A', events: A }])
  assert.equal(events.length, 2)
  assert.equal(events.some((e) => e.type === 'session'), false)
})

test('single session keeps its seq values', () => {
  const A = [header('A'), ev('user/message', 0), ev('assistant/message', 1)]
  const { events } = mergeEvents([{ id: 'A', events: A }])
  assert.deepEqual(events.map((e) => e.seq), [0, 1])
})

test('two sessions: second is shifted past the first', () => {
  const A = [header('A'), ev('user/message', 0), ev('assistant/message', 1)]
  const B = [header('B'), ev('user/message', 0), ev('assistant/message', 1)]
  const { events, offsetOf } = mergeEvents([
    { id: 'A', events: A },
    { id: 'B', events: B },
  ])
  assert.deepEqual(events.map((e) => e.seq), [0, 1, 2, 3])
  assert.equal(offsetOf.get('A'), 0)
  assert.equal(offsetOf.get('B'), 2)
})

test('tool/result sourceEventSeqs are shifted with their session', () => {
  const A = [header('A'), ev('assistant/message', 0), { ...ev('tool/result', 1), sourceEventSeqs: [0] }]
  const B = [header('B'), ev('assistant/message', 0), { ...ev('tool/result', 1), sourceEventSeqs: [0] }]
  const { events } = mergeEvents([
    { id: 'A', events: A },
    { id: 'B', events: B },
  ])
  const results = events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 2)
  // A's reference stays (offset 0), B's points into its own shifted range.
  assert.deepEqual(results[0].sourceEventSeqs, [0])
  assert.deepEqual(results[1].sourceEventSeqs, [2])
})

test('surfaceOp V4 spelling (startSeq/endSeq) is shifted', () => {
  const A = [header('A'), ev('user/message', 0), ev('assistant/message', 1)]
  const B = [
    header('B'),
    ev('user/message', 0),
    { ...ev('user/message', 1), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } },
  ]
  const { events } = mergeEvents([
    { id: 'A', events: A },
    { id: 'B', events: B },
  ])
  const op = events.find((e) => e.surfaceOp)
  assert.deepEqual(op.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 3 })
})

test('surfaceOp legacy spelling (start/end) is shifted', () => {
  const A = [header('A'), ev('user/message', 0), ev('assistant/message', 1)]
  const B = [header('B'), ev('user/message', 0), { ...ev('user/message', 1), surfaceOp: { op: 'replace', start: 0, end: 1 } }]
  const { events } = mergeEvents([
    { id: 'A', events: A },
    { id: 'B', events: B },
  ])
  const op = events.find((e) => e.surfaceOp)
  assert.deepEqual(op.surfaceOp, { op: 'replace', start: 2, end: 3 })
})

test('non-sequential source seq gaps are tolerated (offset = maxSeq + 1)', () => {
  const A = [header('A'), ev('user/message', 0), ev('assistant/message', 4)]
  const B = [header('B'), ev('user/message', 0)]
  const { events, offsetOf } = mergeEvents([
    { id: 'A', events: A },
    { id: 'B', events: B },
  ])
  assert.equal(offsetOf.get('B'), 5)
  assert.deepEqual(events.map((e) => e.seq), [0, 4, 5])
})

test('empty session contributes nothing', () => {
  const A = [header('A')]
  const B = [header('B'), ev('user/message', 0)]
  const { events } = mergeEvents([
    { id: 'A', events: A },
    { id: 'B', events: B },
  ])
  assert.deepEqual(events.map((e) => e.seq), [0])
})

test('event payloads are deep-copied (source arrays not mutated)', () => {
  const A = [header('A'), ev('user/message', 0, { data: { text: 'a' } })]
  const { events } = mergeEvents([{ id: 'A', events: A }])
  events[0].data.text = 'changed'
  assert.equal(A[1].data.text, 'a')
})

test('time/turn/step display fields are preserved', () => {
  const A = [header('A'), { ...ev('assistant/message', 0), time: 999, data: { turn: 7, step: 3 } }]
  const { events } = mergeEvents([{ id: 'A', events: A }])
  assert.equal(events[0].time, 999)
  assert.equal(events[0].data.turn, 7)
  assert.equal(events[0].data.step, 3)
})

console.log('\n' + passed + ' test(s) passed' + (process.exitCode ? ' (with failures)' : ''))
