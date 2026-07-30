'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw, Package2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { OrderAlertBar } from '@/components/packaging/order-alert-bar'
import { BoardColumn } from '@/components/packaging-board/BoardColumn'
import { ClaimSheet } from '@/components/packaging-board/ClaimSheet'
import { getBoardData, getPackagingUsers } from '@/actions/packaging-board'
import { addContainer } from '@/actions/packaging-v2'
import { useAuth } from '@/lib/auth-context'
import type { BoardData, SkuBoardCard, PackagingUser } from '@/lib/packaging/board-types'
import type { ContainerSize } from '@/lib/packaging/types'
import { format } from 'date-fns'

const REFRESH_INTERVAL = 150_000 // 150 seconds

const CONTAINER_SIZES: ContainerSize[] = [8, 4, 3, 2, 1]

export default function PackagingBoardPage() {
  const { user } = useAuth()

  const [boardData, setBoardData] = useState<BoardData | null>(null)
  const [users, setUsers] = useState<PackagingUser[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  // Claim sheet state
  const [claimCard, setClaimCard] = useState<SkuBoardCard | null>(null)
  const [claimSheetOpen, setClaimSheetOpen] = useState(false)

  // Add container sheet state
  const [containerSheetOpen, setContainerSheetOpen] = useState(false)
  const [containerSku, setContainerSku] = useState<string>('')
  const [containerSize, setContainerSize] = useState<ContainerSize>(4)
  const [addingContainer, setAddingContainer] = useState(false)

  // Mobile tab state
  const [activeTab, setActiveTab] = useState<'fill' | 'case' | 'done'>('fill')

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load board data
  const fetchBoard = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true)
    try {
      const data = await getBoardData()
      setBoardData(data)
      setLastUpdated(new Date())
      // Hard failure (not authorized / unexpected crash) — board arrays are
      // empty, so this is toast-worthy. Soft degradation (data.softErrors)
      // is intentionally NOT toasted here: this board runs unattended on
      // the packaging-room TV, polling on a timer with nobody to dismiss
      // toasts, so a persistent soft failure would otherwise stack a red
      // toast on every refresh tick forever. It's surfaced instead as a
      // quiet, persistent indicator below (see the "Degraded" banner).
      if (data.error) {
        toast.error(`Board error: ${data.error}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load board'
      toast.error(msg)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    Promise.all([
      fetchBoard(),
      getPackagingUsers().then(setUsers).catch(() => {}),
    ])
  }, [fetchBoard])

  // Auto-refresh
  useEffect(() => {
    function schedule() {
      refreshTimerRef.current = setTimeout(() => {
        fetchBoard().then(schedule)
      }, REFRESH_INTERVAL)
    }
    schedule()
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [fetchBoard])

  function handleClaimClick(card: SkuBoardCard) {
    setClaimCard(card)
    setClaimSheetOpen(true)
  }

  function handleRefresh() {
    fetchBoard(true)
  }

  // All distinct SKUs from board for container picker
  const allSkus = boardData
    ? Array.from(
        new Set([
          ...boardData.toFillCards.map((c) => c.sku),
          ...boardData.toCaseCards.map((c) => c.sku),
        ])
      ).sort()
    : []

  async function handleAddContainer() {
    if (!containerSku) {
      toast.error('Select a SKU first')
      return
    }
    setAddingContainer(true)
    try {
      const result = await addContainer(containerSku as import('@/lib/packaging/types').SKU, containerSize)
      if (result.success) {
        toast.success(`Added ${containerSize}-unit container for ${containerSku}`)
        setContainerSheetOpen(false)
        fetchBoard()
      } else {
        toast.error(result.error ?? 'Failed to add container')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add container'
      toast.error(msg)
    } finally {
      setAddingContainer(false)
    }
  }

  const toFillCount = boardData?.toFillCards.length ?? 0
  const toCaseCount = boardData?.toCaseCards.length ?? 0
  const doneCount = boardData?.doneItems.length ?? 0

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-2">
          <Package2 className="h-6 w-6 text-amber-500" />
          <h1 className="text-2xl font-bold">Packaging Board</h1>
          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-bold text-amber-600 dark:text-amber-400">
            v2
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <OrderAlertBar />
          {lastUpdated && (
            <span className="text-xs text-muted-foreground hidden sm:inline">
              Updated {format(lastUpdated, 'h:mm:ss a')}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            className="h-9"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            <span className="ml-1 hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Hard failure state — not authorized / unexpected crash */}
      {boardData?.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {boardData.error}
        </div>
      )}

      {/* Soft degradation indicator — board still usable, so this is a
          quiet, persistent banner rather than a toast (see fetchBoard). */}
      {boardData?.softErrors && boardData.softErrors.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-500">
          Some board data is degraded: {boardData.softErrors.join('; ')}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          Loading board...
        </div>
      )}

      {!loading && boardData && (
        <>
          {/* Desktop: 3-column grid */}
          <div className="hidden md:grid md:grid-cols-3 md:gap-6">
            <BoardColumn
              title="To Fill"
              accentColor="amber"
              cards={boardData.toFillCards}
              sessionUser={user}
              users={users}
              onClaimClick={handleClaimClick}
              onRefresh={handleRefresh}
            />
            <BoardColumn
              title="To Case"
              accentColor="purple"
              cards={boardData.toCaseCards}
              sessionUser={user}
              users={users}
              onClaimClick={handleClaimClick}
              onRefresh={handleRefresh}
            />
            <BoardColumn
              title="Done Today"
              accentColor="green"
              doneItems={boardData.doneItems}
              sessionUser={user}
              users={users}
              onClaimClick={handleClaimClick}
              onRefresh={handleRefresh}
            />
          </div>

          {/* Mobile: Tabs */}
          <div className="md:hidden">
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger
                  value="fill"
                  className="text-amber-500 data-[state=active]:text-amber-500"
                >
                  TO FILL ({toFillCount})
                </TabsTrigger>
                <TabsTrigger
                  value="case"
                  className="text-purple-400 data-[state=active]:text-purple-400"
                >
                  TO CASE ({toCaseCount})
                </TabsTrigger>
                <TabsTrigger
                  value="done"
                  className="text-green-500 data-[state=active]:text-green-500"
                >
                  DONE ({doneCount})
                </TabsTrigger>
              </TabsList>

              <TabsContent value="fill" className="mt-4">
                <BoardColumn
                  title="To Fill"
                  accentColor="amber"
                  cards={boardData.toFillCards}
                  sessionUser={user}
                  users={users}
                  onClaimClick={handleClaimClick}
                  onRefresh={handleRefresh}
                />
              </TabsContent>
              <TabsContent value="case" className="mt-4">
                <BoardColumn
                  title="To Case"
                  accentColor="purple"
                  cards={boardData.toCaseCards}
                  sessionUser={user}
                  users={users}
                  onClaimClick={handleClaimClick}
                  onRefresh={handleRefresh}
                />
              </TabsContent>
              <TabsContent value="done" className="mt-4">
                <BoardColumn
                  title="Done Today"
                  accentColor="green"
                  doneItems={boardData.doneItems}
                  sessionUser={user}
                  users={users}
                  onClaimClick={handleClaimClick}
                  onRefresh={handleRefresh}
                />
              </TabsContent>
            </Tabs>
          </div>
        </>
      )}

      {/* Floating Add Container button (mobile) */}
      <div className="fixed bottom-6 right-6 md:hidden z-40">
        <Button
          size="lg"
          className="h-14 w-14 rounded-full shadow-lg"
          onClick={() => setContainerSheetOpen(true)}
          title="Add container"
        >
          <Plus className="h-6 w-6" />
        </Button>
      </div>

      {/* Desktop Add Container button */}
      <div className="hidden md:flex justify-end pt-2">
        <Button
          variant="outline"
          onClick={() => setContainerSheetOpen(true)}
          className="h-10"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Container
        </Button>
      </div>

      {/* Claim Sheet */}
      <ClaimSheet
        card={claimCard}
        open={claimSheetOpen}
        onOpenChange={setClaimSheetOpen}
        users={users}
        sessionUser={user}
        onSuccess={handleRefresh}
      />

      {/* Add Container Sheet */}
      <Sheet open={containerSheetOpen} onOpenChange={setContainerSheetOpen}>
        <SheetContent side="bottom" className="md:max-w-md md:ml-auto">
          <SheetHeader className="pb-4">
            <SheetTitle>Add Staged Container</SheetTitle>
            <SheetDescription>Add a bulk container to the staging area</SheetDescription>
          </SheetHeader>

          <div className="space-y-4 pb-6">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">SKU</p>
              <Select value={containerSku} onValueChange={setContainerSku}>
                <SelectTrigger className="h-12">
                  <SelectValue placeholder="Select a SKU..." />
                </SelectTrigger>
                <SelectContent>
                  {allSkus.map((sku) => (
                    <SelectItem key={sku} value={sku}>
                      {sku}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Container size (units)</p>
              <div className="grid grid-cols-5 gap-2">
                {CONTAINER_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setContainerSize(size)}
                    className={`h-12 rounded-lg border-2 text-sm font-bold transition-colors ${
                      containerSize === size
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background hover:border-primary/60'
                    }`}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>

            <Button
              className="h-12 w-full text-base font-semibold"
              disabled={!containerSku || addingContainer}
              onClick={handleAddContainer}
            >
              {addingContainer ? 'Adding...' : `Add ${containerSize}-unit container`}
            </Button>

            <Button
              variant="ghost"
              className="w-full"
              onClick={() => setContainerSheetOpen(false)}
              disabled={addingContainer}
            >
              Cancel
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
