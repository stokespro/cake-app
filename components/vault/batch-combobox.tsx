'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { Check, ChevronsUpDown } from 'lucide-react'
import type { Batch } from '@/types/vault'

interface BatchComboboxProps {
  batches: Batch[]
  value: string
  onChange: (batchId: string) => void
  placeholder?: string
}

export function BatchCombobox({
  batches,
  value,
  onChange,
  placeholder = 'Select batch...',
}: BatchComboboxProps) {
  const [open, setOpen] = useState(false)
  const selected = batches.find((b) => b.id === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          {selected
            ? `${selected.name} (${selected.strain?.name || 'No strain'})`
            : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search batches..." />
          <CommandList>
            <CommandEmpty>No batch found.</CommandEmpty>
            <CommandGroup>
              {batches.map((batch) => (
                <CommandItem
                  key={batch.id}
                  value={`${batch.name} ${batch.strain?.name || ''}`}
                  onSelect={() => {
                    onChange(batch.id)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === batch.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {batch.name} ({batch.strain?.name || 'No strain'})
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
