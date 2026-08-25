// Regression coverage for the SPRO-131 staging bug.
//
// The bug: every packaging inventory write was
//
//     UPDATE inventory SET staged = $1 WHERE sku_id = $2
//
// and nothing had ever created inventory rows for SKUs made through the app.
// A zero-row UPDATE is not an error in Postgres, so PostgREST returned
// `error: null`, the inventory_log row was written regardless, and the UI
// toasted "Added 8 to AS staged". Aloha Sugar was staged three times on
// 2026-08-25 and never left 0. 18 of 32 active SKUs were in that state.
//
// Two properties are locked in here, and they are separate:
//   1. the write is an UPSERT keyed on sku_id, so a missing row gets created
//      rather than silently skipped;
//   2. the write asserts a row actually came back, so a no-op can never again
//      be reported as success.
//
// Property 2 matters on its own. An upsert that somehow wrote nothing would
// still be a silent failure without the row-count check, and the row-count
// check is what turns any future variant of this bug into a visible error
// instead of a wrong number on a warehouse TV.
//
// '@/lib/supabase/server' and '@/lib/auth/session' are mocked wholesale so
// this stays hermetic — same style as actions/auth.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireRole = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const mockCreateServiceClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => mockCreateServiceClient(...args),
}));

const { addStagedInventory, updateInventory } = await import('./packaging');

// ---------------------------------------------------------------------------
// Minimal chainable stand-in for the Supabase query builder.
//
// Records every (table, method, args) so a test can assert on the shape of the
// write — specifically that it is `.upsert()` carrying sku_id, and not the
// `.update()` that caused the bug. `then` makes the builder awaitable, which is
// how the non-.single() calls resolve.
// ---------------------------------------------------------------------------

interface RecordedCall {
  table: string;
  ops: Array<{ method: string; args: unknown[] }>;
}

type Terminal = 'single' | 'maybeSingle' | 'await';
type Responder = (call: RecordedCall, terminal: Terminal) => unknown;

const CHAIN_METHODS = ['select', 'eq', 'gte', 'update', 'upsert', 'insert', 'delete', 'order'];

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
      builder.single = () => Promise.resolve(responder(call, 'single'));
      builder.maybeSingle = () => Promise.resolve(responder(call, 'maybeSingle'));
      builder.then = (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
        Promise.resolve(responder(call, 'await')).then(onOk, onErr);

      return builder;
    },
  };

  return { client, calls };
}

function opFor(call: RecordedCall, method: string) {
  return call.ops.find(op => op.method === method);
}

function inventoryWrite(calls: RecordedCall[]) {
  return calls.find(
    c => c.table === 'inventory' && c.ops.some(op => op.method === 'upsert' || op.method === 'update')
  );
}

const SKU_ID = 'sku-aloha-sugar';

// Responder covering the happy path: the SKU exists, has no inventory row yet,
// and the write succeeds. Individual tests override pieces via `overrides`.
function defaultResponder(overrides: {
  existingStaged?: number | null;
  writeResult?: { data: unknown; error: unknown };
} = {}): Responder {
  const { existingStaged = null, writeResult = { data: [{ sku_id: SKU_ID }], error: null } } =
    overrides;

  return (call, terminal) => {
    if (call.table === 'skus') {
      return { data: { id: SKU_ID }, error: null };
    }
    if (call.table === 'inventory') {
      if (terminal === 'maybeSingle' || terminal === 'single') {
        return existingStaged === null
          ? { data: null, error: null }
          : { data: { staged: existingStaged, filled: 0, cased: 0 }, error: null };
      }
      return writeResult;
    }
    // inventory_log and anything else
    return { data: null, error: null };
  };
}

beforeEach(() => {
  mockRequireRole.mockReset();
  mockCreateServiceClient.mockReset();
  mockRequireRole.mockResolvedValue({
    authorized: true,
    session: { userId: 'u1', role: 'packaging', name: 'Packaging Manager' },
  });
});

describe('addStagedInventory', () => {
  it('creates the inventory row for a SKU that has none (SPRO-131)', async () => {
    const { client, calls } = createFakeDb(defaultResponder());
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await addStagedInventory('AS', 8);

    expect(result).toEqual({ success: true });

    const write = inventoryWrite(calls);
    expect(write).toBeDefined();

    // The heart of the fix: an upsert carrying sku_id, not a bare update.
    expect(opFor(write!, 'update')).toBeUndefined();
    const upsert = opFor(write!, 'upsert');
    expect(upsert).toBeDefined();
    expect(upsert!.args[0]).toEqual({ sku_id: SKU_ID, staged: 8 });
    expect(upsert!.args[1]).toEqual({ onConflict: 'sku_id' });
  });

  it('adds to the existing count when a row is already there', async () => {
    const { client, calls } = createFakeDb(defaultResponder({ existingStaged: 12 }));
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await addStagedInventory('AS', 8);

    expect(result).toEqual({ success: true });
    expect(opFor(inventoryWrite(calls)!, 'upsert')!.args[0]).toEqual({
      sku_id: SKU_ID,
      staged: 20,
    });
  });

  it('reports failure instead of success when the write lands on no rows', async () => {
    // This is the exact shape PostgREST returned during the bug: no error, and
    // nothing written. Before the fix this returned { success: true } and the
    // UI toasted "Added 8 to AS staged".
    const { client } = createFakeDb(
      defaultResponder({ writeResult: { data: [], error: null } })
    );
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await addStagedInventory('AS', 8);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no inventory row written/i);
  });

  it('surfaces a real database error', async () => {
    const { client } = createFakeDb(
      defaultResponder({ writeResult: { data: null, error: { message: 'permission denied' } } })
    );
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await addStagedInventory('AS', 8);

    expect(result.success).toBe(false);
    expect(result.error).toBe('permission denied');
  });

  it('refuses unauthorized callers before touching the database', async () => {
    mockRequireRole.mockResolvedValue({ authorized: false, reason: 'No valid session' });

    const result = await addStagedInventory('AS', 8);

    expect(result).toEqual({ success: false, error: 'No valid session' });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });
});

describe('updateInventory', () => {
  it('upserts so a manual adjustment on a row-less SKU actually lands', async () => {
    const { client, calls } = createFakeDb(defaultResponder());
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await updateInventory('AS', { staged: 8 });

    expect(result).toEqual({ success: true });

    const write = inventoryWrite(calls);
    expect(opFor(write!, 'update')).toBeUndefined();
    expect(opFor(write!, 'upsert')!.args[0]).toEqual({ sku_id: SKU_ID, staged: 8 });
  });

  it('carries only the fields the caller provided', async () => {
    const { client, calls } = createFakeDb(defaultResponder());
    mockCreateServiceClient.mockResolvedValue(client);

    await updateInventory('AS', { cased: 3, filled: 5 });

    // staged is absent, so an upsert onto an existing row leaves it alone and an
    // insert takes the column default of 0.
    expect(opFor(inventoryWrite(calls)!, 'upsert')!.args[0]).toEqual({
      sku_id: SKU_ID,
      cased: 3,
      filled: 5,
    });
  });

  it('reports failure when the write lands on no rows', async () => {
    const { client } = createFakeDb(
      defaultResponder({ writeResult: { data: [], error: null } })
    );
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await updateInventory('AS', { staged: 8 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no inventory row written/i);
  });

  it('rejects an empty update', async () => {
    const { client } = createFakeDb(defaultResponder());
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await updateInventory('AS', {});

    expect(result).toEqual({ success: false, error: 'No updates provided' });
  });
});
