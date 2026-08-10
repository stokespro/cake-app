'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Play, FastForward, History, Edit2, CalendarCog, Trash2 } from 'lucide-react'
import { format } from 'date-fns'
import { parseLocalDate } from '@/lib/utils'
import {
  getDayProgress,
  getPairingLabel,
  getCycleStageLabel,
  PHASE_BADGE_CLASSES,
} from '@/lib/cultivation/helpers'
import { STAGE_ORDER } from '@/types/cultivation'
import type { GrowRoom, RoomCycle, PipelineStage } from '@/types/cultivation'

// ─── Props ────────────────────────────────────────────────────────────────────

export interface RoomCardProps {
  room: GrowRoom
  activeCycles: RoomCycle[]
  allRooms: GrowRoom[]
  taskCounts?: { pending: number; overdue: number }
  onStartCycle?: (room: GrowRoom) => void
  onAdvanceStage?: (room: GrowRoom) => void
  /** Admin-only — correct milestone dates on an active cycle. Rendered only when activeCycles.length > 0. */
  onEditCycle?: (room: GrowRoom) => void
  onHistory?: (room: GrowRoom) => void
  onEdit?: (room: GrowRoom) => void
  onDelete?: (room: GrowRoom) => void
  variant?: 'default' | 'tv'
}

// ─── TV typography ──────────────────────────────────────────────────────────
//
// tv variant only, split into two independent query scopes:
//
//  - TV_TITLE / TV_BODY are sized off the CARD's own `[container-type:size]`
//    box and cover everything that isn't per-cycle: room name, pairing
//    label, cycle-count badge, task counts, notes, "No active cycle".
//  - TV_COL_BODY / TV_COL_MILESTONE are ALSO sized off the CARD's own box,
//    not the per-cycle column (SPRO-83 uniform-font-size fix). Each cycle
//    column used to be its own `[container-type:size]` container, which made
//    its `cqmin` width-bound as soon as a room had enough concurrent cycles
//    to squeeze its columns narrow — a 3-cycle room's text was visibly
//    smaller than a 2-cycle room's next to it on the live board (F1 vs
//    F3/F5/F6), which reads as "something's not right," not "this room is
//    busier." Every card is an identical-size cell in the page grid, so a
//    card-scoped `cqmin` is identical across all four cards regardless of
//    cycle count — that's what makes the text uniform. The column div keeps
//    `min-w-0 min-h-0 overflow-hidden flex flex-col gap-1` but deliberately
//    does NOT have `[container-type:size]` anymore, so its descendants'
//    `cqmin` resolves up to the nearest container ancestor: the Card.
//
// There is deliberately no `--tv-scale` custom property. It existed solely
// to compensate for the old vertical-stack layout, where a card's required
// height (and therefore the text it could afford) scaled with active-cycle
// count. Cards are fixed-size grid cells regardless of layout scheme, so
// there's nothing left for a height-derived scale factor to compensate for.
//
// Trade-off, stated plainly: card-to-card uniformity was chosen over
// maximizing size on less-busy cards. A 2-cycle card COULD render larger
// text if sized off its own (wider) columns, but that inconsistency is
// exactly what's being fixed — text must now fit the WORST case (3
// concurrent cycles, the common count per rooms-hold-multiple-concurrent-
// cycles) since one size serves every card regardless of its own count.
//
// Floors: TV_COL_BODY floors at 14px and TV_COL_MILESTONE at 12px —
// unchanged from before this pass. TV_TITLE/TV_BODY floors are untouched
// (1.5rem / 1rem).
//
// The clamp midpoints below (5.5cqmin / 4.6cqmin) are sized off the CARD, so
// they have to satisfy two budgets at once:
//
//  - Vertical, per column: ~7 text lines (cycle label, progress
//    label/value, then 5 stacked milestone lines) plus a fixed 8px progress
//    bar and ~24px of flex gaps, so required column height is roughly
//    `9.45 * fontSize + 32`, checked against the card's content height.
//  - Horizontal, at 3 columns (the width-worst case now that font size no
//    longer varies by count): the widest row is the cycle header,
//    "Cycle #1" plus a stage badge like "Flower W3", needing roughly
//    `8.5 * fontSize + 24`px of badge padding, checked against a 3-column
//    width of roughly `(cardWidth - 32 - 24) / 3`.
//
// At 1920x1080 (card ~926x480, cqmin 480, 3-col width ~290px) 5.5cqmin gives
// ~26.4px against a ~31px horizontal ceiling. At 1366x768 (card ~649x324,
// cqmin 324, 3-col width ~197px) it gives ~17.8px against a ~20.4px
// ceiling. Confirmed live at 1920x1080 (26.29px), 1512x800 (18.59px), and
// 2560x1440 (32px — hits the clamp ceiling), across a 3-cycle card and
// 2-cycle cards side by side, with zero clipping and zero page scroll — no
// multiplier change needed.
//
// The column-separator rule (`border-l border-zinc-700/60 pl-3` on every
// column but the first, see the columns grid below) was added AFTER that
// measurement and eats ~13px (1px border + 12px padding) out of the content
// width of 2 of the 3 columns at the 3-column width. That tightens the
// horizontal ceiling at 1366x768 to roughly `((197 - 13) - 24) / 8.5` ≈
// 18.8px against the achieved ~17-18px — still positive but a noticeably
// thinner margin than before the divider (was ~2.6px, now roughly ~1-2px).
// Not yet re-measured live at 1366x768 with the divider in place; if a
// re-measure finds it too tight, drop the TV_COL_BODY multiplier slightly
// (e.g. 5.5 -> 5.2cqmin) rather than removing/shrinking the divider, since
// the divider is what makes multi-cycle cards legible as separate cycles at
// all.

