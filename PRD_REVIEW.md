# PRD Review — Salon WhatsApp AI Automation

**Reviewed against:** your live app (`vcut-app` — Next.js 16 / React 19 / Firebase Firestore, multi-branch salon ERP).
**Date:** 2026-11-23
**Verdict:** Architecturally sound PRD, but it is written as a *greenfield* build. ~70% of its data model and business logic **already exists** in your Firestore app. The biggest risk is not "can we build it" — it is **rebuilding what you already have and silently changing accounting definitions during migration.** Recommend: keep Firestore as source of truth, build WhatsApp as a thin *integration layer* on top of your existing data, and defer the full Postgres migration.

---

## 1. Executive summary

| Area | PRD quality | Main concern |
|---|---|---|
| WhatsApp architecture | Strong | Meta onboarding + template approval lead time underestimated |
| Role model | Good | Adds "Captain" role your app doesn't have; ignores existing `admin/accountant/employee` |
| Data model | Decent but duplicative | ~15 of 23 tables already exist in Firestore under different names/shapes |
| Accounting rules | Mostly correct | **PRD's "Net Operating Collection" ≠ your app's "Full Net P&L"** — they will disagree on every dashboard |
| Migration plan | Named but thin | Dual source-of-truth during parallel run is the #1 unsolved risk |
| Timeline (12 wk) | Optimistic | Realistic for WhatsApp layer only; not for full Firebase→Postgres migration |
| AI safety | Good | Correctly forbids inventing payments; needs hard tool-grounding, not free-gen |

**One-line recommendation:** Build Phase 1–3 (WhatsApp receptionist + captain accounting) as an **integration backend that reads/writes your existing Firestore** via the same conventions your app uses. Treat the NestJS+Postgres rewrite (section 15) as a *separate, later* decision — not a precondition.

---

## 2. Biggest risk: you already have this system

The PRD reads as if accounting, branches, staff, incentives and daily closing don't exist yet. They do. Mapping:

