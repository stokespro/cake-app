import { AlertCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

interface ErrorStateProps {
  title: string
  message: string
  onRetry: () => void
}

// Shared "load failed" card — a failed fetch must never render as confident
// zeros, so every data-fetching page shows this instead of an empty state.
// Deliberately does NOT handle session-expiry errors: by the time a caller
// renders this, useAuth().handleSessionError(error) has already returned
// false, i.e. the redirect-to-/login path has been ruled out and this is a
// genuine, retriable load failure.
export function ErrorState({ title, message, onRetry }: ErrorStateProps) {
  return (
    <Card className="border-destructive/30">
      <CardContent className="py-6">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h3 className="text-lg font-medium mb-2">{title}</h3>
          <p className="text-muted-foreground mb-4">{message}</p>
          <Button onClick={onRetry} variant="outline">
            Try Again
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
