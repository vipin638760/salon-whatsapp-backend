import { LedgerInput, parseCell, DeductionCategory, DeductionItem } from './ledger-extractor';

/**
 * Turn a captain's free-text WhatsApp message into the structured LedgerInput
 * the reconciler consumes. This is the deliberately-simple text path; an OCR /
 * voice extractor will produce the same LedgerInput shape later. It NEVER adds
 * up money itself for the record — it only groups tokens; reconcileLedger does
 * the arithmetic and the flagging.
 *
 * Grammar (one item per line):
 *   "<name> <amt> <amt> …"   → a collection column (name + per-entry amounts)
 *   "cash <amt>"             → physical cash counted (closing)
 *   "online|gpay|upi|card|deposit|expense <amt>"  → a deduction from cash
 * Amounts may be "50", "50+10", "₹1,250".
 */

const CASH_KEYWORDS = ['cash'];
const ONLINE_KEYWORDS = ['online', 'gpay', 'upi', 'card', 'deposit'];
const EXPENSE_KEYWORDS = ['expense', 'expenses'];
const DEDUCTION_KEYWORDS = [...ONLINE_KEYWORDS, ...EXPENSE_KEYWORDS];

function deductionCategory(key: string): DeductionCategory {
  if (ONLINE_KEYWORDS.includes(key)) return 'online';
  if (EXPENSE_KEYWORDS.includes(key)) return 'expense';
  return 'other';
}

export interface ParsedLedgerText {
  input: LedgerInput;
  /** True once a cash line is present → treat as a closing to reconcile. */
  isClosing: boolean;
  unmatched_lines: string[];
}

function sumParsed(tokens: string[]): number {
  return tokens.reduce((s, t) => {
    const v = parseCell(t);
    return Number.isNaN(v) ? s : s + v;
  }, 0);
}

export function parseLedgerText(text: string): ParsedLedgerText {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const columns: LedgerInput['columns'] = [];
  const deductionItems: DeductionItem[] = [];
  let cashCounted: number | null = null;
  const unmatched: string[] = [];

  for (const line of lines) {
    const tokens = line.split(/\s+/);
    const key = tokens[0].toLowerCase().replace(/[:：,]/g, '');
    const rest = tokens.slice(1);

    if (!rest.length) {
      unmatched.push(line);
      continue;
    }

    if (CASH_KEYWORDS.includes(key)) {
      cashCounted = (cashCounted ?? 0) + sumParsed(rest);
    } else if (DEDUCTION_KEYWORDS.includes(key)) {
      deductionItems.push({ category: deductionCategory(key), label: key, amount: sumParsed(rest) });
    } else {
      columns.push({ name: tokens[0].replace(/[:：]/g, ''), entries: rest });
    }
  }

  const isClosing = cashCounted !== null;
  const input: LedgerInput = { columns };

  if (isClosing) {
    const collectionTotals = columns.map((c) => sumParsed(c.entries.map(String)));
    input.reconciliation = {
      collection_totals_used: collectionTotals,
      deductions: deductionItems.map((d) => d.amount),
      deduction_items: deductionItems,
      cash_counted: cashCounted as number,
    };
  }

  return { input, isClosing, unmatched_lines: unmatched };
}
