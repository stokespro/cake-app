import { describe, expect, it } from 'vitest'
import { BASE, LINKS, SETTINGS_TABS, inSettingsGroup, isActive, isSubActive } from './trim-nav'

const labels = (links: { label: string }[]) => links.map((l) => l.label)

describe('primary strip', () => {
  it('is Overview, Harvest, Trim station, Reports, Pay register, Settings', () => {
    expect(labels(LINKS)).toEqual(['Overview', 'Harvest', 'Trim station', 'Reports', 'Pay register', 'Settings'])
  })

  it('no longer lists Look up a tag, Hangers or Trimmers', () => {
    const hrefs = LINKS.map((l) => l.href)
    expect(hrefs).not.toContain(`${BASE}/lookup`)
    expect(hrefs).not.toContain(`${BASE}/hangers`)
    expect(hrefs).not.toContain(`${BASE}/staff`)
  })

  it('keeps the existing access gates unchanged', () => {
    const needs = Object.fromEntries(LINKS.map((l) => [l.label, l.needs]))
    expect(needs).toEqual({
      Overview: undefined,
      Harvest: 'weigh',
      'Trim station': 'operate',
      Reports: undefined,
      'Pay register': 'finance',
      Settings: undefined,
    })
  })
})

describe('settings sub-strip', () => {
  it('is Settings, Hangers, Trimmers, all ungated, on their original routes', () => {
    expect(SETTINGS_TABS).toEqual([
      { href: `${BASE}/settings`, label: 'Settings' },
      { href: `${BASE}/hangers`, label: 'Hangers' },
      { href: `${BASE}/staff`, label: 'Trimmers' },
    ])
  })

  it('shows only on Settings, Hangers and Trimmers pages', () => {
    for (const p of [`${BASE}/settings`, `${BASE}/hangers`, `${BASE}/staff`, `${BASE}/staff/abc-123`]) {
      expect(inSettingsGroup(p)).toBe(true)
    }
    for (const p of [BASE, `${BASE}/harvest`, `${BASE}/station`, `${BASE}/lookup`, `${BASE}/reports`, `${BASE}/pay-register`]) {
      expect(inSettingsGroup(p)).toBe(false)
    }
  })

  it('does not match look-alike prefixes', () => {
    expect(inSettingsGroup(`${BASE}/staffing`)).toBe(false)
    expect(inSettingsGroup(`${BASE}/hangers-old`)).toBe(false)
  })

  it('lights only the current page', () => {
    expect(isSubActive(`${BASE}/hangers`, `${BASE}/hangers`)).toBe(true)
    expect(isSubActive(`${BASE}/hangers`, `${BASE}/settings`)).toBe(false)
    expect(isSubActive(`${BASE}/staff/abc`, `${BASE}/staff`)).toBe(true)
    expect(isSubActive(`${BASE}/staff/abc`, `${BASE}/hangers`)).toBe(false)
  })
})

describe('isActive (primary strip)', () => {
  const settings = `${BASE}/settings`
  it('lights Settings on Settings, Hangers, Trimmers and a trimmer detail page', () => {
    for (const p of [`${BASE}/settings`, `${BASE}/hangers`, `${BASE}/staff`, `${BASE}/staff/abc-123`]) {
      expect(isActive(p, settings)).toBe(true)
    }
  })

  it('does not light Settings elsewhere', () => {
    for (const p of [BASE, `${BASE}/harvest`, `${BASE}/station`, `${BASE}/reports`, `${BASE}/lookup`]) {
      expect(isActive(p, settings)).toBe(false)
    }
  })

  it('keeps Overview lit on batch pages only besides itself', () => {
    expect(isActive(BASE, BASE)).toBe(true)
    expect(isActive(`${BASE}/batches/b1`, BASE)).toBe(true)
    expect(isActive(`${BASE}/hangers`, BASE)).toBe(false)
  })

  it('lights Trim station and Reports on their own routes', () => {
    expect(isActive(`${BASE}/station`, `${BASE}/station`)).toBe(true)
    expect(isActive(`${BASE}/reports`, `${BASE}/reports`)).toBe(true)
    expect(isActive(`${BASE}/reports`, `${BASE}/station`)).toBe(false)
  })
})
