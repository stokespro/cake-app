// SPRO-73 coverage for the dashboard summary server action.
//
// Locked-in properties:
//   1. Open work is BOTH todo and in_progress — the pending-task count and
//      the upcoming-task list must include each of them and must exclude
//      done, cancelled, and archived rows (archived via `archived_at IS NULL`).
//   2. Every task query stays scoped to the caller's own agent_id.
//   3. Unauthorized callers get the requireRole reason and the db is never
//      touched.
//
// '@/lib/supabase/server' and '@/lib/auth/session' are mocked wholesale so
// this stays hermetic — same style as actions/tasks.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireRole = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const mockCreateServiceClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => mockCreateServiceClient(...args),
}));

const { getDashboardSummary } = await import('./dashboard');

// ---------------------------------------------------------------------------
// Minimal chainable stand-in for the Supabase query builder (same pattern as
// actions/tasks.test.ts). Records every (table, method, args) so tests can
// assert on the exact shape of each query.
// ---------------------------------------------------------------------------

interface RecordedCall {
  table: string;
  ops: Array<{ method: string; args: unknown[] }>;
}

type Responder = (call: RecordedCall) => unknown;

const CHAIN_METHODS = ['select', 'eq', 'is', 'in', 'gte', 'order', 'limit'];

function createFakeDb(responder: Responder) {
  const calls: RecordedCall[] = [];

  const client = {
    from(table: string) {
      const call: RecordedCall = { table, ops: [] };
      calls.push(call);

      const builder: Record<string, unknown> = {};
      for (const method of CHAIN_METHODS) {
        builder[method] = (...args: unknown[]) => {
          call.ops.push({ method, args });
          return builder;
        };
      }
      builder.then = (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
        Promise.resolve(responder(call)).then(onOk, onErr);

      return builder;
    },
  };

  return { client, calls };
}

function opFor(call: RecordedCall, method: string) {
  return call.ops.find(op => op.method === method);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-agent';
const session = { userId: USER_ID, role: 'sales', name: 'Agent' };

const defaultResponder: Responder = () => ({ data: [], count: 0, error: null });

function setupDb(responder: Responder = defaultResponder) {
  const fake = createFakeDb(responder);
  mockCreateServiceClient.mockResolvedValue(fake.client);
  return fake;
}

/** The two sales_tasks queries: [0] = pending count, [1] = upcoming list. */
function taskQueries(calls: RecordedCall[]) {
  return calls.filter(c => c.table === 'sales_tasks');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({ authorized: true, session });
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe('auth gate', () => {
  it('returns the requireRole reason and never touches the db when unauthorized', async () => {
    mockRequireRole.mockResolvedValue({ authorized: false, reason: 'No valid session' });
    const { calls } = setupDb();

    const result = await getDashboardSummary();

    expect(result).toEqual({ error: 'No valid session' });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Open-work scope (SPRO-73)
// ---------------------------------------------------------------------------

describe('open-work task queries', () => {
  it('counts todo AND in_progress, excluding done/cancelled and archived rows', async () => {
    const { calls } = setupDb();

    const result = await getDashboardSummary();

    expect(result.error).toBeUndefined();
    const [pendingCount] = taskQueries(calls);
    expect(pendingCount).toBeDefined();
    expect(opFor(pendingCount, 'in')?.args).toEqual(['status', ['todo', 'in_progress']]);
    expect(opFor(pendingCount, 'is')?.args).toEqual(['archived_at', null]);
    expect(opFor(pendingCount, 'eq')?.args).toEqual(['agent_id', USER_ID]);
  });

  it('lists upcoming todo AND in_progress tasks, excluding done/cancelled and archived rows', async () => {
    const { calls } = setupDb();

    const result = await getDashboardSummary();

    expect(result.error).toBeUndefined();
    const [, upcoming] = taskQueries(calls);
    expect(upcoming).toBeDefined();
    expect(opFor(upcoming, 'in')?.args).toEqual(['status', ['todo', 'in_progress']]);
    expect(opFor(upcoming, 'is')?.args).toEqual(['archived_at', null]);
    expect(opFor(upcoming, 'eq')?.args).toEqual(['agent_id', USER_ID]);
    expect(opFor(upcoming, 'order')?.args).toEqual(['due_date', { ascending: true }]);
    expect(opFor(upcoming, 'limit')?.args).toEqual([5]);
  });

  it('surfaces the open-task count in the summary stats', async () => {
    setupDb((call) =>
      call.table === 'sales_tasks' && call.ops.some(op => op.method === 'limit')
        ? { data: [], count: null, error: null }
        : call.table === 'sales_tasks'
          ? { data: null, count: 7, error: null }
          : { data: [], count: 0, error: null }
    );

    const result = await getDashboardSummary();

    expect(result.error).toBeUndefined();
    expect(result.data?.stats.pendingTasks).toBe(7);
  });
});
