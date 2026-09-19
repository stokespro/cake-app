'use client'

// SPRO-148: the order-level discount/credit controls and the read-only
// breakdown, shared by all three order surfaces so the three stay identical:
//   - /dashboard/orders/new            (create)
//   - components/orders/order-sheet    (dispensary Orders tab, create + edit)
//   - /dashboard/orders edit sheet     (main orders list)
//
// All money rules live in lib/orders/deductions.ts — this file only holds the
// draft state (strings, as typed) and the markup. The server revalidates
// everything on submit; nothing here is a trust boundary.

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  MAX_DEDUCTION_REASON_LENGTH,
  breakdownFromOrder,
  calculateOrderTotals,
  hasOrderDeductions,
  normalizeDeduction,
  validateOrderDeductions,
  type DeductionInput,
  type OrderDeductionFields,
} from '@/lib/orders/deductions'
import { BadgePercent, HandCoins, X } from 'lucide-react'

/** One deduction as the user is typing it. `null` means the control is not applied. */
export interface DeductionDraft {
  amount: string
  reason: string
}

/** Draft state for both deductions on an order. At most one of each. */
export interface OrderDeductionsValue {
  discount: DeductionDraft | null
  credit: DeductionDraft | null
}

/** Neither deduction applied — the state for a brand-new order. */
export const EMPTY_ORDER_DEDUCTIONS: OrderDeductionsValue = { discount: null, credit: null }

const EMPTY_DRAFT: DeductionDraft = { amount: '', reason: '' }

/**
 * Seeds the controls from an order that already has deductions persisted, so
 * an edit preserves them unless the user changes or removes them. An absent
 * pair stays absent (control collapsed).
 */
export function deductionsFromOrder(
  order: Partial<OrderDeductionFields> | null | undefined
): OrderDeductionsValue {
  if (!order) return EMPTY_ORDER_DEDUCTIONS
  return {
    discount:
      typeof order.discount_amount === 'number'
        ? { amount: String(order.discount_amount), reason: order.discount_reason ?? '' }
        : null,
    credit:
      typeof order.credit_amount === 'number'
        ? { amount: String(order.credit_amount), reason: order.credit_reason ?? '' }
        : null,
  }
}

/** Converts a draft to the server-action payload shape. A collapsed control sends null. */
export function toDeductionInput(draft: DeductionDraft | null): DeductionInput | null {
  if (!draft) return null
  return { amount: draft.amount, reason: draft.reason }
}

/** Client-side mirror of the server check. Returns an error message, or null. */
export function validateOrderDeductionsValue(
  value: OrderDeductionsValue,
  subtotal: number
): string | null {
  const result = validateOrderDeductions({
    subtotal,
    discount: toDeductionInput(value.discount),
    credit: toDeductionInput(value.credit),
  })
  return result.ok ? null : result.error
}

/** Live money breakdown for the draft state — deductions only count once numeric. */
export function previewOrderTotals(value: OrderDeductionsValue, subtotal: number) {
  const numericAmount = (draft: DeductionDraft | null): number | null => {
    const { amount } = normalizeDeduction(toDeductionInput(draft) ?? undefined)
    return amount !== null && Number.isFinite(amount) && amount > 0 ? amount : null
  }

  return calculateOrderTotals(subtotal, {
    discount_amount: numericAmount(value.discount),
    discount_reason: null,
    credit_amount: numericAmount(value.credit),
    credit_reason: null,
  })
}

const CONFIG = {
  discount: {
    label: 'Discount',
    applyLabel: 'Apply discount',
    reasonPlaceholder: 'Reason (e.g. volume deal)',
    Icon: BadgePercent,
  },
  credit: {
    label: 'Credit',
    applyLabel: 'Apply credit',
    reasonPlaceholder: 'Reason (e.g. damaged case)',
    Icon: HandCoins,
  },
} as const

type DeductionRowProps = {
  kind: 'discount' | 'credit'
  draft: DeductionDraft | null
  disabled?: boolean
  idPrefix: string
  onApply: () => void
  onRemove: () => void
  onChange: (draft: DeductionDraft) => void
}

