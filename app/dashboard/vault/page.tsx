'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/lib/auth-context'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import {
  Search,
  Plus,
  Minus,
  Loader2,
  ScanLine,
  Settings,
  Printer,
  ChevronRight,
  Pencil,
  X,
  Package,
  Check,
  ChevronsUpDown,
} from 'lucide-react'
import Link from 'next/link'
import {
  getAllPackages,
  getFilteredPackages,
  getPackage,
  adjustWeight,
  createPackage,
  updatePackage,
  getRecentTransactions,
  getStrains,
  getProductTypes,
  getUniqueBatches,
  getBatches,
} from '@/actions/vault'
import type { VaultPackage, Transaction, Strain, ProductType, Batch } from '@/types/vault'

const GRAMS_PER_LB = 453.592

export default function VaultPage() {
  const { user, handleSessionError } = useAuth()
  const [packages, setPackages] = useState<VaultPackage[]>([])
  const [loading, setLoading] = useState(true)

  // Filter state
  const [strainFilter, setStrainFilter] = useState<string[]>([])
  const [batchFilter, setBatchFilter] = useState<string[]>([])
  const [typeFilter, setTypeFilter] = useState<string[]>([])
  const [strains, setStrains] = useState<Strain[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [uniqueBatches, setUniqueBatches] = useState<string[]>([])
  const [productTypes, setProductTypes] = useState<ProductType[]>([])

  // Selected package state (for Sheet)
  const [selectedPackage, setSelectedPackage] = useState<VaultPackage | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [sheetOpen, setSheetOpen] = useState(false)

  // Weight adjustment state
  const [adjustAmount, setAdjustAmount] = useState('')
  const [adjusting, setAdjusting] = useState(false)
  const [adjustError, setAdjustError] = useState<string | null>(null)

  // Edit package dialog
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editBatchId, setEditBatchId] = useState('')
  const [editTypeId, setEditTypeId] = useState('')
  const [updating, setUpdating] = useState(false)

  // New package dialog
  const [newPackageDialogOpen, setNewPackageDialogOpen] = useState(false)
  const [newTagId, setNewTagId] = useState('')
  const [newBatchId, setNewBatchId] = useState('')
  const [newBatchOpen, setNewBatchOpen] = useState(false)
  const [newTypeId, setNewTypeId] = useState('')
  const [newWeight, setNewWeight] = useState('')
  const [creating, setCreating] = useState(false)

  // Tag lookup
  const [lookupTag, setLookupTag] = useState('')
  const [lookingUp, setLookingUp] = useState(false)

  const canManagePackages = user?.role === 'admin' || user?.role === 'management' || user?.role === 'vault'
  const canAccessAdmin = user?.role === 'admin' || user?.role === 'management'
  const canEdit = user?.role === 'admin' || user?.role === 'management'

  // Fetch packages based on filters
  const fetchPackages = useCallback(async () => {
    setLoading(true)

    const hasFilters = strainFilter.length > 0 || batchFilter.length > 0 || typeFilter.length > 0

    let result
    if (hasFilters) {
      result = await getFilteredPackages({
        strainIds: strainFilter.length > 0 ? strainFilter : undefined,
        batches: batchFilter.length > 0 ? batchFilter : undefined,
        typeIds: typeFilter.length > 0 ? typeFilter : undefined,
      })
    } else {
      result = await getAllPackages()
    }

    if (result.success && result.packages) {
      setPackages(result.packages)
    } else {
      toast.error(result.error || 'Failed to load packages')
    }
    setLoading(false)
  }, [strainFilter, batchFilter, typeFilter])

  // Fetch filter data
  // Note: a toast per failed fetch (rather than a full page error state) was
  // chosen here deliberately — this data only feeds the filter dropdowns, the
  // primary package list has its own error handling via fetchPackages/toast
  // above, and restructuring this page around a blocking error state for
  // secondary filter data would be disproportionate to the risk (stale/empty
  // dropdowns, not zeroed-looking primary data).
  const fetchFilterData = async () => {
    const [strainsResult, typesResult, batchesResult, uniqueBatchesResult] = await Promise.all([
      getStrains(),
      getProductTypes(),
      getBatches({ activeOnly: true }), // Only fetch active batches for dropdowns
      getUniqueBatches(),
    ])

    if (strainsResult.success && strainsResult.strains) {
      setStrains(strainsResult.strains)
    } else {
      console.error('Error fetching strains:', strainsResult.error)
      if (handleSessionError(strainsResult.error)) return
      toast.error(strainsResult.error || 'Failed to load filter options')
      setStrains([])
    }
    if (typesResult.success && typesResult.productTypes) {
      setProductTypes(typesResult.productTypes)
    } else {
      console.error('Error fetching product types:', typesResult.error)
      if (handleSessionError(typesResult.error)) return
      toast.error(typesResult.error || 'Failed to load filter options')
      setProductTypes([])
    }
    if (batchesResult.success && batchesResult.batches) {
      setBatches(batchesResult.batches)
    } else {
      console.error('Error fetching batches:', batchesResult.error)
      if (handleSessionError(batchesResult.error)) return
      toast.error(batchesResult.error || 'Failed to load filter options')
      setBatches([])
    }
    if (uniqueBatchesResult.success && uniqueBatchesResult.batches) {
      setUniqueBatches(uniqueBatchesResult.batches)
    } else {
      console.error('Error fetching unique batches:', uniqueBatchesResult.error)
      if (handleSessionError(uniqueBatchesResult.error)) return
      toast.error(uniqueBatchesResult.error || 'Failed to load filter options')
      setUniqueBatches([])
    }
  }

  useEffect(() => {
    fetchPackages()
    fetchFilterData()
  }, [])

  useEffect(() => {
    fetchPackages()
  }, [fetchPackages])

  // Calculate summary stats
  const totalPackages = packages.length
  const totalGrams = packages.reduce((sum, p) => sum + p.current_weight, 0)
  const totalPounds = totalGrams / GRAMS_PER_LB

  // Handle tag lookup
  const handleLookupTag = async () => {
    if (!lookupTag.trim()) return

    setLookingUp(true)
    const result = await getPackage(lookupTag.trim())

    if (result.success) {
      if (result.package) {
        setSelectedPackage(result.package)
        const txResult = await getRecentTransactions(result.package.tag_id)
        if (txResult.success && txResult.transactions) {
          setTransactions(txResult.transactions)
        }
        setSheetOpen(true)
      } else {
        toast.error('Package not found')
        if (canManagePackages) {
          setNewTagId(lookupTag.trim())
          setNewPackageDialogOpen(true)
        }
      }
    } else {
      toast.error(result.error || 'Failed to lookup package')
    }

    setLookingUp(false)
    setLookupTag('')
  }

  // Handle selecting a package from the list
  const handleSelectPackage = async (pkg: VaultPackage) => {
    setSelectedPackage(pkg)
    setAdjustAmount('')
    setAdjustError(null)

    const result = await getRecentTransactions(pkg.tag_id)
    if (result.success && result.transactions) {
      setTransactions(result.transactions)
    }
    setSheetOpen(true)
  }

  // Handle weight adjustment
  const handleAdjustWeight = async (type: 'add' | 'remove') => {
    if (!selectedPackage || !user) return
    setAdjustError(null)

    const amount = parseFloat(adjustAmount)
    if (isNaN(amount) || amount <= 0) {
      setAdjustError('Please enter a valid weight')
      return
    }

    if (type === 'remove' && amount > selectedPackage.current_weight) {
      setAdjustError('Cannot remove more than current balance')
      return
    }

    setAdjusting(true)
    const result = await adjustWeight(selectedPackage.tag_id, amount, type, user.id)

    if (result.success && result.package) {
      setSelectedPackage(result.package)
      toast.success(`${type === 'add' ? 'Added' : 'Removed'} ${amount}g`)
      setAdjustAmount('')

      // Refresh transactions
      const txResult = await getRecentTransactions(selectedPackage.tag_id)
      if (txResult.success && txResult.transactions) {
        setTransactions(txResult.transactions)
      }

      // Refresh packages list
      fetchPackages()
    } else {
      setAdjustError(result.error || 'Failed to adjust weight')
    }

    setAdjusting(false)
  }

  // Handle opening edit dialog
  const handleOpenEdit = () => {
    if (!selectedPackage) return

    // Find the batch that matches
    const matchingBatch = batches.find(b => b.name === selectedPackage.batch)
    setEditBatchId(matchingBatch?.id || '')
    setEditTypeId(selectedPackage.type_id)
    setEditDialogOpen(true)
  }

  // Handle updating package
  const handleUpdatePackage = async () => {
    if (!selectedPackage) return

    const batch = batches.find(b => b.id === editBatchId)
    if (!batch) {
      toast.error('Please select a batch')
      return
    }

    if (!editTypeId) {
      toast.error('Please select a type')
      return
    }

    setUpdating(true)
    const result = await updatePackage(selectedPackage.tag_id, {
      batch: batch.name,
      strain: batch.strain?.name || '',
      strainId: batch.strain_id,
      typeId: editTypeId,
    })

    if (result.success && result.package) {
      setSelectedPackage(result.package)
      toast.success('Package updated')
      setEditDialogOpen(false)
      fetchPackages()
    } else {
      toast.error(result.error || 'Failed to update package')
    }

    setUpdating(false)
  }

  // Handle creating new package
  const handleCreatePackage = async () => {
    if (!user) return

    const weight = parseFloat(newWeight)
    if (isNaN(weight) || weight < 0) {
      toast.error('Please enter a valid weight')
      return
    }

    const batch = batches.find(b => b.id === newBatchId)
    if (!batch) {
      toast.error('Please select a batch')
      return
    }

    if (!newTypeId) {
      toast.error('Please select a type')
      return
    }

    setCreating(true)
    const result = await createPackage(
      newTagId,
      batch.name,
      batch.strain?.name || '',
      batch.strain_id,
      newTypeId,
      weight,
      user.id
    )

    if (result.success && result.package) {
      toast.success('Package created successfully')
      setNewPackageDialogOpen(false)
      setSelectedPackage(result.package)
      resetNewPackageForm()
      fetchPackages()

      // Open the sheet with the new package
      const txResult = await getRecentTransactions(result.package.tag_id)
      if (txResult.success && txResult.transactions) {
        setTransactions(txResult.transactions)
      }
      setSheetOpen(true)
    } else {
      toast.error(result.error || 'Failed to create package')
    }

    setCreating(false)
  }

  const resetNewPackageForm = () => {
    setNewTagId('')
    setNewBatchId('')
    setNewBatchOpen(false)
    setNewTypeId('')
    setNewWeight('')
  }

  // Handle print
  const handlePrint = () => {
    const printContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Vault Inventory Report</title>
        <style>
          body { font-family: system-ui, sans-serif; padding: 20px; }
          h1 { margin-bottom: 5px; }
          .date { color: #666; margin-bottom: 20px; }
          .summary { display: flex; gap: 40px; margin-bottom: 30px; }
          .summary-item { }
          .summary-label { font-size: 12px; color: #666; text-transform: uppercase; }
          .summary-value { font-size: 24px; font-weight: bold; }
          .summary-sub { font-size: 12px; color: #666; }
          table { width: 100%; border-collapse: collapse; }
          th, td { text-align: left; padding: 8px; border-bottom: 1px solid #ddd; }
          th { font-weight: 600; background: #f5f5f5; }
          .mono { font-family: monospace; font-size: 12px; }
          .right { text-align: right; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <h1>Vault Inventory Report</h1>
        <p class="date">${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>

        <div class="summary">
          <div class="summary-item">
            <div class="summary-label">Packages</div>
            <div class="summary-value">${totalPackages}</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">Total Weight</div>
            <div class="summary-value">${totalPounds.toFixed(2)} lbs</div>
            <div class="summary-sub">${totalGrams.toFixed(2)}g</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Tag ID</th>
              <th>Batch</th>
              <th>Strain</th>
              <th>Type</th>
              <th class="right">Weight (g)</th>
              <th class="right">Weight (lbs)</th>
            </tr>
          </thead>
          <tbody>
            ${packages.map(pkg => `
              <tr>
                <td class="mono">${pkg.tag_id}</td>
                <td>${pkg.batch}</td>
                <td>${pkg.strain}</td>
                <td>${pkg.type?.name || '-'}</td>
                <td class="right">${pkg.current_weight.toFixed(2)}</td>
                <td class="right">${(pkg.current_weight / GRAMS_PER_LB).toFixed(4)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </body>
      </html>
    `

    const printWindow = window.open('', '_blank')
    if (printWindow) {
      printWindow.document.write(printContent)
      printWindow.document.close()
      printWindow.print()
    }
  }

  // Get selected batch for edit dialog
  const selectedEditBatch = batches.find(b => b.id === editBatchId)
  const selectedNewBatch = batches.find(b => b.id === newBatchId)

  // Check if package is empty (for yellow warning)
  const isPackageEmpty = selectedPackage && selectedPackage.current_weight === 0

  if (loading && packages.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">Vault Inventory</h1>
            <p className="text-muted-foreground mt-1">Manage bulk cannabis packages</p>
          </div>
          {canAccessAdmin && (
            <Button variant="outline" asChild>
              <Link href="/dashboard/vault/admin">
                <Settings className="mr-2 h-4 w-4" />
                Admin
              </Link>
            </Button>
          )}
        </div>

        {/* Tag Lookup */}
        <Card>
          <CardContent className="py-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Scan or enter tag ID..."
                  value={lookupTag}
                  onChange={(e) => setLookupTag(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLookupTag()}
                  className="pl-9"
                />
              </div>
              <Button onClick={handleLookupTag} disabled={lookingUp}>
                {lookingUp ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters Card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold">Filters</CardTitle>
            <div className="flex items-center gap-2">
              {(strainFilter.length > 0 || batchFilter.length > 0 || typeFilter.length > 0) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStrainFilter([])
                    setBatchFilter([])
                    setTypeFilter([])
                  }}
                >
                  <X className="h-4 w-4 mr-1" />
                  Clear
                </Button>
              )}
              <Button variant="ghost" size="icon" onClick={handlePrint}>
                <Printer className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Strain</Label>
              <Select
                value={strainFilter.length === 1 ? strainFilter[0] : strainFilter.length > 1 ? 'multiple' : 'all'}
                onValueChange={(value) => {
                  if (value === 'all') {
                    setStrainFilter([])
                  } else if (value !== 'multiple') {
                    setStrainFilter([value])
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All Strains">
                    {strainFilter.length === 0 ? 'All Strains' :
                     strainFilter.length === 1 ? strains.find(s => s.id === strainFilter[0])?.name :
                     `${strainFilter.length} Strains`}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Strains</SelectItem>
                  {strains.map((strain) => (
                    <SelectItem key={strain.id} value={strain.id}>
                      {strain.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Batch</Label>
              <Select
                value={batchFilter.length === 1 ? batchFilter[0] : batchFilter.length > 1 ? 'multiple' : 'all'}
                onValueChange={(value) => {
                  if (value === 'all') {
                    setBatchFilter([])
                  } else if (value !== 'multiple') {
                    setBatchFilter([value])
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All Batches">
                    {batchFilter.length === 0 ? 'All Batches' :
                     batchFilter.length === 1 ? batchFilter[0] :
                     `${batchFilter.length} Batches`}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Batches</SelectItem>
                  {uniqueBatches.map((batch) => (
                    <SelectItem key={batch} value={batch}>
                      {batch}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Type</Label>
              <Select
                value={typeFilter.length === 1 ? typeFilter[0] : typeFilter.length > 1 ? 'multiple' : 'all'}
                onValueChange={(value) => {
                  if (value === 'all') {
                    setTypeFilter([])
                  } else if (value !== 'multiple') {
                    setTypeFilter([value])
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All Types">
                    {typeFilter.length === 0 ? 'All Types' :
                     typeFilter.length === 1 ? productTypes.find(t => t.id === typeFilter[0])?.name :
                     `${typeFilter.length} Types`}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {productTypes.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4">
        <Card className="bg-green-500/10 border-green-500/30">
          <CardContent className="py-6 text-center">
            <p className="text-3xl md:text-4xl font-bold">{totalPackages}</p>
            <p className="text-sm text-green-600 font-medium">Packages</p>
          </CardContent>
        </Card>
        <Card className="bg-green-500/10 border-green-500/30">
          <CardContent className="py-6 text-center">
            <p className="text-3xl md:text-4xl font-bold">{totalPounds.toFixed(2)}</p>
            <p className="text-sm text-green-600 font-medium">Pounds</p>
            <p className="text-xs text-muted-foreground">{totalGrams.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}g</p>
          </CardContent>
        </Card>
      </div>

      {/* Packages List */}
      <Card>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {packages.map((pkg) => (
              <button
                key={pkg.tag_id}
                onClick={() => handleSelectPackage(pkg)}
                className={`w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors text-left ${!pkg.is_active ? 'opacity-60' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className={`font-mono text-sm font-medium truncate ${!pkg.is_active ? 'line-through text-muted-foreground' : ''}`}>{pkg.tag_id}</p>
                    {!pkg.is_active && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                        Inactive
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground truncate">
                    {pkg.batch} • {pkg.strain} • {pkg.type?.name || '-'}
                  </p>
                </div>
                <div className="flex items-center gap-3 ml-4">
                  <div className="text-right">
                    <p className={`font-semibold ${!pkg.is_active ? 'text-gray-400' : 'text-green-600'}`}>{pkg.current_weight.toFixed(2)}g</p>
                    <p className="text-xs text-muted-foreground">
                      {(pkg.current_weight / GRAMS_PER_LB).toFixed(2)} lb
                    </p>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                </div>
              </button>
            ))}
            {packages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Package className="h-12 w-12 mb-4 opacity-50" />
                <p>No packages found</p>
                {(strainFilter.length > 0 || batchFilter.length > 0 || typeFilter.length > 0) && (
                  <Button
                    variant="link"
                    onClick={() => {
                      setStrainFilter([])
                      setBatchFilter([])
                      setTypeFilter([])
                    }}
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Package Detail Sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader className="text-center pb-4">
            <div className="flex items-center justify-center gap-2">
              <SheetTitle className="font-mono text-lg">
                {selectedPackage?.tag_id}
              </SheetTitle>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={handleOpenEdit}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
            </div>
          </SheetHeader>

          {selectedPackage && (
            <div className="space-y-6">
              {/* Deactivated Warning */}
              {!selectedPackage.is_active && (
                <div className="flex items-center justify-center gap-2 p-3 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                  <span className="text-sm font-medium">This tag is deactivated</span>
                </div>
              )}

              {/* Meta Row */}
              <div className="flex flex-wrap justify-center gap-2 text-sm">
                <Badge variant="secondary">{selectedPackage.batch}</Badge>
                <Badge variant="secondary">{selectedPackage.strain}</Badge>
                <Badge variant="outline">{selectedPackage.type?.name || '-'}</Badge>
                {!selectedPackage.is_active && (
                  <Badge variant="outline" className="bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">Inactive</Badge>
                )}
              </div>

              {/* Current Balance */}
              <Card className={`${isPackageEmpty ? 'bg-yellow-500/10 border-yellow-500/30' : 'bg-green-500/10 border-green-500/30'}`}>
                <CardContent className="py-6 text-center">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Current Balance</p>
                  <p className={`text-4xl font-bold ${isPackageEmpty ? 'text-yellow-600' : 'text-green-600'}`}>
                    {selectedPackage.current_weight.toFixed(2)}g
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {(selectedPackage.current_weight / GRAMS_PER_LB).toFixed(4)} lbs
                  </p>
                  {isPackageEmpty && (
                    <p className="text-yellow-600 text-sm mt-2 font-medium">Package is empty</p>
                  )}
                </CardContent>
              </Card>

              {/* Weight Adjuster */}
              {canManagePackages && (
                <Card>
                  <CardContent className="pt-4 space-y-4">
                    <Label className="text-sm text-muted-foreground">Enter weight (grams)</Label>
                    <div className="relative">
                      <Input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={adjustAmount}
                        onChange={(e) => {
                          setAdjustError(null)
                          const regex = /^\d*\.?\d{0,2}$/
                          if (e.target.value === '' || regex.test(e.target.value)) {
                            setAdjustAmount(e.target.value)
                          }
                        }}
                        className="text-center text-2xl h-14 pr-8"
                      />
                      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground">g</span>
                    </div>

                    {adjustError && (
                      <p className="text-destructive text-sm text-center">{adjustError}</p>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                      <Button
                        variant="outline"
                        size="lg"
                        onClick={() => handleAdjustWeight('remove')}
                        disabled={adjusting || !adjustAmount}
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      >
                        <Minus className="h-4 w-4 mr-2" />
                        Remove
                      </Button>
                      <Button
                        variant="outline"
                        size="lg"
                        onClick={() => handleAdjustWeight('add')}
                        disabled={adjusting || !adjustAmount}
                        className="text-green-600 hover:text-green-600 hover:bg-green-500/10"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Add
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Recent Activity */}
              <div>
                <h3 className="text-sm font-semibold mb-3">Recent Activity</h3>
                <div className="space-y-2">
                  {transactions.map((tx) => (
                    <div
                      key={tx.id}
                      className="flex items-center justify-between text-sm p-3 rounded-lg bg-muted/50"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`font-medium ${tx.type === 'add' ? 'text-green-600' : 'text-red-600'}`}>
                          {tx.type === 'add' ? '+' : '-'}{tx.amount}g
                        </span>
                        <span className="text-muted-foreground">→</span>
                        <span className="font-medium">{tx.resulting_balance}g</span>
                      </div>
                      <div className="text-right text-muted-foreground">
                        <p className="text-xs">{tx.user?.name || 'Unknown'}</p>
                        <p className="text-xs">{new Date(tx.created_at).toLocaleDateString()}</p>
                      </div>
                    </div>
                  ))}
                  {transactions.length === 0 && (
                    <p className="text-muted-foreground text-sm text-center py-4">
                      No transactions yet
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Edit Package Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Package</DialogTitle>
            <DialogDescription>
              Update package details for {selectedPackage?.tag_id}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label>Batch</Label>
              <Select value={editBatchId} onValueChange={setEditBatchId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select batch..." />
                </SelectTrigger>
                <SelectContent>
                  {batches.map((batch) => (
                    <SelectItem key={batch.id} value={batch.id}>
                      {batch.name} ({batch.strain?.name || 'No strain'})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Strain</Label>
              <Input
                value={selectedEditBatch?.strain?.name || 'Select a batch first'}
                readOnly
                className="bg-muted"
              />
              <p className="text-xs text-muted-foreground mt-1">Auto-selected from batch</p>
            </div>

            <div>
              <Label>Type</Label>
              <Select value={editTypeId} onValueChange={setEditTypeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select type..." />
                </SelectTrigger>
                <SelectContent>
                  {productTypes.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleUpdatePackage}
              disabled={updating || !editBatchId || !editTypeId}
            >
              {updating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Package Dialog */}
      <Dialog open={newPackageDialogOpen} onOpenChange={setNewPackageDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Package</DialogTitle>
            <DialogDescription>
              Add a new package to the vault inventory
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label>Tag ID</Label>
              <Input
                placeholder="Enter or scan tag ID..."
                value={newTagId}
                onChange={(e) => setNewTagId(e.target.value)}
              />
            </div>

            <div>
              <Label>Batch</Label>
              <Popover open={newBatchOpen} onOpenChange={setNewBatchOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={newBatchOpen}
                    className="w-full justify-between font-normal"
                  >
                    {newBatchId
                      ? (() => {
                          const batch = batches.find((b) => b.id === newBatchId)
                          return batch ? `${batch.name} (${batch.strain?.name || 'No strain'})` : 'Select batch...'
                        })()
                      : 'Select batch...'}
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
                              setNewBatchId(batch.id)
                              setNewBatchOpen(false)
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                newBatchId === batch.id ? "opacity-100" : "opacity-0"
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
            </div>

            <div>
              <Label>Strain</Label>
              <Input
                value={selectedNewBatch?.strain?.name || 'Select a batch first'}
                readOnly
                className="bg-muted"
              />
              <p className="text-xs text-muted-foreground mt-1">Auto-selected from batch</p>
            </div>

            <div>
              <Label>Type</Label>
              <Select value={newTypeId} onValueChange={setNewTypeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select type..." />
                </SelectTrigger>
                <SelectContent>
                  {productTypes.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Starting Weight (grams)</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="Enter weight..."
                value={newWeight}
                onChange={(e) => setNewWeight(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setNewPackageDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreatePackage}
              disabled={creating || !newTagId || !newBatchId || !newTypeId || !newWeight}
            >
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Package
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
