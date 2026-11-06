import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// the message Ctrl+Up/Down landed on (null: none, the normal view)
const selected = atom({ plugin: 'navigator', key: 'selected' } as const, null)
// the message the side pane's block is on; only the pane reads it, so a write redraws the pane alone
const here = atom({ plugin: 'navigator', key: 'here' } as const, null)

// Ctrl+Up/Down (and Alt+Up/Down) are bound globally to these diff-view actions, idle outside
// the diff view, so a band Button naming them is pressed by those chords from the prompt.
const UP = 'app:diffFileListUp'
const DOWN = 'app:diffFileListDown'
const PANE = 'navigator'
const PANE_COLUMNS = 32

// Your messages, oldest first, by row id (the id a UserMessage row renders under).
type Msg = { id: string; label: string }
const msgs: Msg[] = []
// The newest conversation rows, oldest first: something to scroll to for "the bottom".
const tail: string[] = []

const index = (id: string | null) => (id === null ? -1 : msgs.findIndex(m => m.id === id))
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

// Which of your messages are on screen: index in msgs -> its row's last report. A row reports
// as it crosses the screen's edge, so the block follows the wheel at once. A big jump moves rows
// without a report, so it holds the block and recounts: every row redraws once, and the ones
// that did not answer this round (an older gen) are gone.
const report = new Map<number, { isOn: boolean; gen: number; cutBelow: boolean }>()
// The last of your messages to leave the screen, and whether it left at the bottom (you scrolled
// up, into the answer above it).
let lastOff: { i: number; viaBottom: boolean } | null = null
let gen = 0
let holding = false // a recount is due or running: the block stays where it is
let counting = false
let again = false
const RECOUNT_MS = 300 // time for every row to redraw once (redraws run at most 10 a second)

function recount($: EngineInterface) {
  holding = true
  if (counting) {
    again = true
    return
  }
  counting = true
  again = false
  gen += 1
  $.ui.invalidate('ui.render')
  $.clock.after(RECOUNT_MS, () => {
    counting = false
    if (again) return recount($)
    for (const [i, r] of report) if (r.gen !== gen) report.delete(i)
    holding = false
    publish($)
  })
}

// A big move (a jump): the block shows where it lands at once and holds there until the recount.
async function bigMove($: EngineInterface, move: () => Promise<unknown>) {
  holding = true
  try {
    await move()
  } finally {
    recount($)
  }
}

// Puts the block on the message you jumped to while it is on screen, else on the topmost one on
// screen. Written from a timer, as a render hook may not write state; one write per burst.
let publishing = false
function publish($: EngineInterface) {
  if (publishing || holding) return
  publishing = true
  $.clock.after(0, async () => {
    publishing = false
    if (holding) return
    const on = [...report].flatMap(([i, r]) => (r.isOn ? [i] : []))
    let at: number
    if (on.length === 0) {
      // inside a long answer: the message whose answer it is, from how the last one left
      if (lastOff === null) return
      at = lastOff.viaBottom ? Math.max(0, lastOff.i - 1) : lastOff.i
    } else {
      const sel = index(await read($, selected))
      at = on.includes(sel) ? sel : Math.min(...on)
    }
    const id = msgs[at]?.id ?? null
    if (id !== (await read($, here))) await update($, here, () => id)
  })
}

// A message comes on screen beside one already there; far from all of them, rows moved unreported.
function besideOthers(i: number) {
  const others = [...report].flatMap(([k, r]) => (r.isOn && k !== i ? [k] : []))
  return others.length === 0 || others.some(k => Math.abs(k - i) === 1)
}

// A row draws under an id of its own, not the transcript id scrolling takes, so rows are
// matched to your messages by their text: drawn row id -> index in msgs.
const drawnAs = new Map<string, number>()
function rowIndex(rowId: string, text: string) {
  const known = drawnAs.get(rowId)
  if (known !== undefined) return known
  const key = oneLine(text).slice(0, 80)
  const taken = new Set(drawnAs.values())
  const same = msgs.flatMap((m, i) => (m.label.slice(0, 80) === key ? [i] : []))
  // shortcut: two messages with the same first 80 characters are told apart by draw order only
  const i = same.find(k => !taken.has(k)) ?? same[0] ?? -1
  if (i !== -1) drawnAs.set(rowId, i)
  return i
}

