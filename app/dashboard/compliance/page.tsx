'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@/lib/auth-context'
import {
  getComplianceEntries,
  createComplianceEntry,
  updateComplianceEntry,
  deleteComplianceEntry,
} from '@/actions/compliance'
import type { ComplianceEntry } from '@/actions/compliance'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
import { Plus, Search, Edit2, Trash2, Printer, ExternalLink, X } from 'lucide-react'
import { format } from 'date-fns'
import { DatePresetFilter } from '@/components/filters/date-preset-filter'
import {
  COMPLIANCE_DATE_PRESETS,
  isWithinDateRange,
  resolveDatePresetRange,
  type DatePresetKey,
} from '@/lib/date-filters'

const REPORT_TYPES = [
  { value: 'plant_movement', label: 'Plant Movement' },
  { value: 'destruction', label: 'Destruction' },
  { value: 'package_adjustment', label: 'Package Adjustment' },
  { value: 'harvest', label: 'Harvest' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'waste_disposal', label: 'Waste Disposal' },
  { value: 'other', label: 'Other' },
]

const METRC_LICENSE_ID = 'GAAI-BSOT-FUQO'

const getMetrcUrl = (tagId: string) => {
  return `https://ok.metrc.com/industry/${METRC_LICENSE_ID}/packages?shortcut=dynamicLink&type=Package&field=Label&value=${encodeURIComponent(tagId)}&tab=packages`
}

const REPORT_TYPE_COLORS: Record<string, string> = {
  plant_movement: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  destruction: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  package_adjustment: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  harvest: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  transfer: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  waste_disposal: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  other: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200',
}

function getReportTypeLabel(type: string, customType?: string | null): string {
  if (type === 'other' && customType) return customType
  return REPORT_TYPES.find(t => t.value === type)?.label || type
}

function getReportTypeBadgeClass(type: string): string {
  return REPORT_TYPE_COLORS[type] || REPORT_TYPE_COLORS.other
}

interface FormData {
  report_type: string
  custom_report_type: string
  event_date: string
  summary: string
  metrc_ids_text: string
  location: string
  witness: string
}

const emptyForm: FormData = {
  report_type: 'plant_movement',
  custom_report_type: '',
  event_date: new Date().toISOString().slice(0, 16),
  summary: '',
  metrc_ids_text: '',
  location: '',
  witness: '',
}

