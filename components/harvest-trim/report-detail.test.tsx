// Render-level coverage for the hanger table: the pay rule, subtotal semantics and the column choice. Static
// markup in the node environment (no DOM), which is enough to assert what is and is not in the table.

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TrimDayEpisode } from '@/actions/trim-reports'
import { defaultHiddenColumns } from '@/lib/trim/report-columns'
import type { SortState } from '@/lib/trim/report-table'
import { RENDER_STEP, ReportDetailView } from './report-detail'

let n = 0
function ep(over: Partial<TrimDayEpisode> = {}): TrimDayEpisode {
  n++
  return {
    checkoutId: `co-${n}`,
    status: 'returned',
    seq: 1,
    hangerCode: `H1B-${String(n).padStart(3, '0')}`,
    loadId: `load-${n}`,
    batchId: 'b1',
    batchName: '1001-F1-BB',
    strainName: 'Bubble Bath',
    trimmerId: 't-antonio',
    trimmerName: 'Antonio',
    checkedOutAt: '2026-10-21T13:00:00+00:00',
    returnedAt: '2026-10-21T14:00:00+00:00',
    turnaroundHours: 1,
    issuedG: 600,
    issuedPlantCount: 8,
    flowerG: 250,
    trimG: 100,
    stemsG: 200,
    returnedTotalG: 550,
    varianceG: 5,
    variancePct: 0.8,
    varianceStatus: 'ok',
    returnKind: 'complete',
    ratePerLb: 225,
    payAmount: 50,
    ...over,
  }
}

const crew = [
  ep({ trimmerId: 't-antonio', trimmerName: 'Antonio' }),
  ep({ trimmerId: 't-antonio', trimmerName: 'Antonio' }),
  ep({ trimmerId: 't-wayne', trimmerName: 'Wayne' }),
]

const BY_TRIMMER: SortState = { key: 'trimmer', dir: 'asc' }

function render(over: Partial<React.ComponentProps<typeof ReportDetailView>> = {}) {
  return renderToStaticMarkup(
    <ReportDetailView
      episodes={crew}
      showMoney
      showDates={false}
      sort={BY_TRIMMER}
      onSortChange={() => {}}
      resetKey="k"
      finishedOnly={false}
      onFinishedOnlyChange={() => {}}
      hidden={defaultHiddenColumns()}
      onToggle={() => {}}
      onReset={() => {}}
      {...over}
    />
  )
}

/** Just the wide-screen table (the card list below it repeats the same figures). */
function table(html: string): string {
  return html.slice(html.indexOf('<table'), html.indexOf('</table>') + 8)
}

/** The <tr> elements of the table body that are subtotal rows. */
function subtotalRows(html: string): string[] {
  return [...table(html).matchAll(/<tr[^>]*data-subtotal[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0])
}

/** Header cell labels of the table (the buttons inside <th>), in order. */
function headers(html: string): string[] {
  const head = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'))
  return [...head.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1])
}

describe('columns', () => {
  it('default: nine columns, Trim and Stems off', () => {
    expect(headers(render())).toEqual(['Hanger', 'Batch', 'Trimmer', 'Out → in', 'Issued', 'Flower', 'Variance', 'Status', 'Pay'])
  })

  it('turning Trim and Stems on shows them', () => {
    expect(headers(render({ hidden: [] }))).toEqual([
      'Hanger', 'Batch', 'Trimmer', 'Out → in', 'Issued', 'Flower', 'Trim', 'Stems', 'Variance', 'Status', 'Pay',
    ])
  })

  it('Hanger stays even if a stored choice tried to hide it', () => {
    expect(headers(render({ hidden: ['hanger' as never, 'batch', 'trim', 'stems'] }))).toEqual(['Hanger', 'Trimmer', 'Out → in', 'Issued', 'Flower', 'Variance', 'Status', 'Pay'])
  })

  it('every shown header is a sort button with aria-sort', () => {
    const html = render({ sort: { key: 'flower', dir: 'desc' } })
    expect(html).toContain('aria-sort="descending"')
    expect(html.match(/aria-sort="none"/g)?.length).toBe(8)
  })
})

