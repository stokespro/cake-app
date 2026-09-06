// SPRO-73 coverage for the sales-task CRUD server actions.
//
// Locked-in properties:
//   1. createTask always stores the canonical 'todo' status (never legacy
//      'pending') and assigns the task to the caller.
//   2. Mutations (update / status change / archive / restore) are allowed
//      only to the task's CURRENT stored assignee or an admin — never based
//      on anything the client submitted.
//   3. 'done' stamps completed_at; every other status clears it.
//   4. Archive is a soft delete: an UPDATE writing archived_at/archived_by,
//      never a DELETE. Restore clears both columns.
//   5. Active reads filter `archived_at IS NULL`; archived reads filter the
//      inverse. Both stay scoped to the caller's own agent_id.
//
// '@/lib/supabase/server' and '@/lib/auth/session' are mocked wholesale so
// this stays hermetic — same style as actions/packaging.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireRole = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const mockCreateServiceClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => mockCreateServiceClient(...args),
}));

const {
  getTasks,
  getArchivedTasks,
  getAssignableUsers,
  createTask,
  updateTask,
  updateTaskStatus,
  archiveTask,
  restoreTask,
} = await import('./tasks');

// ---------------------------------------------------------------------------
// Minimal chainable stand-in for the Supabase query builder (same pattern as
// actions/packaging.test.ts). Records every (table, method, args) so tests
// can assert on the exact shape of reads and writes.
// ---------------------------------------------------------------------------

interface RecordedCall {
  table: string;
  ops: Array<{ method: string; args: unknown[] }>;
}

type Terminal = 'single' | 'maybeSingle' | 'await';
type Responder = (call: RecordedCall, terminal: Terminal) => unknown;

const CHAIN_METHODS = ['select', 'eq', 'is', 'not', 'in', 'order', 'insert', 'update', 'delete'];

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

function taskWrite(calls: RecordedCall[]) {
  return calls.find(c => c.table === 'sales_tasks' && c.ops.some(op => op.method === 'update'));
}

