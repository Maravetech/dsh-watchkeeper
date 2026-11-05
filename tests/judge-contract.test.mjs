// The judge contract: a plain JSON request in, a plain JSON decision out.
// These tests pin the mapping from the judge reply to the internal answer shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeAnswers } from '../lib/watch/host.js'

const tiered = { options: ['forward', 'fallback'], forward_option: 'forward' }

test('answer on the forward option maps to the forward probability', () => {
  const out = judgeAnswers({ decision: 'answer', selected: 'forward', confidence: 0.9 }, tiered)
  assert.equal(out.answers.pick.choice, 'forward')
  assert.equal(out.answers.pick.probabilities.forward, 0.9)
  assert.equal(out.answers.forward.noul, 0.9)
  assert.ok(out.answers.unsure.noul < 0.7)
})

test('answer on the fallback option inverts the forward probability', () => {
  const out = judgeAnswers({ decision: 'answer', selected: 'fallback', confidence: 0.9 }, tiered)
  assert.ok(Math.abs(out.answers.forward.noul - 0.1) < 1e-9)
})

test('human, unknown option, bad confidence and missing fields all become null', () => {
  assert.equal(judgeAnswers({ decision: 'human', reason: 'unsure' }, tiered), null)
  assert.equal(judgeAnswers({ decision: 'answer', selected: 'nope', confidence: 0.9 }, tiered), null)
  assert.equal(judgeAnswers({ decision: 'answer', selected: 'forward', confidence: 'high' }, tiered), null)
  assert.equal(judgeAnswers({}, tiered), null)
  assert.equal(judgeAnswers(null, tiered), null)
})

test('non-tier questions carry no forward probability', () => {
  const out = judgeAnswers({ decision: 'answer', selected: 'a', confidence: 0.7 }, { options: ['a', 'b'] })
  assert.equal(out.answers.forward, undefined)
  assert.equal(out.answers.pick.choice, 'a')
})

test('confidence is clamped into 0..1', () => {
  const out = judgeAnswers({ decision: 'answer', selected: 'a', confidence: 3 }, { options: ['a', 'b'] })
  assert.equal(out.answers.pick.probabilities.a, 1)
  const low = judgeAnswers({ decision: 'answer', selected: 'a', confidence: -1 }, { options: ['a', 'b'] })
  assert.equal(low.answers.pick.probabilities.a, 0)
})
