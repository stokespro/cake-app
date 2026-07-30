import { redirect } from 'next/navigation'
import { verifySession } from '@/lib/auth/session'

export default async function Home() {
  // The real auth is the PIN-based crm-session cookie, not the Supabase
  // shadow session — supabase.auth.getUser() never reflects logout (see
  // SPRO-13), which sent logged-out users straight back to /dashboard.
  const session = await verifySession()

  if (session) {
    redirect('/dashboard')
  } else {
    redirect('/login')
  }
}
