'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/lib/auth-context'
import {
  getOrderCustomers,
  getActiveSkus,
  getOrderCustomerPricing,
  createOrderFromSheet,
  updateOrderFromSheet,
} from '@/actions/orders'
import type { CustomerBasicRecord, OrderSkuRecord, CustomerPricingRecord } from '@/actions/orders'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
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
import { SkuCombobox } from '@/components/orders/sku-combobox'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { Loader2, Plus, Trash2, Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Order } from '@/types/database'

// Use types from the server actions layer
type CustomerPricingData = CustomerPricingRecord
type SkuOption = OrderSkuRecord

interface OrderItem {
  sku_id: string
  sku_code: string
  sku_name: string
  cases: number              // number of cases ordered
  units_per_case: number     // units per case for this SKU
  quantity: number           // total units (cases * units_per_case)
  unit_price: number | null  // null means manual entry required
  line_total: number         // total price (quantity * unit_price)
}

interface OrderSheetProps {
  open: boolean
  onClose: () => void
  customerId?: string
  onSuccess: () => void
  order?: Order // Optional prop for edit mode
}

export function OrderSheet({ open, onClose, customerId, onSuccess, order }: OrderSheetProps) {
  const [customers, setCustomers] = useState<CustomerBasicRecord[]>([])
  const [skus, setSkus] = useState<SkuOption[]>([])
  const [customerPricing, setCustomerPricing] = useState<CustomerPricingData[]>([])
  const [selectedCustomerId, setSelectedCustomerId] = useState(customerId || order?.customer_id || '')
  const [orderItems, setOrderItems] = useState<OrderItem[]>([])
  const [orderNotes, setOrderNotes] = useState(order?.order_notes || '')
  const [requestedDeliveryDate, setRequestedDeliveryDate] = useState(order?.requested_delivery_date || '')
  const [deliveredAt, setDeliveredAt] = useState(order?.delivered_at?.split('T')[0] || '')
  const [paymentTerms, setPaymentTerms] = useState(order?.payment_terms ?? false)
  const [termsPaymentDate, setTermsPaymentDate] = useState(order?.terms_payment_date || '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [customerOpen, setCustomerOpen] = useState(false)
  const [showAllCustomers, setShowAllCustomers] = useState(false)
  const { user } = useAuth()

  // Fetch customer pricing when customer changes
  const fetchCustomerPricing = useCallback(async (custId: string) => {
    if (!custId) {
      setCustomerPricing([])
      return
    }

    const result = await getOrderCustomerPricing(custId)
    if (result.error) {
      console.error('Error fetching customer pricing:', result.error)
      setCustomerPricing([])
      return
    }
    setCustomerPricing(result.data!)
  }, [])

  // Get price for a SKU based on customer pricing rules
  // Priority: item price > category price > null (manual)
  const getPriceForSku = useCallback((skuId: string): number | null => {
    // Check for item-specific price
    const itemPrice = customerPricing.find(p => p.sku_id === skuId)
    if (itemPrice) {
      return itemPrice.price_per_unit
    }

    // Check for category price
    const sku = skus.find(s => s.id === skuId)
    if (sku?.product_type_id) {
      const categoryPrice = customerPricing.find(p => p.product_type_id === sku.product_type_id)
      if (categoryPrice) {
        return categoryPrice.price_per_unit
      }
    }

    // No pricing found
    return null
  }, [customerPricing, skus])

  useEffect(() => {
    if (open) {
      fetchCustomers()
      fetchSkus()

      // Initialize form with existing order data or defaults
      if (order) {
        // Edit mode - populate with existing order data
        setSelectedCustomerId(order.customer_id)
        setOrderNotes(order.order_notes || '')
        setRequestedDeliveryDate(order.requested_delivery_date || '')
        setDeliveredAt(order.delivered_at?.split('T')[0] || '')
        setPaymentTerms(order.payment_terms ?? false)
        setTermsPaymentDate(order.terms_payment_date || '')
        fetchCustomerPricing(order.customer_id)

        // Order items will be loaded in separate useEffect after skus are loaded
      } else {
        // Create mode - set defaults
        const defaultDate = new Date()
        defaultDate.setDate(defaultDate.getDate() + 7)
        setRequestedDeliveryDate(defaultDate.toISOString().split('T')[0])

        // Set customer if provided
        if (customerId) {
          setSelectedCustomerId(customerId)
          fetchCustomerPricing(customerId)
        }
      }
    }
  }, [open, customerId, order, fetchCustomerPricing])

  // Fetch pricing when customer changes
  useEffect(() => {
    if (selectedCustomerId && open) {
      fetchCustomerPricing(selectedCustomerId)
    }
  }, [selectedCustomerId, open, fetchCustomerPricing])

  // Update prices when pricing data changes
  useEffect(() => {
    if (customerPricing.length > 0 && orderItems.length > 0) {
      setOrderItems(prev => prev.map(item => {
        const newPrice = getPriceForSku(item.sku_id)
        return {
          ...item,
          unit_price: newPrice,
          line_total: newPrice !== null ? item.quantity * newPrice : 0
        }
      }))
    }
  }, [customerPricing, getPriceForSku])

  // Load order items when skus are loaded (for edit mode)
  useEffect(() => {
    if (order && order.order_items && skus.length > 0 && orderItems.length === 0) {
      const formOrderItems = order.order_items.map(item => {
        const sku = skus.find(s => s.id === item.sku_id)
        const unitsPerCase = sku?.units_per_case || 32
        // DB stores cases in quantity field, not units
        const cases = item.quantity
        const totalUnits = cases * unitsPerCase
        const unitPrice = item.unit_price ?? getPriceForSku(item.sku_id)
        const lineTotal = unitPrice !== null ? totalUnits * unitPrice : 0

        return {
          sku_id: item.sku_id,
          sku_code: sku?.code || '',
          sku_name: sku?.name || 'Unknown SKU',
          cases: cases,
          units_per_case: unitsPerCase,
          quantity: totalUnits,  // Total units for UI display and pricing
          unit_price: unitPrice,
          line_total: lineTotal
        }
      })
      setOrderItems(formOrderItems)
    }
  }, [skus, order, getPriceForSku])

  // Reset form when sheet closes
  useEffect(() => {
    if (!open) {
      setSelectedCustomerId(customerId || '')
      setOrderItems([])
      setOrderNotes('')
      setDeliveredAt('')
      setPaymentTerms(false)
      setTermsPaymentDate('')
      setError(null)
      setCustomerPricing([])
      const defaultDate = new Date()
      defaultDate.setDate(defaultDate.getDate() + 7)
      setRequestedDeliveryDate(defaultDate.toISOString().split('T')[0])
    }
  }, [open, customerId])

  const fetchCustomers = async () => {
    const result = await getOrderCustomers()
    if (result.error) {
      console.error('Error fetching customers:', result.error)
      return
    }
    setCustomers(result.data!)
  }

  const fetchSkus = async () => {
    const result = await getActiveSkus(true)
    if (result.error) {
      console.error('Error fetching skus:', result.error)
      return
    }
    setSkus(result.data!)
  }

  const addOrderItem = () => {
    if (skus.length === 0) return

    const firstSku = skus[0]
    const price = getPriceForSku(firstSku.id)
    const unitsPerCase = firstSku.units_per_case || 32
    const cases = 1
    const quantity = cases * unitsPerCase
    const lineTotal = price !== null ? quantity * price : 0

    setOrderItems([
      ...orderItems,
      {
        sku_id: firstSku.id,
        sku_code: firstSku.code,
        sku_name: firstSku.name,
        cases: cases,
        units_per_case: unitsPerCase,
        quantity: quantity,
        unit_price: price,
        line_total: lineTotal
      }
    ])
  }

  const updateOrderItem = (index: number, field: keyof OrderItem, value: string | number | null) => {
    const updated = [...orderItems]
    updated[index] = { ...updated[index], [field]: value }

    if (field === 'sku_id') {
      // SKU changed - update all related fields
      const sku = skus.find(s => s.id === value)
      if (sku) {
        updated[index].sku_code = sku.code
        updated[index].sku_name = sku.name
        updated[index].units_per_case = sku.units_per_case || 32
        updated[index].unit_price = getPriceForSku(sku.id)
        // Recalculate quantity and line_total based on current cases
        updated[index].quantity = updated[index].cases * updated[index].units_per_case
        updated[index].line_total = updated[index].unit_price !== null
          ? updated[index].quantity * updated[index].unit_price
          : 0
      }
    } else if (field === 'cases') {
      // Cases changed - recalculate quantity and line_total
      const cases = value as number
      updated[index].quantity = cases * updated[index].units_per_case
      updated[index].line_total = updated[index].unit_price !== null
        ? updated[index].quantity * updated[index].unit_price
        : 0
    } else if (field === 'unit_price') {
      // Unit price changed - recalculate line_total
      const price = value as number | null
      updated[index].line_total = price !== null
        ? updated[index].quantity * price
        : 0
    }

    setOrderItems(updated)
  }

  const removeOrderItem = (index: number) => {
    setOrderItems(orderItems.filter((_, i) => i !== index))
  }

  // Calculate order total
  const orderTotal = orderItems.reduce((sum, item) => sum + item.line_total, 0)

  const hasUnpricedItems = orderItems.some(item => item.unit_price === null)

  const validateForm = () => {
    if (!selectedCustomerId) {
      setError('Please select a customer')
      return false
    }

    if (orderItems.length === 0) {
      setError('Please add at least one item to the order')
      return false
    }

    if (!requestedDeliveryDate) {
      setError('Please select a requested delivery date')
      return false
    }

    if (paymentTerms && !termsPaymentDate) {
      setError('Payment expected date is required for terms orders')
      return false
    }

    // Validate each order item
    for (let i = 0; i < orderItems.length; i++) {
      const item = orderItems[i]

      if (!item.sku_id) {
        setError(`Please select a SKU for item ${i + 1}`)
        return false
      }

      if (!item.quantity || item.quantity <= 0) {
        setError(`Please enter a valid quantity greater than 0 for item ${i + 1}`)
        return false
      }

      if (item.unit_price === null || item.unit_price <= 0) {
        setError(`Please enter a valid price for item ${i + 1} (${item.sku_name})`)
        return false
      }
    }

    return true
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!user?.id) {
      toast.error('Not authenticated. Please log in again.')
      return
    }

    if (!validateForm()) {
      return
    }

    setLoading(true)

    try {
      const isEditMode = !!order

      const items = orderItems.map(item => {
        const unitPrice = item.unit_price ?? 0
        const lineTotal = item.quantity * unitPrice  // quantity = total units for pricing
        return {
          sku_id: item.sku_id,
          cases: item.cases,        // store cases, not units
          unit_price: unitPrice,
          line_total: Number.isFinite(lineTotal) ? lineTotal : 0,
        }
      })

      let result: { error?: string }

      if (isEditMode) {
        result = await updateOrderFromSheet(order.id, {
          customer_id: selectedCustomerId,
          order_notes: orderNotes || null,
          requested_delivery_date: requestedDeliveryDate,
          delivered_at: deliveredAt || null,
          total_price: orderTotal,
          items,
          payment_terms: paymentTerms,
          terms_payment_date: paymentTerms ? (termsPaymentDate || null) : null,
        })
      } else {
        result = await createOrderFromSheet({
          customer_id: selectedCustomerId,
          order_notes: orderNotes || null,
          requested_delivery_date: requestedDeliveryDate,
          total_price: orderTotal,
          items,
          payment_terms: paymentTerms,
          terms_payment_date: paymentTerms ? (termsPaymentDate || null) : null,
        })
      }

      if (result.error) {
        const action = isEditMode ? 'updating' : 'creating'
        throw new Error(result.error || `An unexpected error occurred while ${action} the order`)
      }

      // Call success callback and close sheet
      onSuccess()
      onClose()
    } catch (error) {
      console.error('Error in handleSubmit:', error)
      const action = order ? 'updating' : 'creating'
      setError(error instanceof Error ? error.message : `An unexpected error occurred while ${action} the order`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="sm:max-w-[700px] w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{order ? 'Edit Order' : 'Create New Order'}</SheetTitle>
          <SheetDescription>
            {order ? 'Update an existing order' : 'Submit a new order for a customer'}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="space-y-6 mt-6">
          {error && (
            <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">
              {error}
            </div>
          )}

          {/* Order Details */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium">Order Details</h3>

            <div className="grid grid-cols-1 gap-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="customer">Customer *</Label>
                  {!customerId && !order && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Show inactive</span>
                      <Switch
                        checked={showAllCustomers}
                        onCheckedChange={setShowAllCustomers}
                        className="scale-75"
                      />
                    </div>
                  )}
                </div>
                <Popover open={customerOpen} onOpenChange={setCustomerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={customerOpen}
                      className="w-full justify-between font-normal"
                      disabled={!!customerId || !!order}
                    >
                      {selectedCustomerId
                        ? customers.find((c) => c.id === selectedCustomerId)?.business_name
                        : "Select a customer..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command filter={(value, search) => {
                      const valueLower = value.toLowerCase()
                      const searchTerms = search.toLowerCase().split(' ').filter(Boolean)
                      return searchTerms.every(term => valueLower.includes(term)) ? 1 : 0
                    }}>
                      <CommandInput placeholder="Search customers..." />
                      <CommandList>
                        <CommandEmpty>No customer found.</CommandEmpty>
                        <CommandGroup>
                          {customers
                            .filter((customer) => showAllCustomers || customer.is_active !== false)
                            .map((customer) => (
                            <CommandItem
                              key={customer.id}
                              value={`${customer.business_name} ${customer.license_name || ''} ${customer.omma_license || ''} ${customer.city || ''}`}
                              onSelect={() => {
                                setSelectedCustomerId(customer.id)
                                setCustomerOpen(false)
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  selectedCustomerId === customer.id ? "opacity-100" : "opacity-0"
                                )}
                              />
                              <div className="flex flex-col">
                                <span>
                                  {customer.business_name}
                                  {customer.is_active === false && (
                                    <span className="ml-2 text-xs text-muted-foreground">(Inactive)</span>
                                  )}
                                </span>
                                {(customer.license_name || customer.city) && (
                                  <span className="text-xs text-muted-foreground">
                                    {[customer.license_name, customer.city].filter(Boolean).join(' • ')}
                                  </span>
                                )}
                              </div>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <Label htmlFor="deliveryDate">Requested Delivery Date *</Label>
                <Input
                  id="deliveryDate"
                  type="date"
                  value={requestedDeliveryDate}
                  onChange={(e) => setRequestedDeliveryDate(e.target.value)}
                  required
                  disabled={loading}
                />
              </div>

              {/* Payment Terms */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="paymentTerms">Payment Terms</Label>
                  <Switch
                    id="paymentTerms"
                    checked={paymentTerms}
                    onCheckedChange={(checked) => {
                      setPaymentTerms(checked)
                      if (!checked) setTermsPaymentDate('')
                    }}
                    disabled={loading}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Enable if this customer pays after delivery. Revenue defers to payment date.
                </p>
              </div>

              {paymentTerms && (
                <div className="space-y-2">
                  <Label htmlFor="termsPaymentDate">Payment Expected *</Label>
                  <Input
                    id="termsPaymentDate"
                    type="date"
                    value={termsPaymentDate}
                    onChange={(e) => setTermsPaymentDate(e.target.value)}
                    required
                    disabled={loading}
                  />
                </div>
              )}

              {order && (
                <div className="space-y-2">
                  <Label htmlFor="deliveredAt">Delivered Date</Label>
                  <Input
                    id="deliveredAt"
                    type="date"
                    value={deliveredAt}
                    onChange={(e) => setDeliveredAt(e.target.value)}
                    disabled={loading}
                  />
                  <p className="text-xs text-muted-foreground">
                    Date order was delivered — controls which month revenue is attributed to.
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Order Notes</Label>
              <Textarea
                id="notes"
                placeholder="Special instructions, delivery notes, etc..."
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
                rows={3}
                disabled={loading}
                className="resize-none"
              />
            </div>
          </div>

          {/* Order Items */}
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-medium">Order Items</h3>
              <Button
                type="button"
                size="sm"
                onClick={addOrderItem}
                disabled={skus.length === 0 || loading}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Item
              </Button>
            </div>

            {orderItems.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground border border-dashed rounded-lg">
                No items added yet. Click &ldquo;Add Item&rdquo; to start.
              </div>
            ) : (
              <div className="space-y-3">
                {orderItems.map((item, index) => (
                  <div key={index} className="p-3 border rounded-lg bg-muted/50 space-y-2">
                    {/* SKU Selection Row */}
                    <div className="flex items-center gap-2">
                      <SkuCombobox
                        skus={skus}
                        value={item.sku_id}
                        onChange={(value) => updateOrderItem(index, 'sku_id', value)}
                        disabled={loading}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeOrderItem(index)}
                        disabled={loading}
                        className="h-8 w-8 shrink-0"
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                    {/* Cases, Unit Price, Total Row */}
                    <div className="flex items-center gap-2 text-sm">
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          min="1"
                          value={item.cases}
                          onChange={(e) => updateOrderItem(index, 'cases', parseInt(e.target.value) || 1)}
                          disabled={loading}
                          className="w-16 h-8"
                        />
                        <span className="text-muted-foreground whitespace-nowrap">
                          cases ({item.quantity} units)
                        </span>
                      </div>
                      <span className="text-muted-foreground">×</span>
                      <div className="flex items-center gap-1">
                        <span className="text-muted-foreground">$</span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={item.unit_price ?? ''}
                          onChange={(e) => {
                            const parsed = parseFloat(e.target.value)
                            updateOrderItem(index, 'unit_price', Number.isFinite(parsed) ? parsed : null)
                          }}
                          disabled={loading}
                          className={`w-20 h-8 ${item.unit_price === null ? 'border-amber-400' : ''}`}
                        />
                        <span className="text-muted-foreground">/unit</span>
                      </div>
                      <span className="text-muted-foreground">=</span>
                      <span className="font-semibold whitespace-nowrap">
                        {item.unit_price !== null ? `$${item.line_total.toFixed(2)}` : '-'}
                      </span>
                    </div>
                  </div>
                ))}

                <div className="flex justify-center pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addOrderItem}
                    disabled={skus.length === 0 || loading}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add Item
                  </Button>
                </div>

                {/* Order Total */}
                <div className="flex justify-end items-center gap-4 pt-3 border-t">
                  <span className="text-sm text-muted-foreground">Order Total:</span>
                  <span className="text-lg font-bold">
                    {hasUnpricedItems ? (
                      <span className="text-amber-600">Incomplete pricing</span>
                    ) : (
                      `$${orderTotal.toFixed(2)}`
                    )}
                  </span>
                </div>
              </div>
            )}

            {hasUnpricedItems && (
              <p className="text-sm text-amber-600">
                Some items need pricing. Enter prices manually or set up customer pricing defaults.
              </p>
            )}
          </div>

          <SheetFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={loading || !selectedCustomerId || orderItems.length === 0 || !requestedDeliveryDate}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {order ? 'Updating...' : 'Creating...'}
                </>
              ) : (
                order ? 'Update Order' : 'Create Order'
              )}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
