/**
 * Derive a short pin/avatar label from a user's name.
 *
 * `users.initials` is the authoritative value and an admin can edit it, but it
 * is nullable — a user created before the column existed, or one an admin never
 * filled in, must still get a label rather than an empty pin. This is the
 * fallback, and it mirrors the seed in
 * `supabase/migrations/20260828230000_add_user_initials.sql` exactly so a
 * derived label and a seeded one never disagree for the same name.
 *
 * Single-word names ("Stokes") take their first two letters rather than one:
 * a first-letter-only rule collides "Sam" and "Stokes" onto "S", and those are
 * two different sales reps.
 */
export function deriveInitials(name: string | null | undefined): string {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/** Stored initials when set, otherwise derived from the name. */
export function resolveInitials(
  initials: string | null | undefined,
  name: string | null | undefined
): string {
  const stored = String(initials ?? '').trim()
  return stored ? stored.toUpperCase() : deriveInitials(name)
}
