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