| PRD table / concept | Already in your app (Firestore) | Mismatch to resolve |
|---|---|---|
| `branches` | `branches` collection | PRD adds `captain_user_id`, `opening/closing_time` — you don't have captains or hours |
| `staff` | `staff` (name, salary, `incentive_pct`, join/exit, branch_id) | PRD's flat 10% ignores your per-staff `incentive_pct` |
| `services` / `service_prices` | `menus` (groups→items) + `settings/global` rates | PRD assumes branch-wise price table; you price via menu + GST rates by branch *type* |
| `appointments` / `appointment_items` | **Does not exist** — you are POS/walk-in, not booking-first | This is genuinely new. Biggest *additive* piece. |
| `payments` (per-booking) | `invoices` (draft/settled, `invoice_no`, walk-in #) **+** `entries` daily rollup | **Model conflict** — see §4 |
| `expenses` | `entries` (petrol/material_expense/others) + `expense_types` + `daily_expenses` | PRD per-expense rows vs your rollup+category grid |
| `staff_incentives` | computed from `service_logs` + `incentive_pct`, `Math.round` at source | PRD recomputes with flat rate — would drift from your numbers |
| `daily_closings` | `entries` (`actual_cash`) + `day_closures` (per-staff locked incentive) | Two of your constructs collapsed into one PRD table |
| `whatsapp_*`, `approvals`, `audit_logs` | **New** | Genuinely needed |
| `customers` | `customers` (+ denormalized `last_visit_*`) | PRD omits last-visit denorm your POS relies on |
| Loan resource (cross-branch staff) | `loan_flag` + `home_branch_id` across invoices/service_logs/entries | **PRD has no concept of this.** Sale→current branch, salary→home branch. Will break incentive attribution if ignored. |
| Mid-month transfers | `staff_transfers` + `effectiveBranchOnDate()` | PRD assumes static `branch_id`. Your truth is date-dependent. |

**Implication:** A from-scratch Postgres schema that doesn't encode `effectiveBranchOnDate`, loan attribution, walk-in numbering, invoice-sequence-per-branch-per-date, and GST-in-P&L **will produce different totals than your current dashboards** — and you'll spend the pilot reconciling rupee differences.

---

## 3. Role model mismatch

- **Your app:** `admin | accountant | employee` (see `dashboard/layout.js` NAV gate).
- **PRD:** `customer | staff | captain | owner | admin`.

"Captain" ≈ a branch-scoped accountant. Two options:
1. Map Captain → a new branch-scoped variant of `accountant` (cleaner, reuses your gates).
2. Add a genuinely new role (more work, touches every permission check).

**Critical gap the PRD misses:** your app has a hard rule — **salary is masked for non-admin** (`•••••`). The PRD lets a Captain see branch accounts and closing, which in your app *includes salary in P&L*. The WhatsApp layer **must preserve salary masking for captains**, or you leak payroll over WhatsApp. Not mentioned anywhere in the PRD.

---

## 4. Accounting correctness — the definitions don't match

This is the part to get right before any code.

**PRD** (§7.4): `Net Operating Collection = Total Collections − Refunds − Expenses`, cash/online tracked separately. Reasonable, standard.

**Your app** (CLAUDE.md): branch `n` = **Full Net P&L** = income − (variable + fixed + **salary** + **GST estimate** `iOnline × gst_pct/100`). Card colour: `n > 0` green, `n ≤ 0` red (zero = not profitable, never `n ≥ 0`).

These are **different quantities.** PRD's "net" excludes salary and GST; yours includes both. If the WhatsApp "closing report" shows PRD-net and the dashboard shows your Full Net P&L, the owner sees two different "profit" numbers for the same branch/day. 

**Must decide up front:** which definition is canonical, and make WhatsApp quote *that one*. Recommendation: WhatsApp reports **cash-movement** (physical cash reconciliation — what captains actually need) and **defers P&L to the dashboard's existing Full Net P&L**, so there's one profit number in the business.

Also good in the PRD and worth keeping: immutable ledger + reversals (not overwrites), idempotency on webhooks, separate physical-cash vs online-settlement balances. Your current model edits the daily `entry` in place — moving to an append-only ledger is a real improvement *if* you commit to it, but it's a rewrite of how `entries` work.

---

## 5. WhatsApp / Meta realities the PRD soft-pedals

- **Onboarding lead time:** Meta WhatsApp Business verification, number migration, and template approval routinely take **1–3 weeks** and can stall on business verification. This gates *everything* and isn't in the critical path of the 12-week plan.
- **Template + 24-hour window:** Business-initiated messages (booking reminders, closing nudges, owner summaries) need **pre-approved templates** and respect the 24h customer-service window. Your "notify owner / reminders / missing-branch nudges" all fall here — design the templates early.
- **One number, many roles, phone collisions:** a staff member who is also a customer, or a captain messaging from a personal number, breaks phone→role mapping. Need an explicit enrollment + "I'm acting as" disambiguation.
- **Cost:** WhatsApp conversation pricing (India) + OpenAI tokens are the variable costs that will dominate — not the ₹5.5k–16k infra line. Model them per-message.

---

## 6. AI safety — mostly right, two additions

The PRD correctly forbids inventing prices/payments and requires human review of uncertain OCR/voice. Add:
- **Hard tool-grounding:** the LLM must never *compute* money. It calls a priced tool/endpoint; it only phrases the result. Treat every number in a message as coming from a DB read, never from generation.
- **Confirmation before any write:** the PRD shows this for captain accounts — enforce it universally (booking, expense, closing, branch creation) via the "AI action approval engine" (§16), which is the right idea and should be a first-class service, not an afterthought.
- **Multi-language NLU risk:** Kannada/Hindi intent + amount extraction (code-switched, transliterated numbers) is materially harder than English. Pilot the amount-extraction accuracy before trusting it for accounting.

---

## 7. Migration (§15) — the unsolved core problem

"Run old and new in parallel" is stated but not designed. During parallel run, **what is the source of truth for a day's cash?** If both Firestore (your app) and Postgres (new backend) accept writes, they *will* diverge. Options:
- **A (recommended first):** WhatsApp backend is a *client* of Firestore — reads/writes the same collections your app uses, via the same helpers. No second database. No divergence. Postgres migration deferred until the WhatsApp layer is proven.
- **B:** Postgres is source of truth, Firestore app becomes a read replica via sync. Much more work; only worth it if you're committed to leaving Firebase.

The PRD jumps to B's architecture. A gets you WhatsApp value in weeks without betting the business on a migration.

---

## 8. Gaps not addressed in the PRD

- **No booking model exists today** — appointments/availability are the genuinely new build; your app is walk-in/POS. Scheduling, staff availability, and no-double-booking are net-new and non-trivial.
- **GST / tax invoicing** — your app already handles GST; PRD treats tax as an optional OCR field. Clarify compliance ownership.
- **DPDP Act (India) / data retention** — "customer consent & retention" is one line. Storing customer phone + visit history + chat transcripts needs an actual retention/opt-out policy.
- **Offline / poor connectivity** — captains in salons with bad signal; webhook/message durability (PRD's point 12 is good — keep it).
- **Existing invoice sequence / walk-in numbering** — `{BRANCH-PREFIX}-{DDMMYY}-{NNN}` and `Walk-in #NNN` must survive. Not in PRD.
- **Testing AI non-determinism** — acceptance tests (§13) are good but assume deterministic behavior; add eval-style tests for intent/amount extraction.

---

## 9. Recommended phasing (revised, lower-risk)

| Phase | Scope | Backend choice |
|---|---|---|
| 0 | Meta onboarding + template approval (start **now**, runs in parallel) | — |
| 1 | WhatsApp webhook + phone→role (reuse `admin/accountant/employee`, add branch-scoped "captain") + audit log | Reads/writes **existing Firestore** |
| 2 | Captain daily accounting: cash/online/expense capture → writes your existing `entries`, with confirm-before-save + immutable audit | Firestore |
| 3 | Daily closing (cash reconciliation only) + owner consolidated summary (defer P&L to dashboard's Full Net P&L) | Firestore |
| 4 | AI receptionist + **new** booking model (appointments/availability) — the genuinely new build | Firestore (+ new collections) |
| 5 | *Decision point:* do we actually need Postgres/NestJS? Migrate only if Firestore limits bite. | — |

This front-loads value (WhatsApp accounting in weeks), preserves your accounting truth, and makes the Postgres rewrite an *optional* later step instead of a precondition.

---

## 10. Open questions to lock before coding

1. **Canonical profit number:** WhatsApp cash-movement only, P&L from dashboard's Full Net P&L? (Recommended yes.)
2. **Captain = branch-scoped accountant**, or a brand-new role? (Recommended: reuse accountant, add branch scope.)
3. **Salary masking over WhatsApp for captains** — confirm it must be masked (your app already masks it).
4. **Source of truth during pilot** — Firestore (recommended) or new Postgres?
5. **Incentive rate** — honor your existing per-staff `incentive_pct` and loan attribution, not flat 10%? (Recommended yes.)
6. **Bookings** — is appointment scheduling in scope for v1, or is the receptionist info-only until the booking model exists?

---

## 11. Locked decisions (2026-11-23)

| # | Question | Decision | Consequence for the build |
|---|---|---|---|
| 1 | Canonical profit number | **Both, clearly labeled** | WhatsApp shows **Cash movement** (physical cash reconciliation) *and* **Net P&L** = the dashboard's existing Full Net P&L (income − variable − fixed − salary − GST est.). Both must be labeled so no one reads cash-in-hand as profit. The P&L figure is *read from the same computation your dashboard uses* — never recomputed in the WhatsApp layer. |
| 2 | Captain role | **Branch-scoped accountant** | No new role. Reuse `accountant` gates + a mandatory branch filter keyed to the captain's assigned branch. A captain is an accountant who can only ever see/act on one branch. |
| 3 | Source of truth (pilot) | **Firestore (existing)** | The WhatsApp backend is a *client* of your current Firestore. It reads/writes the same collections (`entries`, `invoices`, `service_logs`, `staff`, `branches`, `customers`) through the same helpers (`effectiveBranchOnDate`, incentive `Math.round`, loan `home_branch_id`, walk-in/invoice numbering). **No Postgres, no second DB, no divergence.** NestJS/Postgres rewrite is deferred to a later evidence-based decision. |
| 4 | Bookings in v1 | **Info-only receptionist** | v1 answers services/prices/branches and hands off to a human; it does **not** schedule. No appointments/availability model yet. Booking is a later phase. |
| 5 | Incentive rate (default) | **Existing per-staff `incentive_pct` + loan attribution** | Never a flat 10%. Sale attribution → current branch; salary attribution → `home_branch_id`. Mirrors `updateStaffRow`. |
| 6 | Salary over WhatsApp (default) | **Masked for captains** | Captain-facing cash/closing/incentive messages mask salary (`•••••`), same as your non-admin dashboard rule. Only the owner sees salary figures. |

**Net effect on the first build:** this is now a **Firestore-integration WhatsApp backend**, not a Postgres rewrite. The only *new* persistence is WhatsApp-specific: `whatsapp_contacts`, `whatsapp_conversations`, `whatsapp_messages`, `approvals`, `audit_logs` (new Firestore collections). Everything financial reuses what exists.

**Revised first deliverables** (supersedes PRD §18):
1. New Firestore collections for WhatsApp/audit/approvals (shapes + security rules).
2. Node/NestJS integration service skeleton: Meta webhook (verify + receive + idempotency), phone→role resolver (admin/accountant[+branch scope]/employee), audit logger.
3. Captain accounting intent → writes an existing daily `entry` behind a confirm step, salary masked, loan-aware.
4. Owner read commands → cash-movement + Full-Net-P&L summary (reusing dashboard math), salary visible to owner only.
5. AI action approval engine as a first-class service (prepare → confirm → post).

---

### Bottom line
The PRD is a solid blueprint for a *new* company. For *your* company, its main flaw is ignoring that the hard parts — multi-branch accounting, incentives, cross-branch loan attribution, P&L, transfers — already exist and are subtly nuanced. Build WhatsApp as a layer over what you have; treat the Postgres/NestJS rewrite as a separate, evidence-driven decision later. That cuts risk, preserves your numbers, and delivers WhatsApp value in weeks instead of months.
