'use client'

// The reports table's column choice: which columns are hidden, remembered per device.
// Storage format, tolerance for bad values and the pay rule live in lib/trim/report-columns.ts.

import { useCallback, useEffect, useState } from 'react'
import {
  defaultHiddenColumns,
  readStoredColumns,
  toggleColumn,
  writeStoredColumns,
  type ReportColumnKey,
} from '@/lib/trim/report-columns'

export function useReportColumns() {
  // Defaults on the first render (server and client agree), the stored choice right after mount. The table
  // only exists once a report has loaded, well after this effect has run, so no default flash is visible.
  const [hidden, setHidden] = useState<ReportColumnKey[]>(defaultHiddenColumns)
  useEffect(() => {
    setHidden(readStoredColumns())
  }, [])

  const toggle = useCallback(
    (key: ReportColumnKey) => {
      const next = toggleColumn(hidden, key)
      setHidden(next)
      writeStoredColumns(next)
    },
    [hidden]
  )

  const reset = useCallback(() => {
    const next = defaultHiddenColumns()
    setHidden(next)
    writeStoredColumns(next)
  }, [])

  return { hidden, toggle, reset }
}
