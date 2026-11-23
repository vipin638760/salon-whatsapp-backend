import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../firestore/firestore.service';
import { WhatsappService } from './whatsapp.service';
import { RoleResolverService } from '../auth/role-resolver.service';
import { AccountingService } from '../accounting/accounting.service';
import { ReportingService } from '../reporting/reporting.service';
import { Role } from '../auth/role.types';

/**
 * The brain of the inbound path. For each message:
 *  1. dedup by WhatsApp message id (idempotency — Meta redelivers)
 *  2. store the raw inbound message
 *  3. resolve sender → role (+ branch scope for captains)
 *  4. route to the role-appropriate handler
 *
 * Intent detection (LLM) is stubbed — see detectIntent(). The model only
 * SELECTS an intent/tool; it never computes money or confirms writes.
 */
@Injectable()
export class MessageRouterService {
  private readonly logger = new Logger(MessageRouterService.name);

  constructor(
    private readonly fs: FirestoreService,
    private readonly wa: WhatsappService,
    private readonly roles: RoleResolverService,
    private readonly accounting: AccountingService,
    private readonly reporting: ReportingService,
  ) {}

  async handleWebhook(body: any): Promise<void> {
    const messages = this.extractMessages(body);
    for (const m of messages) {
      await this.handleOne(m);
    }
  }

  private async handleOne(m: InboundMessage): Promise<void> {
    // 1. Idempotency — first writer wins; redelivery is a no-op.
    const ref = this.fs.col('whatsapp_messages').doc(m.id);
    const created = await this.fs.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, {
        id: m.id,
        from: m.from,
        type: m.type,
        text: m.text ?? null,
        direction: 'in',
        processed: false,
        received_at: this.fs.now(),
      });
      return true;
    });
    if (!created) {
      this.logger.debug(`duplicate message ${m.id} ignored`);
      return;
    }

    // 3. Resolve sender → role (+ branch).
    const ctx = await this.roles.resolve(m.from);

    // 4. Route.
    const intent = await this.detectIntent(m, ctx.role);
    const reply = await this.route(intent, m, ctx);

    if (reply) await this.wa.sendText(m.from, reply);
    await ref.update({ processed: true, role: ctx.role, intent });
  }

  private async route(intent: string, m: InboundMessage, ctx: SenderContext): Promise<string | null> {
    switch (ctx.role) {
      case Role.OWNER:
      case Role.ADMIN:
        return this.reporting.handleOwnerCommand(intent, m.text ?? '', ctx);
      case Role.CAPTAIN:
      case Role.ACCOUNTANT:
        return this.accounting.handleCaptainMessage(intent, m, ctx);
      case Role.EMPLOYEE:
        return 'Staff self-service is coming soon. For now please contact your branch captain.';
      default:
        // Unknown number → treat as customer (info-only receptionist, v1).
        return 'Welcome to V-Cut Salon! 😊 Reply with: 1) Services & prices 2) Find a branch 3) Talk to our team.';
    }
  }

  /**
   * STUB: replace with an LLM intent classifier. It must return only a known
   * intent label and never fabricate amounts. Until then, a trivial keyword map.
   */
  private async detectIntent(m: InboundMessage, _role: Role): Promise<string> {
    const t = (m.text ?? '').toLowerCase();
    if (/close|closing/.test(t)) return 'closing.submit';
    if (/expense|bill/.test(t)) return 'accounting.expense';
    if (/cash|online|collection/.test(t)) return 'accounting.collection';
    if (/report|revenue|performance/.test(t)) return 'report.summary';
    if (/price|service|book/.test(t)) return 'receptionist.info';
    return 'unknown';
  }

  private extractMessages(body: any): InboundMessage[] {
    const out: InboundMessage[] = [];
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        for (const msg of change?.value?.messages ?? []) {
          out.push({
            id: msg.id,
            from: msg.from,
            type: msg.type,
            text: msg.text?.body,
          });
        }
      }
    }
    return out;
  }
}

export interface InboundMessage {
  id: string;
  from: string;
  type: string;
  text?: string;
}

export interface SenderContext {
  userId: string | null;
  role: Role;
  branchId: string | null; // non-null and enforced for captains
  phone: string;
}