const TV_TITLE = 'text-[clamp(1.5rem,6.7cqmin,3.5rem)]'
const TV_BODY = 'text-[clamp(1rem,3.4cqmin,2.25rem)]'
const TV_COL_BODY = 'text-[clamp(0.875rem,5.5cqmin,2rem)]'
const TV_COL_MILESTONE = 'text-[clamp(0.75rem,4.6cqmin,1.5rem)]'

/**
 * Max cycle COLUMNS rendered per tv card, and the threshold at which the
 * per-column milestone list is dropped entirely.
 *
 * Post-SPRO-83-fix, this is a WIDTH budget, not a height budget: columns lay
 * out across the card's fixed content height, so more cycles no longer risk
 * vertical clipping — they risk becoming too narrow to read. 5 columns is
 * kept as the cap (rooms run perpetual rotation, so 5 concurrent cycles is a
 * real state, not a hypothetical) but at 5 the milestone list — 5 lines of
 * text stacked in an already-narrow column — is dropped so the column isn't
 * forced skinnier still. 6+ is summarized by `+N more` instead of rendered,
 * same visible-overflow-not-silent-clipping principle as before.
 */
const TV_MAX_RENDERED_CYCLES = 5

// ─── Component ────────────────────────────────────────────────────────────────

export function RoomCard({
  room,
  activeCycles,
  allRooms,
  taskCounts,
  onStartCycle,
  onAdvanceStage,
  onEditCycle,
  onHistory,
  onEdit,
  onDelete,
  variant = 'default',
}: RoomCardProps) {
  const pairingLabel = getPairingLabel(room, allRooms)

  const tv = variant === 'tv'

  // tv: when a card has more cycles than fit, keep the operationally urgent
  // ones — order by stage progression (most advanced first) rather than
  // display order, so a late-stage (harvest/dry/trim) cycle is never the one
  // dropped in favor of an earlier-stage one. STAGE_ORDER already exists in
  // types/cultivation.ts, so reuse it instead of inventing a second
  // stage-priority list here. Unrecognized stage values sort last.
  const cyclesForTv = tv
    ? [...activeCycles].sort(
        (a, b) =>
          STAGE_ORDER.indexOf(b.current_stage as PipelineStage) -
          STAGE_ORDER.indexOf(a.current_stage as PipelineStage)
      )
    : activeCycles
  const renderedCycles = tv ? cyclesForTv.slice(0, TV_MAX_RENDERED_CYCLES) : activeCycles
  const hiddenCycleCount = tv ? Math.max(activeCycles.length - TV_MAX_RENDERED_CYCLES, 0) : 0
  // tv: milestone dates are the least glanceable detail on a wall display,
  // so they're the first thing shed once columns get too narrow to carry a
  // 5-line vertical list (see TV_MAX_RENDERED_CYCLES).
  const tvHideMilestones = tv && activeCycles.length >= TV_MAX_RENDERED_CYCLES

  return (
    // tv: `[container-type:size]` turns the card into a query container on
    // both axes — grid rows are `minmax(0, 1fr)` so the cell (and therefore
    // the card) always has a definite block size, which is what lets the
    // `cqmin`-based TV_TITLE/TV_BODY above scale safely off the card box
    // instead of guessing viewport size. Per-cycle text (TV_COL_BODY /
    // TV_COL_MILESTONE) is ALSO sized off this same card-level container —
    // the per-cycle columns below are deliberately NOT their own query
    // container, so their `cqmin` resolves up to this box, keeping text size
    // identical across cards regardless of cycle count (see the TV
    // typography comment block above).
    <Card
      className={
        tv ? 'border-zinc-700 bg-zinc-900 h-full flex flex-col min-h-0 [container-type:size]' : undefined
      }
    >
      {/* tv: header/content padding trimmed from the shadcn default (p-6) —
          that 24px-per-side default eats vertical budget a fixed-height
          kiosk card can't spare. */}
      <CardHeader className={tv ? 'pt-3 pb-2 px-4 shrink-0' : 'pb-3'}>
        <div className="flex items-center justify-between">
          <CardTitle className={tv ? `${TV_TITLE} font-bold` : 'text-base'}>
            {room.room_name}
            <span
              className={
                tv
                  ? `text-zinc-400 font-normal ${TV_BODY} ml-1`
                  : 'text-muted-foreground font-normal text-sm ml-1'
              }
            >
              #{room.room_number}
            </span>
          </CardTitle>
          <div className="flex items-center gap-1">
            {activeCycles.length > 0 && (
              <Badge variant="outline" className={tv ? TV_BODY : 'text-xs'}>
                {activeCycles.length} {activeCycles.length === 1 ? 'cycle' : 'cycles'}
              </Badge>
            )}
          </div>
        </div>
        {pairingLabel && (
          <p className={tv ? `${TV_BODY} text-zinc-400` : 'text-xs text-muted-foreground'}>
            {pairingLabel}
          </p>
        )}
      </CardHeader>

      <CardContent
        className={
          tv ? 'flex-1 min-h-0 overflow-hidden flex flex-col gap-2 px-4 pb-3' : 'space-y-3'
        }
      >
        {activeCycles.length === 0 ? (
          <p className={tv ? `${TV_BODY} text-zinc-400` : 'text-sm text-muted-foreground'}>
            No active cycle
          </p>
        ) : tv ? (
          <>
            {/* tv: cycles laid out as COLUMNS, not a vertical stack (SPRO-83
                fix). The old vertical stack made required card height grow
                with cycle count while the page grid gives every card a
                fixed-height cell — measured on the live board at 1512 wide,
                a 3-cycle card overflowed its cell below ~860px of viewport
                height (last-cycle-bottom vs. card-bottom: -8px @ 860,
                +18px @ 800, +55px @ 720). Laying cycles out side-by-side
                instead means required height is driven by ONE column's
                content, not N stacked blocks, so height is now
                (approximately) independent of cycle count — cycle count
                pressures width instead, which is the axis with slack.
                `flex-1 min-h-0` makes the row fill (not exceed) the
                remaining CardContent height; each column is top-aligned
                (default flex-col behavior). Columns are deliberately NOT
                their own `[container-type:size]` container — TV_COL_BODY /
                TV_COL_MILESTONE are sized off the CARD instead, so text size
                stays uniform across cards regardless of cycle count (see
                the TV typography comment block for why). */}
            <div
              className="flex-1 min-h-0 grid gap-3"
              style={{
                gridTemplateColumns: `repeat(${renderedCycles.length}, minmax(0, 1fr))`,
              }}
            >
              {renderedCycles.map((cycle, index) => {
                const progress = getDayProgress(cycle)
                const stageLabel = getCycleStageLabel(cycle.current_stage, cycle.flower_start)
                const hasMilestones =
                  cycle.dome_start ||
                  cycle.veg_start ||
                  cycle.flower_start ||
                  cycle.harvest_date ||
                  cycle.trim_start
                return (
                  // tv: a full-height left rule on every column except the
                  // first (SPRO-83 column-separator fix) — once dates sit
                  // flush against the column's right edge (see the
                  // label-left/date-right milestone rows below), a plain
                  // `gap-3` gutter alone reads as one continuous line across
                  // 3 cycles rather than 3 separate blocks. `pl-3` keeps
                  // this column's own text off the rule; the previous
                  // column's content already has the `gap-3` gutter as
                  // clearance on its side, so it doesn't also need a
                  // right-padding twin. Border color is a touch dimmer than
                  // the card's own `border-zinc-700` so it reads as a quiet
                  // divider, not another focal element.
                  <div
                    key={cycle.id}
                    className={`min-w-0 min-h-0 overflow-hidden flex flex-col gap-1 ${
                      index > 0 ? 'border-l border-zinc-700/60 pl-3' : ''
                    }`}
                  >
                    {/* flex-wrap, not justify-between-or-bust: at 5 columns
                        "Cycle #3" + a stage badge can be tighter than the
                        column is wide, and this must never overflow
                        horizontally. Wrapping the badge to its own line is a
                        CSS-only fallback that can't produce overflow,
                        without needing an exact per-count layout decision. */}
                    <div className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 ${TV_COL_BODY}`}>
                      <span className="text-zinc-400">
                        {cycle.cycle_number ? `Cycle #${cycle.cycle_number}` : 'Cycle'}
                      </span>
                      <Badge
                        className={`${PHASE_BADGE_CLASSES[cycle.current_stage] || 'bg-gray-500 text-white'} ${TV_COL_BODY}`}
                      >
                        {stageLabel}
                      </Badge>
                    </div>
                    <div className={`flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 ${TV_COL_BODY}`}>
                      <span className="text-zinc-400">Progress</span>
                      <span className="font-medium">
                        {progress ? `Day ${progress.current} of ${progress.total}` : '—'}
                      </span>
                    </div>
                    {progress && (
                      <div className="h-2 w-full rounded-full bg-muted overflow-hidden shrink-0">
                        <div
                          className={`h-full rounded-full ${PHASE_BADGE_CLASSES[cycle.current_stage]?.split(' ')[0] || 'bg-gray-500'}`}
                          style={{
                            width: `${Math.min((progress.current / progress.total) * 100, 100)}%`,
                          }}
                        />
                      </div>
                    )}
                    {hasMilestones && !tvHideMilestones && (
                      // tv: a vertical one-per-line list, not the old wrapped
                      // chip row — a column is narrow by construction, so a
                      // wrapped row of chips would wrap unpredictably and
                      // its height would stop being predictable per column.
                      // A vertical list's height is just "N lines", which is
                      // what makes the column budget plannable.
                      <div className={`flex flex-col gap-0.5 pt-0.5 ${TV_COL_MILESTONE} text-zinc-400 min-w-0`}>
                        {/* tv: label left / date right per line, not one
                            span — the date is the operationally load-bearing
                            half, so on a width crunch it's the label that
                            shrinks/ellipsizes (`truncate`), never the date
                            (`shrink-0 whitespace-nowrap`). */}
                        {cycle.dome_start && (
                          <div className="flex justify-between gap-2 min-w-0">
                            <span className="truncate">Dome</span>
                            <span className="shrink-0 whitespace-nowrap">
                              {format(parseLocalDate(cycle.dome_start), 'MMM d')}
                            </span>
                          </div>
                        )}
                        {cycle.veg_start && (
                          <div className="flex justify-between gap-2 min-w-0">
                            <span className="truncate">Veg</span>
                            <span className="shrink-0 whitespace-nowrap">
                              {format(parseLocalDate(cycle.veg_start), 'MMM d')}
                            </span>
                          </div>
                        )}
                        {cycle.flower_start && (
                          <div className="flex justify-between gap-2 min-w-0">
                            <span className="truncate">Flower</span>
                            <span className="shrink-0 whitespace-nowrap">
                              {format(parseLocalDate(cycle.flower_start), 'MMM d')}
                            </span>
                          </div>
                        )}
                        {cycle.harvest_date && (
                          <div className="flex justify-between gap-2 min-w-0">
                            <span className="truncate">Harvest</span>
                            <span className="shrink-0 whitespace-nowrap">
                              {format(parseLocalDate(cycle.harvest_date), 'MMM d')}
                            </span>
                          </div>
                        )}
                        {cycle.trim_start && (
                          <div className="flex justify-between gap-2 min-w-0">
                            <span className="truncate">Trim</span>
                            <span className="shrink-0 whitespace-nowrap">
                              {format(parseLocalDate(cycle.trim_start), 'MMM d')}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* tv: overflow must be visible and truthful, not silently
                swallowed by the card's overflow-hidden — see
                TV_MAX_RENDERED_CYCLES. */}
            {hiddenCycleCount > 0 && (
              <p className={`${TV_BODY} text-zinc-400 shrink-0`}>+{hiddenCycleCount} more</p>
            )}
          </>
        ) : (
          <>
            {/* All active cycles with milestone timelines */}
            {activeCycles.map((cycle) => {
              const progress = getDayProgress(cycle)
              const stageLabel = getCycleStageLabel(cycle.current_stage, cycle.flower_start)
              const hasMilestones =
                cycle.dome_start ||
                cycle.veg_start ||
                cycle.flower_start ||
                cycle.harvest_date ||
                cycle.trim_start
              return (
                <div key={cycle.id} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {cycle.cycle_number ? `Cycle #${cycle.cycle_number}` : 'Cycle'}
                    </span>
                    <Badge
                      className={`${PHASE_BADGE_CLASSES[cycle.current_stage] || 'bg-gray-500 text-white'} text-xs`}
                    >
                      {stageLabel}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Progress</span>
                    <span className="font-medium">
                      {progress ? `Day ${progress.current} of ${progress.total}` : '—'}
                    </span>
                  </div>
                  {progress && (
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full ${PHASE_BADGE_CLASSES[cycle.current_stage]?.split(' ')[0] || 'bg-gray-500'}`}
                        style={{
                          width: `${Math.min((progress.current / progress.total) * 100, 100)}%`,
                        }}
                      />
                    </div>
                  )}
                  {hasMilestones && (
                    <div className="flex flex-wrap justify-between gap-x-4 pt-1 text-[11px] text-muted-foreground">
                      <div className="flex flex-col leading-relaxed">
                        {cycle.dome_start && (
                          <span>Dome: {format(parseLocalDate(cycle.dome_start), 'MMM d')}</span>
                        )}
                        {cycle.veg_start && (
                          <span>Veg: {format(parseLocalDate(cycle.veg_start), 'MMM d')}</span>
                        )}
                        {cycle.flower_start && (
                          <span>
                            Flower: {format(parseLocalDate(cycle.flower_start), 'MMM d')}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-col leading-relaxed text-right">
                        {cycle.harvest_date && (
                          <span>
                            Harvest: {format(parseLocalDate(cycle.harvest_date), 'MMM d')}
                          </span>
                        )}
                        {cycle.trim_start && (
                          <span>Trim: {format(parseLocalDate(cycle.trim_start), 'MMM d')}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}

        {/* Task counts */}
        {taskCounts && (
          <p className={tv ? `${TV_BODY} text-zinc-400` : 'text-xs text-muted-foreground'}>
            {taskCounts.pending} pending
            {taskCounts.overdue > 0 && (
              <span className="text-red-500"> / {taskCounts.overdue} overdue</span>
            )}
          </p>
        )}

        {/* Notes — tv: no longer shed at a cycle-count threshold (removed
            TV_HIDE_NOTES_AT_CYCLES post-SPRO-83-fix). That threshold existed
            because notes sat below a vertical cycle stack whose height grew
            with cycle count, so at some count notes were exactly the
            overflow tipping point. Cycles are columns now — their row's
            height doesn't grow with cycle count — so there's no longer a
            cycle-count-correlated height pressure for notes to be shed
            against. `line-clamp-1` still caps its own worst case. */}
        {room.notes && (
          <p
            className={
              tv ? `${TV_BODY} text-zinc-400 line-clamp-1` : 'text-xs text-muted-foreground line-clamp-2'
            }
          >
            {room.notes}
          </p>
        )}

        {/* Action buttons — only rendered when callbacks are provided */}
        {(onStartCycle || onAdvanceStage || onEditCycle || onHistory || onEdit || onDelete) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {onStartCycle && (
              <Button variant="outline" size="sm" onClick={() => onStartCycle(room)}>
                <Play className="h-4 w-4 mr-1" />
                Start Cycle
              </Button>
            )}
            {onAdvanceStage && activeCycles.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => onAdvanceStage(room)}>
                <FastForward className="h-4 w-4 mr-1" />
                Advance Stage
              </Button>
            )}
            {onEditCycle && activeCycles.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => onEditCycle(room)}>
                <CalendarCog className="h-4 w-4 mr-1" />
                Edit Cycle
              </Button>
            )}
            {onHistory && (
              <Button variant="ghost" size="sm" onClick={() => onHistory(room)}>
                <History className="h-4 w-4 mr-1" />
                History
              </Button>
            )}
            {onEdit && (
              <Button variant="ghost" size="sm" onClick={() => onEdit(room)}>
                <Edit2 className="h-4 w-4 mr-1" />
                Edit Room
              </Button>
            )}
            {onDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => onDelete(room)}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                Remove
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
