// End to end: model requests pass through the mod's turn.step hook and the
// pane shows what they did to the cache.
import { expect, mock, test } from 'claude-code/testing'
import type { TurnUsage } from 'claude-code'

const PANE = {
  plugin: 'cache-kpis',
  component: 'Pane',
  requestId: 'cache-kpis',
  props: {
    title: 'Cache',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Reads a step's stream to its end, as the engine does, then its result.
const run = async (stream: AsyncIterable<unknown> & { result: Promise<unknown> }) => {
  for await (const _ of stream) {
    // nothing streams in these tests
  }

  return stream.result
}

const usage = (read: number, write: number): TurnUsage => ({
  model: 'claude-opus-5-5',
  input_tokens: 0,
  output_tokens: 50,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})

test('a request after a 10 min pause shows the last turn as invalidated by TTL', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const answers = [usage(0, 20_000), usage(0, 21_000)]
  on('agent.list', () => ({ value: [] }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: answers.shift() ?? null,
    }
  })

  const step = (turnId: string, messageCount: number) =>
    run($.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount }))

  await step('t1', 1)
  await clock.advance(10 * 60_000)
  await step('t2', 3)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const turn = await ui.find({ type: 'Text', text: /Letzter Turn/ })
  const misses = await ui.find({ type: 'Text', text: /^Misses/ })

  expect(turn?.text).toMatch(/✗ invalidiert \(TTL\)/)
  expect(misses?.text).toMatch(/1 \(TTL 1\)/)
  await ui.unmount()
})

test('a request that reads the cached prefix shows the last turn as a hit', async ($, on) => {
  mock.clock(on, { now: 0 })
  const answers = [usage(0, 20_000), usage(20_000, 500)]
  on('agent.list', () => ({ value: [] }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: answers.shift() ?? null,
    }
  })

  await run($.turn.step({ turnId: 't1', index: 0, model: 'x', messageCount: 1 }))
  await run($.turn.step({ turnId: 't2', index: 0, model: 'x', messageCount: 3 }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const turn = await ui.find({ type: 'Text', text: /Letzter Turn/ })

  // 20,000 / (0 + 20,000 + 500) = 97.56…% → 97.6%
  expect(turn?.text).toMatch(/✓ 97\.6% · 1 Req/)
  await ui.unmount()
})

// On the terminal's main screen no click reaches a Button: only keys, and
// only while the pane holds the keyboard. So /cache-kpis must open it with
// focus, and the reset Button must answer a key.
test('/cache-kpis opens the pane holding the keyboard, Escape closing it', async ($, on) => {
  const opened: { id: string; focus?: true; closeOnEscape?: true }[] = []
  on('ui.open', (_, e) => {
    opened.push({ id: e.id, focus: e.focus, closeOnEscape: e.closeOnEscape })

    return { value: { isPlaced: true } }
  })

  // As typed at the prompt of a main-screen terminal.
  await $.command.run({
    command: 'cache-kpis',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  expect(opened).toStrictEqual([{ id: 'cache-kpis', focus: true, closeOnEscape: true }])
})

test('reset answers the r key and empties the counters', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('agent.list', () => ({ value: [] }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: usage(0, 5_000),
    }
  })
  await run($.turn.step({ turnId: 't1', index: 0, model: 'x', messageCount: 1 }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const button = await ui.find({ key: 'reset' })

  expect(button?.props.hotkey).toBe('r')
  expect((await ui.find({ type: 'Text', text: /^Requests/ }))?.text).toMatch(/1$/)
  await ui.press({ key: 'reset' })
  expect((await ui.find({ type: 'Text', text: /^Requests/ }))?.text).toMatch(/ 0$/)
  await ui.unmount()
})
