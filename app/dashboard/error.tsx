'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AlertTriangle, RotateCcw, LogIn } from 'lucide-react'

// Session-expiry handling is authoritative in AuthProvider (lib/auth-context.tsx),
// which detects an expired/invalid session out-of-band and redirects to
// /login itself. This boundary previously tried to special-case session
// errors via isSessionError(error), but that branch was unreachable: (a)
// NO_SESSION_REASON is only ever returned as data by requireRole(), never
// thrown, so it can't reach a React error boundary; (b) in a production
// Next build, server-side error messages are replaced with a generic string
// before reaching the client, so isSessionError() would return false in
// prod even if something did throw it. Kept as a plain, generic error
// boundary — do not add session detection back here.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Dashboard error boundary caught:', error)
  }, [error])

  return (
    <div className="flex items-center justify-center min-h-[60vh] p-4">
      <Card className="w-full max-w-md border-red-200">
        <CardContent className="py-8">
          <div className="text-center">
            <AlertTriangle className="h-12 w-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-lg font-medium text-red-900 mb-2">Something went wrong</h2>
            <p className="text-red-700 mb-6">
              We couldn&apos;t load this page. Try again, or log in again if the problem persists.
            </p>
            <div className="flex flex-col sm:flex-row gap-2 justify-center">
              <Button onClick={reset} variant="outline">
                <RotateCcw className="mr-2 h-4 w-4" />
                Try again
              </Button>
              <Button asChild>
                <Link href="/login">
                  <LogIn className="mr-2 h-4 w-4" />
                  Go to login
                </Link>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
