import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../firestore/firestore.service';
import {
  buildStaffBillingRow,
  mergeStaffRow,
  StaffBillingRow,
  StaffDoc,
  BranchDoc,
  TransferDoc,
  GlobalSettings,
} from '../accounting/vcut-helpers';

export type ApprovalKind =
  | 'accounting.collection'
  | 'accounting.expense'
  | 'closing.submit'
  | 'branch.create';

export type ApprovalStatus = 'DRAFT' | 'CONFIRMED' | 'POSTED' | 'REJECTED';

export interface Approval {
  id: string;
  kind: ApprovalKind;
  created_by_user_id: string | null;
  created_by_phone: string;
  branch_id: string | null;
  payload: Record<string, unknown>;
  /** YYYY-MM-DD (IST) the entry belongs to; defaults to today at prepare time. */
  entry_date?: string;
  /** Set when the figures do not reconcile — blocks posting until explained. */
  requires_explanation: boolean;
  explanation?: string;
  /** Large/sensitive actions need the owner, not just the captain. */
  requires_owner_approval: boolean;
  status: ApprovalStatus;
}

/** Shape of the LedgerDraft payload a captain draft carries (see ledger-extractor). */
interface DraftPayload {
  columns?: Array<{ name: string; computed_total: number }>;
  expenses?: { computed_total: number } | null;
  reconciliation?: {
    cash_counted: number;
    expected_cash: number;
    difference: number;
    deduction_breakdown?: Array<{ category: 'online' | 'expense' | 'other'; label: string; amount: number }>;
  } | null;
}