describe('pay rule: no Pay column for a viewer without pay access', () => {
  it('grow: not in the table, no dollar figure, no rate, not in the column selector', () => {
    const html = render({ showMoney: false, hidden: [] })
    expect(headers(html)).not.toContain('Pay')
    expect(table(html)).not.toMatch(/\$\d/)
    expect(html).not.toMatch(/\$\d/) // no dollar amount anywhere, table or cards
    expect(html).not.toContain('/lb')
    expect(html).not.toContain('>Pay<')
    // The selector is closed in static markup; it is built from selectableColumns(showMoney), covered in
    // lib/trim/report-columns.test.ts. Here: nothing in the page, open or not, offers Pay.
    expect(html).not.toMatch(/Pay/)
  })

  it('grow still gets subtotals, without a pay figure', () => {
    const html = render({ showMoney: false, hidden: [] })
    expect(html).toContain('data-subtotal')
    expect(html).not.toMatch(/\$\d/)
  })

  it('admin: Pay column, rate and subtotal pay are present', () => {
    const html = render()
    expect(headers(html)).toContain('Pay')
    expect(html).toContain('$225.00/lb')
    expect(html).toContain('$100.00') // Antonio's two $50 lines
  })
})

describe('subtotal rows', () => {
  it('sorted by trimmer: one per person, as a row with a row header, marked as a subtotal', () => {
    const rows = subtotalRows(render())
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r).toContain('<th')
      expect(r).toContain('scope="row"')
      expect(r).toContain('Subtotal')
    }
    expect(rows[0]).toContain('2 hangers')
    expect(rows[0]).toContain('for Antonio') // announced with whose subtotal it is
    expect(rows[1]).toContain('1 hanger<')
  })

  it('any other sort: no subtotal rows', () => {
    const html = render({ sort: { key: 'flower', dir: 'desc' } })
    expect(html).not.toContain('data-subtotal')
    expect(html).not.toContain('Subtotal')
    expect(render({ sort: { key: 'outIn', dir: 'asc' } })).not.toContain('data-subtotal')
  })

  it('respects the visible columns: nothing for a hidden column, and the name moves into the label', () => {
    const [first] = subtotalRows(render({ hidden: ['trimmer', 'trim', 'stems', 'flower', 'pay'] }))
    expect(first).toContain('Antonio subtotal')
    expect(first).not.toContain('lb') // Flower is hidden, so no flower figure
    expect(first).not.toContain('$') // Pay is hidden
    expect(first).toContain('1,200 g') // Issued is visible
  })

  it('has one cell per visible column, so each figure sits under its header', () => {
    const [row] = subtotalRows(render())
    expect((row.match(/<t[dh][ >]/g) ?? []).length).toBe(9)
    const [fewer] = subtotalRows(render({ hidden: ['batch', 'status', 'pay', 'trim', 'stems'] }))
    expect((fewer.match(/<t[dh][ >]/g) ?? []).length).toBe(6)
  })
})

describe('totals vs rendered rows', () => {
  const big = Array.from({ length: RENDER_STEP + 40 }, (_, i) =>
    ep({ trimmerId: i < RENDER_STEP + 30 ? 't-a' : 't-b', trimmerName: i < RENDER_STEP + 30 ? 'Ana' : 'Bo', flowerG: 10, payAmount: 1 })
  )

  it('renders only a slice, says so, and the subtotal still covers the whole block', () => {
    const html = render({ episodes: big })
    expect(html).toContain(`Showing ${RENDER_STEP + 30} of ${RENDER_STEP + 40} hangers`) // block-aligned cut
    expect(html).toContain('Show all')
    // Ana's block is RENDER_STEP + 30 rows: her subtotal says so, though the slice could have ended earlier.
    expect(html).toContain(`${RENDER_STEP + 30} hangers`)
    expect(html).toContain('Totals and subtotals cover all')
  })

  it('a short list has no "show more"', () => {
    expect(render()).not.toContain('Show all')
  })
})

