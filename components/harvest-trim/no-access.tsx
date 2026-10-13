import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

interface NoAccessProps {
  title?: string
  message?: string
  /** Offer a way out so the screen is never a dead end. */
  backHref?: string
  backLabel?: string
}

/** Deep links render for any logged-in role, so every page shows this instead of a broken screen. */
export function NoAccess({
  title = 'No access',
  message = 'Your account does not have access to this part of Harvest & Trim.',
  backHref = '/dashboard',
  backLabel = 'Back to dashboard',
}: NoAccessProps) {
  return (
    <Card>
      <CardContent className="py-10">
        <div className="text-center">
          <ShieldAlert className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
          <h2 className="mb-2 text-lg font-medium">{title}</h2>
          <p className="mx-auto mb-5 max-w-md text-muted-foreground">{message}</p>
          <Button asChild variant="outline" className="h-14 px-6">
            <Link href={backHref}>{backLabel}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
