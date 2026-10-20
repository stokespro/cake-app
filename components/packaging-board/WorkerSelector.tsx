'use client'

import { cn } from '@/lib/utils'

interface WorkerSelectorProps {
  // Structural so PackagingUser, trim staff, etc. all satisfy it.
  users: { id: string; name: string }[]
  selectedId: string | null
  onSelect: (userId: string, userName: string) => void
  /** Prompt shown above the buttons. Defaults to the packaging board wording. */
  label?: string
}

export function WorkerSelector({
  users,
  selectedId,
  onSelect,
  label = 'Who is doing this?',
}: WorkerSelectorProps) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {users.map((user) => {
          const isSelected = user.id === selectedId
          return (
            <button
              key={user.id}
              type="button"
              onClick={() => onSelect(user.id, user.name)}
              className={cn(
                'h-14 rounded-lg border-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isSelected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background hover:border-primary/60 hover:bg-muted'
              )}
            >
              {user.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}
