// Default view (agreed with the user): one status line under the prompt; the
// full table opens only on /cache-kpis, never by itself at session start, and
// nothing is drawn above the prompt.
import { expect, mock, test } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PANE = {
  plugin: 'cache-kpis',
  component: 'Pane',
  requestId: 'cache-kpis',
  props: {
    title: 'Cache',
    isFocused: true,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'cache-kpis',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

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

const answerSteps = (on: On, answers: TurnUsage[]) => {
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
}

const recordStatus = (on: On) => {
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    lines.push(e.text)

    return { value: undefined }
  })

  return lines
}

const answerSessionStart = (on: On) => {
  on('command.register', () => ({ value: { command: 'cache-kpis' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

const startSession = ($: Engine) =>
  $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

test('session start registers the command but opens no pane and shows no line', async ($, on) => {
  const opened: string[] = []
  const lines = recordStatus(on)
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  answerSessionStart(on)

  await startSession($)

  expect(opened).toStrictEqual([])
  expect(lines).toStrictEqual([undefined])
})

test('after a 10 min pause the line under the prompt shows the turn invalidated by TTL', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const lines = recordStatus(on)
  answerSteps(on, [usage(0, 20_000), usage(0, 21_000)])

  await run($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  await clock.advance(10 * 60_000)
  await run($.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 3 }))

  // first request: cold start, 0 of 20,000 read → 0.0%, the turn a hit
  // second: 0 of 41,000 read → 0.0%, the 20,000 cached tokens lost to the pause
  expect(lines).toStrictEqual([
    'cache 0.0% · last turn ✓ 0.0% · 1 Req · Misses 0 · /cache-kpis',
    'cache 0.0% · last turn ✗ invalidated (TTL) · Misses 1 (TTL 1) · /cache-kpis',
  ])
})

test('a reload brings the line back from the stats the session kept', async ($, on) => {
  mock.clock(on, { now: 0 })
  answerSteps(on, [usage(0, 20_000)])
  answerSessionStart(on)
  const lines = recordStatus(on)
  await run($.turn.step({ turnId: 't1', index: 0, model: 'x', messageCount: 1 }))
  const before = lines.length

  await startSession($)

  expect(lines.slice(before)).toStrictEqual([
    'cache 0.0% · last turn ✓ 0.0% · 1 Req · Misses 0 · /cache-kpis',
  ])
})

test('reset clears the line under the prompt', async ($, on) => {
  mock.clock(on, { now: 0 })
  answerSteps(on, [usage(0, 20_000)])
  const lines = recordStatus(on)
  await run($.turn.step({ turnId: 't1', index: 0, model: 'x', messageCount: 1 }))
  const before = lines.length

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'reset' })
  await ui.unmount()

  expect(lines.slice(before)).toStrictEqual([undefined])
})

test('nothing is drawn above the prompt', async ($, on) => {
  mock.clock(on, { now: 0 })
  answerSteps(on, [usage(0, 20_000)])
  recordStatus(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  await run($.turn.step({ turnId: 't1', index: 0, model: 'x', messageCount: 1 }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