function remember(id: string, label: string) {
  if (index(id) === -1) msgs.push({ id, label: oneLine(label) })
}

function pushTail(id: string) {
  tail.push(id)
  if (tail.length > 30) tail.shift()
}

// [uuid, parentUuid, isYourMessage, text]: the transcript file is megabytes (screenshots,
// tool output), over the 4 MiB a mod may read, so python strips each row to this first.
type Row = [string, string | null, boolean, string]
const STRIP = `
import json, sys
out = []
for line in open(sys.argv[1]):
    try:
        r = json.loads(line)
    except Exception:
        continue
    if not r.get("uuid"):
        continue
    mine = r.get("type") == "user" and not r.get("isMeta") and (r.get("origin") or {}).get("kind") == "human"
    c = (r.get("message") or {}).get("content")
    text = c if isinstance(c, str) else next((b.get("text", "") for b in (c or []) if isinstance(b, dict) and b.get("type") == "text"), "")
    out.append([r["uuid"], r.get("parentUuid"), mine, text[:200] if mine else ""])
print(json.dumps(out))
`

// Your earlier messages, from this session's transcript file: the rows on screen are drawn
// lazily, so the file is the only full list. Follows the parent chain from the newest row so
// rewound branches are left out.
async function loadHistory($: EngineInterface, cwd: string) {
  try {
    const home = await $.env.get('HOME')
    const file = `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${await $.session.id()}.jsonl`
    const { exitCode, stdout } = await $.process.run(['python3', '-I', '-c', STRIP, file])
    if (exitCode !== 0) return
    const rows = JSON.parse(stdout) as Row[]
    const byId = new Map(rows.map(r => [r[0], r]))
    const chain: Row[] = []
    let r = rows.at(-1)
    while (r) {
      chain.push(r)
      r = r[1] ? byId.get(r[1]) : undefined
    }
    chain.reverse()
    const later = msgs.splice(0) // seen since, keep after
    for (const [id, , mine, text] of chain) if (mine) remember(id, text)
    for (const m of later) remember(m.id, m.label)
    tail.splice(0, tail.length, ...chain.slice(-30).map(row => row[0]))
    drawnAs.clear() // indexes moved: match the rows again
    report.clear()
    recount($)
  } catch {
    // shortcut: no python3 or an unreadable file loads nothing; only messages sent from now on are reachable
  }
}

async function jumpTo($: EngineInterface, i: number) {
  const m = msgs[i]
  if (m === undefined) return
  await bigMove($, async () => {
    await update($, here, () => m.id)
    await update($, selected, () => m.id)
    await $.ui.scroll({ to: { requestId: m.id }, block: 'start' })
  })
}

// Back to the latest answer: the newest row that is a drawn instance, bottom edge in view.
async function toBottom($: EngineInterface) {
  await bigMove($, async () => {
    await update($, here, () => msgs.at(-1)?.id ?? null) // a first guess; the recount settles it
    await update($, selected, () => null)
    for (const id of [...tail].reverse()) {
      const moved = await $.ui.scroll({ to: { requestId: id }, block: 'end' }).catch(() => ({ deny: 'failed' }))
      if (!('deny' in moved)) return
    }
  })
}

async function move($: EngineInterface, step: -1 | 1) {
  const at = index(await read($, selected))
  const target = (at === -1 ? msgs.length : at) + step
  if (target < 0) return // already on your first message
  if (target >= msgs.length) return toBottom($)
  await jumpTo($, target)
}

// Terminal cells a character takes: 2 for emoji and East Asian wide letters, 0 for marks that
// combine with the one before.
const WIDE =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]|\p{Extended_Pictographic}/u
const JOINING = /[\p{Mn}\p{Me}‍︀-️]/u
const cells = (ch: string) => (JOINING.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1)

