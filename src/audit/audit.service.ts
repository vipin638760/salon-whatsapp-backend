import { Injectable } from '@nestjs/common';
import { FirestoreService } from '../firestore/firestore.service';

export interface AuditEntry {
  actor_user_id: string | null; // resolved user, or null if unknown sender
  actor_phone: string;
  role: string | null;
  branch_id: string | null;
  action: string; // e.g. 'accounting.draft.create', 'closing.submit'
  initiating_message_id: string; // the WhatsApp message that caused it
  payload: Record<string, unknown>;
  result: 'drafted' | 'confirmed' | 'posted' | 'rejected' | 'error';
}

/**
 * Immutable action log (PRD §11, security §11). Every AI/user action that
 * touches data is written here with the WhatsApp message that initiated it.
 * Append-only: never update or delete an audit row.
 */
@Injectable()
export class AuditService {
  constructor(private readonly fs: FirestoreService) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.fs.col('audit_logs').add({ ...entry, created_at: this.fs.now() });
  }
}
