import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';

/**
 * The single gateway to the vcut-app Firestore (source of truth — locked
 * decision §3). All existing collections are reused as-is:
 *
 *   branches, staff, staff_transfers, entries, invoices, service_logs,
 *   customers, menus, settings/global, day_closures, users
 *
 * New WhatsApp-only collections this backend owns:
 *   whatsapp_contacts, whatsapp_conversations, whatsapp_messages,
 *   approvals, audit_logs
 *
 * IMPORTANT: this backend must honor vcut-app conventions when it writes —
 * effectiveBranchOnDate for staff branch, incentive Math.round at source,
 * loan `home_branch_id` attribution, per-branch-per-date invoice sequence,
 * walk-in numbering, and the `n > 0` (not >= 0) P&L colour rule. Those helpers
 * should be ported from vcut-app/src/lib, not re-invented here.
 */
@Injectable()
export class FirestoreService implements OnModuleInit {
  private readonly logger = new Logger(FirestoreService.name);
  private _db!: admin.firestore.Firestore;

  onModuleInit() {
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: process.env.FIREBASE_PROJECT_ID,
      });
      this.logger.log('Firebase Admin initialized (vcut-app project).');
    }
    this._db = admin.firestore();
  }

  get db(): admin.firestore.Firestore {
    return this._db;
  }

  col(name: string) {
    return this._db.collection(name);
  }

  /** Server timestamp helper so writes match vcut-app's serverTimestamp() rows. */
  now() {
    return admin.firestore.FieldValue.serverTimestamp();
  }
}
