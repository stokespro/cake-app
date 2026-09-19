// SPRO-148 review fix: the dispensary Orders tab could not edit an existing
// order.
//
// The Orders tab hands the record getCustomerOrders() returns straight to
// <OrderSheet>. The query selected the order header only — no order_items — so
// the sheet initialized with zero line items and refused to submit ("at least
// one item"), and the fields it rewrites but never received (delivery date,
// payment terms) would have been wiped had it saved.
//
// This locks the query's shape: anything the sheet round-trips is selected,
// and the line items arrive with the SKU details needed to price them.
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

const { getCustomerOrders } = await import('./customers');

const CUSTOMER_ID = 'cust-1';

const ORDER_ROW = {
  id: 'order-1',
  customer_id: CUSTOMER_ID,
  status: 'pending',
  total_price: 590,
  discount_amount: 50,
  discount_reason: 'volume deal',
  order_items: [
    {
      id: 'item-1',
      sku_id: 'sku-a',
      quantity: 2,
      unit_price: 10,
      line_total: 640,
      sku: { id: 'sku-a', code: 'AS', name: 'Aloha Sugar', units_per_case: 32 },
    },
  ],
};

/** Captures the select() string and resolves with one order. */
function createFakeDb() {
  const state: { table?: string; select?: string } = {};

  const builder: Record<string, unknown> = {};
  for (const method of ['eq', 'order', 'limit']) {
    builder[method] = () => builder;
  }
  builder.select = (arg: string) => {
    state.select = arg;
    return builder;
  };
  builder.then = (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
    Promise.resolve({ data: [ORDER_ROW], error: null }).then(onOk, onErr);

  const client = {
    from(table: string) {
      state.table = table;
      return builder;
    },
  };

  return { client, state };
}

/** Collapses the multi-line select() template into single-spaced text. */
function normalized(select: string | undefined) {
  return (select ?? '').replace(/\s+/g, ' ');
}

beforeEach(() => {
  mockRequireRole.mockReset();
  mockCreateServiceClient.mockReset();
  mockRequireRole.mockResolvedValue({
    authorized: true,
    session: { userId: 'u1', role: 'sales', name: 'Sales' },
  });
});

describe('getCustomerOrders', () => {
  it('selects the order line items the edit sheet needs', async () => {
    const { client, state } = createFakeDb();
    mockCreateServiceClient.mockResolvedValue(client);

    await getCustomerOrders(CUSTOMER_ID);

    const select = normalized(state.select);
    expect(select).toContain('order_items(');
    // Everything mapOrderItemsToForm() reads off a persisted item.
    for (const field of ['sku_id', 'quantity', 'unit_price', 'line_total']) {
      expect(select).toContain(field);
    }
    expect(select).toContain('sku:skus(id, code, name, units_per_case, price_per_unit, product_type_id)');
  });

  it('selects every field the sheet rewrites on save, so none is silently wiped', async () => {
    const { client, state } = createFakeDb();
    mockCreateServiceClient.mockResolvedValue(client);

    await getCustomerOrders(CUSTOMER_ID);

    const select = normalized(state.select);
    for (const field of [
      'requested_delivery_date',
      'delivered_at',
      'payment_terms',
      'terms_payment_date',
      'order_notes',
      // SPRO-148 deduction pairs
      'discount_amount',
      'discount_reason',
      'credit_amount',
      'credit_reason',
    ]) {
      expect(select).toContain(field);
    }
  });

  it('returns the order with its items attached', async () => {
    const { client } = createFakeDb();
    mockCreateServiceClient.mockResolvedValue(client);

    const result = await getCustomerOrders(CUSTOMER_ID);

    expect(result.data).toHaveLength(1);
    expect(result.data![0].order_items).toEqual(ORDER_ROW.order_items);
  });

  it('refuses an unauthorized caller before touching the database', async () => {
    mockRequireRole.mockResolvedValue({ authorized: false, reason: 'No valid session' });

    const result = await getCustomerOrders(CUSTOMER_ID);

    expect(result).toEqual({ error: 'No valid session' });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });
});
