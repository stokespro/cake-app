'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Play, FastForward, History, Edit2, CalendarCog, Trash2 } from 'lucide-react'
import { format } from 'date-fns'
import { parseLocalDate } from '@/lib/utils'
import { getDayProgress, getPairingLabel, PHASE_BADGE_CLASSES } from '@/lib/cultivation/helpers'
import type { GrowRoom, RoomCycle, GrowPhase } from '@/types/cultivation'
import { PHASE_CONFIG } from '@/types/cultivation'

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
  const phaseConfig = PHASE_CONFIG[room.current_phase]
  const pairingLabel = getPairingLabel(room, allRooms)

  const tv = variant === 'tv'

  return (
    <Card className={tv ? 'border-zinc-700 bg-zinc-900' : undefined}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className={tv ? 'text-2xl font-bold' : 'text-base'}>
            {room.room_name}
            <span
              className={
                tv
                  ? 'text-zinc-400 font-normal text-lg ml-1'
                  : 'text-muted-foreground font-normal text-sm ml-1'
              }
            >
              #{room.room_number}
            </span>
          </CardTitle>
          <div className="flex items-center gap-1">
            <Badge
              className={PHASE_BADGE_CLASSES[room.current_phase] || 'bg-gray-500 text-white'}
            >
              {phaseConfig?.label || room.current_phase}
            </Badge>
            {activeCycles.length > 1 && (
              <Badge variant="outline" className={tv ? 'text-base' : 'text-xs'}>
                {activeCycles.length} cycles
              </Badge>
            )}
          </div>
        </div>
        {pairingLabel && (
          <p className={tv ? 'text-base text-zinc-400' : 'text-xs text-muted-foreground'}>
            {pairingLabel}
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {room.current_phase === 'empty' && activeCycles.length === 0 ? (
          <p className={tv ? 'text-base text-zinc-400' : 'text-sm text-muted-foreground'}>
            No active cycle
          </p>
        ) : (
          <>
            {/* All active cycles with milestone timelines */}
            {activeCycles.map((cycle) => {
              const progress = getDayProgress(cycle)
              const stageConfig = PHASE_CONFIG[cycle.current_stage as GrowPhase]
              const hasMilestones =
                cycle.dome_start ||
                cycle.veg_start ||
                cycle.flower_start ||
                cycle.harvest_date ||
                cycle.trim_start
              return (
                <div key={cycle.id} className="space-y-1">
                  <div
                    className={`flex items-center justify-between ${tv ? 'text-base' : 'text-sm'}`}
                  >
                    <span className={tv ? 'text-zinc-400' : 'text-muted-foreground'}>
                      {cycle.cycle_number ? `Cycle #${cycle.cycle_number}` : 'Cycle'}
                    </span>
                    <Badge
                      className={`${PHASE_BADGE_CLASSES[cycle.current_stage] || 'bg-gray-500 text-white'} ${tv ? 'text-base' : 'text-xs'}`}
                    >
                      {stageConfig?.label || cycle.current_stage}
                    </Badge>
                  </div>
                  <div
                    className={`flex items-center justify-between ${tv ? 'text-base' : 'text-sm'}`}
                  >
                    <span className={tv ? 'text-zinc-400' : 'text-muted-foreground'}>
                      Progress
                    </span>
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
                    <div
                      className={`flex flex-wrap justify-between gap-x-4 pt-1 ${tv ? 'text-sm text-zinc-400' : 'text-[11px] text-muted-foreground'}`}
                    >
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
          <p className={tv ? 'text-base text-zinc-400' : 'text-xs text-muted-foreground'}>
            {taskCounts.pending} pending
            {taskCounts.overdue > 0 && (
              <span className="text-red-500"> / {taskCounts.overdue} overdue</span>
            )}
          </p>
        )}

        {/* Notes */}
        {room.notes && (
          <p
            className={
              tv
                ? 'text-base text-zinc-400 line-clamp-2'
                : 'text-xs text-muted-foreground line-clamp-2'
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
