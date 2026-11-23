import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../firestore/firestore.service';
import { Role } from './role.types';
import type { SenderContext } from '../whatsapp/message-router.service';

/**
 * Maps a WhatsApp phone number to a role + branch scope using the existing
 * `users` / `staff` collections, cached in `whatsapp_contacts`.
 *
 * Security (PRD §11): a captain's branchId comes ONLY from their stored
 * assignment, never from message text. Unknown numbers resolve to CUSTOMER
 * (info-only, v1). Phone collisions (staff who is also a customer) are
 * resolved in favour of the staff/captain role, and should later support an
 * explicit "acting as" switch.
 */
@Injectable()
export class RoleResolverService {
  private readonly logger = new Logger(RoleResolverService.name);

  constructor(private readonly fs: FirestoreService) {}

  async resolve(phone: string): Promise<SenderContext> {
    const normalized = this.normalize(phone);

    // 1. Fast path: cached contact.
    const contact = await this.fs.col('whatsapp_contacts').doc(normalized).get();
    if (contact.exists) {
      const c = contact.data()!;
      return { userId: c.user_id ?? null, role: (c.role as Role) ?? Role.CUSTOMER, branchId: c.branch_id ?? null, phone: normalized };
    }

    // 2. Look up an ERP user by phone (users collection carries role + branch).
    const userSnap = await this.fs.col('users').where('phone', '==', normalized).limit(1).get();
    if (!userSnap.empty) {
      const u = userSnap.docs[0];
      const data = u.data();
      const role = this.mapRole(data.role, data.branch_id);
      const ctx: SenderContext = {
        userId: u.id,
        role,
        branchId: role === Role.CAPTAIN ? (data.branch_id ?? null) : (data.branch_id ?? null),
        phone: normalized,
      };
      await this.cache(normalized, ctx);
      return ctx;
    }

    // 3. Unknown → customer.
    const ctx: SenderContext = { userId: null, role: Role.CUSTOMER, branchId: null, phone: normalized };
    await this.cache(normalized, ctx);
    return ctx;
  }

  /** accountant + a single branch assignment ⇒ treat as branch-scoped captain. */
  private mapRole(raw: string | undefined, branchId: string | undefined): Role {
    switch (raw) {
      case 'admin':
        return Role.OWNER; // single-owner business; admin over all branches
      case 'accountant':
        return branchId ? Role.CAPTAIN : Role.ACCOUNTANT;
      case 'employee':
        return Role.EMPLOYEE;
      default:
        return Role.CUSTOMER;
    }
  }

  private async cache(phone: string, ctx: SenderContext): Promise<void> {
    await this.fs.col('whatsapp_contacts').doc(phone).set(
      { phone, user_id: ctx.userId, role: ctx.role, branch_id: ctx.branchId, updated_at: this.fs.now() },
      { merge: true },
    );
  }

  /** Strip '+', spaces; keep digits. Align with how vcut-app stores phone. */
  private normalize(phone: string): string {
    return phone.replace(/[^\d]/g, '');
  }
}
