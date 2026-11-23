import { parseCell, reconcileLedger, LedgerInput } from '../src/accounting/ledger-extractor';
import fixture from '../fixtures/handwritten-ledger-001.json';

/**
 * Ground-truth test: the real captain photo transcribed in
 * fixtures/handwritten-ledger-001.json must produce a DRAFT that does NOT
 * auto-post, because the cash line (370) cannot be reconciled against the
 * expected 3770. Also proves columns are re-summed independently and
 * low-confidence columns are flagged for review.
 */
describe('parseCell', () => {
  it('reads plain numbers and strings', () => {
    expect(parseCell(50)).toBe(50);
    expect(parseCell('50')).toBe(50);
  });
  it('evaluates "N+10" remainder cells', () => {
    expect(parseCell('50+10')).toBe(60);
    expect(parseCell('50 + 10')).toBe(60);
  });
  it('strips ₹ and commas', () => {
    expect(parseCell('₹1,250')).toBe(1250);
  });
  it('returns NaN for unreadable cells', () => {
    expect(Number.isNaN(parseCell('u400+10'))).toBe(true);
    expect(Number.isNaN(parseCell('???'))).toBe(true);
  });
});

describe('reconcileLedger — fixture handwritten-ledger-001', () => {
  // Map the fixture to extractor input. ASHKAR's 4th cell is fed as the raw
  // string "50+10" (not the pre-parsed 60) to exercise parseCell end-to-end.
  const ashkar = fixture.columns.find((c) => c.name === 'ASHKAR')!;
  const ashkarEntries: Array<number | string> = ashkar.entries.map((v, i) => (i === 3 ? '50+10' : v));

  const input: LedgerInput = {
    columns: [
      {
        name: 'KAMIL',
        entries: fixture.columns.find((c) => c.name === 'KAMIL')!.entries,
        handwritten_total: 2650,
      },
      { name: 'ASHKAR', entries: ashkarEntries, handwritten_total: 2760 },
      {
        name: 'GOOGLE_GPAY',
        entries: fixture.columns.find((c) => c.name === 'GOOGLE_GPAY')!.entries,
        handwritten_total: null,
        low_confidence: true,
      },
    ],
    expenses: {
      items: fixture.expenses_block.items,
      handwritten_total: fixture.expenses_block.handwritten_total,
    },
    reconciliation: {
      collection_totals_used: [2750, 2650], // the rounded totals written on the page
      deductions: [1000, 630], // unlabeled -1000, expenses -630
      cash_counted: fixture.reconciliation_block_as_written.cash_circled, // 370
    },
  };

  const draft = reconcileLedger(input);
  const col = (name: string) => draft.columns.find((c) => c.name === name)!;

  it('re-sums KAMIL to 2650 and matches the handwritten total', () => {
    expect(col('KAMIL').computed_total).toBe(2650);
    expect(col('KAMIL').matches).toBe(true);
  });

  it('re-sums ASHKAR to 2760 (parsing the "50+10" cell) and matches', () => {
    expect(col('ASHKAR').computed_total).toBe(2760);
    expect(col('ASHKAR').matches).toBe(true);
  });

  it('flags the low-confidence GOOGLE_GPAY column for review', () => {
    expect(col('GOOGLE_GPAY').low_confidence).toBe(true);
    expect(col('GOOGLE_GPAY').matches).toBeNull();
  });

  it('re-sums expenses to 630 and matches', () => {
    expect(draft.expenses!.computed_total).toBe(630);
    expect(draft.expenses!.matches).toBe(true);
  });

  it('does NOT reconcile cash: 370 counted vs 3770 expected', () => {
    expect(draft.reconciliation!.expected_cash).toBe(3770);
    expect(draft.reconciliation!.reconciles).toBe(false);
    expect(draft.reconciliation!.requires_explanation).toBe(true);
    expect(draft.reconciliation!.difference).toBe(-3400); // 370 − 3770
  });

  it('refuses to auto-post — status DRAFT, requires explanation', () => {
    expect(draft.status).toBe('DRAFT');
    expect(draft.auto_post).toBe(false);
    expect(draft.requires_explanation).toBe(true);
    expect(draft.flags.length).toBeGreaterThan(0);
  });
});
