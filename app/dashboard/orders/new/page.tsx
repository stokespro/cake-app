'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/lib/auth-context'
import {
  getOrderCustomers,
  getActiveSkus,
  getOrderCustomerPricing,
  createOrder,
} from '@/actions/orders'
import type { CustomerBasicRecord, OrderSkuRecord, CustomerPricingRecord } from '@/actions/orders'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { ArrowLeft, Loader2, Plus, Trash2, DollarSign, Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
// Use types from the server actions layer
type Customer = CustomerBasicRecord
type SKU = OrderSkuRecord
type CustomerPricingData = CustomerPricingRecord

interface OrderItem {
  sku_id: string
  sku_code: string
  sku_name: string
  cases: number // number of cases
  units_per_case: number // units per case for this SKU
  quantity: number // total units (cases * units_per_case)
  unit_price: number
  line_total: number
}

export default function NewOrderPage() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [skus, setSkus] = useState<SKU[]>([])
  const [customerId, setCustomerId] = useState('')
  const [customerPricing, setCustomerPricing] = useState<CustomerPricingData[]>([])
  const [orderItems, setOrderItems] = useState<OrderItem[]>([])
  const [orderNotes, setOrderNotes] = useState('')
  const [requestedDeliveryDate, setRequestedDeliveryDate] = useState('')
  const [orderDate, setOrderDate] = useState('')
  const [totalPrice, setTotalPrice] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [customerOpen, setCustomerOpen] = useState(false)
  const router = useRouter()
  const { user } = useAuth()

  useEffect(() => {
    fetchCustomers()
    fetchSKUs()
    // Set default order date to today
    const today = new Date()
    setOrderDate(today.toISOString().split('T')[0])
    // Set default delivery date to 7 days from now
    const defaultDate = new Date()
    defaultDate.setDate(defaultDate.getDate() + 7)
    setRequestedDeliveryDate(defaultDate.toISOString().split('T')[0])
  }, [])

  useEffect(() => {
    calculateTotal()
  }, [orderItems])

  const fetchCustomers = async () => {
    const result = await getOrderCustomers()
    if (result.error) {
      console.error('Error fetching customers:', result.error)
      return
    }
    setCustomers(result.data!)
  }

  const fetchSKUs = async () => {
    // Fetch all active SKUs (in_stock=false ones shown greyed out so user can see them)
    const result = await getActiveSkus(false)
    if (result.error) {
      console.error('Error fetching SKUs:', result.error)
      return
    }
    setSkus(result.data!)
  }

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
  // Priority: item price > category price > base price ($0)
  const getPriceForSku = useCallback((skuId: string, skuList: SKU[]): number => {
    // Check for item-specific price
    const itemPrice = customerPricing.find(p => p.sku_id === skuId)
    if (itemPrice) {
      return itemPrice.price_per_unit
    }

    // Check for category price
    const sku = skuList.find(s => s.id === skuId)
    if (sku?.product_type_id) {
      const categoryPrice = customerPricing.find(p => p.product_type_id === sku.product_type_id)
      if (categoryPrice) {
        return categoryPrice.price_per_unit
      }
    }

    // Default to base price or 0
    return sku?.price_per_unit || 0
  }, [customerPricing])

  // Fetch customer pricing when customer changes
  useEffect(() => {
    if (customerId) {
      fetchCustomerPricing(customerId)
    } else {
      setCustomerPricing([])
    }
  }, [customerId, fetchCustomerPricing])

  // Update existing line item prices when customer pricing changes
  useEffect(() => {
    if (orderItems.length > 0 && skus.length > 0) {
      setOrderItems(prev => prev.map(item => {
        // Inline pricing logic to avoid stale closure from getPriceForSku
        // Priority: item price > category price > base price
        let newPrice = 0
        
        // Check for item-specific price
        const itemPrice = customerPricing.find(p => p.sku_id === item.sku_id)
        if (itemPrice) {
          newPrice = itemPrice.price_per_unit
        } else {
          // Check for category price
          const sku = skus.find(s => s.id === item.sku_id)
          if (sku?.product_type_id) {
            const categoryPrice = customerPricing.find(p => p.product_type_id === sku.product_type_id)
            if (categoryPrice) {
              newPrice = categoryPrice.price_per_unit
            } else {
              newPrice = sku?.price_per_unit || 0
            }
          } else {
            newPrice = sku?.price_per_unit || 0
          }
        }
        
        return {
          ...item,
          unit_price: newPrice,
          line_total: item.quantity * newPrice
        }
      }))
    }
  }, [customerPricing, skus])

  const addOrderItem = () => {
    if (skus.length === 0) return

    const firstSku = skus[0]
    const unitsPerCase = firstSku.units_per_case || 32
    const cases = 1
    const quantity = cases * unitsPerCase
    const unitPrice = getPriceForSku(firstSku.id, skus)
    const lineTotal = quantity * unitPrice

    setOrderItems([
      ...orderItems,
      {
        sku_id: firstSku.id,
        sku_code: firstSku.code,
        sku_name: firstSku.name,
        cases: cases,
        units_per_case: unitsPerCase,
        quantity: quantity,
        unit_price: unitPrice,
        line_total: lineTotal
      }
    ])
  }

  const updateOrderItem = (index: number, field: keyof OrderItem, value: string | number) => {
    const updated = [...orderItems]
    updated[index] = { ...updated[index], [field]: value }

    if (field === 'sku_id') {
      // SKU changed - update all related fields
      const sku = skus.find(s => s.id === value)
      if (sku) {
        updated[index].sku_code = sku.code
        updated[index].sku_name = sku.name
        updated[index].units_per_case = sku.units_per_case || 32
        updated[index].unit_price = getPriceForSku(sku.id, skus)
        // Recalculate quantity and line_total based on current cases
        updated[index].quantity = updated[index].cases * updated[index].units_per_case
        updated[index].line_total = updated[index].quantity * updated[index].unit_price
      }
    } else if (field === 'cases') {
      // Cases changed - recalculate quantity and line_total
      const cases = value as number
      updated[index].quantity = cases * updated[index].units_per_case
      updated[index].line_total = updated[index].quantity * updated[index].unit_price
    } else if (field === 'unit_price') {
      // Unit price changed - recalculate line_total
      updated[index].line_total = updated[index].quantity * (value as number)
    }

    setOrderItems(updated)
  }

  const removeOrderItem = (index: number) => {
    setOrderItems(orderItems.filter((_, i) => i !== index))
  }

  const calculateTotal = () => {
    const total = orderItems.reduce((sum, item) => sum + item.line_total, 0)
    setTotalPrice(total)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (orderItems.length === 0) {
      setError('Please add at least one item to the order')
      return
    }
    if (!user) {
      setError('Not authenticated')
      return
    }

    // Client-side guard: reject any line item whose SKU is out of stock
    const outOfStockItems = orderItems.filter(item => {
      const sku = skus.find(s => s.id === item.sku_id)
      return sku && !sku.in_stock
    })
    if (outOfStockItems.length > 0) {
      const names = outOfStockItems.map(i => i.sku_code).join(', ')
      setError(`Cannot submit order — the following SKUs are out of stock: ${names}`)
      return
    }

    setLoading(true)
    setError(null)

    try {
      const result = await createOrder({
        customer_id: customerId,
        order_notes: orderNotes || null,
        order_date: orderDate,
        requested_delivery_date: requestedDeliveryDate,
        total_price: totalPrice,
        items: orderItems.map(item => ({
          sku_id: item.sku_id,
          cases: item.cases,
          unit_price: item.unit_price || 0,
          line_total: Number.isFinite(item.line_total) ? item.line_total : 0,
        })),
      })

      if (result.error) throw new Error(result.error)

      router.push('/dashboard/orders')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/dashboard/orders">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Create Order</h1>
          <p className="text-muted-foreground mt-1">Submit a new wholesale order</p>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Order Details */}
        <Card>
          <CardHeader>
            <CardTitle>Order Details</CardTitle>
            <CardDescription>Basic order information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && (
              <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="customer">Customer *</Label>
                <Popover open={customerOpen} onOpenChange={setCustomerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={customerOpen}
                      className="h-12 w-full justify-between font-normal"
                    >
                      {customerId
                        ? customers.find((c) => c.id === customerId)?.business_name
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
                          {customers.map((customer) => (
                            <CommandItem
                              key={customer.id}
                              value={`${customer.business_name} ${customer.license_name || ''} ${customer.omma_license || ''} ${customer.city || ''}`}
                              onSelect={() => {
                                setCustomerId(customer.id)
                                setCustomerOpen(false)
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  customerId === customer.id ? "opacity-100" : "opacity-0"
                                )}
                              />
                              <div className="flex flex-col">
                                <span>{customer.business_name}</span>
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

            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="deliveryDate">Requested Delivery Date *</Label>
                <Input
                  id="deliveryDate"
                  type="date"
                  value={requestedDeliveryDate}
                  onChange={(e) => setRequestedDeliveryDate(e.target.value)}
                  required
                  disabled={loading}
                  className="h-12"
                />
              </div>
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
          </CardContent>
        </Card>

        {/* Order Items */}
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <div>
                <CardTitle>Order Items</CardTitle>
                <CardDescription>Add products to this order</CardDescription>
              </div>
              <Button
                type="button"
                size="sm"
                onClick={addOrderItem}
                disabled={skus.length === 0}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Item
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {orderItems.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No items added yet. Click &quot;Add Item&quot; to start.
              </div>
            ) : (
              <>
                {orderItems.map((item, index) => (
                  <div key={index} className="border rounded-lg p-4 space-y-4">
                    {/* SKU Selection Row */}
                    <div className="flex items-center gap-4">
                      <div className="flex-1 space-y-2">
                        <Label>SKU</Label>
                        <SkuCombobox
                          skus={skus}
                          value={item.sku_id}
                          onChange={(value) => updateOrderItem(index, 'sku_id', value)}
                          showUnitsPerCase
                          showOutOfStock
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeOrderItem(index)}
                        className="mt-6"
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>

                    {/* Pricing Row */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 items-end">
                      <div className="space-y-2">
                        <Label>Cases</Label>
                        <Input
                          type="number"
                          min="1"
                          value={item.cases}
                          onChange={(e) => updateOrderItem(index, 'cases', parseInt(e.target.value) || 1)}
                        />
                        <p className="text-xs text-muted-foreground">
                          {item.quantity} units ({item.units_per_case}/case)
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label>Unit Price</Label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={item.unit_price}
                            onChange={(e) => updateOrderItem(index, 'unit_price', parseFloat(e.target.value) || 0)}
                            className="pl-7"
                          />
                        </div>
                      </div>

                      <div className="space-y-2 md:col-span-2">
                        <Label>Line Total</Label>
                        <div className="flex items-center h-10 px-3 bg-muted rounded-md font-semibold text-lg">
                          ${item.line_total.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                <div className="flex justify-center pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addOrderItem}
                    disabled={skus.length === 0}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add Item
                  </Button>
                </div>

                {/* Total */}
                <div className="flex justify-end pt-4">
                  <div className="flex items-center gap-2 text-xl font-semibold">
                    <span>Order Total:</span>
                    <div className="flex items-center">
                      <DollarSign className="h-5 w-5" />
                      {totalPrice.toFixed(2)}
                    </div>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.back()}
            disabled={loading}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={loading || !customerId || orderItems.length === 0}
            className="flex-1"
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating Order...
              </>
            ) : (
              'Create Order'
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