// Exactly `width` cells, cut with "…" or padded, so each message keeps to one line and the block
// spans it. Errs wide (an emoji sequence counts 2 a part), so a line is cut early, never wrapped.
function fit(text: string, width: number) {
  const chars = [...text]
  const total = chars.reduce((n, ch) => n + cells(ch), 0)
  if (total <= width) return text + ' '.repeat(width - total)
  let out = ''
  let used = 0
  for (const ch of chars) {
    if (used + cells(ch) > width - 1) break
    out += ch
    used += cells(ch)
  }
  return `${out}…${' '.repeat(width - 1 - used)}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'messages', description: 'Show the list of your messages on the right' })
    await loadHistory($, e.cwd)
    void $.ui.open({ id: PANE, title: 'Your messages', columns: PANE_COLUMNS })
    return result
  })

  on('command.run', { command: 'messages' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Your messages', columns: PANE_COLUMNS })
    return { text: 'Messages pane opened.' }
  })

  // every new row of the main conversation; your own messages also join the list
  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      pushTail(e.uuid)
      if (e.door === 'prompt' && e.origin.kind === 'composer' && !e.message.isMeta) {
        const block = e.message.content.find(b => b.type === 'text')
        remember(e.uuid, block && 'text' in block && typeof block.text === 'string' ? block.text : '')
        recount($) // the list grew and Claude jumps to the bottom: redraw and recount
      }
    }
    return result
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const i = rowIndex(e.requestId, e.props.text)
    const seen = e.props.onScreen
    if (seen !== undefined && i !== -1) {
      const isOn = seen !== null
      const before = report.get(i)
      const was = before?.isOn ?? false
      if (was && !isOn) lastOff = { i, viaBottom: before?.cutBelow ?? false }
      // top on screen, bottom cut: the row sits at the screen's bottom edge
      const cutBelow = seen !== null && seen.first === 0 && seen.last < seen.of - 1
      report.set(i, { isOn, gen, cutBelow })
      if (!holding) {
        if (isOn && !was && !besideOthers(i)) recount($) // far from the rest: rows moved unreported
        else if (isOn !== was) publish($)
      }
    }

    const row = await next(e)
    const sel = await read($, selected)
    if (i === -1 || msgs[i]?.id !== sel) return row

    const { Box } = $.ui.resolve(e)
    return (
      <Box borderStyle="round" borderColor="warning">
        {row}
      </Box>
    )
  })

  // the list on the right, in claude-squad's style: a purple label, one line per message, a
  // light block on the one where you are; click a line to jump
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const at = index(await read($, here))
    const width = e.props.bodyColumns - 1 // one cell spare so a line never wraps
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 5)
    const focus = at !== -1 ? at : msgs.length - 1
    const start = Math.max(0, Math.min(focus - Math.floor(room / 2), msgs.length - room))
    const digits = String(msgs.length).length

    return (
      <Box flexDirection="column">
        <Text backgroundColor="merged" color="inverseText"> Your messages </Text>
        {msgs.length === 0 && <Text dimColor>No messages found yet.</Text>}
        {msgs.slice(start, start + room).map((m, k) => {
          const i = start + k
          const isHere = i === at
          const label = `${String(i + 1).padStart(digits)}. ${m.label}`
          return (
            <Button key={`m-${i}`} label={label} plain onPress={() => jumpTo($, i)}>
              <Text backgroundColor={isHere ? 'permission' : undefined} color={isHere ? 'inverseText' : undefined}>
                {fit(` ${label}`, width)}
              </Text>
            </Button>
          )
        })}
      </Box>
    )
  })

  // the key line under the chat, in claude-squad's menu style: keys in color, words dim
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const at = index(await read($, selected))
    const where = at === -1 ? `${msgs.length} messages` : `${at + 1}/${msgs.length}`
    const rest = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {rest}
        <Box>
          <Button key="up" label="ctrl+↑ prev" action={UP} plain onPress={() => move($, -1)}>
            <Text color="permission">ctrl+↑</Text>
            <Text dimColor> prev</Text>
          </Button>
          <Text dimColor> · </Text>
          <Button key="down" label="ctrl+↓ next" action={DOWN} plain onPress={() => move($, 1)}>
            <Text color="permission">ctrl+↓</Text>
            <Text dimColor> next</Text>
          </Button>
          <Text dimColor> · {where}</Text>
        </Box>
      </Box>
    )
  })

  // a new message ends the jumping; a failed reset must never block sending it
  on('prompt.submit', async ($, e, next) => {
    await update($, selected, () => null).catch(() => {})
    return next(e)
  })
}
