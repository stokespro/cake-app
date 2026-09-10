'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth-context'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Calendar } from '@/components/ui/calendar'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { SkuCombobox } from '@/components/orders/sku-combobox'
import { toast } from 'sonner'
import { Plus, Edit2, Trash2, CalendarIcon, Percent } from 'lucide-react'
import { format } from 'date-fns'
import { cn } from '@/lib/utils'
import {
  getCommissionRates,
  getSalespeople,
  getProductTypes,
  getSkus,
  createCommissionRate,
  updateCommissionRate,
  deleteCommissionRate,
  type CommissionRateRow,
  type SalespersonOption,
  type ProductTypeOption,
  type SkuOption,
} from '@/actions/commissions'

interface RateFormData {
  salesperson_id: string
  product_type_id: string
  sku_id: string
  min_unit_price: string
  rate_percent: string
  effective_from: Date | undefined
  effective_to: Date | undefined
}

const initialFormData: RateFormData = {
  salesperson_id: '',
  product_type_id: '',
  sku_id: '',
  min_unit_price: '',
  rate_percent: '',
  effective_from: undefined,
  effective_to: undefined,
}

export default function CommissionRatesPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()

  const [rates, setRates] = useState<CommissionRateRow[]>([])
  const [salespeople, setSalespeople] = useState<SalespersonOption[]>([])
  const [productTypes, setProductTypes] = useState<ProductTypeOption[]>([])
  const [skus, setSkus] = useState<SkuOption[]>([])
  const [filteredSkus, setFilteredSkus] = useState<SkuOption[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Sheet state
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingRate, setEditingRate] = useState<CommissionRateRow | null>(null)
  const [formData, setFormData] = useState<RateFormData>(initialFormData)

  // Delete dialog state
  const [deleteRateId, setDeleteRateId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const userRole = user?.role || 'standard'
  const canManage = userRole === 'admin' || userRole === 'management'

  useEffect(() => {
    if (!authLoading && user && !canManage) {
      router.push('/dashboard')
    }
  }, [user, authLoading, canManage, router])

  useEffect(() => {
    if (canManage) {
      fetchData()
    }
  }, [canManage])

  // Filter SKUs when product type changes
  useEffect(() => {
    if (formData.product_type_id && formData.product_type_id !== 'all') {
      setFilteredSkus(skus.filter(sku => sku.product_type_id === formData.product_type_id))
    } else {
      setFilteredSkus(skus)
    }
    // Reset SKU selection when product type changes
    if (formData.product_type_id !== editingRate?.product_type_id) {
      setFormData(prev => ({ ...prev, sku_id: '' }))
    }
  }, [formData.product_type_id, skus])

  const fetchData = async () => {
    try {
      const [ratesResult, salespeopleResult, typesResult, skusResult] = await Promise.all([
        getCommissionRates(),
        getSalespeople(),
        getProductTypes(),
        getSkus(),
      ])

      if (ratesResult.error) throw new Error(ratesResult.error)
      if (salespeopleResult.error) throw new Error(salespeopleResult.error)
      if (typesResult.error) throw new Error(typesResult.error)
      if (skusResult.error) throw new Error(skusResult.error)

      setRates(ratesResult.data ?? [])
      setSalespeople(salespeopleResult.data ?? [])
      setProductTypes(typesResult.data ?? [])
      setSkus(skusResult.data ?? [])
      setFilteredSkus(skusResult.data ?? [])
    } catch (error) {
      console.error('Error fetching data:', error)
      toast.error('Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  const openAddSheet = () => {
    setEditingRate(null)
    setFormData({
      ...initialFormData,
      effective_from: new Date(),
    })
    setSheetOpen(true)
  }

  const openEditSheet = (rate: CommissionRateRow) => {
    setEditingRate(rate)
    setFormData({
      salesperson_id: rate.salesperson_id || '',
      product_type_id: rate.product_type_id || '',
      sku_id: rate.sku_id || '',
      min_unit_price: rate.min_unit_price != null ? rate.min_unit_price.toString() : '',
      rate_percent: rate.rate_percent.toString(),
      effective_from: rate.effective_from ? new Date(rate.effective_from) : undefined,
      effective_to: rate.effective_to ? new Date(rate.effective_to) : undefined,
    })
    setSheetOpen(true)
  }

  const handleSave = async () => {
    // Validate rate percent
    const ratePercent = parseFloat(formData.rate_percent)
    if (isNaN(ratePercent) || ratePercent < 0 || ratePercent > 100) {
      toast.error('Rate must be between 0 and 100')
      return
    }
    if (!formData.effective_from) {
      toast.error('Effective from date is required')
      return
    }

    // Validate min_unit_price if provided
    let minUnitPrice: number | null = null
    if (formData.min_unit_price.trim() !== '') {
      const parsed = parseFloat(formData.min_unit_price)
      if (isNaN(parsed) || parsed < 0) {
        toast.error('Min price must be 0 or greater')
        return
      }
      minUnitPrice = parsed
    }

    setSaving(true)
    try {
      const rateData = {
        salesperson_id: formData.salesperson_id || null,
        product_type_id: formData.product_type_id && formData.product_type_id !== 'all' ? formData.product_type_id : null,
        sku_id: formData.sku_id && formData.sku_id !== 'all' ? formData.sku_id : null,
        min_unit_price: minUnitPrice,
        rate_percent: ratePercent,
        effective_from: format(formData.effective_from, 'yyyy-MM-dd'),
        effective_to: formData.effective_to ? format(formData.effective_to, 'yyyy-MM-dd') : null,
      }

      if (editingRate) {
        const result = await updateCommissionRate(editingRate.id, rateData)
        if (result.error) throw new Error(result.error)
        toast.success('Rate updated successfully')
      } else {
        const result = await createCommissionRate(rateData)
        if (result.error) throw new Error(result.error)
        toast.success('Rate created successfully')
      }

      setSheetOpen(false)
      setEditingRate(null)
      setFormData(initialFormData)
      fetchData()
    } catch (error) {
      console.error('Error saving rate:', error)
      toast.error('Failed to save rate')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteRateId) return

    setDeleting(true)
    try {
      const result = await deleteCommissionRate(deleteRateId)
      if (result.error) throw new Error(result.error)
      toast.success('Rate deleted successfully')
      setDeleteRateId(null)
      fetchData()
    } catch (error) {
      console.error('Error deleting rate:', error)
      toast.error('Failed to delete rate')
    } finally {
      setDeleting(false)
    }
  }

  const formatDateDisplay = (dateStr?: string | null) => {
    if (!dateStr) return '—'
    return format(new Date(dateStr), 'MMM d, yyyy')
  }

  // Sort rates by salesperson name, product type, then min_unit_price DESC (highest first, null/floor last)
  const sortedRates = [...rates].sort((a, b) => {
    // First by salesperson name (global defaults first)
    const aName = a.salesperson?.full_name || ''
    const bName = b.salesperson?.full_name || ''
    if (!aName && bName) return -1
    if (aName && !bName) return 1
    const nameCompare = aName.localeCompare(bName)
    if (nameCompare !== 0) return nameCompare

    // Then by product type name
    const aType = a.product_type?.name || ''
    const bType = b.product_type?.name || ''
    const typeCompare = aType.localeCompare(bType)
    if (typeCompare !== 0) return typeCompare

    // Then by min_unit_price DESC (null/floor rates last)
    const aPrice = a.min_unit_price
    const bPrice = b.min_unit_price
    if (aPrice == null && bPrice == null) return 0
    if (aPrice == null) return 1  // null goes last
    if (bPrice == null) return -1 // null goes last
    return Number(bPrice) - Number(aPrice) // DESC order
  })

  if (loading || authLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (!canManage) {
    return null
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Commission Rates</h1>
          <p className="text-muted-foreground mt-1">Configure commission rates for salespeople</p>
        </div>
        <Button onClick={openAddSheet}>
          <Plus className="mr-2 h-4 w-4" />
          Add Rate
        </Button>
      </div>

      {/* Rates Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Percent className="h-5 w-5" />
            Commission Rates ({rates.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rates.length === 0 ? (
            <div className="text-center py-12">
              <Percent className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground mb-4">No commission rates configured yet</p>
              <Button onClick={openAddSheet}>
                <Plus className="mr-2 h-4 w-4" />
                Add Your First Rate
              </Button>
            </div>
          ) : (
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Salesperson</TableHead>
                    <TableHead>Product Type</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Min Price</TableHead>
                    <TableHead className="text-right">Rate %</TableHead>
                    <TableHead>Effective From</TableHead>
                    <TableHead>Effective To</TableHead>
                    <TableHead className="w-[100px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedRates.map((rate) => (
                    <TableRow key={rate.id}>
                      <TableCell>
                        {rate.salesperson?.full_name || (
                          <Badge variant="secondary">Global Default</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {rate.product_type?.name || (
                          <span className="text-muted-foreground">All</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {rate.sku ? (
                          <span>{rate.sku.code}</span>
                        ) : (
                          <span className="text-muted-foreground">All</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {rate.min_unit_price != null ? (
                          <span className="font-mono">≥ ${Number(rate.min_unit_price).toFixed(2)}</span>
                        ) : (
                          <Badge variant="secondary">Floor</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {rate.rate_percent}%
                      </TableCell>
                      <TableCell>{formatDateDisplay(rate.effective_from)}</TableCell>
                      <TableCell>{formatDateDisplay(rate.effective_to)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => openEditSheet(rate)}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => setDeleteRateId(rate.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit Sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{editingRate ? 'Edit Rate' : 'Add Rate'}</SheetTitle>
            <SheetDescription>
              {editingRate
                ? 'Update the commission rate configuration'
                : 'Create a new commission rate. Leave fields blank for broader defaults.'}
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-6 pt-6">
            {/* Salesperson */}
            <div className="space-y-2">
              <Label>Salesperson</Label>
              <Select
                value={formData.salesperson_id || 'all'}
                onValueChange={(value) => setFormData(prev => ({
                  ...prev,
                  salesperson_id: value === 'all' ? '' : value
                }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select salesperson" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Salespeople (Global Default)</SelectItem>
                  {salespeople.map((sp) => (
                    <SelectItem key={sp.id} value={sp.id}>
                      {sp.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Leave as &quot;All&quot; for a global default rate
              </p>
            </div>

            {/* Product Type */}
            <div className="space-y-2">
              <Label>Product Type</Label>
              <Select
                value={formData.product_type_id || 'all'}
                onValueChange={(value) => setFormData(prev => ({
                  ...prev,
                  product_type_id: value === 'all' ? '' : value,
                  sku_id: '' // Reset SKU when product type changes
                }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select product type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Product Types</SelectItem>
                  {productTypes.map((pt) => (
                    <SelectItem key={pt.id} value={pt.id}>
                      {pt.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* SKU */}
            <div className="space-y-2">
              <Label>SKU</Label>
              <SkuCombobox
                skus={filteredSkus}
                value={formData.sku_id}
                onChange={(skuId) => setFormData(prev => ({
                  ...prev,
                  sku_id: skuId
                }))}
                showEmptyOption
                emptyOptionLabel="All SKUs"
              />
              <p className="text-xs text-muted-foreground">
                SKU-specific rates take highest priority
              </p>
            </div>

            {/* Min Unit Price */}
            <div className="space-y-2">
              <Label>Min Price (Optional)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={formData.min_unit_price}
                  onChange={(e) => setFormData(prev => ({ ...prev, min_unit_price: e.target.value }))}
                  placeholder="e.g., 12.00"
                  className="pl-7"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Leave empty for floor rate (applies to all prices below other tiers)
              </p>
            </div>

            {/* Rate Percent */}
            <div className="space-y-2">
              <Label>Rate %</Label>
              <div className="relative">
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={formData.rate_percent}
                  onChange={(e) => setFormData(prev => ({ ...prev, rate_percent: e.target.value }))}
                  placeholder="e.g., 10"
                  className="pr-8"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  %
                </span>
              </div>
            </div>

            {/* Effective From */}
            <div className="space-y-2">
              <Label>Effective From</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      'w-full justify-start text-left font-normal',
                      !formData.effective_from && 'text-muted-foreground'
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {formData.effective_from
                      ? format(formData.effective_from, 'PPP')
                      : 'Pick a date'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={formData.effective_from}
                    onSelect={(date) => setFormData(prev => ({ ...prev, effective_from: date }))}
                  />
                </PopoverContent>
              </Popover>
            </div>

            {/* Effective To */}
            <div className="space-y-2">
              <Label>Effective To (Optional)</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      'w-full justify-start text-left font-normal',
                      !formData.effective_to && 'text-muted-foreground'
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {formData.effective_to
                      ? format(formData.effective_to, 'PPP')
                      : 'No end date (ongoing)'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={formData.effective_to}
                    onSelect={(date) => setFormData(prev => ({ ...prev, effective_to: date }))}
                  />
                </PopoverContent>
              </Popover>
              {formData.effective_to && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setFormData(prev => ({ ...prev, effective_to: undefined }))}
                >
                  Clear end date
                </Button>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-4 border-t">
              <Button
                className="flex-1"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving...' : editingRate ? 'Update Rate' : 'Create Rate'}
              </Button>
              <Button
                variant="outline"
                onClick={() => setSheetOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteRateId} onOpenChange={(open) => !open && setDeleteRateId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Rate</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this commission rate? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
