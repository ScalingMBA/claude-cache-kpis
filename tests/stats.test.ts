// Spec (agreed with the user): a request is a miss when it fails to read the
// prefix the thread's previous request had cached (read + written), by at
// least 1024 tokens. The first request of a thread is a cold start, never a
// miss. Cause, first that applies: fewer messages than before → compaction,
// another model → model, a pause of 5 min or more → ttl, else prefix.
// Subagents are counted apart from the main thread. Hit rate is
// read / (uncached + read + written).
import { describe, expect, test } from 'claude-code/testing'

import type { CacheSample } from '../types'
import { EMPTY_STATS, classify, hitRate, record } from '../hooks/stats'

const MIN = 60_000

const sample = (over: Partial<CacheSample>): CacheSample => ({
  at: 0,
  model: 'claude-opus-5-5',
  input: 10,
  read: 0,
  write: 0,
  messageCount: 1,
  ...over,
})

// Previous request: 20,000 read + 3,000 written → 23,000 cached.
const PREV = sample({ at: 0, read: 20_000, write: 3_000, messageCount: 4 })

describe('classify', () => {
  test('the first request of a thread is a cold start, not a miss', async () => {
    expect(classify(null, sample({ write: 18_000 }))).toStrictEqual({ kind: 'cold' })
  })

  test('reading the whole previous prefix is a hit', async () => {
    const cur = sample({ at: MIN, read: 23_000, write: 500, messageCount: 6 })

    expect(classify(PREV, cur)).toStrictEqual({ kind: 'hit' })
  })

  test('losing 1023 tokens is still a hit, 1024 is a miss', async () => {
    // 23,000 − 21,977 = 1,023 ; 23,000 − 21,976 = 1,024
    const almost = sample({ at: MIN, read: 21_977, messageCount: 6 })
    const missed = sample({ at: MIN, read: 21_976, messageCount: 6 })

    expect(classify(PREV, almost)).toStrictEqual({ kind: 'hit' })
    expect(classify(PREV, missed)).toStrictEqual({
      kind: 'miss',
      cause: 'prefix',
      lost: 1_024,
      gapMs: MIN,
    })
  })

  test('a pause just under 5 min is a prefix miss, at 5 min a ttl miss', async () => {
    const under = sample({ at: 5 * MIN - 1, read: 0, messageCount: 6 })
    const at = sample({ at: 5 * MIN, read: 0, messageCount: 6 })

    expect(classify(PREV, under)).toMatchObject({ kind: 'miss', cause: 'prefix' })
    expect(classify(PREV, at)).toStrictEqual({
      kind: 'miss',
      cause: 'ttl',
      lost: 23_000,
      gapMs: 5 * MIN,
    })
  })

  test('another model is a model miss, even after a long pause', async () => {
    const cur = sample({ at: 30 * MIN, model: 'claude-sonnet-5-5', read: 0, messageCount: 6 })

    expect(classify(PREV, cur)).toMatchObject({ kind: 'miss', cause: 'model' })
  })

  test('fewer messages than before is compaction, before model or pause', async () => {
    const cur = sample({ at: 30 * MIN, model: 'claude-sonnet-5-5', read: 4_000, messageCount: 2 })

    expect(classify(PREV, cur)).toStrictEqual({
      kind: 'miss',
      cause: 'compaction',
      lost: 19_000,
      gapMs: 30 * MIN,
    })
  })
})

describe('record', () => {
  test('main-thread misses are counted by cause with the tokens lost', async () => {
    let stats = record(EMPTY_STATS, { turnId: 't1', sample: PREV })
    stats = record(stats, {
      turnId: 't2',
      sample: sample({ at: 10 * MIN, read: 0, write: 24_000, messageCount: 6 }),
    })
    stats = record(stats, {
      turnId: 't3',
      sample: sample({ at: 11 * MIN, read: 1_000, write: 24_000, messageCount: 8 }),
    })

    expect(stats.main.requests).toBe(3)
    expect(stats.main.misses).toBe(2)
    expect(stats.main.causes).toStrictEqual({ ttl: 1, model: 0, compaction: 0, prefix: 1 })
    // ttl: 23,000 lost ; prefix: 24,000 − 1,000 = 23,000 lost
    expect(stats.main.lost).toBe(46_000)
    expect(stats.main.lastRequestHit).toBe(false)
    expect(stats.main.lastMiss).toStrictEqual({
      request: 3,
      cause: 'prefix',
      lost: 23_000,
      gapMs: MIN,
    })
  })

  test('the last turn sums its own requests and starts over on a new turn', async () => {
    let stats = record(EMPTY_STATS, { turnId: 't1', sample: PREV })
    stats = record(stats, {
      turnId: 't2',
      sample: sample({ at: 10 * MIN, read: 0, write: 24_000, messageCount: 6 }),
    })
    stats = record(stats, {
      turnId: 't2',
      sample: sample({ at: 10 * MIN + 5_000, read: 24_000, write: 200, messageCount: 8 }),
    })

    expect(stats.lastTurn).toStrictEqual({
      turnId: 't2',
      requests: 2,
      input: 20,
      read: 24_000,
      write: 24_200,
      misses: 1,
      causes: ['ttl'],
    })

    stats = record(stats, {
      turnId: 't3',
      sample: sample({ at: 11 * MIN, read: 24_200, write: 100, messageCount: 10 }),
    })

    expect(stats.lastTurn).toStrictEqual({
      turnId: 't3',
      requests: 1,
      input: 10,
      read: 24_200,
      write: 100,
      misses: 0,
      causes: [],
    })
  })

  test('a subagent is counted apart and its first request is cold', async () => {
    let stats = record(EMPTY_STATS, { turnId: 't1', sample: PREV })
    stats = record(stats, {
      agentId: 'agent-a',
      agentLabel: 'Explore · find auth',
      turnId: 'a1',
      sample: sample({ at: MIN, read: 0, write: 15_000, messageCount: 1 }),
    })
    stats = record(stats, {
      agentId: 'agent-a',
      turnId: 'a1',
      sample: sample({ at: 2 * MIN, read: 0, write: 16_000, messageCount: 3 }),
    })

    expect(stats.main.requests).toBe(1)
    expect(stats.main.misses).toBe(0)
    expect(stats.lastTurn?.turnId).toBe('t1')
    expect(stats.agents).toHaveLength(1)
    expect(stats.agents[0]?.label).toBe('Explore · find auth')
    expect(stats.agents[0]?.requests).toBe(2)
    // cold start not counted; second request lost all 15,000 cached tokens
    expect(stats.agents[0]?.misses).toBe(1)
    expect(stats.agents[0]?.lost).toBe(15_000)
  })
})

describe('hitRate', () => {
  test('is the share of input tokens read from the cache', async () => {
    // 900 / (50 + 900 + 50) = 0.9
    expect(hitRate({ input: 50, read: 900, write: 50 })).toBe(0.9)
  })

  test('is null before any request', async () => {
    expect(hitRate({ input: 0, read: 0, write: 0 })).toBeNull()
  })
})
