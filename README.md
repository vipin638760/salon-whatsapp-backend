# Salon WhatsApp Backend (scaffold)

A **Firestore-integration layer** that puts the V-Cut salon ERP on WhatsApp. Per the locked decisions in [`PRD_REVIEW.md`](./PRD_REVIEW.md) §11, **Firestore stays the source of truth** — this service reads/writes the same collections `vcut-app` uses. There is no Postgres and no second database in v1.

> Status: **scaffold / skeleton.** Webhook verification, signature validation, idempotency, phone→role resolution, the approval gate and routing are wired. Money-touching logic (amount extraction, the actual `entries` writes, P&L aggregation) is deliberately stubbed with `TODO`s that point at the vcut-app helpers to port.

## What's implemented
| Concern | File | State |
|---|---|---|
| Meta webhook verify (GET) + receive (POST) | `src/whatsapp/whatsapp.controller.ts` | ✅ |
| Raw-body signature check (`X-Hub-Signature-256`) | `src/whatsapp/meta-signature.guard.ts` | ✅ |
| Idempotency (dedup by message id, txn) | `src/whatsapp/message-router.service.ts` | ✅ |
| Phone → role (+ branch scope for captains) | `src/auth/role-resolver.service.ts` | ✅ |
| Approval engine (prepare → confirm → owner-approve → post) | `src/approvals/approvals.service.ts` | ✅ full gate + entries rollup |
| Ledger reconciliation (re-sum + flag + cash check) | `src/accounting/ledger-extractor.ts` | ✅ tested |
| Captain draft accounting (text → reconcile → draft) | `src/accounting/accounting.service.ts` + `ledger-text.ts` | ✅ text path |
| Owner summaries (cash movement + Net P&L) | `src/reporting/reporting.service.ts` | ⬜ aggregation stubbed |
| Immutable audit log | `src/audit/audit.service.ts` | ✅ |
| Message sender (text + templates) | `src/whatsapp/whatsapp.service.ts` | ✅ |

## Guardrails baked in (from locked decisions)
- **Source of truth = Firestore** — `FirestoreService` is the only data gateway; reuse vcut-app's `entries`, `invoices`, `service_logs`, `staff`, `branches`, `customers`.
- **Captain = branch-scoped accountant** — `Role.CAPTAIN` is `accountant` + a stored `branchId`; scope never comes from message text.
- **Salary masked** for non-owners (`canSeeSalary`, `SALARY_MASK`).
- **Both profit figures, labeled** — cash movement vs. the dashboard's Full Net P&L; the P&L is read from the same math, never recomputed.
- **Draft, never auto-post** — all writes go through `ApprovalsService`; discrepancies set `requires_explanation`; large expenses set `requires_owner_approval`.
- **Idempotent + signed webhooks** — safe under Meta redelivery; spoofed posts rejected.

## Collections
Reused (vcut-app): `branches`, `staff`, `staff_transfers`, `entries`, `invoices`, `service_logs`, `customers`, `menus`, `settings/global`, `day_closures`, `users`.
New (owned here): `whatsapp_contacts`, `whatsapp_conversations`, `whatsapp_messages`, `approvals`, `audit_logs`.

## Run (after wiring real credentials)
```bash
npm install
cp .env.example .env     # fill Meta + Firebase values; add serviceAccount.json
npm run start:dev        # http://localhost:3001/webhooks/whatsapp
```
This is a skeleton: `npm install` has not been run and no Meta/Firebase credentials are included. Point a Meta test number's webhook at `/webhooks/whatsapp` to exercise the verify + receive path.

## Next implementation tasks (in order)
1. Port vcut-app write helpers (`effectiveBranchOnDate`, incentive `Math.round`, loan `home_branch_id`, invoice/walk-in numbering) into a shared module.
2. ✅ `ApprovalsService.post()` upserts the daily `entries` doc by (branch_id, date), append-only + idempotent (`wa_posts`), with an `activity_log` trail. Builds `staff_billing` rows via ported vcut helpers (`vcut-helpers.ts`): incentive `Math.round` at the per-staff/branch-type rate, `home_branch_id` + `loan_flag` via `effectiveBranchOnDate`, rollup-merged by `staff_id`. A closing now splits collection into `cash` channel + `online` and routes expenses to `others`, via labeled deductions carried from the text (`gpay/upi/card/deposit` → online, `expense` → others). Owner sign-off closes the loop: `ownerApprove`/`ownerReject` move a CONFIRMED draft to POSTED (writes `entries`) or REJECTED (writes nothing); `listPendingOwner` + `resolvePending` back the owner's "approve #id" / "reject #id <reason>" replies in `ReportingService`. Still to add: material sales / `mat_incentive` (not on the text path).
3. ✅ Reconciliation logic (`ledger-extractor.ts`) re-sums columns, flags mismatches/low-confidence cells, and refuses non-reconciling cash — tested against `fixtures/handwritten-ledger-001.json` (`npm test`). Still to do: feed it from a real amount extractor (text → OCR → voice) and wire `AccountingService.parseAmounts` to it.
4. LLM intent classifier replacing `MessageRouterService.detectIntent` (tool-selection only; never computes money).
5. Port the dashboard's Full Net P&L aggregation into `ReportingService`.
6. WhatsApp message templates for business-initiated sends (reminders, owner summaries).
