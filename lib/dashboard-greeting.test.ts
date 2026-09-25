import { describe, expect, it } from 'vitest'
import { formatDashboardGreeting } from './dashboard-greeting'

/** The exact string the dashboard rendered before personalization. */
const FALLBACK = "Welcome back! Here's your overview."

describe('formatDashboardGreeting', () => {
  it('uses the first token of a multi-word name', () => {
    expect(formatDashboardGreeting('Joshua Stokes')).toBe(
      "Welcome back Joshua! Here's your overview."
    )
  })

  it('ignores surrounding and repeated whitespace', () => {
    expect(formatDashboardGreeting('   Joshua   Ray  Stokes  ')).toBe(
      "Welcome back Joshua! Here's your overview."
    )
  })

  it('handles a single-token name', () => {
    expect(formatDashboardGreeting('Joshua')).toBe(
      "Welcome back Joshua! Here's your overview."
    )
  })

  it('falls back for null', () => {
    expect(formatDashboardGreeting(null)).toBe(FALLBACK)
  })

  it('falls back for undefined', () => {
    expect(formatDashboardGreeting(undefined)).toBe(FALLBACK)
  })

  it('falls back for an empty string', () => {
    expect(formatDashboardGreeting('')).toBe(FALLBACK)
  })

  it('falls back for a whitespace-only string', () => {
    expect(formatDashboardGreeting('   \t \n ')).toBe(FALLBACK)
  })
})
