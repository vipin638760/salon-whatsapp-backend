import { parseLedgerText } from '../src/accounting/ledger-text';
import { reconcileLedger } from '../src/accounting/ledger-extractor';

describe('parseLedgerText → reconcileLedger (captain text path)', () => {
  it('parses collection-only text into columns, no reconciliation', () => {
    const { input, isClosing } = parseLedgerText('KAMIL 50 50 100\nASHKAR 60 150 100');
    expect(isClosing).toBe(false);
    expect(input.columns.map((c) => c.name)).toEqual(['KAMIL', 'ASHKAR']);
    const draft = reconcileLedger(input);
    expect(draft.columns[0].computed_total).toBe(200);
    expect(draft.columns[1].computed_total).toBe(310);
    expect(draft.reconciliation).toBeNull();
  });

  it('reconciles a balanced closing (cash matches expected)', () => {
    // collections 200+310=510, minus online 100, minus expense 10 = 400 expected
    const { input, isClosing } = parseLedgerText(
      'KAMIL 50 50 100\nASHKAR 60 150 100\nonline 100\nexpense 10\ncash 400',
    );
    expect(isClosing).toBe(true);
    const draft = reconcileLedger(input);
    expect(draft.reconciliation!.expected_cash).toBe(400);
    expect(draft.reconciliation!.reconciles).toBe(true);
    expect(draft.requires_explanation).toBe(false);
  });

  it('flags an unbalanced closing for explanation', () => {
    const { input } = parseLedgerText('KAMIL 50 50 100\nonline 100\ncash 50');
    const draft = reconcileLedger(input); // expected 200-100=100, counted 50
    expect(draft.reconciliation!.difference).toBe(-50);
    expect(draft.reconciliation!.reconciles).toBe(false);
    expect(draft.requires_explanation).toBe(true);
    expect(draft.auto_post).toBe(false);
  });

  it('categorizes deductions: online vs expense, with the breakdown carried through', () => {
    const { input } = parseLedgerText('KAMIL 50 50 100\ngpay 100\nexpense 10\ncash 90');
    const items = input.reconciliation!.deduction_items!;
    expect(items).toEqual([
      { category: 'online', label: 'gpay', amount: 100 },
      { category: 'expense', label: 'expense', amount: 10 },
    ]);
    const draft = reconcileLedger(input); // 200 − 110 = 90 expected, counted 90
    expect(draft.reconciliation!.reconciles).toBe(true);
    expect(draft.reconciliation!.deduction_breakdown).toEqual(items);
  });

  it('handles "50+10" and ₹/comma amounts in text', () => {
    const { input } = parseLedgerText('ASHKAR 50+10 150\ncash 1,210');
    const draft = reconcileLedger(input);
    expect(draft.columns[0].computed_total).toBe(210);
    expect(draft.reconciliation!.cash_counted).toBe(1210);
  });
});