function DeductionRow({ kind, draft, disabled, idPrefix, onApply, onRemove, onChange }: DeductionRowProps) {
  const { label, applyLabel, reasonPlaceholder, Icon } = CONFIG[kind]

  if (!draft) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={onApply} disabled={disabled}>
        <Icon className="mr-2 h-4 w-4" />
        {applyLabel}
      </Button>
    )
  }

  return (
    <div className="w-full rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={`${idPrefix}-${kind}-amount`} className="flex items-center gap-2 text-sm font-medium">
          <Icon className="h-4 w-4" />
          {label}
        </Label>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${kind}`}
        >
          <X className="h-4 w-4 text-red-500" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative w-28 shrink-0">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
          <Input
            id={`${idPrefix}-${kind}-amount`}
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={draft.amount}
            onChange={(e) => onChange({ ...draft, amount: e.target.value })}
            disabled={disabled}
            className="h-9 pl-6"
            placeholder="0.00"
          />
        </div>
        <Input
          id={`${idPrefix}-${kind}-reason`}
          value={draft.reason}
          onChange={(e) => onChange({ ...draft, reason: e.target.value })}
          disabled={disabled}
          maxLength={MAX_DEDUCTION_REASON_LENGTH}
          className="h-9 flex-1"
          placeholder={reasonPlaceholder}
          aria-label={`${label} reason`}
          required
        />
      </div>
    </div>
  )
}

export interface OrderDeductionsProps {
  value: OrderDeductionsValue
  onChange: (value: OrderDeductionsValue) => void
  /** Active line-item subtotal, before deductions. */
  subtotal: number
  disabled?: boolean
  /** Disambiguates input ids when two instances can be mounted at once. */
  idPrefix?: string
  /** Hides the subtotal/net-total rows when the caller renders its own total. */
  showTotals?: boolean
}

/**
 * Apply/reveal/remove controls plus the live
 * subtotal / deductions / net-total breakdown, sitting under the order totals.
 */
export function OrderDeductions({
  value,
  onChange,
  subtotal,
  disabled,
  idPrefix = 'order',
  showTotals = true,
}: OrderDeductionsProps) {
  const totals = previewOrderTotals(value, subtotal)
  const error = validateOrderDeductionsValue(value, subtotal)

  return (
    <div className="space-y-3 pt-3 border-t">
      <div className="flex flex-wrap items-center gap-2">
        <DeductionRow
          kind="discount"
          draft={value.discount}
          disabled={disabled}
          idPrefix={idPrefix}
          onApply={() => onChange({ ...value, discount: { ...EMPTY_DRAFT } })}
          onRemove={() => onChange({ ...value, discount: null })}
          onChange={(discount) => onChange({ ...value, discount })}
        />
        <DeductionRow
          kind="credit"
          draft={value.credit}
          disabled={disabled}
          idPrefix={idPrefix}
          onApply={() => onChange({ ...value, credit: { ...EMPTY_DRAFT } })}
          onRemove={() => onChange({ ...value, credit: null })}
          onChange={(credit) => onChange({ ...value, credit })}
        />
      </div>

      {showTotals && (
        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span>${totals.subtotal.toFixed(2)}</span>
          </div>
          {totals.discount > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>Discount</span>
              <span>−${totals.discount.toFixed(2)}</span>
            </div>
          )}
          {totals.credit > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>Credit</span>
              <span>−${totals.credit.toFixed(2)}</span>
            </div>
          )}
          <div className="flex justify-between pt-1 border-t font-semibold">
            <span>Order Total</span>
            <span className="text-lg">${totals.netTotal.toFixed(2)}</span>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  )
}

/**
 * Read-only breakdown for detail views. Renders nothing unless the order
 * actually carries a deduction, so untouched orders look exactly as before.
 */
export function OrderDeductionBreakdown({
  order,
  className,
  showTotal = false,
}: {
  order: {
    total_price?: number | null
    discount_amount?: number | null
    discount_reason?: string | null
    credit_amount?: number | null
    credit_reason?: string | null
  }
  className?: string
  /** Appends the net-total row — for callers that don't already render one. */
  showTotal?: boolean
}) {
  if (!hasOrderDeductions(order)) return null

  const totals = breakdownFromOrder(order)

  return (
    <div className={className}>
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">Subtotal</span>
        <span>${totals.subtotal.toFixed(2)}</span>
      </div>
      {totals.discount > 0 && (
        <div className="flex justify-between gap-4 text-sm">
          <span className="text-muted-foreground">
            Discount
            {order.discount_reason ? (
              <span className="block text-xs italic">{order.discount_reason}</span>
            ) : null}
          </span>
          <span className="whitespace-nowrap">−${totals.discount.toFixed(2)}</span>
        </div>
      )}
      {totals.credit > 0 && (
        <div className="flex justify-between gap-4 text-sm">
          <span className="text-muted-foreground">
            Credit
            {order.credit_reason ? (
              <span className="block text-xs italic">{order.credit_reason}</span>
            ) : null}
          </span>
          <span className="whitespace-nowrap">−${totals.credit.toFixed(2)}</span>
        </div>
      )}
      {showTotal && (
        <div className="flex justify-between pt-1 border-t text-sm font-semibold">
          <span>Total</span>
          <span>${totals.netTotal.toFixed(2)}</span>
        </div>
      )}
    </div>
  )
}
