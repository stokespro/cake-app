'use client'

import { useState } from 'react'
import { PackagePlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { CycleOption } from '@/actions/harvest-trim'
import { DeclareHarvestBatchesForm } from './declare-harvest-batches-form'

interface DeclareBatchesCardProps {
  cycle: CycleOption
  /** The cycle already has batches: collapse this behind a button. */
  collapsed: boolean
  onDeclared: () => void
}

/**
 * The same declare form the cultivation dialogs show at the harvest advance, available here for when
 * that step was skipped (or the strains changed). Declaring is idempotent per cycle, so using both
 * paths is safe.
 */
export function DeclareBatchesCard({ cycle, collapsed, onDeclared }: DeclareBatchesCardProps) {
  const [open, setOpen] = useState(!collapsed)

  if (!open) {
    return (
      <Button type="button" variant="outline" className="h-14 w-full" onClick={() => setOpen(true)}>
        <PackagePlus className="mr-2 h-4 w-4" />
        Declare batches for this room
      </Button>
    )
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <DeclareHarvestBatchesForm
          cycleId={cycle.id}
          roomNumber={cycle.roomNumber}
          harvestDate={cycle.harvestDate}
          skipLabel="Close"
          onDone={(outcome) => {
            if (outcome.kind === 'declared') {
              toast.success(
                `${outcome.names.length} ${outcome.names.length === 1 ? 'batch' : 'batches'} declared`
              )
              onDeclared()
            }
            setOpen(false)
          }}
        />
      </CardContent>
    </Card>
  )
}
