// Pure helpers for the Overview's cycle selector. No I/O, so they are unit-tested.
//
// The Overview is about work after the plants come down, so it only offers cycles in harvest, dry or
// trim. This filter is deliberately local to the Overview: listHarvestCycles also serves the Harvest
// page, which must keep listing flower cycles (harvest day arrives before the stage flip does).

import type { CycleOption } from '@/actions/harvest-trim'

/** Selector value for "every cycle" (the board scoped to all open work). */
export const ALL_CYCLES = 'all'

const HUB_STAGES: readonly string[] = ['harvest', 'dry', 'trim']

/** The cycles the Overview offers: those in harvest, dry or trim. Order is preserved. */
export function hubCycles<T extends Pick<CycleOption, 'stage'>>(cycles: readonly T[]): T[] {
  return cycles.filter((c) => HUB_STAGES.includes(c.stage))
}

/**
 * The selector value to start on. A remembered pick wins only if it is still on offer ("all", or a
 * visible cycle); a remembered cycle that has since left harvest/dry/trim, or was filtered out, falls
 * back to the cycle where the work is (trim, then dry, then the first), and to "all" when none is visible.
 */
export function pickHubCycle(visible: readonly Pick<CycleOption, 'id' | 'stage'>[], stored: string | null): string {
  if (stored === ALL_CYCLES || (stored !== null && visible.some((c) => c.id === stored))) return stored as string
  return (visible.find((c) => c.stage === 'trim') ?? visible.find((c) => c.stage === 'dry') ?? visible[0])?.id ?? ALL_CYCLES
}