describe('checked-out (open) hangers', () => {
  // 13:00Z checkout, "now" 15:30Z: held 2.5 hours.
  const NOW = Date.parse('2026-10-21T15:30:00+00:00')
  const open = (over: Partial<TrimDayEpisode> = {}) =>
    ep({
      status: 'out',
      hangerCode: 'H1B-OPEN',
      trimmerId: 't-antonio',
      trimmerName: 'Antonio',
      returnedAt: null,
      turnaroundHours: null,
      issuedG: 700,
      issuedPlantCount: 6,
      flowerG: null,
      trimG: null,
      stemsG: null,
      returnedTotalG: null,
      varianceG: null,
      variancePct: null,
      varianceStatus: null,
      returnKind: null,
      payAmount: null,
      ...over,
    })
  const withOpen = [...crew, open()]
  const openRowHtml = (html: string) => table(html).match(/<tr[^>]*data-open[^>]*>[\s\S]*?<\/tr>/)![0]
  const cellsOf = (tr: string) => [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())

  it('is a distinct row: Checked out tag, dashed/muted treatment, checkout time, held-so-far, plants and issued weight', () => {
    const html = render({ episodes: withOpen, nowMs: NOW, hidden: [] })
    const tr = openRowHtml(html)
    expect(tr).toContain('Checked out')
    expect(tr).toContain('text-muted-foreground')
    expect(tr).toContain('H1B-OPEN')
    expect(tr).toContain('held 2.5 h so far')
    expect(tr).toContain('6 plants')
    expect(tr).toContain('700 g')
    expect(tr).toMatch(/→ —/) // no return time yet
  })

  it('every result cell is the em dash, never a zero', () => {
    const tr = openRowHtml(render({ episodes: withOpen, nowMs: NOW, hidden: [] }))
    const cells = cellsOf(tr)
    // Hanger, Batch, Trimmer, Out -> in, Issued, Flower, Trim, Stems, Variance, Status, Pay
    expect(cells).toHaveLength(11)
    expect(cells.slice(5)).toEqual(['—', '—', '—', '—', '—', '—'])
    expect(tr).not.toMatch(/\b0(\.0+)? ?(g|lb)\b/)
    expect(tr).not.toContain('$')
  })

  it('does not change a returned row or any subtotal figure; the block just says how many are in progress', () => {
    const base = subtotalRows(render({ episodes: crew }))
    const html = render({ episodes: withOpen, nowMs: NOW })
    const rows = subtotalRows(html)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('1 in progress')
    expect(rows[0]).toContain('2 hangers') // Antonio's two returned hangers; the open one is not a third
    const strip = (r: string) => r.replace(/<span[^>]*>1 in progress<\/span>/, '')
    expect(strip(rows[0])).toBe(base[0])
    expect(rows[1]).toBe(base[1])
    expect(rows[1]).not.toContain('in progress')
  })

  it('heading and footnote say how many are in progress', () => {
    const html = render({ episodes: withOpen, nowMs: NOW })
    expect(html).toContain('4, 1 in progress')
    expect(html).toContain('not counted in any total or subtotal')
    expect(render()).not.toContain('in progress')
  })

  it('card view (phones): tagged, plants and issued, dashes elsewhere', () => {
    const html = render({ episodes: withOpen, nowMs: NOW, hidden: [] })
    const card = html.slice(html.indexOf('<ul')).match(/<li[^>]*data-open[^>]*>[\s\S]*?<\/li>/)![0]
    expect(card).toContain('Checked out')
    expect(card).toContain('6 plants')
    expect(card).toContain('700 g')
    expect(card).toContain('held 2.5 h so far')
    expect(card).toContain('border-dashed')
  })

  it('grow: an open row adds no dollar figure, rate or Pay anywhere', () => {
    const html = render({ episodes: withOpen, nowMs: NOW, showMoney: false, hidden: [] })
    expect(html).not.toMatch(/\$\d/)
    expect(html).not.toContain('/lb')
    expect(html).not.toMatch(/Pay/)
    expect(html).toContain('Checked out')
  })

  it('admin: an open row shows no pay and no rate', () => {
    const tr = openRowHtml(render({ episodes: withOpen, nowMs: NOW, hidden: [] }))
    expect(tr).not.toContain('/lb')
    expect(tr).not.toContain('$')
  })

  it('only open hangers in a block: the subtotal shows dashes and the count, not zeros', () => {
    const html = render({ episodes: [open()], nowMs: NOW })
    const [row] = subtotalRows(html)
    expect(row).toContain('0 hangers')
    expect(row).toContain('1 in progress')
    expect(row).not.toMatch(/\b0(\.0+)? ?(g|lb)\b/)
    expect(row).not.toContain('$')
  })
})

