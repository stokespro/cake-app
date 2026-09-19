// SPRO-148 review fixes: the order write paths are a trust boundary.
//
// Two properties are locked in here, and they are independent:
//
//   1. A submitted line amount can never reach the database. Every write path
//      re-derives `cases x units_per_case x unit_price` from the skus table,
//      so a forged server-action payload cannot set an order item's
//      line_total, cannot inflate the subtotal the deduction ceiling is
//      checked against, and cannot set total_price. (The action inputs no
//      longer even carry line_total; these tests push one through anyway, the
//      way a hand-rolled POST would.)
//
//   2. An invalid deduction is rejected BEFORE anything is written — including
//      a sub-cent amount, which is positive as typed but 0.00 once normalized
//      for storage. Previously it reached the insert and only the DB CHECK
//      stopped it, half-way through a multi-statement write.
//
// '@/lib/supabase/server' and '@/lib/auth/session' are mocked wholesale so this
// stays hermetic — same style as actions/packaging.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireRole = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const mockCreateServiceClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => mockCreateServiceClient(...args),
}));

const { createOrder, createOrderFromSheet, saveOrder, updateOrderFromSheet } =
  await import('./orders');

// ---------------------------------------------------------------------------
// Chainable stand-in for the Supabase query builder — records every
// (table, method, args) so a test can assert on the exact write payload.
// ---------------------------------------------------------------------------

interface RecordedCall {
  table: string;
  ops: Array<{ method: string; args: unknown[] }>;
}

type Terminal = 'single' | 'maybeSingle' | 'await';
type Responder = (call: RecordedCall, terminal: Terminal) => unknown;

const CHAIN_METHODS = ['select', 'eq', 'in', 'update', 'upsert', 'insert', 'delete', 'order'];

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

function writeTo(calls: RecordedCall[], table: string) {
  return calls.find(
    c => c.table === table && c.ops.some(op => ['insert', 'update', 'delete'].includes(op.method))
  );
}

/** The payload of the first `method` call against `table`. */
function payload(calls: RecordedCall[], table: string, method: 'insert' | 'update') {
  const call = calls.find(c => c.table === table && opFor(c, method));
  return opFor(call!, method)!.args[0];
}

/** Every call that would change data — the assertion target for "no write". */
function writes(calls: RecordedCall[]) {
  return calls.filter(c =>
    c.ops.some(op => ['insert', 'update', 'upsert', 'delete'].includes(op.method))
  );
}

const ORDER_ID = 'order-1';
const CUSTOMER_ID = 'cust-1';

// Two SKUs with DIFFERENT units_per_case, so a test can tell a server-derived
// amount from one that reused a client number or the 32 default.
const SKU_A = { id: 'sku-a', units_per_case: 32 };
const SKU_B = { id: 'sku-b', units_per_case: 10 };

function responder(overrides: { skus?: Array<{ id: string; units_per_case: number }> } = {}): Responder {
  const { skus = [SKU_A, SKU_B] } = overrides;

  return (call, terminal) => {
    if (call.table === 'skus') {
      const requested = (opFor(call, 'in')?.args[1] as string[]) ?? [];
      return { data: skus.filter(s => requested.includes(s.id)), error: null };
    }
    if (call.table === 'orders' && terminal === 'single') {
      return { data: { id: ORDER_ID }, error: null };
    }
    return { data: null, error: null };
  };
}

/**
 * An item as a forged payload would send it: a line_total that is not what the
 * server's own pricing rule produces. `line_total` is not on the input type any
 * more, so the cast is the point — this is the shape of a hand-rolled POST.
 */
function forgedItem(item: { sku_id: string; cases: number; unit_price: number; line_total: number }) {
  return item as unknown as { sku_id: string; cases: number; unit_price: number };
}

function baseCreateInput() {
  return {
    customer_id: CUSTOMER_ID,
    order_date: '2026-09-19',
    requested_delivery_date: '2026-09-26',
    items: [{ sku_id: SKU_A.id, cases: 2, unit_price: 10 }],
  };
}

beforeEach(() => {
  mockRequireRole.mockReset();
  mockCreateServiceClient.mockReset();
  mockRequireRole.mockResolvedValue({
    authorized: true,
    session: { userId: 'u1', role: 'admin', name: 'Admin' },
  });
});

// ---------------------------------------------------------------------------
// Property 1 — line amounts come from the skus table, never from the payload
// ---------------------------------------------------------------------------

