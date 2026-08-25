'use client'

import { useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SkuLike {
  id: string
  code: string
  name: string
  units_per_case?: number | null
  in_stock?: boolean
}

interface SkuComboboxProps<T extends SkuLike> {
  skus: T[]
  value: string
  onChange: (skuId: string) => void
  disabled?: boolean
  className?: string
  showUnitsPerCase?: boolean
  showOutOfStock?: boolean
}

export function SkuCombobox<T extends SkuLike>({
  skus,
  value,
  onChange,
  disabled = false,
  className,
  showUnitsPerCase = false,
  showOutOfStock = false,
}: SkuComboboxProps<T>) {
  const [open, setOpen] = useState(false)

  const selectedSku = skus.find((s) => s.id === value)

  const getLabel = (sku: T) => {
    const base = showUnitsPerCase
      ? `${sku.code} - ${sku.name} (${sku.units_per_case || 32}/case)`
      : `${sku.code} - ${sku.name}`
    return showOutOfStock && !sku.in_stock ? `${base} — Out of Stock` : base
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('w-full min-w-0 justify-between overflow-hidden font-normal', className)}
        >
          <span className="truncate text-left">
            {selectedSku ? getLabel(selectedSku) : 'Select SKU...'}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command
          filter={(value, search) => {
            const valueLower = value.toLowerCase()
            const searchTerms = search.toLowerCase().split(' ').filter(Boolean)
            return searchTerms.every((term) => valueLower.includes(term)) ? 1 : 0
          }}
        >
          <CommandInput placeholder="Search SKUs..." />
          <CommandList>
            <CommandEmpty>No SKU found.</CommandEmpty>
            <CommandGroup>
              {skus.map((sku) => {
                const outOfStock = showOutOfStock && !sku.in_stock
                return (
                  <CommandItem
                    key={sku.id}
                    value={`${sku.code} ${sku.name}`}
                    disabled={outOfStock}
                    className={outOfStock ? 'text-muted-foreground opacity-50' : ''}
                    onSelect={() => {
                      onChange(sku.id)
                      setOpen(false)
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 h-4 w-4',
                        value === sku.id ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    {getLabel(sku)}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
