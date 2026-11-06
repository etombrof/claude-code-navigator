import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'navigator',
  component: 'Pane',
  requestId: 'navigator',
  surface: 'terminal',
  props: {
    title: 'Your messages',
    isFocused: false,
    bodyColumns: 32,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const ON = { first: 0, last: 2, of: 3 }
const ROW = { origin: { kind: 'composer' }, isExpanded: true } as const

const row = (requestId: string, text: string, onScreen: typeof ON | null) =>
  ({
    plugin: 'navigator',
    component: 'UserMessage',
    requestId,
    surface: 'terminal',
    props: { ...ROW, text, onScreen },
  }) as const

const TEXTS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'a message far too long to fit on one line of the side pane',
  '日本語日本語日本語日本語日本語日本語',
]

// shortcut: Ctrl+Up/Down and clicks are untested, the kit cannot fake a transcript scroll
test('the block follows the wheel within a tick, recounts after a jump, and lines stay one line', async ($, on) => {
  const clock = mock.clock(on)
  mock.session(on)
  // stands for Claude drawing a message row beneath the mod
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>row</Text>
  })
  for (const [k, text] of TEXTS.entries()) {
    await $.session.append({
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid: `u${k}`,
      message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
    })
  }

  const pane = await $.ui.mount(PANE)
  await clock.advance(1000) // each new message recounts: let that finish
  const lines = async () => (await pane.findAll({ type: 'Text' })).filter(t => /^ \d\./.test(t.text))
  const block = async () =>
    (await lines()).flatMap(t => (t.props.backgroundColor === 'permission' ? [t.text.trim()] : []))

  // the wheel: rows report as they cross the screen's edge, the block follows on the next tick
  const first = await $.ui.mount(row('r1', 'first', ON))
  const second = await $.ui.mount(row('r2', 'second', ON))
  await clock.advance(1)
  expect(await block()).toEqual(['1. first'])
  await first.redraw({ ...ROW, text: 'first', onScreen: null })
  await clock.advance(1)
  expect(await block()).toEqual(['2. second'])

  // a big jump of Claude's own: rows vanish without a report and far ones appear; a recount fixes it
  await first.unmount()
  await second.unmount()
  const fourth = await $.ui.mount(row('r4', 'fourth', ON))
  const fifth = await $.ui.mount(row('r5', 'fifth', ON))
  await clock.advance(1000)
  expect(await block()).toEqual(['4. fourth'])

  // scrolling down: the fourth leaves at the top, so the fifth is the topmost
  await fourth.redraw({ ...ROW, text: 'fourth', onScreen: { first: 1, last: 2, of: 3 } })
  await fourth.redraw({ ...ROW, text: 'fourth', onScreen: null })
  await clock.advance(1)
  expect(await block()).toEqual(['5. fifth'])

  // back up: the fifth leaves at the bottom, the screen is inside the fourth's answer
  await fifth.redraw({ ...ROW, text: 'fifth', onScreen: { first: 0, last: 1, of: 3 } })
  await fifth.redraw({ ...ROW, text: 'fifth', onScreen: null })
  await clock.advance(1)
  expect(await block()).toEqual(['4. fourth'])

  // every message keeps to one line of the pane (31 cells), a long one cut with "…"
  const all = (await lines()).map(t => t.text)
  expect(all.slice(0, 6).map(t => t.length)).toEqual(Array(6).fill(31))
  expect(all[5]?.endsWith('…')).toBe(true)
  // a wide letter takes two cells: 4 + 13 × 2 + 1 = 31
  expect(all[6]).toBe(' 7. 日本語日本語日本語日本語日…')

  await fourth.unmount()
  await fifth.unmount()
  await pane.unmount()
})
