import { ApprovalsService, Approval } from '../src/approvals/approvals.service';

/**
 * Exercises ApprovalsService.post() against an in-memory Firestore fake:
 *   • a confirmed collection draft rolls into the daily entries doc (append),
 *   • a redelivered CONFIRM does NOT double-count (idempotent via wa_posts),
 *   • a second draft for the same branch+date adds to the same doc.
 */

interface Doc {
  id: string;
  data: Record<string, any>;
}

class FakeTxn {
  constructor(private readonly store: FakeFirestore) {}
  async get(target: any) {
    if (target.__query) return this.store.runQuery(target);
    const d = this.store.getDoc(target.__col, target.id);
    return { exists: !!d, data: () => d, ref: target };
  }
  set(ref: any, data: Record<string, any>) {
    this.store.setDoc(ref.__col, ref.id, data);
  }
  update(ref: any, data: Record<string, any>) {
    this.store.updateDoc(ref.__col, ref.id, data);
  }
}

class FakeFirestore {
  cols: Record<string, Record<string, Record<string, any>>> = {};
  private seq = 0;

  col(name: string) {
    this.cols[name] ??= {};
    const self = this;
    const makeQuery = (filters: Array<[string, any]>): any => ({
      __query: true,
      __col: name,
      __filters: filters,
      where(f: string, _op: string, v: any) {
        return makeQuery([...filters, [f, v]]);
      },
      limit() {
        return this;
      },
      async get() {
        return self.runQuery({ __col: name, __filters: filters });
      },
    });
    return {
      __col: name,
      doc(id?: string) {
        const docId = id ?? `auto_${name}_${++self.seq}`;
        return {
          __col: name,
          id: docId,
          async get() {
            const d = self.getDoc(name, docId);
            return { exists: !!d, id: docId, data: () => d };
          },
          async set(data: Record<string, any>) {
            self.setDoc(name, docId, data);
          },
          async update(data: Record<string, any>) {
            self.updateDoc(name, docId, data);
          },
        };
      },
      where(f: string, _op: string, v: any) {
        return makeQuery([[f, v]]);
      },
      async get() {
        return self.runQuery({ __col: name, __filters: [] });
      },
    };
  }

  seed(col: string, id: string, data: Record<string, any>) {
    this.cols[col] ??= {};
    this.cols[col][id] = data;
  }

  get db() {
    return {
      runTransaction: async (fn: (t: FakeTxn) => Promise<void>) => fn(new FakeTxn(this)),
    };
  }

  now() {
    return '<ts>';
  }

  // ─── store internals used by FakeTxn ───
  getDoc(col: string, id: string) {
    return this.cols[col]?.[id];
  }
  setDoc(col: string, id: string, data: Record<string, any>) {
    this.cols[col] ??= {};
    this.cols[col][id] = JSON.parse(JSON.stringify(data));
  }
  updateDoc(col: string, id: string, data: Record<string, any>) {
    const cur = (this.cols[col] ??= {})[id] ?? {};
    for (const [k, v] of Object.entries(data)) {
      if (k.includes('.')) {
        const [root, leaf] = k.split('.');
        cur[root] ??= {};
        cur[root][leaf] = v;
      } else {
        cur[k] = v;
      }
    }
    this.cols[col][id] = cur;
  }
  runQuery(q: { __col: string; __filters: Array<[string, any]> }) {
    const all = Object.entries(this.cols[q.__col] ?? {});
    const matched = all.filter(([, d]) => q.__filters.every(([f, v]) => d[f] === v));
    return {
      empty: matched.length === 0,
      docs: matched.map(([id, d]) => ({ id, ref: { __col: q.__col, id }, data: () => d })),
    };
  }
}

function collectionDraft(fs: FakeFirestore, svc: ApprovalsService) {
  return svc.prepare({
    kind: 'accounting.collection',
    created_by_user_id: 'u-captain',
    created_by_phone: '+910000000000',
    branch_id: 'branch-1',
    entry_date: '2026-11-23',
    payload: { columns: [{ name: 'KAMIL', computed_total: 300 }, { name: 'ASHKAR', computed_total: 200 }] },
    requires_explanation: false,
    requires_owner_approval: false,
  });
}