describe('server-derived line amounts', () => {
  it('createOrder ignores a forged line_total and prices from the skus table', async () => {
    const { client, calls } = createFakeDb(responder());
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await createOrder({
      ...baseCreateInput(),
      // 2 cases x 32 units x $10 = $640. The payload claims $5.
      items: [forgedItem({ sku_id: SKU_A.id, cases: 2, unit_price: 10, line_total: 5 })],
    });

    expect(result).toEqual({});

    const orderInsert = opFor(writeTo(calls, 'orders')!, 'insert')!.args[0] as Record<string, unknown>;
    expect(orderInsert.total_price).toBe(640);

    const itemsInsert = opFor(writeTo(calls, 'order_items')!, 'insert')!.args[0] as Array<Record<string, unknown>>;
    expect(itemsInsert).toEqual([
      { order_id: ORDER_ID, sku_id: SKU_A.id, quantity: 2, unit_price: 10, line_total: 640 },
    ]);
  });

  it('createOrderFromSheet uses each SKU own units_per_case', async () => {
    const { client, calls } = createFakeDb(responder());
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await createOrderFromSheet({
      customer_id: CUSTOMER_ID,
      requested_delivery_date: '2026-09-26',
      items: [
        forgedItem({ sku_id: SKU_A.id, cases: 1, unit_price: 2, line_total: 999999 }), // 32 x 2 = 64
        forgedItem({ sku_id: SKU_B.id, cases: 3, unit_price: 5, line_total: 0 }),      // 10 x 3 x 5 = 150
      ],
    });

    expect(result).toEqual({});
    expect(
      (opFor(writeTo(calls, 'orders')!, 'insert')!.args[0] as Record<string, unknown>).total_price
    ).toBe(214);
    expect(
      (opFor(writeTo(calls, 'order_items')!, 'insert')!.args[0] as Array<Record<string, unknown>>)
        .map(i => i.line_total)
    ).toEqual([64, 150]);
  });

  it('updateOrderFromSheet re-derives amounts on the dispensary-tab edit path', async () => {
    const { client, calls } = createFakeDb(responder());
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await updateOrderFromSheet(ORDER_ID, {
      customer_id: CUSTOMER_ID,
      requested_delivery_date: '2026-09-26',
      items: [forgedItem({ sku_id: SKU_B.id, cases: 4, unit_price: 1.5, line_total: 1 })],
    });

    expect(result).toEqual({});
    // 4 cases x 10 units x $1.50 = $60
    expect(
      (opFor(writeTo(calls, 'orders')!, 'update')!.args[0] as Record<string, unknown>).total_price
    ).toBe(60);
    expect(
      (payload(calls, 'order_items', 'insert') as Array<Record<string, unknown>>)[0].line_total
    ).toBe(60);
  });

  it('saveOrder excludes deleted items from the subtotal and re-derives the survivors', async () => {
    const { client, calls } = createFakeDb(responder());
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await saveOrder(ORDER_ID, {
      status: 'pending',
      order_notes: '',
      requested_delivery_date: '2026-09-26',
      delivered_at_override: '',
      payment_terms: false,
      terms_payment_date: null,
      items: [
        { id: 'item-1', sku_id: SKU_A.id, cases: 1, unit_price: 10 },                  // 320
        { id: 'item-2', sku_id: SKU_B.id, cases: 5, unit_price: 100, _deleted: true }, // excluded
      ],
    });

    expect(result).toEqual({});
    expect(
      (opFor(writeTo(calls, 'orders')!, 'update')!.args[0] as Record<string, unknown>).total_price
    ).toBe(320);

    const itemUpdate = calls.find(c => c.table === 'order_items' && opFor(c, 'update'));
    expect((opFor(itemUpdate!, 'update')!.args[0] as Record<string, unknown>).line_total).toBe(320);
  });

  it('rejects an item whose SKU no longer exists, without writing anything', async () => {
    const { client, calls } = createFakeDb(responder({ skus: [SKU_A] }));
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await createOrder({
      ...baseCreateInput(),
      items: [{ sku_id: 'sku-gone', cases: 1, unit_price: 10 }],
    });

    expect(result.error).toMatch(/SKU that no longer exists/i);
    expect(writes(calls)).toHaveLength(0);
  });

  it('rejects a non-whole or non-positive case count, without writing anything', async () => {
    for (const cases of [0, -1, 1.5]) {
      const { client, calls } = createFakeDb(responder());
      mockCreateServiceClient.mockResolvedValue(client);

      const result = await createOrder({
        ...baseCreateInput(),
        items: [{ sku_id: SKU_A.id, cases, unit_price: 10 }],
      });

      expect(result.error).toMatch(/whole number of cases/i);
      expect(writes(calls)).toHaveLength(0);
    }
  });

  it('rejects a negative unit price, without writing anything', async () => {
    const { client, calls } = createFakeDb(responder());
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await createOrder({
      ...baseCreateInput(),
      items: [{ sku_id: SKU_A.id, cases: 1, unit_price: -5 }],
    });

    expect(result.error).toMatch(/unit price/i);
    expect(writes(calls)).toHaveLength(0);
  });

  it('checks the deduction ceiling against the SERVER subtotal, not the forged one', async () => {
    const { client, calls } = createFakeDb(responder());
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await createOrder({
      ...baseCreateInput(),
      // Real subtotal $640; the payload claims $100,000 to make room for the discount.
      items: [forgedItem({ sku_id: SKU_A.id, cases: 2, unit_price: 10, line_total: 100000 })],
      discount: { amount: 5000, reason: 'forged headroom' },
    });

    expect(result.error).toMatch(/cannot exceed the order subtotal of \$640\.00/i);
    expect(writes(calls)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Property 2 — deductions are validated before any write
// ---------------------------------------------------------------------------

describe('deduction validation before write', () => {
  for (const kind of ['discount', 'credit'] as const) {
    it(`rejects a sub-cent ${kind} before any write`, async () => {
      for (const amount of [0.001, 0.002, 0.003, 0.004]) {
        const { client, calls } = createFakeDb(responder());
        mockCreateServiceClient.mockResolvedValue(client);

        const result = await createOrder({
          ...baseCreateInput(),
          [kind]: { amount, reason: 'sub-cent' },
        });

        expect(result.error).toMatch(/must be at least \$0\.01/i);
        expect(writes(calls)).toHaveLength(0);
      }
    });
  }

  it('accepts the smallest representable deduction', async () => {
    const { client, calls } = createFakeDb(responder());
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await createOrder({
      ...baseCreateInput(),
      discount: { amount: 0.01, reason: 'one cent' },
    });

    expect(result).toEqual({});
    const insert = opFor(writeTo(calls, 'orders')!, 'insert')!.args[0] as Record<string, unknown>;
    expect(insert.discount_amount).toBe(0.01);
    expect(insert.total_price).toBe(639.99);
  });

  it('writes normalized deduction fields and the net total', async () => {
    const { client, calls } = createFakeDb(responder());
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await createOrder({
      ...baseCreateInput(),
      discount: { amount: '25.499', reason: '  volume deal  ' },
      credit: { amount: 10, reason: 'damaged case' },
    });

    expect(result).toEqual({});
    const insert = opFor(writeTo(calls, 'orders')!, 'insert')!.args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({
      discount_amount: 25.5,
      discount_reason: 'volume deal',
      credit_amount: 10,
      credit_reason: 'damaged case',
      // 640 - 25.50 - 10
      total_price: 604.5,
    });
  });

  it('rejects an amount with no reason before any write', async () => {
    const { client, calls } = createFakeDb(responder());
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await createOrder({
      ...baseCreateInput(),
      credit: { amount: 5, reason: '   ' },
    });

    expect(result.error).toMatch(/reason is required/i);
    expect(writes(calls)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The dispensary Orders tab edits through updateOrderFromSheet
// ---------------------------------------------------------------------------

describe('updateOrderFromSheet deductions (dispensary Orders tab)', () => {
  async function edit(input: Record<string, unknown>) {
    const { client, calls } = createFakeDb(responder());
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await updateOrderFromSheet(ORDER_ID, {
      customer_id: CUSTOMER_ID,
      requested_delivery_date: '2026-09-26',
      items: [{ sku_id: SKU_A.id, cases: 2, unit_price: 10 }], // subtotal 640
      ...input,
    });

    return {
      result,
      update: opFor(writeTo(calls, 'orders')!, 'update')!.args[0] as Record<string, unknown>,
    };
  }

  it('preserves a deduction resubmitted unchanged', async () => {
    const { result, update } = await edit({ discount: { amount: 50, reason: 'volume deal' } });

    expect(result).toEqual({});
    expect(update).toMatchObject({
      discount_amount: 50,
      discount_reason: 'volume deal',
      credit_amount: null,
      credit_reason: null,
      total_price: 590,
    });
  });

  it('changes a deduction amount and reason', async () => {
    const { result, update } = await edit({ discount: { amount: 75.25, reason: 'renegotiated' } });

    expect(result).toEqual({});
    expect(update).toMatchObject({
      discount_amount: 75.25,
      discount_reason: 'renegotiated',
      total_price: 564.75,
    });
  });

  it('removes a deduction by writing NULLs and restoring the gross total', async () => {
    const { result, update } = await edit({ discount: null, credit: null });

    expect(result).toEqual({});
    expect(update).toMatchObject({
      discount_amount: null,
      discount_reason: null,
      credit_amount: null,
      credit_reason: null,
      total_price: 640,
    });
  });

  it('refuses an unauthorized caller before touching the database', async () => {
    mockRequireRole.mockResolvedValue({ authorized: false, reason: 'No valid session' });

    const result = await updateOrderFromSheet(ORDER_ID, {
      customer_id: CUSTOMER_ID,
      requested_delivery_date: '2026-09-26',
      items: [{ sku_id: SKU_A.id, cases: 1, unit_price: 1 }],
    });

    expect(result).toEqual({ error: 'No valid session' });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });
});