export default function CompliancePage() {
  const [entries, setEntries] = useState<ComplianceEntry[]>([])
  const [filteredEntries, setFilteredEntries] = useState<ComplianceEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterType, setFilterType] = useState('all')
  const [filterDatePreset, setFilterDatePreset] = useState<DatePresetKey>('all')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingEntry, setEditingEntry] = useState<ComplianceEntry | null>(null)
  const [form, setForm] = useState<FormData>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteEntryId, setDeleteEntryId] = useState<string | null>(null)

  const { user } = useAuth()
  const userRole = user?.role || 'standard'
  const canManage = userRole === 'admin' || userRole === 'management'

  const fetchEntries = useCallback(async () => {
    try {
      const result = await getComplianceEntries()
      if (result.error) {
        console.error('Error fetching compliance log:', result.error)
        return
      }
      setEntries(result.data ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!user) return
    fetchEntries()
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const applyFilters = useCallback(() => {
    let filtered = [...entries]

    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      filtered = filtered.filter(entry =>
        entry.summary?.toLowerCase().includes(term) ||
        entry.location?.toLowerCase().includes(term) ||
        entry.report_type?.toLowerCase().includes(term) ||
        entry.custom_report_type?.toLowerCase().includes(term) ||
        entry.metrc_ids?.some(id => id.toLowerCase().includes(term))
      )
    }

    if (filterType !== 'all') {
      filtered = filtered.filter(entry => entry.report_type === filterType)
    }

    // Filter by event date, using the selected preset (or the custom from/to
    // dates when the preset is 'custom'). event_date is a timestamp, so
    // membership is decided on its local calendar day — that keeps the whole of
    // the selected end date in range, including its final second.
    const eventDateRange = resolveDatePresetRange(filterDatePreset, {
      from: filterDateFrom,
      to: filterDateTo,
    })
    if (eventDateRange.dateFrom || eventDateRange.dateTo) {
      filtered = filtered.filter(entry => isWithinDateRange(entry.event_date, eventDateRange))
    }

    setFilteredEntries(filtered)
  }, [entries, searchTerm, filterType, filterDatePreset, filterDateFrom, filterDateTo])

  useEffect(() => {
    applyFilters()
  }, [applyFilters])

  const clearFilters = () => {
    setSearchTerm('')
    setFilterType('all')
    setFilterDatePreset('all')
    setFilterDateFrom('')
    setFilterDateTo('')
  }

  const hasActiveFilters = searchTerm || filterType !== 'all' || filterDatePreset !== 'all'

  // Sheet handlers
  const openCreateSheet = () => {
    setEditingEntry(null)
    setForm({ ...emptyForm, event_date: new Date().toISOString().slice(0, 16) })
    setSheetOpen(true)
  }

  const openEditSheet = (entry: ComplianceEntry) => {
    setEditingEntry(entry)
    setForm({
      report_type: entry.report_type,
      custom_report_type: entry.custom_report_type || '',
      event_date: new Date(entry.event_date).toISOString().slice(0, 16),
      summary: entry.summary,
      metrc_ids_text: (entry.metrc_ids || []).join('\n'),
      location: entry.location || '',
      witness: entry.witness || '',
    })
    setSheetOpen(true)
  }

  const parseMetrcIds = (text: string): string[] => {
    return text
      .split(/[\n,]+/)
      .map(id => id.trim())
      .filter(id => id.length > 0)
  }

  const handleSubmit = async () => {
    if (!form.summary.trim() || !form.event_date) return

    setSaving(true)
    try {
      const metrcIds = parseMetrcIds(form.metrc_ids_text)
      const payload = {
        event_date: form.event_date,
        report_type: form.report_type,
        custom_report_type: form.report_type === 'other' ? form.custom_report_type || null : null,
        summary: form.summary.trim(),
        metrc_ids: metrcIds,
        location: form.location.trim() || null,
        witness: form.witness.trim() || null,
        metadata: {},
      }

      let result: { error?: string }
      if (editingEntry) {
        result = await updateComplianceEntry(editingEntry.id, payload)
      } else {
        result = await createComplianceEntry(payload)
      }

      if (result.error) {
        alert('Error saving compliance entry: ' + result.error)
        return
      }

      setSheetOpen(false)
      setEditingEntry(null)
      setForm(emptyForm)
      fetchEntries()
    } finally {
      setSaving(false)
    }
  }

  // Delete handlers
  const confirmDelete = (id: string) => {
    setDeleteEntryId(id)
    setDeleteDialogOpen(true)
  }

  const handleDelete = async () => {
    if (!deleteEntryId) return

    const result = await deleteComplianceEntry(deleteEntryId)
    if (result.error) {
      alert('Error deleting entry: ' + result.error)
      return
    }
    setDeleteDialogOpen(false)
    setDeleteEntryId(null)
    fetchEntries()
  }

  // Print handler
  const handlePrint = (entry: ComplianceEntry) => {
    const printWindow = window.open('', '_blank')
    if (!printWindow) return

    printWindow.document.write(`
      <html>
      <head>
        <title>Compliance Report - ${entry.id.slice(0, 8)}</title>
        <style>
          body { font-family: system-ui, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; }
          h1 { font-size: 24px; margin-bottom: 8px; }
          .subtitle { color: #666; margin-bottom: 24px; }
          .field { margin-bottom: 16px; }
          .label { font-weight: 600; font-size: 14px; color: #444; margin-bottom: 4px; }
          .value { font-size: 16px; }
          .summary { white-space: pre-wrap; line-height: 1.6; }
          .metrc-ids { display: flex; gap: 8px; flex-wrap: wrap; }
          .metrc-id { background: #f0f0f0; padding: 4px 8px; border-radius: 4px; font-family: monospace; }
          .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 12px; color: #888; }
          @media print { body { padding: 20px; } }
        </style>
      </head>
      <body>
        <h1>CAKE Compliance Report</h1>
        <div class="subtitle">Oklahoma Medical Marijuana Authority</div>

        <div class="field">
          <div class="label">Report Type</div>
          <div class="value">${getReportTypeLabel(entry.report_type, entry.custom_report_type)}</div>
        </div>

        <div class="field">
          <div class="label">Event Date</div>
          <div class="value">${new Date(entry.event_date).toLocaleString()}</div>
        </div>

        <div class="field">
          <div class="label">Logged By</div>
          <div class="value">${entry.logged_by_user?.name || 'Unknown'}</div>
        </div>

        ${entry.location ? `<div class="field"><div class="label">Location</div><div class="value">${entry.location}</div></div>` : ''}

        ${entry.witness ? `<div class="field"><div class="label">Witness</div><div class="value">${entry.witness}</div></div>` : ''}

        ${entry.metrc_ids?.length ? `<div class="field"><div class="label">Metrc IDs</div><div class="metrc-ids">${entry.metrc_ids.map(id => `<a href="${getMetrcUrl(id)}" target="_blank" rel="noopener noreferrer" class="metrc-id" style="text-decoration:none;color:inherit;">${id}</a>`).join('')}</div></div>` : ''}

        <div class="field">
          <div class="label">Summary</div>
          <div class="value summary">${entry.summary}</div>
        </div>

        <div class="footer">
          Printed ${new Date().toLocaleString()} | Entry ID: ${entry.id}
          ${entry.is_edited ? ` | Last edited by ${entry.editor?.name || 'Unknown'} on ${new Date(entry.last_edited_at || '').toLocaleString()}` : ''}
        </div>
      </body>
      </html>
    `)
    printWindow.document.close()
    printWindow.print()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading compliance log...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Compliance Log</h1>
          <p className="text-muted-foreground mt-1">OMMA compliance activity tracking</p>
        </div>
        <Button onClick={openCreateSheet}>
          <Plus className="mr-2 h-4 w-4" />
          Log Event
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search entries..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger>
                <SelectValue placeholder="Report Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {REPORT_TYPES.map(type => (
                  <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DatePresetFilter
              value={filterDatePreset}
              onValueChange={setFilterDatePreset}
              presets={COMPLIANCE_DATE_PRESETS}
              customFrom={filterDateFrom}
              customTo={filterDateTo}
              onCustomFromChange={setFilterDateFrom}
              onCustomToChange={setFilterDateTo}
              placeholder="Event date"
              idPrefix="compliance-event-date"
            />
          </div>
          <div className="flex items-center justify-between mt-4">
            <span className="text-sm text-muted-foreground">
              {filteredEntries.length} of {entries.length} entries
            </span>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="mr-1 h-4 w-4" />
                Clear Filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Empty State */}
      {filteredEntries.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No compliance entries found</p>
            <Button className="mt-4" onClick={openCreateSheet}>
              <Plus className="mr-2 h-4 w-4" />
              Log Your First Event
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Desktop Table */}
          <div className="hidden sm:block">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="max-w-[300px]">Summary</TableHead>
                      <TableHead>Metrc IDs</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Logged By</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredEntries.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="whitespace-nowrap">
                          {format(new Date(entry.event_date), 'MMM d, yyyy')}
                          <div className="text-xs text-muted-foreground">
                            {format(new Date(entry.event_date), 'h:mm a')}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getReportTypeBadgeClass(entry.report_type)}`}>
                            {getReportTypeLabel(entry.report_type, entry.custom_report_type)}
                          </span>
                          {entry.is_edited && (
                            <Badge variant="outline" className="ml-1 text-orange-600 text-xs">
                              Edited
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="max-w-[300px]">
                          <p className="truncate">{entry.summary}</p>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {entry.metrc_ids?.slice(0, 3).map((id) => (
                              <a
                                key={id}
                                href={getMetrcUrl(id)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs bg-muted px-2 py-0.5 rounded hover:bg-muted/80"
                              >
                                {id}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ))}
                            {(entry.metrc_ids?.length || 0) > 3 && (
                              <span className="text-xs text-muted-foreground">
                                +{entry.metrc_ids.length - 3} more
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{entry.location || '-'}</TableCell>
                        <TableCell>{entry.logged_by_user?.name || 'Unknown'}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handlePrint(entry)}
                              title="Print"
                            >
                              <Printer className="h-4 w-4" />
                            </Button>
                            {canManage && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => openEditSheet(entry)}
                                  title="Edit"
                                >
                                  <Edit2 className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => confirmDelete(entry.id)}
                                  className="text-red-600 hover:text-red-700"
                                  title="Delete"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          {/* Mobile Cards */}
          <div className="sm:hidden space-y-3">
            {filteredEntries.map((entry) => (
              <Card key={entry.id}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getReportTypeBadgeClass(entry.report_type)}`}>
                        {getReportTypeLabel(entry.report_type, entry.custom_report_type)}
                      </span>
                      {entry.is_edited && (
                        <Badge variant="outline" className="ml-1 text-orange-600 text-xs">
                          Edited
                        </Badge>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(entry.event_date), 'MMM d, yyyy h:mm a')}
                    </span>
                  </div>

                  <p className="text-sm line-clamp-3">{entry.summary}</p>

                  {entry.metrc_ids?.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {entry.metrc_ids.map((id) => (
                        <a
                          key={id}
                          href={getMetrcUrl(id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs bg-muted px-2 py-0.5 rounded hover:bg-muted/80"
                        >
                          {id}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{entry.logged_by_user?.name || 'Unknown'}</span>
                    {entry.location && <span>{entry.location}</span>}
                  </div>

                  <div className="flex items-center gap-1 pt-1 border-t">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handlePrint(entry)}
                    >
                      <Printer className="h-4 w-4 mr-1" />
                      Print
                    </Button>
                    {canManage && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditSheet(entry)}
                        >
                          <Edit2 className="h-4 w-4 mr-1" />
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => confirmDelete(entry.id)}
                          className="text-red-600 hover:text-red-700"
                        >
                          <Trash2 className="h-4 w-4 mr-1" />
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* Create/Edit Sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{editingEntry ? 'Edit Compliance Entry' : 'Log Compliance Event'}</SheetTitle>
            <SheetDescription>
              {editingEntry ? 'Update this compliance log entry.' : 'Record a new OMMA compliance event.'}
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-4 mt-6">
            {/* Report Type */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Report Type *</label>
              <Select
                value={form.report_type}
                onValueChange={(value) => setForm(prev => ({ ...prev, report_type: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_TYPES.map(type => (
                    <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Custom Report Type (when Other selected) */}
            {form.report_type === 'other' && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Custom Type</label>
                <Input
                  value={form.custom_report_type}
                  onChange={(e) => setForm(prev => ({ ...prev, custom_report_type: e.target.value }))}
                  placeholder="Describe the event type..."
                />
              </div>
            )}

            {/* Event Date */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Event Date *</label>
              <Input
                type="datetime-local"
                value={form.event_date}
                onChange={(e) => setForm(prev => ({ ...prev, event_date: e.target.value }))}
              />
            </div>

            {/* Summary */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Summary *</label>
              <Textarea
                value={form.summary}
                onChange={(e) => setForm(prev => ({ ...prev, summary: e.target.value }))}
                placeholder="Describe the compliance event..."
                rows={4}
              />
            </div>

            {/* Metrc IDs */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Metrc IDs</label>
              <Textarea
                value={form.metrc_ids_text}
                onChange={(e) => setForm(prev => ({ ...prev, metrc_ids_text: e.target.value }))}
                placeholder="Enter Metrc tag IDs, one per line or comma-separated"
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                Enter Metrc tag IDs, one per line or comma-separated
              </p>
            </div>

            {/* Location */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Location</label>
              <Input
                value={form.location}
                onChange={(e) => setForm(prev => ({ ...prev, location: e.target.value }))}
                placeholder="e.g., Grow Room A, Processing Lab"
              />
            </div>

            {/* Witness */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Witness</label>
              <Input
                value={form.witness}
                onChange={(e) => setForm(prev => ({ ...prev, witness: e.target.value }))}
                placeholder="Witness name (if applicable)"
              />
            </div>

            {/* Submit */}
            <div className="flex gap-2 pt-4">
              <Button
                onClick={handleSubmit}
                disabled={saving || !form.summary.trim() || !form.event_date}
                className="flex-1"
              >
                {saving ? 'Saving...' : editingEntry ? 'Update Entry' : 'Log Event'}
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

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Compliance Entry</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete this compliance log entry.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