/**
 * The AI action approval engine (PRD §16, locked decision §11).
 *
 * The AI (or a captain) PREPARES a draft here. Nothing touches the financial
 * record until a human CONFIRMS, and sensitive/large actions additionally
 * need owner approval. Posting is where the actual Firestore `entries` /
 * closing write happens — always as an append/reversal, never a silent
 * overwrite.
 *
 * NOTE: the post() handlers are intentionally stubs — wiring them to the real
 * vcut-app write helpers (entries rollup, incentive Math.round, loan
 * attribution) is the next implementation task.
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);
  constructor(private readonly fs: FirestoreService) {}

  async prepare(input: Omit<Approval, 'id' | 'status'>): Promise<Approval> {
    const ref = this.fs.col('approvals').doc();
    const approval: Approval = {
      ...input,
      entry_date: input.entry_date ?? todayIST(),
      id: ref.id,
      status: 'DRAFT',
    };
    await ref.set({ ...approval, created_at: this.fs.now() });
    return approval;
  }

  async confirm(id: string, actorUserId: string | null): Promise<Approval> {
    const ref = this.fs.col('approvals').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new Error(`approval ${id} not found`);
    const a = snap.data() as Approval;

    if (a.requires_explanation && !a.explanation) {
      throw new Error('explanation required before this draft can be confirmed');
    }
    const nextStatus: ApprovalStatus = a.requires_owner_approval ? 'CONFIRMED' : 'POSTED';
    await ref.update({ status: nextStatus, confirmed_by: actorUserId, confirmed_at: this.fs.now() });

    if (nextStatus === 'POSTED') await this.post({ ...a, status: 'POSTED' });
    return { ...a, status: nextStatus };
  }

  async attachExplanation(id: string, explanation: string): Promise<void> {
    await this.fs.col('approvals').doc(id).update({ explanation });
  }

  /**
   * Owner sign-off on a captain-confirmed draft that needed owner approval
   * (large expense, daily closing). Moves CONFIRMED → POSTED and writes to the
   * financial record. Still blocks if an explanation is required but missing.
   */
  async ownerApprove(id: string, ownerUserId: string | null): Promise<Approval> {
    const ref = this.fs.col('approvals').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new Error(`approval ${id} not found`);
    const a = snap.data() as Approval;

    if (a.status !== 'CONFIRMED') {
      throw new Error(`approval ${id} is ${a.status}, not awaiting owner approval`);
    }
    if (a.requires_explanation && !a.explanation) {
      throw new Error('explanation required before this draft can be approved');
    }
    await ref.update({ status: 'POSTED', owner_approved_by: ownerUserId, owner_approved_at: this.fs.now() });
    await this.post({ ...a, status: 'POSTED' });
    return { ...a, status: 'POSTED' };
  }

  /** Owner rejects a captain-confirmed draft. Nothing is posted. */
  async ownerReject(id: string, ownerUserId: string | null, reason?: string): Promise<Approval> {
    const ref = this.fs.col('approvals').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new Error(`approval ${id} not found`);
    const a = snap.data() as Approval;
    if (a.status !== 'CONFIRMED') {
      throw new Error(`approval ${id} is ${a.status}, not awaiting owner approval`);
    }
    await ref.update({
      status: 'REJECTED',
      owner_rejected_by: ownerUserId,
      owner_rejected_at: this.fs.now(),
      reject_reason: reason ?? null,
    });
    return { ...a, status: 'REJECTED' };
  }

  /** Drafts awaiting the owner (CONFIRMED), optionally scoped to one branch. */
  async listPendingOwner(branchId?: string): Promise<Approval[]> {
    let q = this.fs.col('approvals').where('status', '==', 'CONFIRMED');
    if (branchId) q = q.where('branch_id', '==', branchId);
    const snap = await q.get();
    return snap.docs.map((d: any) => d.data() as Approval);
  }

  /**
   * Resolve the 6-char short id the owner sees (`#abc123`) to a pending draft.
   * Matches only among drafts awaiting the owner, so a reply can't act on
   * something already posted or on another branch's draft.
   */
  async resolvePending(shortId: string, branchId?: string): Promise<Approval | null> {
    const prefix = shortId.replace(/^#/, '').toLowerCase();
    const pending = await this.listPendingOwner(branchId);
    return pending.find((a) => a.id.toLowerCase().startsWith(prefix)) ?? null;
  }

  /**
   * Post a confirmed draft to the vcut-app financial record.
   *
   * Append-only rollup: finds the daily `entries` doc for (branch_id,
   * entry_date) — the same (branch, date) doc the accountant/POS roll into —
   * and ADDS to it inside a transaction. It never overwrites a figure, and an
   * `activity_log` line records the WhatsApp origin + actor. Idempotent: each
   * approval id is stamped in `wa_posts`, so a redelivered CONFIRM cannot
   * double-count.
   *
   * NOT handled here (left to the accountant, needs labeled data the captain
   * text path doesn't yet separate): per-staff incentive rows (Math.round at
   * source), loan `home_branch_id` attribution, and the online/cash split on a
   * closing. Those enrich the same doc later; this only moves the cash/expense
   * totals and the counted-cash reconciliation.
   */
  private async post(approval: Approval): Promise<void> {
    if (approval.kind === 'branch.create') return; // not a financial rollup
    const branchId = approval.branch_id;
    const date = approval.entry_date ?? todayIST();
    if (!branchId) {
      this.logger.warn(`approval ${approval.id} has no branch_id — not posting.`);
      return;
    }

    const actor = approval.created_by_user_id ?? approval.created_by_phone;
    const mutation = this.rollupMutation(approval);
    if (!mutation) return;

    // Per-staff rows (incentive Math.round, loan home_branch_id) for the
    // collection/closing paths; read reference data before the transaction.
    const staffRows = await this.resolveStaffRows(approval, branchId, date);

    const entriesCol = this.fs.col('entries');
    const existingQ = entriesCol.where('branch_id', '==', branchId).where('date', '==', date).limit(1);

    let posted = false;
    await this.fs.db.runTransaction(async (t) => {
      const snap = await t.get(existingQ);
      const logLine = { time: new Date().toISOString(), user: actor, action: 'WhatsApp', notes: mutation.note };

      if (!snap.empty) {
        const docRef = snap.docs[0].ref;
        const data = snap.docs[0].data() as Record<string, any>;
        if (data.wa_posts && data.wa_posts[approval.id]) return; // already posted

        const update: Record<string, any> = {
          [`wa_posts.${approval.id}`]: true,
          activity_log: [...(data.activity_log ?? []), logLine],
          updated_at: this.fs.now(),
        };
        for (const [field, delta] of Object.entries(mutation.add)) {
          update[field] = (Number(data[field]) || 0) + delta;
        }
        for (const [field, value] of Object.entries(mutation.set ?? {})) update[field] = value;
        if (staffRows.length) {
          update.staff_billing = mergeBilling((data.staff_billing ?? []) as StaffBillingRow[], staffRows);
        }
        t.update(docRef, update);
      } else {
        const docRef = entriesCol.doc();
        t.set(docRef, {
          branch_id: branchId,
          date,
          online: 0,
          cash: 0,
          mat_expense: 0,
          others: 0,
          ...mutation.add,
          ...(mutation.set ?? {}),
          staff_billing: staffRows,
          wa_posts: { [approval.id]: true },
          activity_log: [logLine],
          created_at: this.fs.now(),
          created_by: `whatsapp:${actor}`,
        });
      }
      posted = true;
    });
    if (posted) this.logger.log(`Posted ${approval.kind} ${approval.id} → entries ${branchId}/${date}.`);
  }

  /** Translate a draft into increments (`add`) / absolute fields (`set`) on the daily entry. */
  private rollupMutation(
    approval: Approval,
  ): { add: Record<string, number>; set?: Record<string, number>; note: string } | null {
    const p = approval.payload as DraftPayload;
    switch (approval.kind) {
      case 'accounting.collection': {
        const total = (p.columns ?? []).reduce((s, c) => s + (Number(c.computed_total) || 0), 0);
        if (!total) return null;
        return { add: { cash: total }, note: `Collection +₹${total} (${(p.columns ?? []).length} staff columns)` };
      }
      case 'accounting.expense': {
        const amount = Number((approval.payload as { amount?: number }).amount) || 0;
        if (!amount) return null;
        return { add: { others: amount }, note: `Expense +₹${amount}` };
      }
      case 'closing.submit': {
        const r = p.reconciliation;
        const collected = (p.columns ?? []).reduce((s, c) => s + (Number(c.computed_total) || 0), 0);
        const sumCat = (cat: string) =>
          (r?.deduction_breakdown ?? []).filter((d) => d.category === cat).reduce((s, d) => s + (Number(d.amount) || 0), 0);
        const online = sumCat('online');
        const expense = sumCat('expense');
        const cashChannel = collected - online; // collection that came in as cash
        return {
          add: { cash: cashChannel, online, others: expense },
          set: r ? { actual_cash: r.cash_counted, cash_diff: r.difference } : {},
          note: r
            ? `Closing: cash +₹${cashChannel}, online +₹${online}, expense +₹${expense}; counted ₹${r.cash_counted} (diff ₹${r.difference})`
            : `Closing: collected +₹${collected}`,
        };
      }
      default:
        return null;
    }
  }

  /**
   * Resolve a captain's collection columns into staff_billing rows. Matches a
   * column name to a staff by name, computes the rounded incentive at the
   * branch-type rate, and attributes home_branch_id via effectiveBranchOnDate
   * (loan_flag when the staff's home ≠ the reporting branch). Unmatched columns
   * stay counted in cash but are not attributed to anyone.
   */
  private async resolveStaffRows(approval: Approval, branchId: string, date: string): Promise<StaffBillingRow[]> {
    if (approval.kind !== 'accounting.collection' && approval.kind !== 'closing.submit') return [];
    const cols = ((approval.payload as DraftPayload).columns ?? []).filter((c) => Number(c.computed_total) > 0);
    if (!cols.length) return [];

    const [staffSnap, transfersSnap, branchSnap, settingsSnap] = await Promise.all([
      this.fs.col('staff').get(),
      this.fs.col('staff_transfers').where('status', '==', 'active').get(),
      this.fs.col('branches').doc(branchId).get(),
      this.fs.col('settings').doc('global').get(),
    ]);

    const staff: StaffDoc[] = staffSnap.docs.map((d: any) => ({ id: d.id, ...(d.data() as object) }));
    const transfers: TransferDoc[] = transfersSnap.docs.map((d: any) => d.data() as TransferDoc);
    const branch: BranchDoc | undefined = branchSnap.exists ? { id: branchSnap.id, ...(branchSnap.data() as object) } : undefined;
    const globalSettings: GlobalSettings | undefined = settingsSnap.exists ? (settingsSnap.data() as GlobalSettings) : undefined;

    const byName = new Map<string, StaffDoc>();
    for (const s of staff) if (s.name) byName.set(normName(s.name), s);

    const rows: StaffBillingRow[] = [];
    for (const c of cols) {
      const s = byName.get(normName(c.name));
      if (!s) {
        this.logger.warn(`Column "${c.name}" matched no staff — counted in cash, not attributed.`);
        continue;
      }
      rows.push(
        buildStaffBillingRow({
          staff: s,
          billing: Number(c.computed_total) || 0,
          entryBranchId: branchId,
          date,
          branch,
          globalSettings,
          transfers,
        }),
      );
    }
    return rows;
  }
}

const normName = (x: string): string => x.trim().toLowerCase();

/** Rollup-merge incoming staff rows into an existing staff_billing array by staff_id. */
function mergeBilling(existing: StaffBillingRow[], incoming: StaffBillingRow[]): StaffBillingRow[] {
  const out = existing.map((r) => ({ ...r }));
  for (const row of incoming) {
    const i = out.findIndex((r) => r.staff_id === row.staff_id);
    if (i >= 0) out[i] = mergeStaffRow(out[i], row);
    else out.push(row);
  }
  return out;
}

/** Today's date as YYYY-MM-DD in Asia/Kolkata (the salon chain's timezone). */
function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
