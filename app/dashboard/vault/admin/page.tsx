'use client'

import { useState, useEffect, type ChangeEvent } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  ToggleLeft,
  ToggleRight,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
  FileText,
  Upload,
  X,
} from 'lucide-react'
import {
  getStrains,
  createStrain,
  updateStrain,
  deleteStrain,
  getBatches,
  createBatch,
  updateBatch,
  deleteBatch,
  toggleBatchActive,
  bulkToggleBatchActive,
  createBatchCoaUploadUrl,
  attachBatchCoa,
  removeBatchCoa,
  getProductTypes,
  createProductType,
  updateProductType,
  deleteProductType,
  getAllPackages,
  togglePackageActive,
} from '@/actions/vault'
import { createClient } from '@/lib/supabase/client'
import type { Strain, Batch, ProductType, VaultPackage } from '@/types/vault'

const MAX_COA_BYTES = 20 * 1024 * 1024

// Formats an optional lab-testing percentage value; renders "—" when missing
function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return `${value.toFixed(2)}%`
}

export default function VaultAdminPage() {
  const [activeTab, setActiveTab] = useState('strains')

  // Strains state
  const [strains, setStrains] = useState<Strain[]>([])
  const [strainsLoading, setStrainsLoading] = useState(true)
  const [strainDialogOpen, setStrainDialogOpen] = useState(false)
  const [editingStrain, setEditingStrain] = useState<Strain | null>(null)
  const [strainName, setStrainName] = useState('')
  const [strainSaving, setStrainSaving] = useState(false)
  const [strainError, setStrainError] = useState('')
  const [deleteStrainId, setDeleteStrainId] = useState<string | null>(null)
  const [strainDeleting, setStrainDeleting] = useState(false)

  // Batches state
  const [batches, setBatches] = useState<Batch[]>([])
  const [batchesLoading, setBatchesLoading] = useState(true)
  const [batchDialogOpen, setBatchDialogOpen] = useState(false)
  // Tracks whether the dialog was opened as "Add" or "Edit" for label purposes only —
  // kept separate from `editingBatch` because a successful create promotes `editingBatch`
  // mid-flow (see handleSaveBatch) and the title/button label shouldn't flip when that happens.
  const [batchDialogMode, setBatchDialogMode] = useState<'create' | 'edit'>('create')
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null)
  const [batchName, setBatchName] = useState('')
  const [batchStrainId, setBatchStrainId] = useState('')
  const [batchThc, setBatchThc] = useState('')
  const [batchTerpenes, setBatchTerpenes] = useState('')
  const [batchTotalCannabinoids, setBatchTotalCannabinoids] = useState('')
  const [batchSaving, setBatchSaving] = useState(false)
  const [batchError, setBatchError] = useState('')
  const [coaFile, setCoaFile] = useState<File | null>(null)
  const [coaUploading, setCoaUploading] = useState(false)
  const [existingCoa, setExistingCoa] = useState<{ url: string; filename: string } | null>(null)
  const [deleteBatchId, setDeleteBatchId] = useState<string | null>(null)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [togglingBatchId, setTogglingBatchId] = useState<string | null>(null)
  const [batchStatusFilter, setBatchStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [batchStrainFilter, setBatchStrainFilter] = useState('all')
  const [batchSortColumn, setBatchSortColumn] = useState<
    'name' | 'strain' | 'thc' | 'terpenes' | 'cannabinoids' | 'status' | 'created_at' | null
  >(null)
  const [batchSortDirection, setBatchSortDirection] = useState<'asc' | 'desc'>('asc')
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<string>>(new Set())
  const [bulkBatchActionLoading, setBulkBatchActionLoading] = useState(false)

  // Product Types state
  const [productTypes, setProductTypes] = useState<ProductType[]>([])
  const [typesLoading, setTypesLoading] = useState(true)
  const [typeDialogOpen, setTypeDialogOpen] = useState(false)
  const [editingType, setEditingType] = useState<ProductType | null>(null)
  const [typeName, setTypeName] = useState('')
  const [typeSaving, setTypeSaving] = useState(false)
  const [typeError, setTypeError] = useState('')
  const [deleteTypeId, setDeleteTypeId] = useState<string | null>(null)
  const [typeDeleting, setTypeDeleting] = useState(false)

  // Package Tags state
  const [packages, setPackages] = useState<VaultPackage[]>([])
  const [packagesLoading, setPackagesLoading] = useState(true)
  const [togglingPackageId, setTogglingPackageId] = useState<string | null>(null)
  const [packageSearch, setPackageSearch] = useState('')
  const [packageStatusFilter, setPackageStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [packageStrainFilter, setPackageStrainFilter] = useState('all')
  const [packageTypeFilter, setPackageTypeFilter] = useState('all')
  const [packageSortColumn, setPackageSortColumn] = useState<
    'tag_id' | 'batch' | 'strain' | 'type' | 'weight' | null
  >(null)
  const [packageSortDirection, setPackageSortDirection] = useState<'asc' | 'desc'>('asc')
  const [selectedPackageIds, setSelectedPackageIds] = useState<Set<string>>(new Set())
  const [bulkPackageActionLoading, setBulkPackageActionLoading] = useState(false)

  // Load data
  useEffect(() => {
    loadStrains()
    loadBatches()
    loadProductTypes()
    loadPackages()
  }, [])

  async function loadStrains() {
    setStrainsLoading(true)
    const result = await getStrains()
    if (result.success && result.strains) {
      setStrains(result.strains)
    }
    setStrainsLoading(false)
  }

  async function loadBatches() {
    setBatchesLoading(true)
    const result = await getBatches()
    if (result.success && result.batches) {
      setBatches(result.batches)
    }
    setBatchesLoading(false)
  }

  async function loadProductTypes() {
    setTypesLoading(true)
    const result = await getProductTypes()
    if (result.success && result.productTypes) {
      setProductTypes(result.productTypes)
    }
    setTypesLoading(false)
  }

  async function loadPackages() {
    setPackagesLoading(true)
    const result = await getAllPackages({ activeOnly: false })
    if (result.success && result.packages) {
      setPackages(result.packages)
    }
    setPackagesLoading(false)
  }

  async function handleTogglePackageActive(pkg: VaultPackage) {
    setTogglingPackageId(pkg.tag_id)
    const result = await togglePackageActive(pkg.tag_id, !pkg.is_active)
    if (result.success) {
      loadPackages()
    } else {
      alert(result.error || 'Failed to toggle package status')
    }
    setTogglingPackageId(null)
  }

  function handlePackageSort(column: 'tag_id' | 'batch' | 'strain' | 'type' | 'weight') {
    if (packageSortColumn === column) {
      setPackageSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setPackageSortColumn(column)
      setPackageSortDirection('asc')
    }
  }

  function togglePackageSelected(tagId: string) {
    setSelectedPackageIds(prev => {
      const next = new Set(prev)
      if (next.has(tagId)) {
        next.delete(tagId)
      } else {
        next.add(tagId)
      }
      return next
    })
  }

  function toggleSelectAllPackages() {
    setSelectedPackageIds(prev => {
      const allSelected = filteredPackages.length > 0 && filteredPackages.every(pkg => prev.has(pkg.tag_id))
      if (allSelected) {
        return new Set()
      }
      return new Set(filteredPackages.map(pkg => pkg.tag_id))
    })
  }

  async function handleBulkTogglePackageActive(isActive: boolean) {
    const ids = Array.from(selectedPackageIds)
    if (ids.length === 0) return
    setBulkPackageActionLoading(true)
    const results = await Promise.all(
      ids.map(async (tagId) => ({ tagId, result: await togglePackageActive(tagId, isActive) }))
    )
    const failed = results.filter(r => !r.result.success)
    loadPackages()
    setSelectedPackageIds(new Set())
    setBulkPackageActionLoading(false)
    if (failed.length > 0) {
      alert(`Failed to update ${failed.length} tag(s): ${failed.map(f => f.tagId).join(', ')}`)
    }
  }

  // Distinct strain/type options present in the loaded packages
  const packageStrainOptions = Array.from(new Set(packages.map(pkg => pkg.strain).filter(Boolean))).sort()
  const packageTypeOptions = Array.from(
    new Set(packages.map(pkg => pkg.type?.name).filter((name): name is string => !!name))
  ).sort()

  // Filter packages by search + status + strain + type
  const filteredPackages = packages
    .filter(pkg => {
      if (packageStatusFilter === 'active' && !pkg.is_active) return false
      if (packageStatusFilter === 'inactive' && pkg.is_active) return false
      if (packageStrainFilter !== 'all' && pkg.strain !== packageStrainFilter) return false
      if (packageTypeFilter !== 'all' && pkg.type?.name !== packageTypeFilter) return false
      if (!packageSearch.trim()) return true
      const search = packageSearch.toLowerCase()
      return (
        pkg.tag_id.toLowerCase().includes(search) ||
        pkg.batch.toLowerCase().includes(search) ||
        pkg.strain.toLowerCase().includes(search) ||
        pkg.type?.name?.toLowerCase().includes(search)
      )
    })
    .sort((a, b) => {
      if (!packageSortColumn) return 0
      const dir = packageSortDirection === 'asc' ? 1 : -1
      let aVal: string | number
      let bVal: string | number
      switch (packageSortColumn) {
        case 'tag_id':
          aVal = a.tag_id
          bVal = b.tag_id
          break
        case 'batch':
          aVal = a.batch
          bVal = b.batch
          break
        case 'strain':
          aVal = a.strain
          bVal = b.strain
          break
        case 'type':
          aVal = a.type?.name || ''
          bVal = b.type?.name || ''
          break
        case 'weight':
          aVal = a.current_weight
          bVal = b.current_weight
          break
      }
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return (aVal - bVal) * dir
      }
      return String(aVal).localeCompare(String(bVal)) * dir
    })

  const allFilteredPackagesSelected =
    filteredPackages.length > 0 && filteredPackages.every(pkg => selectedPackageIds.has(pkg.tag_id))

  // Distinct strain options present in the loaded batches
  const batchStrainOptions = Array.from(
    new Set(batches.map(b => b.strain?.name).filter((name): name is string => !!name))
  ).sort()

  // Filter batches by status + strain
  const filteredBatches = batches
    .filter(b => {
      if (batchStatusFilter === 'active' && !b.is_active) return false
      if (batchStatusFilter === 'inactive' && b.is_active) return false
      if (batchStrainFilter !== 'all' && b.strain?.name !== batchStrainFilter) return false
      return true
    })
    .sort((a, b) => {
      if (!batchSortColumn) return 0
      const dir = batchSortDirection === 'asc' ? 1 : -1
      let aVal: string | number
      let bVal: string | number
      switch (batchSortColumn) {
        case 'name':
          aVal = a.name
          bVal = b.name
          break
        case 'strain':
          aVal = a.strain?.name || ''
          bVal = b.strain?.name || ''
          break
        case 'thc':
          aVal = a.thc_percentage ?? -1
          bVal = b.thc_percentage ?? -1
          break
        case 'terpenes':
          aVal = a.terpenes_percentage ?? -1
          bVal = b.terpenes_percentage ?? -1
          break
        case 'cannabinoids':
          aVal = a.total_cannabinoids_percentage ?? -1
          bVal = b.total_cannabinoids_percentage ?? -1
          break
        case 'status':
          aVal = a.is_active ? 1 : 0
          bVal = b.is_active ? 1 : 0
          break
        case 'created_at':
          aVal = new Date(a.created_at).getTime()
          bVal = new Date(b.created_at).getTime()
          break
      }
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return (aVal - bVal) * dir
      }
      return String(aVal).localeCompare(String(bVal)) * dir
    })

  const allFilteredBatchesSelected =
    filteredBatches.length > 0 && filteredBatches.every(b => selectedBatchIds.has(b.id))

  // Strain handlers
  function openStrainDialog(strain?: Strain) {
    if (strain) {
      setEditingStrain(strain)
      setStrainName(strain.name)
    } else {
      setEditingStrain(null)
      setStrainName('')
    }
    setStrainError('')
    setStrainDialogOpen(true)
  }

  async function handleSaveStrain() {
    setStrainSaving(true)
    setStrainError('')

    let result
    if (editingStrain) {
      result = await updateStrain(editingStrain.id, strainName)
    } else {
      result = await createStrain(strainName)
    }

    if (result.success) {
      setStrainDialogOpen(false)
      loadStrains()
    } else {
      setStrainError(result.error || 'Failed to save strain')
    }
    setStrainSaving(false)
  }

  async function handleDeleteStrain() {
    if (!deleteStrainId) return
    setStrainDeleting(true)
    const result = await deleteStrain(deleteStrainId)
    if (result.success) {
      loadStrains()
    } else {
      alert(result.error || 'Failed to delete strain')
    }
    setDeleteStrainId(null)
    setStrainDeleting(false)
  }

  // Batch handlers
  function openBatchDialog(batch?: Batch) {
    setBatchDialogMode(batch ? 'edit' : 'create')
    if (batch) {
      setEditingBatch(batch)
      setBatchName(batch.name)
      setBatchStrainId(batch.strain_id)
      setBatchThc(batch.thc_percentage != null ? String(batch.thc_percentage) : '')
      setBatchTerpenes(batch.terpenes_percentage != null ? String(batch.terpenes_percentage) : '')
      setBatchTotalCannabinoids(
        batch.total_cannabinoids_percentage != null ? String(batch.total_cannabinoids_percentage) : ''
      )
      setExistingCoa(
        batch.coa_url ? { url: batch.coa_url, filename: batch.coa_filename || 'lab-results.pdf' } : null
      )
    } else {
      setEditingBatch(null)
      setBatchName('')
      setBatchStrainId('')
      setBatchThc('')
      setBatchTerpenes('')
      setBatchTotalCannabinoids('')
      setExistingCoa(null)
    }
    setCoaFile(null)
    setBatchError('')
    setBatchDialogOpen(true)
  }

  function handleCoaFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) {
      setCoaFile(null)
      return
    }

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!isPdf) {
      setBatchError('Only PDF files are supported')
      e.target.value = ''
      setCoaFile(null)
      return
    }

    if (file.size > MAX_COA_BYTES) {
      setBatchError('COA file must be 20 MB or smaller')
      e.target.value = ''
      setCoaFile(null)
      return
    }

    setBatchError('')
    setCoaFile(file)
  }

  async function handleRemoveExistingCoa() {
    if (!editingBatch) return
    setCoaUploading(true)
    const result = await removeBatchCoa(editingBatch.id)
    if (result.success) {
      setExistingCoa(null)
      // Replace the in-dialog batch with the fresh (coa-less) row so a
      // subsequent save/reopen can't resurrect the stale coa_url, and
      // refresh the table now — the dialog may be dismissed via Cancel
      // (no loadBatches() call on that path), which would otherwise leave
      // a dead COA link showing in the batch table.
      if (result.batch) {
        setEditingBatch(result.batch)
      }
      loadBatches()
    } else {
      setBatchError(result.error || 'Failed to remove COA')
    }
    setCoaUploading(false)
  }

  async function handleSaveBatch() {
    setBatchSaving(true)
    setBatchError('')

    const testing = {
      thcPercentage: batchThc,
      terpenesPercentage: batchTerpenes,
      totalCannabinoidsPercentage: batchTotalCannabinoids,
    }

    let result
    if (editingBatch) {
      result = await updateBatch(editingBatch.id, batchName, batchStrainId, testing)
    } else {
      result = await createBatch(batchName, batchStrainId, testing)
    }

    setBatchSaving(false)

    if (!result.success || !result.batch) {
      setBatchError(result.error || 'Failed to save batch')
      return
    }

    // Promote the dialog into edit mode against the row that was just
    // created/updated. Without this, retrying a failed COA upload below
    // (on the create path) would re-run createBatch with the same name and
    // fail with "Batch already exists" — a dead end for the user. The
    // dialog's title/button label are keyed off `batchDialogMode`, not
    // `editingBatch`, so this doesn't flip the label mid-flow.
    setEditingBatch(result.batch)
    setExistingCoa(
      result.batch.coa_url
        ? { url: result.batch.coa_url, filename: result.batch.coa_filename || 'lab-results.pdf' }
        : null
    )

    if (!coaFile) {
      setBatchDialogOpen(false)
      loadBatches()
      return
    }

    // The batch itself is saved at this point — if anything below fails we
    // must not close the dialog, so the user knows to just retry the upload.
    setCoaUploading(true)
    const batchId = result.batch.id

    const uploadUrlResult = await createBatchCoaUploadUrl(batchId, coaFile.name)
    if (!uploadUrlResult.success || !uploadUrlResult.path || !uploadUrlResult.token) {
      setCoaUploading(false)
      setBatchError(`Batch saved, but the COA upload failed: ${uploadUrlResult.error || 'Could not start upload'}`)
      return
    }

    const supabase = createClient()
    const { error: uploadError } = await supabase.storage
      .from('lab-results')
      .uploadToSignedUrl(uploadUrlResult.path, uploadUrlResult.token, coaFile, {
        contentType: 'application/pdf',
      })

    if (uploadError) {
      setCoaUploading(false)
      setBatchError(`Batch saved, but the COA upload failed: ${uploadError.message}`)
      return
    }

    const attachResult = await attachBatchCoa(batchId, uploadUrlResult.path, coaFile.name)
    setCoaUploading(false)

    if (!attachResult.success) {
      setBatchError(`Batch saved, but the COA upload failed: ${attachResult.error || 'Could not attach file'}`)
      return
    }

    setBatchDialogOpen(false)
    loadBatches()
  }

  async function handleDeleteBatch() {
    if (!deleteBatchId) return
    setBatchDeleting(true)
    const result = await deleteBatch(deleteBatchId)
    if (result.success) {
      loadBatches()
    } else {
      alert(result.error || 'Failed to delete batch')
    }
    setDeleteBatchId(null)
    setBatchDeleting(false)
  }

  async function handleToggleBatchActive(batch: Batch) {
    setTogglingBatchId(batch.id)
    const result = await toggleBatchActive(batch.id, !batch.is_active)
    if (result.success) {
      loadBatches()
    } else {
      alert(result.error || 'Failed to toggle batch status')
    }
    setTogglingBatchId(null)
  }

  function handleBatchSort(column: 'name' | 'strain' | 'thc' | 'terpenes' | 'cannabinoids' | 'status' | 'created_at') {
    if (batchSortColumn === column) {
      setBatchSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setBatchSortColumn(column)
      setBatchSortDirection('asc')
    }
  }

  function toggleBatchSelected(id: string) {
    setSelectedBatchIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function toggleSelectAllBatches() {
    setSelectedBatchIds(prev => {
      const allSelected = filteredBatches.length > 0 && filteredBatches.every(b => prev.has(b.id))
      if (allSelected) {
        return new Set()
      }
      return new Set(filteredBatches.map(b => b.id))
    })
  }

  async function handleBulkToggleBatchActive(isActive: boolean) {
    const ids = Array.from(selectedBatchIds)
    if (ids.length === 0) return
    setBulkBatchActionLoading(true)
    const result = await bulkToggleBatchActive(ids, isActive)
    loadBatches()
    setSelectedBatchIds(new Set())
    setBulkBatchActionLoading(false)
    if (!result.success) {
      alert(result.error || 'Failed to update batches')
    }
  }

  // Product Type handlers
  function openTypeDialog(type?: ProductType) {
    if (type) {
      setEditingType(type)
      setTypeName(type.name)
    } else {
      setEditingType(null)
      setTypeName('')
    }
    setTypeError('')
    setTypeDialogOpen(true)
  }

  async function handleSaveType() {
    setTypeSaving(true)
    setTypeError('')

    let result
    if (editingType) {
      result = await updateProductType(editingType.id, typeName)
    } else {
      result = await createProductType(typeName)
    }

    if (result.success) {
      setTypeDialogOpen(false)
      loadProductTypes()
    } else {
      setTypeError(result.error || 'Failed to save product type')
    }
    setTypeSaving(false)
  }

  async function handleDeleteType() {
    if (!deleteTypeId) return
    setTypeDeleting(true)
    const result = await deleteProductType(deleteTypeId)
    if (result.success) {
      loadProductTypes()
    } else {
      alert(result.error || 'Failed to delete product type')
    }
    setDeleteTypeId(null)
    setTypeDeleting(false)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Vault Administration</h1>
        <p className="text-muted-foreground">
          Manage strains, batches, and product types
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-nowrap justify-start gap-1 overflow-x-auto scroll-smooth scrollbar-hide w-full">
          <TabsTrigger value="strains" className="shrink-0">Strains</TabsTrigger>
          <TabsTrigger value="batches" className="shrink-0">Batches</TabsTrigger>
          <TabsTrigger value="types" className="shrink-0">Product Types</TabsTrigger>
          <TabsTrigger value="packages" className="shrink-0">Package Tags</TabsTrigger>
        </TabsList>

        {/* Strains Tab */}
        <TabsContent value="strains" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between space-y-0 gap-3 pb-4">
              <div>
                <CardTitle>Strains</CardTitle>
                <CardDescription>Manage cannabis strains in the system</CardDescription>
              </div>
              <Button onClick={() => openStrainDialog()} className="w-full sm:w-auto">
                <Plus className="mr-2 h-4 w-4" />
                Add Strain
              </Button>
            </CardHeader>
            <CardContent>
              {strainsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead className="hidden sm:table-cell">Created</TableHead>
                        <TableHead className="w-[100px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {strains.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={3} className="text-center text-muted-foreground">
                            No strains found
                          </TableCell>
                        </TableRow>
                      ) : (
                        strains.map((strain) => (
                          <TableRow key={strain.id}>
                            <TableCell className="font-medium">{strain.name}</TableCell>
                            <TableCell className="hidden sm:table-cell">
                              {new Date(strain.created_at).toLocaleDateString()}
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-2">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => openStrainDialog(strain)}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setDeleteStrainId(strain.id)}
                                >
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Batches Tab */}
        <TabsContent value="batches" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between space-y-0 gap-3 pb-4">
              <div>
                <CardTitle>Batches</CardTitle>
                <CardDescription>Manage product batches and their associated strains</CardDescription>
              </div>
              <Button onClick={() => openBatchDialog()} className="w-full sm:w-auto">
                <Plus className="mr-2 h-4 w-4" />
                Add Batch
              </Button>
            </CardHeader>
            <CardContent>
              <div className="mb-4 flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3">
                <Select
                  value={batchStatusFilter}
                  onValueChange={(value) => setBatchStatusFilter(value as 'all' | 'active' | 'inactive')}
                >
                  <SelectTrigger className="w-full sm:w-[150px]">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={batchStrainFilter} onValueChange={setBatchStrainFilter}>
                  <SelectTrigger className="w-full sm:w-[180px]">
                    <SelectValue placeholder="Strain" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Strains</SelectItem>
                    {batchStrainOptions.map((strainName) => (
                      <SelectItem key={strainName} value={strainName}>
                        {strainName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedBatchIds.size > 0 && (
                <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 rounded-md border bg-muted/50 px-4 py-3">
                  <span className="text-sm text-muted-foreground">
                    {selectedBatchIds.size} batch{selectedBatchIds.size === 1 ? '' : 'es'} selected
                  </span>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleBulkToggleBatchActive(true)}
                      disabled={bulkBatchActionLoading}
                    >
                      {bulkBatchActionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Activate selected
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleBulkToggleBatchActive(false)}
                      disabled={bulkBatchActionLoading}
                    >
                      {bulkBatchActionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Deactivate selected
                    </Button>
                  </div>
                </div>
              )}

              {batchesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[40px]">
                          <Checkbox
                            checked={allFilteredBatchesSelected}
                            onCheckedChange={toggleSelectAllBatches}
                            aria-label="Select all"
                          />
                        </TableHead>
                        <TableHead>
                          <button
                            type="button"
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handleBatchSort('name')}
                          >
                            Name
                            {batchSortColumn === 'name' ? (
                              batchSortDirection === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead>
                          <button
                            type="button"
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handleBatchSort('strain')}
                          >
                            Strain
                            {batchSortColumn === 'strain' ? (
                              batchSortDirection === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead>
                          <button
                            type="button"
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handleBatchSort('thc')}
                          >
                            THC %
                            {batchSortColumn === 'thc' ? (
                              batchSortDirection === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead className="hidden sm:table-cell">
                          <button
                            type="button"
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handleBatchSort('terpenes')}
                          >
                            Terpenes %
                            {batchSortColumn === 'terpenes' ? (
                              batchSortDirection === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead className="hidden md:table-cell">
                          <button
                            type="button"
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handleBatchSort('cannabinoids')}
                          >
                            Total Cannabinoids %
                            {batchSortColumn === 'cannabinoids' ? (
                              batchSortDirection === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead className="hidden md:table-cell">COA</TableHead>
                        <TableHead>
                          <button
                            type="button"
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handleBatchSort('status')}
                          >
                            Status
                            {batchSortColumn === 'status' ? (
                              batchSortDirection === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead className="hidden sm:table-cell">
                          <button
                            type="button"
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handleBatchSort('created_at')}
                          >
                            Created
                            {batchSortColumn === 'created_at' ? (
                              batchSortDirection === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead className="w-[120px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredBatches.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={10} className="text-center text-muted-foreground">
                            {batches.length === 0 ? 'No batches found' : 'No batches match your filters'}
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredBatches.map((batch) => (
                          <TableRow key={batch.id} className={!batch.is_active ? 'opacity-60' : ''}>
                            <TableCell>
                              <Checkbox
                                checked={selectedBatchIds.has(batch.id)}
                                onCheckedChange={() => toggleBatchSelected(batch.id)}
                                aria-label={`Select ${batch.name}`}
                              />
                            </TableCell>
                            <TableCell className="font-medium">{batch.name}</TableCell>
                            <TableCell>{batch.strain?.name || '-'}</TableCell>
                            <TableCell>{formatPercent(batch.thc_percentage)}</TableCell>
                            <TableCell className="hidden sm:table-cell">{formatPercent(batch.terpenes_percentage)}</TableCell>
                            <TableCell className="hidden md:table-cell">{formatPercent(batch.total_cannabinoids_percentage)}</TableCell>
                            <TableCell className="hidden md:table-cell">
                              {batch.coa_url ? (
                                <a
                                  href={batch.coa_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={batch.coa_filename || 'View lab results'}
                                  className="inline-flex text-primary hover:text-primary/80"
                                >
                                  <FileText className="h-4 w-4" />
                                </a>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                                batch.is_active
                                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                                  : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                              }`}>
                                {batch.is_active ? 'Active' : 'Inactive'}
                              </span>
                            </TableCell>
                            <TableCell className="hidden sm:table-cell">
                              {new Date(batch.created_at).toLocaleDateString()}
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleToggleBatchActive(batch)}
                                  disabled={togglingBatchId === batch.id}
                                  title={batch.is_active ? 'Deactivate batch' : 'Activate batch'}
                                >
                                  {togglingBatchId === batch.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : batch.is_active ? (
                                    <ToggleRight className="h-4 w-4 text-green-600" />
                                  ) : (
                                    <ToggleLeft className="h-4 w-4 text-gray-400" />
                                  )}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => openBatchDialog(batch)}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setDeleteBatchId(batch.id)}
                                >
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Product Types Tab */}
        <TabsContent value="types" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between space-y-0 gap-3 pb-4">
              <div>
                <CardTitle>Product Types</CardTitle>
                <CardDescription>Manage product types (e.g., Flower, Concentrate)</CardDescription>
              </div>
              <Button onClick={() => openTypeDialog()} className="w-full sm:w-auto">
                <Plus className="mr-2 h-4 w-4" />
                Add Type
              </Button>
            </CardHeader>
            <CardContent>
              {typesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead className="hidden sm:table-cell">Created</TableHead>
                        <TableHead className="w-[100px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {productTypes.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={3} className="text-center text-muted-foreground">
                            No product types found
                          </TableCell>
                        </TableRow>
                      ) : (
                        productTypes.map((type) => (
                          <TableRow key={type.id}>
                            <TableCell className="font-medium">{type.name}</TableCell>
                            <TableCell className="hidden sm:table-cell">
                              {new Date(type.created_at).toLocaleDateString()}
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-2">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => openTypeDialog(type)}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setDeleteTypeId(type.id)}
                                >
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Package Tags Tab */}
        <TabsContent value="packages" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
              <div>
                <CardTitle>Package Tags</CardTitle>
                <CardDescription>Manage package tag activation status. Deactivated tags are hidden from lists but preserved in the system.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <div className="mb-4 flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3">
                <Input
                  placeholder="Search by tag ID, batch, strain, or type..."
                  value={packageSearch}
                  onChange={(e) => setPackageSearch(e.target.value)}
                  className="w-full sm:max-w-sm"
                />
                <Select
                  value={packageStatusFilter}
                  onValueChange={(value) => setPackageStatusFilter(value as 'all' | 'active' | 'inactive')}
                >
                  <SelectTrigger className="w-full sm:w-[150px]">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={packageStrainFilter} onValueChange={setPackageStrainFilter}>
                  <SelectTrigger className="w-full sm:w-[180px]">
                    <SelectValue placeholder="Strain" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Strains</SelectItem>
                    {packageStrainOptions.map((strainName) => (
                      <SelectItem key={strainName} value={strainName}>
                        {strainName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={packageTypeFilter} onValueChange={setPackageTypeFilter}>
                  <SelectTrigger className="w-full sm:w-[180px]">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {packageTypeOptions.map((typeName) => (
                      <SelectItem key={typeName} value={typeName}>
                        {typeName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedPackageIds.size > 0 && (
                <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 rounded-md border bg-muted/50 px-4 py-3">
                  <span className="text-sm text-muted-foreground">
                    {selectedPackageIds.size} tag{selectedPackageIds.size === 1 ? '' : 's'} selected
                  </span>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleBulkTogglePackageActive(true)}
                      disabled={bulkPackageActionLoading}
                    >
                      {bulkPackageActionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Activate selected
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleBulkTogglePackageActive(false)}
                      disabled={bulkPackageActionLoading}
                    >
                      {bulkPackageActionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Deactivate selected
                    </Button>
                  </div>
                </div>
              )}

              {packagesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[40px]">
                          <Checkbox
                            checked={allFilteredPackagesSelected}
                            onCheckedChange={toggleSelectAllPackages}
                            aria-label="Select all"
                          />
                        </TableHead>
                        <TableHead>
                          <button
                            type="button"
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handlePackageSort('tag_id')}
                          >
                            Tag ID
                            {packageSortColumn === 'tag_id' ? (
                              packageSortDirection === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead>
                          <button
                            type="button"
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handlePackageSort('batch')}
                          >
                            Batch
                            {packageSortColumn === 'batch' ? (
                              packageSortDirection === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead>
                          <button
                            type="button"
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handlePackageSort('strain')}
                          >
                            Strain
                            {packageSortColumn === 'strain' ? (
                              packageSortDirection === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead className="hidden sm:table-cell">
                          <button
                            type="button"
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handlePackageSort('type')}
                          >
                            Type
                            {packageSortColumn === 'type' ? (
                              packageSortDirection === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead className="hidden md:table-cell">
                          <button
                            type="button"
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handlePackageSort('weight')}
                          >
                            Weight
                            {packageSortColumn === 'weight' ? (
                              packageSortDirection === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="w-[80px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredPackages.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="text-center text-muted-foreground">
                            {packageSearch ? 'No packages match your search' : 'No packages found'}
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredPackages.map((pkg) => (
                          <TableRow key={pkg.tag_id} className={!pkg.is_active ? 'opacity-60' : ''}>
                            <TableCell>
                              <Checkbox
                                checked={selectedPackageIds.has(pkg.tag_id)}
                                onCheckedChange={() => togglePackageSelected(pkg.tag_id)}
                                aria-label={`Select ${pkg.tag_id}`}
                              />
                            </TableCell>
                            <TableCell className="font-mono text-sm whitespace-nowrap">{pkg.tag_id}</TableCell>
                            <TableCell>{pkg.batch}</TableCell>
                            <TableCell>{pkg.strain}</TableCell>
                            <TableCell className="hidden sm:table-cell">{pkg.type?.name || '-'}</TableCell>
                            <TableCell className="hidden md:table-cell">{pkg.current_weight.toFixed(2)}g</TableCell>
                            <TableCell>
                              <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                                pkg.is_active
                                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                                  : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                              }`}>
                                {pkg.is_active ? 'Active' : 'Inactive'}
                              </span>
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleTogglePackageActive(pkg)}
                                disabled={togglingPackageId === pkg.tag_id}
                                title={pkg.is_active ? 'Deactivate tag' : 'Activate tag'}
                              >
                                {togglingPackageId === pkg.tag_id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : pkg.is_active ? (
                                  <ToggleRight className="h-4 w-4 text-green-600" />
                                ) : (
                                  <ToggleLeft className="h-4 w-4 text-gray-400" />
                                )}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Strain Dialog */}
      <Dialog open={strainDialogOpen} onOpenChange={setStrainDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingStrain ? 'Edit Strain' : 'Add Strain'}</DialogTitle>
            <DialogDescription>
              {editingStrain ? 'Update the strain name.' : 'Enter a name for the new strain.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="strainName">Name</Label>
              <Input
                id="strainName"
                value={strainName}
                onChange={(e) => setStrainName(e.target.value)}
                placeholder="e.g., Blue Dream"
              />
            </div>
            {strainError && (
              <p className="text-sm text-destructive">{strainError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStrainDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveStrain} disabled={strainSaving || !strainName.trim()}>
              {strainSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editingStrain ? 'Save Changes' : 'Add Strain'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Strain Alert */}
      <AlertDialog open={!!deleteStrainId} onOpenChange={() => setDeleteStrainId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Strain?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. Strains that are in use by packages cannot be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteStrain}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {strainDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Batch Dialog */}
      <Dialog open={batchDialogOpen} onOpenChange={setBatchDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{batchDialogMode === 'edit' ? 'Edit Batch' : 'Add Batch'}</DialogTitle>
            <DialogDescription>
              {batchDialogMode === 'edit' ? 'Update the batch details.' : 'Enter details for the new batch.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="batchName">Name</Label>
              <Input
                id="batchName"
                value={batchName}
                onChange={(e) => setBatchName(e.target.value)}
                placeholder="e.g., BD-2024-01"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="batchStrain">Strain</Label>
              <Select value={batchStrainId} onValueChange={setBatchStrainId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a strain" />
                </SelectTrigger>
                <SelectContent>
                  {strains.map((strain) => (
                    <SelectItem key={strain.id} value={strain.id}>
                      {strain.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="batchThc">THC %</Label>
                <Input
                  id="batchThc"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  max="100"
                  value={batchThc}
                  onChange={(e) => setBatchThc(e.target.value)}
                  placeholder="e.g., 22.50"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="batchTerpenes">Terpenes %</Label>
                <Input
                  id="batchTerpenes"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  max="100"
                  value={batchTerpenes}
                  onChange={(e) => setBatchTerpenes(e.target.value)}
                  placeholder="e.g., 1.80"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="batchTotalCannabinoids">Total Cannabinoids %</Label>
                <Input
                  id="batchTotalCannabinoids"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  max="100"
                  value={batchTotalCannabinoids}
                  onChange={(e) => setBatchTotalCannabinoids(e.target.value)}
                  placeholder="e.g., 25.00"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Lab Results (COA)</Label>
              {existingCoa && !coaFile && (
                <div className="flex items-center justify-between gap-2 rounded-md border p-2">
                  <a
                    href={existingCoa.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-primary hover:underline truncate"
                  >
                    <FileText className="h-4 w-4 shrink-0" />
                    <span className="truncate">{existingCoa.filename}</span>
                  </a>
                  {editingBatch && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleRemoveExistingCoa}
                      disabled={coaUploading}
                    >
                      <X className="mr-1 h-3.5 w-3.5" />
                      Remove
                    </Button>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2">
                <Input
                  id="batchCoa"
                  type="file"
                  accept="application/pdf"
                  onChange={handleCoaFileChange}
                  className="text-sm"
                />
              </div>
              {coaFile ? (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Upload className="h-3 w-3" />
                  {existingCoa ? 'Will replace with: ' : 'Staged: '}
                  {coaFile.name}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {existingCoa ? 'Choose a file to replace the current COA.' : 'PDF only, up to 20 MB.'}
                </p>
              )}
            </div>
            {batchError && (
              <p className="text-sm text-destructive">{batchError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveBatch}
              disabled={batchSaving || coaUploading || !batchName.trim() || !batchStrainId}
            >
              {(batchSaving || coaUploading) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {coaUploading ? 'Uploading…' : batchDialogMode === 'edit' ? 'Save Changes' : 'Add Batch'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Batch Alert */}
      <AlertDialog open={!!deleteBatchId} onOpenChange={() => setDeleteBatchId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Batch?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. Batches that are in use by packages cannot be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteBatch}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {batchDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Product Type Dialog */}
      <Dialog open={typeDialogOpen} onOpenChange={setTypeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingType ? 'Edit Product Type' : 'Add Product Type'}</DialogTitle>
            <DialogDescription>
              {editingType ? 'Update the product type name.' : 'Enter a name for the new product type.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="typeName">Name</Label>
              <Input
                id="typeName"
                value={typeName}
                onChange={(e) => setTypeName(e.target.value)}
                placeholder="e.g., Flower"
              />
            </div>
            {typeError && (
              <p className="text-sm text-destructive">{typeError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTypeDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveType} disabled={typeSaving || !typeName.trim()}>
              {typeSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editingType ? 'Save Changes' : 'Add Type'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Product Type Alert */}
      <AlertDialog open={!!deleteTypeId} onOpenChange={() => setDeleteTypeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Product Type?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. Product types that are in use by packages cannot be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteType}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {typeDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
