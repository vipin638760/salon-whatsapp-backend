/**
 * Ported verbatim-in-behaviour from vcut-app/src/lib (calculations.js) and
 * entry/page.js, so WhatsApp-posted figures match the dashboard exactly.
 * See vcut-app/CLAUDE.md:
 *   • effectiveBranchOnDate is the ONLY truth for a staff's branch on a date.
 *   • incentive rate: per-staff override → branch-type global → 10% default.
 *   • incentive is ALWAYS Math.round(...) at source.
 *   • loan rows attribute salary to home_branch_id (loan_flag = true).
 */

export interface StaffDoc {
  id: string;
  name?: string;
  role?: string;
  branch_id?: string | null;
  incentive_pct?: number | string | null;
}
export interface BranchDoc {
  id: string;
  type?: string; // "mens" | "unisex"
}
export interface TransferDoc {
  staff_id: string;
  status?: string;
  start_date?: string | null;
  end_date?: string | null;
  to_branch_id?: string | null;
}
export interface GlobalSettings {
  mens_inc?: number;
  unisex_inc?: number;
}

export interface StaffBillingRow {
  staff_id: string;
  billing: number;
  material: number;
  incentive: number;
  mat_incentive: number;
  staff_total_inc: number;
  incentive_taken: boolean;
  present: boolean;
  home_branch_id: string | null;
  loan_flag: boolean;
}

const MAT_PCT = 0.05;

/** vcut-app effectiveBranchOnDate — honors an active transfer window. */
export function effectiveBranchOnDate(
  st: StaffDoc | null | undefined,
  dateStr: string,
  transfers: TransferDoc[] = [],
): string | null {
  if (!st) return null;
  const t = transfers.find(
    (x) =>
      x.staff_id === st.id &&
      x.status === 'active' &&
      (!x.start_date || x.start_date <= dateStr) &&
      (!x.end_date || x.end_date >= dateStr),
  );
  return t ? (t.to_branch_id ?? null) : (st.branch_id ?? null);
}

/** Incentive % for a staff on an entry (per-staff override → branch-type → 10). */
export function incentiveRate(
  staff: StaffDoc | undefined,
  branch: BranchDoc | undefined,
  globalSettings: GlobalSettings | undefined,
): number {
  if (staff && staff.incentive_pct !== undefined && staff.incentive_pct !== null && staff.incentive_pct !== '') {
    return Number(staff.incentive_pct) || 0;
  }
  if (branch && globalSettings) {
    return branch.type === 'unisex'
      ? Number(globalSettings.unisex_inc ?? 10) || 10
      : Number(globalSettings.mens_inc ?? 10) || 10;
  }
  return 10;
}

/**
 * Build one staff_billing row from a captain-reported billing figure.
 * Material is 0 on the text path (captain reports collection, not material
 * sales), so mat_incentive is 0 too. Incentive rounded at source.
 */
export function buildStaffBillingRow(args: {
  staff: StaffDoc;
  billing: number;
  entryBranchId: string;
  date: string;
  branch?: BranchDoc;
  globalSettings?: GlobalSettings;
  transfers?: TransferDoc[];
}): StaffBillingRow {
  const { staff, billing, entryBranchId, date, branch, globalSettings, transfers = [] } = args;
  const rate = incentiveRate(staff, branch, globalSettings);
  const incentive = Math.round(billing * (rate / 100));
  const home = effectiveBranchOnDate(staff, date, transfers);
  return {
    staff_id: staff.id,
    billing,
    material: 0,
    incentive,
    mat_incentive: 0,
    staff_total_inc: incentive, // no shared/material contribution on this path
    incentive_taken: true,
    present: true,
    home_branch_id: home,
    loan_flag: home !== entryBranchId,
  };
}

/** Add two rows for the same staff (rollup): sum money, keep attribution. */
export function mergeStaffRow(a: StaffBillingRow, b: StaffBillingRow): StaffBillingRow {
  return {
    ...a,
    billing: (Number(a.billing) || 0) + (Number(b.billing) || 0),
    material: (Number(a.material) || 0) + (Number(b.material) || 0),
    incentive: (Number(a.incentive) || 0) + (Number(b.incentive) || 0),
    mat_incentive: (Number(a.mat_incentive) || 0) + (Number(b.mat_incentive) || 0),
    staff_total_inc: (Number(a.staff_total_inc) || 0) + (Number(b.staff_total_inc) || 0),
  };
}

export { MAT_PCT };
