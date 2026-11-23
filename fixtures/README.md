# Reconciliation test fixtures

Real captain-submitted accounts, transcribed and human-verified, used as ground truth for the WhatsApp captain-accounting extractor.

Each fixture encodes: the raw columns/blocks, the **independently computed** sums, which handwritten totals match, low-confidence cells that must go to human review, and the **expected system behavior** — above all that a note which does not reconcile is kept as a `DRAFT` and never auto-posted.

| Fixture | Source | Tests |
|---|---|---|
| `handwritten-ledger-001.json` | Papergrid notebook, 2026-11-23 | Column re-summing (KAMIL 2650, ASHKAR 2760 both match), expense block (630 matches), and a **non-reconciling cash line** (expected 3770 vs written 370) → `requires_explanation: true`, status `DRAFT`. |

## Why these exist
Your locked decisions (see `../PRD_REVIEW.md` §11): extraction produces a **draft the captain confirms**, the system re-sums every column and flags mismatches, and any cash gap forces an explanation before a closing can be submitted. These fixtures are the concrete cases that logic must pass.

Add more fixtures as you collect messy real notes — strike-throughs, multi-staff columns, mixed cash/online, voice-note transcriptions. The harder and more ambiguous, the better.
