/**
 * The dashboard header greeting.
 *
 * Split out of the page component so the fallback is testable: the name comes
 * from `public.users.name` via the session, and a blank or whitespace-only row
 * must render exactly the original static greeting rather than the ragged
 * "Welcome back ! Here's your overview." that naive interpolation produces.
 */

/** Shown when no usable first name is available. */
const FALLBACK_GREETING = "Welcome back! Here's your overview."

/**
 * Build the dashboard greeting for a user's full name.
 *
 * Uses the first whitespace-delimited token as the first name. Returns the
 * static greeting unchanged for missing, empty, or whitespace-only input.
 */
export function formatDashboardGreeting(name: string | null | undefined): string {
  const firstName = (name ?? '').trim().split(/\s+/)[0]
  if (!firstName) return FALLBACK_GREETING
  return `Welcome back ${firstName}! Here's your overview.`
}
