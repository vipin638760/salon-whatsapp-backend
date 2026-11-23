import { Injectable } from '@nestjs/common';
import { FirestoreService } from '../firestore/firestore.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { canSeeSalary, Role, SALARY_MASK } from '../auth/role.types';
import type { SenderContext } from '../whatsapp/message-router.service';

/**
 * Owner read commands. Two labeled figures per locked decision §1:
 *   • CASH MOVEMENT — physical cash reconciliation (what a captain reports).
 *   • NET P&L — the dashboard's EXISTING Full Net P&L
 *     (income − variable − fixed − salary − GST est.), read from the same
 *     computation vcut-app uses. Never recomputed here with a new formula.
 *
 * Salary is shown to the owner; masked for anyone else (there is no non-owner
 * path to this service today, but the guard stays explicit).
 */
@Injectable()
export class ReportingService {
  constructor(
    private readonly fs: FirestoreService,
    private readonly approvals: ApprovalsService,
  ) {}

  async handleOwnerCommand(intent: string, text: string, ctx: SenderContext): Promise<string> {
    switch (intent) {
      case 'report.summary':
        return this.consolidated(ctx);
      case 'approvals.pending':
        return this.pendingApprovals();
      case 'approvals.approve':
        return this.actOnApproval(text, ctx, 'approve');
      case 'approvals.reject':
        return this.actOnApproval(text, ctx, 'reject');
      default:
        return 'Owner menu: 1) All-branch performance 2) Today’s revenue 3) Pending approvals 4) Closing status 5) Staff incentives.';
    }
  }

  /** List drafts awaiting the owner, newest-looking first. */
  private async pendingApprovals(): Promise<string> {
    const pending = await this.approvals.listPendingOwner();
    if (!pending.length) return 'No approvals waiting on you. ✅';
    const lines = pending.map((a) => {
      const flag = a.requires_explanation && !a.explanation ? ' ⚠️ needs explanation' : '';
      return `• #${a.id.slice(0, 6)} — ${a.kind} (${a.branch_id ?? 'network'})${flag}`;
    });
    return ['Awaiting your approval:', ...lines, '', 'Reply "approve #id" or "reject #id <reason>".'].join('\n');
  }

  /** Owner replies "approve #abc123" / "reject #abc123 wrong amount". */
  private async actOnApproval(text: string, ctx: SenderContext, mode: 'approve' | 'reject'): Promise<string> {
    const m = text.match(/#?\b([0-9a-z]{4,})\b/i);
    if (!m) return `Which one? Reply e.g. "${mode} #abc123".`;
    const draft = await this.approvals.resolvePending(m[1]);
    if (!draft) return `No pending draft matches "${m[1]}". It may already be handled.`;
    try {
      if (mode === 'approve') {
        await this.approvals.ownerApprove(draft.id, ctx.userId);
        return `Approved #${draft.id.slice(0, 6)} (${draft.kind}) — posted to ${draft.branch_id ?? 'network'}.`;
      }
      const reason = text.replace(/.*#?\b[0-9a-z]{4,}\b/i, '').trim();
      await this.approvals.ownerReject(draft.id, ctx.userId, reason || undefined);
      return `Rejected #${draft.id.slice(0, 6)}. Nothing was posted.`;
    } catch (e) {
      return (e as Error).message;
    }
  }

  /**
   * STUB: port the dashboard's branchData aggregation so the WhatsApp number
   * and the web dashboard always agree. Returns BOTH labeled figures.
   */
  private async consolidated(ctx: SenderContext): Promise<string> {
    const showSalary = canSeeSalary(ctx.role);
    // TODO: read `entries` + settings/global, reuse Full Net P&L math (n > 0 rule).
    const cashMovement = 0; // physical cash in hand across branches
    const netPL = 0; // dashboard Full Net P&L
    const salaryLine = showSalary ? '• Salary (payroll): ₹0' : `• Salary (payroll): ${SALARY_MASK}`;
    return [
      'Network summary (today):',
      `• Cash movement: ₹${cashMovement}`,
      `• Net P&L: ₹${netPL}  (full P&L — includes salary & GST)`,
      salaryLine,
      '',
      'These are two different numbers: cash in hand vs. profit. Reply a branch name for its detail.',
    ].join('\n');
  }
}
