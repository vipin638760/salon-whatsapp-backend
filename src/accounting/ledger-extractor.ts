/**
 * Ledger reconciliation — the logic a captain's handwritten/photo accounts run
 * through before anything is saved. It does NOT do OCR; it takes the structured
 * transcription an OCR/LLM step produces and:
 *
 *   1. independently re-sums every column (never trusts the handwritten total),
 *   2. flags any column whose computed sum ≠ the written total,
 *   3. flags low-confidence / unparseable cells for human review,
 *   4. reconciles the cash block and forces an explanation on any difference.
 *
 * Output is always a DRAFT with auto_post = false (locked decision §11).
 * Test coverage: fixtures/handwritten-ledger-001.json.
 */

export interface LedgerColumnInput {
  name: string;
  /** Cells may be numbers or strings like "50+10"; unparseable → flagged. */
  entries: Array<number | string>;
  handwritten_total?: number | null;
  low_confidence?: boolean;
}

export interface ExpenseItemInput {
  label: string;
  amount: number;
}

export interface ExpenseBlockInput {
  items: ExpenseItemInput[];
  handwritten_total?: number | null;
}

export type DeductionCategory = 'online' | 'expense' | 'other';

export interface DeductionItem {
  category: DeductionCategory;
  label: string;
  amount: number;
}

export interface ReconciliationInput {
  /** Collection totals summed on the page (e.g. per-staff column totals). */
  collection_totals_used: number[];
  /** Amounts subtracted (online/deposits, expenses, refunds…). */
  deductions: number[];
  /** Optional labeled breakdown of those deductions (online vs expense vs other). */
  deduction_items?: DeductionItem[];
  /** Physical cash counted / circled on the page. */
  cash_counted: number;
}

export interface LedgerInput {
  columns: LedgerColumnInput[];
  expenses?: ExpenseBlockInput;
  reconciliation?: ReconciliationInput;
}

export interface ColumnResult {
  name: string;
  computed_total: number;
  handwritten_total: number | null;
  matches: boolean | null; // null when no handwritten total to compare
  low_confidence: boolean;
  unparseable_cells: number[]; // indices of cells that could not be read
}

export interface ReconciliationResult {
  expected_cash: number;
  cash_counted: number;
  difference: number; // cash_counted − expected_cash
  reconciles: boolean;
  requires_explanation: boolean;
  /** Labeled deductions carried through so posting can split online vs expense. */
  deduction_breakdown: DeductionItem[];
}

export interface LedgerDraft {
  status: 'DRAFT';
  auto_post: false;
  columns: ColumnResult[];
  expenses: { computed_total: number; handwritten_total: number | null; matches: boolean | null } | null;
  reconciliation: ReconciliationResult | null;
  flags: string[];
  requires_explanation: boolean;
}

/** Parse one cell. Supports "50", 50, "50+10", "50 + 10". NaN ⇒ unparseable. */
export function parseCell(cell: number | string): number {
  if (typeof cell === 'number') return cell;
  const cleaned = cell.replace(/[₹,\s]/g, '');
  if (!/^[\d]+(\+[\d]+)*$/.test(cleaned)) return NaN;
  return cleaned.split('+').reduce((s, p) => s + Number(p), 0);
}

function sumColumn(col: LedgerColumnInput): { total: number; unparseable: number[] } {
  let total = 0;
  const unparseable: number[] = [];
  col.entries.forEach((cell, i) => {
    const v = parseCell(cell);
    if (Number.isNaN(v)) unparseable.push(i);
    else total += v;
  });
  return { total, unparseable };
}

export function reconcileLedger(input: LedgerInput): LedgerDraft {
  const flags: string[] = [];

  const columns: ColumnResult[] = input.columns.map((col) => {
    const { total, unparseable } = sumColumn(col);
    const hw = col.handwritten_total ?? null;
    const matches = hw === null ? null : total === hw;
    if (matches === false) {
      flags.push(`Column "${col.name}" sums to ${total} but the note says ${hw}.`);
    }
    if (unparseable.length) {
      flags.push(`Column "${col.name}" has ${unparseable.length} unreadable cell(s) — needs review.`);
    }
    if (col.low_confidence) {
      flags.push(`Column "${col.name}" marked low-confidence — needs review.`);
    }
    return {
      name: col.name,
      computed_total: total,
      handwritten_total: hw,
      matches,
      low_confidence: Boolean(col.low_confidence) || unparseable.length > 0,
      unparseable_cells: unparseable,
    };
  });

  let expenses: LedgerDraft['expenses'] = null;
  if (input.expenses) {
    const computed = input.expenses.items.reduce((s, it) => s + it.amount, 0);
    const hw = input.expenses.handwritten_total ?? null;
    const matches = hw === null ? null : computed === hw;
    if (matches === false) flags.push(`Expenses sum to ${computed} but the note says ${hw}.`);
    expenses = { computed_total: computed, handwritten_total: hw, matches };
  }

  let reconciliation: ReconciliationResult | null = null;
  if (input.reconciliation) {
    const { collection_totals_used, cash_counted, deduction_items } = input.reconciliation;
    // Prefer the labeled items when present (their sum IS the deduction total).
    const deductions = deduction_items?.length
      ? deduction_items.map((d) => d.amount)
      : input.reconciliation.deductions;
    const expected = collection_totals_used.reduce((s, v) => s + v, 0) - deductions.reduce((s, v) => s + v, 0);
    const difference = cash_counted - expected;
    const reconciles = difference === 0;
    if (!reconciles) {
      flags.push(
        `Cash does not reconcile: expected ₹${expected} but ₹${cash_counted} counted (difference ₹${difference}). An explanation is required.`,
      );
    }
    reconciliation = {
      expected_cash: expected,
      cash_counted,
      difference,
      reconciles,
      requires_explanation: !reconciles,
      deduction_breakdown: deduction_items ?? [],
    };
  }

  const requires_explanation =
    (reconciliation?.requires_explanation ?? false) ||
    columns.some((c) => c.matches === false || c.low_confidence) ||
    (expenses?.matches === false);

  return {
    status: 'DRAFT',
    auto_post: false,
    columns,
    expenses,
    reconciliation,
    flags,
    requires_explanation,
  };
}
