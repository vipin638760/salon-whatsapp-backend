import { Injectable } from '@nestjs/common';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import type { InboundMessage, SenderContext } from '../whatsapp/message-router.service';
import { reconcileLedger, parseCell, LedgerDraft } from './ledger-extractor';
import { parseLedgerText } from './ledger-text';

/**
 * Captain-facing accounting. Everything here produces a DRAFT the captain
 * confirms — nothing posts to the financial record directly (locked §11).
 * A captain can only ever act on ctx.branchId (enforced upstream).
 *
 * The money arithmetic lives in ledger-extractor (re-sums + reconciles); this
 * service only parses the message, runs the reconciler, and carries its
 * requires_explanation flag into the approval gate.
 */
@Injectable()
export class AccountingService {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  async handleCaptainMessage(intent: string, m: InboundMessage, ctx: SenderContext): Promise<string> {
    switch (intent) {
      case 'accounting.collection':
        return this.draftCollection(m, ctx);
      case 'accounting.expense':
        return this.draftExpense(m, ctx);
      case 'closing.submit':
        return this.startClosing(m, ctx);
      default:
        return 'I can record collections, expenses, upload a bill, or run your daily closing. What would you like to do?';
    }
  }

  /**
   * Parse per-staff collection columns, INDEPENDENTLY re-sum them (never trust
   * a written total), flag any mismatch, and draft for confirmation.
   */
  private async draftCollection(m: InboundMessage, ctx: SenderContext): Promise<string> {
    const { input } = parseLedgerText(m.text ?? '');
    if (!input.columns.length) {
      return 'Send collections as lines like:\nKAMIL 50 50 100\nASHKAR 60 150 100\nI will total each column and read it back for you to confirm.';
    }
    const draft = reconcileLedger(input);

    const approval = await this.approvals.prepare({
      kind: 'accounting.collection',
      created_by_user_id: ctx.userId,
      created_by_phone: ctx.phone,
      branch_id: ctx.branchId,
      payload: draft as unknown as Record<string, unknown>,
      requires_explanation: draft.requires_explanation,
      requires_owner_approval: false,
    });
    await this.audit.log({
      actor_user_id: ctx.userId, actor_phone: ctx.phone, role: ctx.role, branch_id: ctx.branchId,
      action: 'accounting.draft.create', initiating_message_id: m.id, payload: draft as unknown as Record<string, unknown>, result: 'drafted',
    });
    return this.previewDraft(approval.id, draft, 'Reply CONFIRM to save');
  }

  private async draftExpense(m: InboundMessage, ctx: SenderContext): Promise<string> {
    const amount = parseCell((m.text ?? '').replace(/[^\d₹,+ ]/g, '').trim() || 'x');
    const safeAmount = Number.isNaN(amount) ? 0 : amount;
    const threshold = Number(process.env.LARGE_EXPENSE_APPROVAL_THRESHOLD ?? 5000);
    const draft = await this.approvals.prepare({
      kind: 'accounting.expense',
      created_by_user_id: ctx.userId,
      created_by_phone: ctx.phone,
      branch_id: ctx.branchId,
      payload: { amount: safeAmount, raw: m.text ?? '' },
      requires_explanation: safeAmount === 0, // couldn't read an amount → ask
      requires_owner_approval: safeAmount >= threshold, // large expense → owner
    });
    const extra = safeAmount >= threshold ? ' This is above the approval limit, so the owner will be asked to approve.' : '';
    if (safeAmount === 0) return `I couldn't read an amount in "${m.text ?? ''}". Send e.g. "expense 250 tea".`;
    return `Expense draft (#${draft.id.slice(0, 6)}): ₹${safeAmount}. Reply CONFIRM to submit.${extra}`;
  }

  /**
   * Daily closing. If the message already carries the figures (incl. a cash
   * line), reconcile immediately and force an explanation on any difference;
   * otherwise send the checklist.
   */
  private async startClosing(m: InboundMessage, ctx: SenderContext): Promise<string> {
    const { input, isClosing } = parseLedgerText(m.text ?? '');
    if (!isClosing) {
      return [
        'Daily closing — please send (one per line):',
        '• KAMIL 50 50 100   (collections per staff)',
        '• online 1000        (GPay / card / deposits)',
        '• expense 630        (with bills)',
        '• cash 370           (physical cash counted)',
        'I will reconcile and flag any difference for your explanation before submitting to the owner.',
      ].join('\n');
    }
    const draft = reconcileLedger(input);
    const approval = await this.approvals.prepare({
      kind: 'closing.submit',
      created_by_user_id: ctx.userId,
      created_by_phone: ctx.phone,
      branch_id: ctx.branchId,
      payload: draft as unknown as Record<string, unknown>,
      requires_explanation: draft.requires_explanation,
      requires_owner_approval: true, // closing always goes to the owner
    });
    await this.audit.log({
      actor_user_id: ctx.userId, actor_phone: ctx.phone, role: ctx.role, branch_id: ctx.branchId,
      action: 'closing.draft.create', initiating_message_id: m.id, payload: draft as unknown as Record<string, unknown>, result: 'drafted',
    });
    const action = draft.requires_explanation
      ? 'Reply with an explanation for the difference, then CONFIRM'
      : 'Reply CONFIRM to submit to the owner';
    return this.previewDraft(approval.id, draft, action);
  }

  // ─── preview ────────────────────────────────────────────
  private previewDraft(id: string, draft: LedgerDraft, action: string): string {
    const lines: string[] = [`Draft #${id.slice(0, 6)}:`];
    for (const c of draft.columns) {
      const tag = c.matches === false ? ` ⚠️ page says ${c.handwritten_total}` : c.low_confidence ? ' ⚠️ needs review' : '';
      lines.push(`• ${c.name}: ₹${c.computed_total}${tag}`);
    }
    if (draft.expenses) lines.push(`• Expenses: ₹${draft.expenses.computed_total}`);
    if (draft.reconciliation) {
      const r = draft.reconciliation;
      lines.push(`• Expected cash: ₹${r.expected_cash} | Counted: ₹${r.cash_counted}`);
      if (!r.reconciles) lines.push(`⚠️ Off by ₹${r.difference} — needs an explanation before this can be submitted.`);
    }
    lines.push('', action + ', or correct any figure.');
    return lines.join('\n');
  }
}