describe('ApprovalsService.post() — append-only daily rollup', () => {
  let fs: FakeFirestore;
  let svc: ApprovalsService;
  const entries = () => Object.values(fs.cols['entries'] ?? {});

  beforeEach(() => {
    fs = new FakeFirestore();
    svc = new ApprovalsService(fs as any);
  });

  it('rolls a confirmed collection into a new daily entries doc', async () => {
    const a = await collectionDraft(fs, svc);
    await svc.confirm(a.id, 'u-captain');
    expect(entries()).toHaveLength(1);
    const e = entries()[0];
    expect(e.branch_id).toBe('branch-1');
    expect(e.date).toBe('2026-11-23');
    expect(e.cash).toBe(500); // 300 + 200
    expect(e.wa_posts[a.id]).toBe(true);
    expect(e.activity_log).toHaveLength(1);
    expect(e.created_by).toBe('whatsapp:u-captain');
  });

  it('is idempotent — a redelivered CONFIRM does not double-count', async () => {
    const a = await collectionDraft(fs, svc);
    await svc.confirm(a.id, 'u-captain');
    await svc.confirm(a.id, 'u-captain'); // replay
    expect(entries()).toHaveLength(1);
    expect(entries()[0].cash).toBe(500);
    expect(entries()[0].activity_log).toHaveLength(1);
  });

  it('appends a second draft to the same branch+date doc', async () => {
    const a1 = await collectionDraft(fs, svc);
    await svc.confirm(a1.id, 'u-captain');
    const a2 = await svc.prepare({
      kind: 'accounting.expense',
      created_by_user_id: 'u-captain',
      created_by_phone: '+910000000000',
      branch_id: 'branch-1',
      entry_date: '2026-11-23',
      payload: { amount: 630 },
      requires_explanation: false,
      requires_owner_approval: false,
    });
    await svc.confirm(a2.id, 'u-captain');
    expect(entries()).toHaveLength(1);
    const e = entries()[0];
    expect(e.cash).toBe(500);
    expect(e.others).toBe(630);
    expect(e.activity_log).toHaveLength(2);
  });

  it('attributes staff_billing rows: rounded incentive + loan home_branch_id', async () => {
    fs.seed('branches', 'branch-1', { type: 'mens' });
    fs.seed('settings', 'global', { mens_inc: 10, unisex_inc: 12 });
    fs.seed('staff', 's-kamil', { name: 'KAMIL', branch_id: 'branch-1', incentive_pct: 15 });
    fs.seed('staff', 's-ashkar', { name: 'ASHKAR', branch_id: 'branch-2' }); // home elsewhere → loan

    const a = await collectionDraft(fs, svc); // KAMIL 300, ASHKAR 200 at branch-1
    await svc.confirm(a.id, 'u-captain');

    const rows = entries()[0].staff_billing as any[];
    const kamil = rows.find((r) => r.staff_id === 's-kamil');
    const ashkar = rows.find((r) => r.staff_id === 's-ashkar');

    expect(kamil.incentive).toBe(45); // 300 × 15% (per-staff override)
    expect(kamil.home_branch_id).toBe('branch-1');
    expect(kamil.loan_flag).toBe(false);

    expect(ashkar.incentive).toBe(20); // 200 × 10% (branch-type default)
    expect(ashkar.home_branch_id).toBe('branch-2');
    expect(ashkar.loan_flag).toBe(true);

    expect(entries()[0].cash).toBe(500); // cash total unchanged by attribution
  });

  it('splits a closing into cash channel, online, and expense', async () => {
    const a = await svc.prepare({
      kind: 'closing.submit',
      created_by_user_id: 'u-captain',
      created_by_phone: '+910000000000',
      branch_id: 'branch-1',
      entry_date: '2026-11-23',
      payload: {
        columns: [{ name: 'KAMIL', computed_total: 500 }],
        reconciliation: {
          cash_counted: 390,
          expected_cash: 390,
          difference: 0,
          deduction_breakdown: [
            { category: 'online', label: 'gpay', amount: 100 },
            { category: 'expense', label: 'expense', amount: 10 },
          ],
        },
      },
      requires_explanation: false,
      requires_owner_approval: false, // post immediately for the unit test
    });
    await svc.confirm(a.id, 'u-captain');

    const e = entries()[0];
    expect(e.cash).toBe(400); // 500 collected − 100 online
    expect(e.online).toBe(100);
    expect(e.others).toBe(10);
    expect(e.actual_cash).toBe(390);
    expect(e.cash_diff).toBe(0);
  });

  const pendingClosing = () =>
    svc.prepare({
      kind: 'closing.submit',
      created_by_user_id: 'u-captain',
      created_by_phone: '+910000000000',
      branch_id: 'branch-1',
      entry_date: '2026-11-23',
      payload: {
        columns: [{ name: 'KAMIL', computed_total: 500 }],
        reconciliation: {
          cash_counted: 390,
          expected_cash: 390,
          difference: 0,
          deduction_breakdown: [
            { category: 'online', label: 'gpay', amount: 100 },
            { category: 'expense', label: 'expense', amount: 10 },
          ],
        },
      },
      requires_explanation: false,
      requires_owner_approval: true, // waits for the owner
    });

  it('captain CONFIRM parks an owner-approval draft without posting', async () => {
    const a = await pendingClosing();
    const after = await svc.confirm(a.id, 'u-captain');
    expect(after.status).toBe('CONFIRMED');
    expect(entries()).toHaveLength(0);
    expect(await svc.listPendingOwner()).toHaveLength(1);
  });

  it('owner approval posts the parked closing; a second approval is rejected', async () => {
    const a = await pendingClosing();
    await svc.confirm(a.id, 'u-captain');
    await svc.ownerApprove(a.id, 'u-owner');

    const e = entries()[0];
    expect(e.cash).toBe(400);
    expect(e.online).toBe(100);
    expect(e.others).toBe(10);
    expect(fs.cols['approvals'][a.id].status).toBe('POSTED');
    expect(fs.cols['approvals'][a.id].owner_approved_by).toBe('u-owner');

    await expect(svc.ownerApprove(a.id, 'u-owner')).rejects.toThrow(/not awaiting owner approval/);
    expect(entries()).toHaveLength(1); // not double-posted
  });

  it('owner rejection posts nothing and records the reason', async () => {
    const a = await pendingClosing();
    await svc.confirm(a.id, 'u-captain');
    const r = await svc.ownerReject(a.id, 'u-owner', 'wrong figures');
    expect(r.status).toBe('REJECTED');
    expect(entries()).toHaveLength(0);
    expect(fs.cols['approvals'][a.id].reject_reason).toBe('wrong figures');
  });

  it('resolvePending matches the 6-char short id the owner sees', async () => {
    const a = await pendingClosing();
    await svc.confirm(a.id, 'u-captain');
    const resolved = await svc.resolvePending('#' + a.id.slice(0, 6));
    expect(resolved?.id).toBe(a.id);
  });

  it('ownerApprove refuses when an explanation is required but missing', async () => {
    fs.seed('approvals', 'ap-x', {
      id: 'ap-x',
      kind: 'closing.submit',
      branch_id: 'branch-1',
      entry_date: '2026-11-23',
      payload: { columns: [{ name: 'KAMIL', computed_total: 100 }] },
      requires_explanation: true,
      requires_owner_approval: true,
      status: 'CONFIRMED',
    });
    await expect(svc.ownerApprove('ap-x', 'u-owner')).rejects.toThrow(/explanation required/);
    expect(entries()).toHaveLength(0);
  });

  it('does not post while an explanation is still required', async () => {
    const a = await svc.prepare({
      kind: 'closing.submit',
      created_by_user_id: 'u-captain',
      created_by_phone: '+910000000000',
      branch_id: 'branch-1',
      entry_date: '2026-11-23',
      payload: { columns: [{ name: 'KAMIL', computed_total: 500 }], reconciliation: { cash_counted: 100, expected_cash: 500, difference: -400 } },
      requires_explanation: true,
      requires_owner_approval: false,
    });
    await expect(svc.confirm(a.id, 'u-captain')).rejects.toThrow(/explanation required/);
    expect(entries()).toHaveLength(0);
  });
});