describe('Finished only: a display toggle that moves no number', () => {
  const NOW = Date.parse('2026-10-21T15:30:00+00:00')
  const open = (over: Partial<TrimDayEpisode> = {}) =>
    ep({
      status: 'out',
      hangerCode: 'H1B-OPEN',
      returnedAt: null,
      turnaroundHours: null,
      issuedG: 700,
      issuedPlantCount: 6,
      flowerG: null,
      trimG: null,
      stemsG: null,
      returnedTotalG: null,
      varianceG: null,
      variancePct: null,
      varianceStatus: null,
      returnKind: null,
      payAmount: null,
      ...over,
    })
  // An 'unfinished' RETURN: came back part-trimmed. It is returned, carries flower and pay, and must count.
  const partTrimmed = () => ep({ hangerCode: 'H1B-PART', returnKind: 'unfinished', flowerG: 120, payAmount: 31.5 })

  // Antonio: two full returns, one part-trimmed return, one open. Wayne: one return. Maria: ONLY an open hanger.
  const day = [
    ...crew,
    partTrimmed(),
    open(),
    open({ trimmerId: 't-maria', trimmerName: 'Maria', hangerCode: 'H1B-MARIA' }),
  ]
  const on = (over: Partial<React.ComponentProps<typeof ReportDetailView>> = {}) =>
    render({ episodes: day, nowMs: NOW, finishedOnly: true, ...over })
  const off = (over: Partial<React.ComponentProps<typeof ReportDetailView>> = {}) =>
    render({ episodes: day, nowMs: NOW, finishedOnly: false, ...over })
  /** Hanger codes of the rows in the wide table, in order. */
  const listed = (html: string) => [...table(html).matchAll(/H1B-[A-Z0-9-]+(?=<\/a>)/g)].map((m) => m[0])

  it('ON lists returned rows only; OFF lists the open ones too', () => {
    expect(listed(on())).not.toContain('H1B-OPEN')
    expect(listed(on())).not.toContain('H1B-MARIA')
    expect(listed(off())).toEqual(expect.arrayContaining(['H1B-OPEN', 'H1B-MARIA']))
    expect(listed(off()).length - listed(on()).length).toBe(2)
    expect(table(on())).not.toContain('Checked out')
    expect(table(off())).toContain('Checked out')
  })

  it('REGRESSION: every subtotal is byte-identical with the toggle on and off, for every trimmer that has a returned row', () => {
    const rowsOn = subtotalRows(on())
    const rowsOff = subtotalRows(off())
    // Maria has only an open hanger: her subtotal is the extra row OFF, and does not exist ON.
    expect(rowsOff).toHaveLength(3)
    expect(rowsOn).toHaveLength(2)
    expect(rowsOn).toEqual(rowsOff.filter((r) => !r.includes('Maria')))
    // and with Pay hidden (grow) and every column shown
    const onGrow = subtotalRows(on({ showMoney: false, hidden: [] }))
    const offGrow = subtotalRows(off({ showMoney: false, hidden: [] }))
    expect(onGrow).toEqual(offGrow.filter((r) => !r.includes('Maria')))
  })

  it('the in-progress count stays on each subtotal and in the heading in both modes', () => {
    for (const html of [on(), off()]) {
      expect(subtotalRows(html)[0]).toContain('1 in progress') // Antonio's open hanger
    }
    expect(on()).toContain('(4, 2 in progress not listed)')
    expect(off()).toContain('(6, 2 in progress)')
  })

  it('ON: a trimmer with only open hangers has no all-dashes subtotal row; OFF: it renders correctly', () => {
    expect(subtotalRows(on()).join('')).not.toContain('Maria')
    expect(on()).not.toContain('0 hangers')
    const maria = subtotalRows(off()).find((r) => r.includes('Maria'))!
    expect(maria).toContain('0 hangers')
    expect(maria).toContain('1 in progress')
    expect(maria).not.toMatch(/\b0(\.0+)? ?(g|lb)\b/)
    expect(maria).not.toContain('$')
  })

  it("a part-trimmed ('unfinished') RETURN is listed, tagged and summed in BOTH modes", () => {
    for (const html of [on(), off()]) {
      expect(listed(html)).toContain('H1B-PART')
      expect(table(html)).toContain('Unfinished')
      // Antonio's subtotal includes it: 3 returned hangers, flower 250 + 250 + 120 = 620 g, pay 50 + 50 + 31.5.
      const antonio = subtotalRows(html)[0]
      expect(antonio).toContain('3 hangers')
      expect(antonio).toContain('$131.50')
    }
  })

  it('the unfinished tag and the Checked out tag are different things', () => {
    const t = table(off())
    expect(t.match(/Unfinished/g)).toHaveLength(1)
    expect(t.match(/Checked out/g)).toHaveLength(2)
  })

  it('card view (phones) follows the toggle too, and its subtotals are identical', () => {
    const cards = (html: string) => html.slice(html.indexOf('<ul'))
    expect(cards(on())).not.toContain('H1B-OPEN')
    expect(cards(off())).toContain('H1B-OPEN')
    const sub = (html: string) => [...cards(html).matchAll(/<li[^>]*data-subtotal[^>]*>[\s\S]*?<\/li>/g)].map((m) => m[0])
    expect(sub(on())).toEqual(sub(off()).filter((r) => !r.includes('Maria')))
  })

  it('the switch is a labelled control reflecting the state', () => {
    expect(on()).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="true"/)
    expect(off()).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"/)
    expect(on()).toContain('Finished only')
  })

  it('ON with only open hangers: the switch stays reachable, no table is drawn, and it says how to see them', () => {
    const html = render({ episodes: [open(), open({ hangerCode: 'H1B-OPEN2', loadId: 'l2' })], nowMs: NOW, finishedOnly: true })
    expect(html).toContain('role="switch"')
    expect(html).toContain('No finished hangers to list.')
    expect(html).toContain('2 hangers are still checked out: turn off Finished only to see them.')
    expect(html).not.toContain('data-subtotal')
    expect(listed(html)).toEqual([])
    expect(html).toContain('(0, 2 in progress not listed)')
  })

  it('grow: no dollar figure, rate or Pay in either mode', () => {
    for (const html of [on({ showMoney: false, hidden: [] }), off({ showMoney: false, hidden: [] })]) {
      expect(html).not.toMatch(/\$\d/)
      expect(html).not.toContain('/lb')
      expect(html).not.toMatch(/Pay/)
    }
  })

  it('"Showing x of y" counts the listed rows only (the open hanger is not one of the 260)', () => {
    const many = Array.from({ length: RENDER_STEP + 10 }, () => ep({ trimmerId: 't-a', trimmerName: 'Aaron' }))
    const html = render({ episodes: [...many, open({ trimmerId: 't-a', trimmerName: 'Aaron' })], nowMs: NOW, finishedOnly: true, sort: { key: 'flower', dir: 'desc' } })
    expect(html).toContain(`Showing ${RENDER_STEP} of ${RENDER_STEP + 10} hangers`)
  })
})