function taskInsert(calls: RecordedCall[]) {
  return calls.find(c => c.table === 'sales_tasks' && c.ops.some(op => op.method === 'insert'));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = 'user-agent';
const OTHER_AGENT_ID = 'user-other';
const ADMIN_ID = 'user-admin';
const TASK_ID = 'task-1';

const agentSession = { userId: AGENT_ID, role: 'sales', name: 'Agent' };
const adminSession = { userId: ADMIN_ID, role: 'admin', name: 'Admin' };
const managementSession = { userId: 'user-mgmt', role: 'management', name: 'Mgmt' };

interface ResponderConfig {
  /** Row returned for the sales_tasks authorization fetch. */
  task?: { agent_id: string | null; archived_at: string | null } | null;
  /** Row returned for the users assignee-validation fetch. */
  assignee?: { id: string; role: string } | null;
  writeError?: unknown;
}

function respondWith(config: ResponderConfig = {}): Responder {
  const { task = { agent_id: AGENT_ID, archived_at: null }, assignee = { id: AGENT_ID, role: 'sales' }, writeError = null } = config;

  return (call, terminal) => {
    if (call.table === 'sales_tasks' && (terminal === 'maybeSingle' || terminal === 'single')) {
      return { data: task, error: null };
    }
    if (call.table === 'users' && (terminal === 'maybeSingle' || terminal === 'single')) {
      return { data: assignee, error: null };
    }
    return { data: [], error: writeError };
  };
}

const validUpdate = {
  title: 'Follow up',
  description: 'Call about restock',
  due_date: '2026-09-10',
  status: 'in_progress' as const,
  agent_id: AGENT_ID,
};

function setupDb(responder: Responder) {
  const fake = createFakeDb(responder);
  mockCreateServiceClient.mockResolvedValue(fake.client);
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({ authorized: true, session: agentSession });
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe('auth gate', () => {
  it('every action returns the requireRole reason and never touches the db when unauthorized', async () => {
    mockRequireRole.mockResolvedValue({ authorized: false, reason: 'No valid session' });
    const { calls } = setupDb(respondWith());

    const results = await Promise.all([
      getTasks(),
      getArchivedTasks(),
      getAssignableUsers(),
      createTask({ customer_id: null, title: 'x', description: null, due_date: '2026-09-10', priority: 2 }),
      updateTask(TASK_ID, validUpdate),
      updateTaskStatus(TASK_ID, 'done'),
      archiveTask(TASK_ID),
      restoreTask(TASK_ID),
    ]);

    for (const result of results) {
      expect(result).toEqual({ error: 'No valid session' });
    }
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('getTasks / getArchivedTasks', () => {
  it('getTasks reads only the caller’s non-archived tasks', async () => {
    const { calls } = setupDb(respondWith());

    const result = await getTasks();

    expect(result.error).toBeUndefined();
    const read = calls.find(c => c.table === 'sales_tasks')!;
    expect(opFor(read, 'eq')?.args).toEqual(['agent_id', AGENT_ID]);
    expect(opFor(read, 'is')?.args).toEqual(['archived_at', null]);
  });

  it('getArchivedTasks reads only the caller’s archived tasks', async () => {
    const { calls } = setupDb(respondWith());

    const result = await getArchivedTasks();

    expect(result.error).toBeUndefined();
    const read = calls.find(c => c.table === 'sales_tasks')!;
    expect(opFor(read, 'eq')?.args).toEqual(['agent_id', AGENT_ID]);
    expect(opFor(read, 'not')?.args).toEqual(['archived_at', 'is', null]);
  });
});

describe('getAssignableUsers', () => {
  it('returns only users with task-access roles and only safe fields', async () => {
    const { calls } = setupDb(respondWith());

    const result = await getAssignableUsers();

    expect(result.error).toBeUndefined();
    const read = calls.find(c => c.table === 'users')!;
    expect(opFor(read, 'select')?.args).toEqual(['id, name, role']);
    expect(opFor(read, 'in')?.args).toEqual(['role', ['admin', 'management', 'sales', 'agent']]);
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('createTask', () => {
  const input = {
    customer_id: null,
    title: '  Follow up  ',
    description: null,
    due_date: '2026-09-10',
    priority: 2,
  };

  it('inserts the task as todo, assigned to the caller', async () => {
    const { calls } = setupDb(respondWith());

    const result = await createTask(input);

    expect(result).toEqual({});
    const write = taskInsert(calls)!;
    expect(write).toBeDefined();
    const inserted = opFor(write, 'insert')!.args[0] as Record<string, unknown>;
    expect(inserted.status).toBe('todo');
    expect(inserted.agent_id).toBe(AGENT_ID);
    expect(inserted.title).toBe('Follow up');
  });

  it('rejects a blank title and a missing due date without writing', async () => {
    const { calls } = setupDb(respondWith());

    expect(await createTask({ ...input, title: '   ' })).toEqual({ error: 'Title is required' });
    expect(await createTask({ ...input, due_date: '' })).toEqual({ error: 'Due date is required' });
    expect(taskInsert(calls)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('updateTask', () => {
  it('lets the current assignee edit their own task', async () => {
    const { calls } = setupDb(respondWith());

    const result = await updateTask(TASK_ID, validUpdate);

    expect(result).toEqual({});
    const write = taskWrite(calls)!;
    const updated = opFor(write, 'update')!.args[0] as Record<string, unknown>;
    expect(updated.title).toBe('Follow up');
    expect(updated.status).toBe('in_progress');
    expect(updated.agent_id).toBe(AGENT_ID);
    expect(opFor(write, 'eq')?.args).toEqual(['id', TASK_ID]);
  });

  it('lets an admin edit someone else’s task', async () => {
    mockRequireRole.mockResolvedValue({ authorized: true, session: adminSession });
    const { calls } = setupDb(respondWith({ task: { agent_id: OTHER_AGENT_ID, archived_at: null } }));

    const result = await updateTask(TASK_ID, validUpdate);

    expect(result).toEqual({});
    expect(taskWrite(calls)).toBeDefined();
  });

  it('rejects a non-admin who is not the current stored assignee', async () => {
    mockRequireRole.mockResolvedValue({ authorized: true, session: managementSession });
    const { calls } = setupDb(respondWith({ task: { agent_id: OTHER_AGENT_ID, archived_at: null } }));

    const result = await updateTask(TASK_ID, validUpdate);

    expect(result).toEqual({ error: 'Not authorized to update this task' });
    expect(taskWrite(calls)).toBeUndefined();
  });

  it('rejects an unknown status, blank title, missing due date, and missing assignee', async () => {
    const { calls } = setupDb(respondWith());

    expect(await updateTask(TASK_ID, { ...validUpdate, status: 'complete' as never })).toEqual({
      error: 'Invalid status',
    });
    expect(await updateTask(TASK_ID, { ...validUpdate, title: ' ' })).toEqual({
      error: 'Title is required',
    });
    expect(await updateTask(TASK_ID, { ...validUpdate, due_date: '' })).toEqual({
      error: 'Due date is required',
    });
    expect(await updateTask(TASK_ID, { ...validUpdate, agent_id: '' })).toEqual({
      error: 'Assignee is required',
    });
    expect(taskWrite(calls)).toBeUndefined();
  });

  it('rejects an assignee whose role has no task access', async () => {
    const { calls } = setupDb(respondWith({ assignee: { id: 'user-vault', role: 'vault' } }));

    const result = await updateTask(TASK_ID, { ...validUpdate, agent_id: 'user-vault' });

    expect(result).toEqual({ error: 'Assignee cannot be given tasks' });
    expect(taskWrite(calls)).toBeUndefined();
  });

  it('rejects an assignee that does not exist', async () => {
    const { calls } = setupDb(respondWith({ assignee: null }));

    const result = await updateTask(TASK_ID, { ...validUpdate, agent_id: 'user-ghost' });

    expect(result).toEqual({ error: 'Assignee not found' });
    expect(taskWrite(calls)).toBeUndefined();
  });

  it('refuses to edit an archived task', async () => {
    const { calls } = setupDb(
      respondWith({ task: { agent_id: AGENT_ID, archived_at: '2026-09-01T00:00:00Z' } })
    );

    const result = await updateTask(TASK_ID, validUpdate);

    expect(result).toEqual({ error: 'Archived tasks must be restored before editing' });
    expect(taskWrite(calls)).toBeUndefined();
  });

  it('done stamps completed_at; any other status clears it', async () => {
    const doneDb = setupDb(respondWith());
    await updateTask(TASK_ID, { ...validUpdate, status: 'done' });
    const doneWrite = opFor(taskWrite(doneDb.calls)!, 'update')!.args[0] as Record<string, unknown>;
    expect(typeof doneWrite.completed_at).toBe('string');

    for (const status of ['todo', 'in_progress', 'cancelled'] as const) {
      const db = setupDb(respondWith());
      await updateTask(TASK_ID, { ...validUpdate, status });
      const write = opFor(taskWrite(db.calls)!, 'update')!.args[0] as Record<string, unknown>;
      expect(write.completed_at).toBeNull();
    }
  });
});

describe('updateTaskStatus', () => {
  it('done stamps completed_at; todo clears it', async () => {
    const doneDb = setupDb(respondWith());
    expect(await updateTaskStatus(TASK_ID, 'done')).toEqual({});
    const doneWrite = opFor(taskWrite(doneDb.calls)!, 'update')!.args[0] as Record<string, unknown>;
    expect(doneWrite.status).toBe('done');
    expect(typeof doneWrite.completed_at).toBe('string');

    const todoDb = setupDb(respondWith());
    expect(await updateTaskStatus(TASK_ID, 'todo')).toEqual({});
    const todoWrite = opFor(taskWrite(todoDb.calls)!, 'update')!.args[0] as Record<string, unknown>;
    expect(todoWrite.status).toBe('todo');
    expect(todoWrite.completed_at).toBeNull();
  });

  it('rejects a legacy status value', async () => {
    const { calls } = setupDb(respondWith());

    expect(await updateTaskStatus(TASK_ID, 'pending' as never)).toEqual({ error: 'Invalid status' });
    expect(taskWrite(calls)).toBeUndefined();
  });

  it('rejects a non-admin who is not the current stored assignee', async () => {
    const { calls } = setupDb(respondWith({ task: { agent_id: OTHER_AGENT_ID, archived_at: null } }));

    const result = await updateTaskStatus(TASK_ID, 'done');

    expect(result).toEqual({ error: 'Not authorized to update this task' });
    expect(taskWrite(calls)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Archive / restore
// ---------------------------------------------------------------------------

describe('archiveTask / restoreTask', () => {
  it('archive is a soft delete: an UPDATE stamping archived_at/archived_by, never a DELETE', async () => {
    const { calls } = setupDb(respondWith());

    const result = await archiveTask(TASK_ID);

    expect(result).toEqual({});
    expect(calls.some(c => c.ops.some(op => op.method === 'delete'))).toBe(false);
    const write = taskWrite(calls)!;
    const updated = opFor(write, 'update')!.args[0] as Record<string, unknown>;
    expect(typeof updated.archived_at).toBe('string');
    expect(updated.archived_by).toBe(AGENT_ID);
    expect(opFor(write, 'eq')?.args).toEqual(['id', TASK_ID]);
  });

  it('restore clears archived_at and archived_by', async () => {
    const { calls } = setupDb(
      respondWith({ task: { agent_id: AGENT_ID, archived_at: '2026-09-01T00:00:00Z' } })
    );

    const result = await restoreTask(TASK_ID);

    expect(result).toEqual({});
    const write = taskWrite(calls)!;
    const updated = opFor(write, 'update')!.args[0] as Record<string, unknown>;
    expect(updated.archived_at).toBeNull();
    expect(updated.archived_by).toBeNull();
  });

  it('archive and restore enforce assignee-or-admin authorization', async () => {
    const archiveDb = setupDb(respondWith({ task: { agent_id: OTHER_AGENT_ID, archived_at: null } }));
    expect(await archiveTask(TASK_ID)).toEqual({ error: 'Not authorized to update this task' });
    expect(taskWrite(archiveDb.calls)).toBeUndefined();

    const restoreDb = setupDb(
      respondWith({ task: { agent_id: OTHER_AGENT_ID, archived_at: '2026-09-01T00:00:00Z' } })
    );
    expect(await restoreTask(TASK_ID)).toEqual({ error: 'Not authorized to update this task' });
    expect(taskWrite(restoreDb.calls)).toBeUndefined();

    // Admin may archive someone else's task
    mockRequireRole.mockResolvedValue({ authorized: true, session: adminSession });
    const adminDb = setupDb(respondWith({ task: { agent_id: OTHER_AGENT_ID, archived_at: null } }));
    expect(await archiveTask(TASK_ID)).toEqual({});
    const adminWrite = opFor(taskWrite(adminDb.calls)!, 'update')!.args[0] as Record<string, unknown>;
    expect(adminWrite.archived_by).toBe(ADMIN_ID);
  });

  it('returns "Task not found" when the row does not exist', async () => {
    const { calls } = setupDb(respondWith({ task: null }));

    expect(await archiveTask(TASK_ID)).toEqual({ error: 'Task not found' });
    expect(taskWrite(calls)).toBeUndefined();
  });
});
