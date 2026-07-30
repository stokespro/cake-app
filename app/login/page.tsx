'use client'

import { Suspense, useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/lib/auth-context'
import { authenticateByPin } from '@/actions/auth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2 } from 'lucide-react'
import { sanitizeNextPath } from './sanitize-next-path'

function LoginPageInner() {
  const [pin, setPin] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { login, user, isLoading: authLoading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const isSubmitting = useRef(false)
  const hasRedirected = useRef(false)

  const nextPath = sanitizeNextPath(
    searchParams.get('next'),
    typeof window !== 'undefined' ? window.location.origin : ''
  )
  const sessionExpiredNotice = searchParams.get('reason') === 'session_expired'

  // Redirect if already logged in (single redirect check)
  useEffect(() => {
    if (user && !authLoading && !hasRedirected.current) {
      hasRedirected.current = true
      router.replace(nextPath)
    }
  }, [user, authLoading, router, nextPath])

  const handleDigitPress = (digit: string) => {
    if (pin.length < 4 && !isLoading) {
      setPin(prev => prev + digit)
      setError(null)
    }
  }

  const handleBackspace = () => {
    setPin(prev => prev.slice(0, -1))
    setError(null)
  }

  const handleClear = () => {
    setPin('')
    setError(null)
  }

  // Keyboard support
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isLoading) return

      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault()
        if (pin.length < 4) {
          setPin(prev => prev + e.key)
          setError(null)
        }
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        setPin(prev => prev.slice(0, -1))
        setError(null)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setPin('')
        setError(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isLoading, pin.length])

  // Auto-submit when 4 digits entered
  useEffect(() => {
    if (pin.length === 4 && !isLoading && !isSubmitting.current) {
      isSubmitting.current = true
      setIsLoading(true)

      authenticateByPin(pin)
        .then((result) => {
          if (result.success && result.user) {
            hasRedirected.current = true
            login(result.user)
            // Use replace to prevent back navigation to login
            router.replace(nextPath)
          } else {
            setError(result.error || 'Invalid PIN')
            setPin('')
            setIsLoading(false)
            isSubmitting.current = false
          }
        })
        .catch(() => {
          setError('Authentication failed')
          setPin('')
          setIsLoading(false)
          isSubmitting.current = false
        })
      // Don't reset isLoading on success - let the redirect handle it
    }
  }, [pin, isLoading, login, router, nextPath])

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-b from-zinc-50 to-zinc-100 dark:from-zinc-900 dark:to-zinc-800">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">CAKE</CardTitle>
          <CardDescription className="text-center">
            Enter your 4-digit PIN
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {sessionExpiredNotice && !error && (
            <div className="p-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md text-center dark:text-amber-400 dark:bg-amber-950/20 dark:border-amber-900">
              Your session expired. Please log in again.
            </div>
          )}

          {error && (
            <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md text-center">
              {error}
            </div>
          )}

          {/* PIN Display */}
          <div className="flex justify-center gap-3">
            {[0, 1, 2, 3].map(i => (
              <div
                key={i}
                className={`
                  w-4 h-4 rounded-full transition-colors duration-150
                  ${i < pin.length ? 'bg-primary' : 'bg-muted'}
                `}
              />
            ))}
          </div>

          {/* Number Pad */}
          <div className="grid grid-cols-3 gap-3">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digit => (
              <button
                key={digit}
                onClick={() => handleDigitPress(digit)}
                disabled={isLoading}
                className="
                  h-14 text-xl font-semibold rounded-xl
                  bg-muted hover:bg-accent active:bg-muted
                  text-foreground transition-colors duration-150
                  disabled:opacity-50
                "
              >
                {digit}
              </button>
            ))}
            <button
              onClick={handleClear}
              disabled={isLoading}
              className="
                h-14 text-sm font-medium rounded-xl
                bg-muted hover:bg-accent active:bg-muted
                text-muted-foreground transition-colors duration-150
                disabled:opacity-50
              "
            >
              Clear
            </button>
            <button
              onClick={() => handleDigitPress('0')}
              disabled={isLoading}
              className="
                h-14 text-xl font-semibold rounded-xl
                bg-muted hover:bg-accent active:bg-muted
                text-foreground transition-colors duration-150
                disabled:opacity-50
              "
            >
              0
            </button>
            <button
              onClick={handleBackspace}
              disabled={isLoading}
              className="
                h-14 text-xl rounded-xl
                bg-muted hover:bg-accent active:bg-muted
                text-foreground transition-colors duration-150
                disabled:opacity-50
              "
            >
              &#x232B;
            </button>
          </div>

          {isLoading && (
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Verifying...</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default function LoginPage() {
  // useSearchParams() requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  )
}
