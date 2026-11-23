/**
 * Roles. vcut-app has admin | accountant | employee. WhatsApp adds OWNER
 * (an admin over all branches) and CAPTAIN — which, per locked decision §2,
 * is NOT a new permission system: a captain is an `accountant` hard-scoped to
 * one branch. The scope is enforced in SenderContext.branchId, never trusted
 * from the message.
 */
export enum Role {
  OWNER = 'owner',
  ADMIN = 'admin',
  ACCOUNTANT = 'accountant',
  CAPTAIN = 'captain',
  EMPLOYEE = 'employee',
  CUSTOMER = 'customer',
}

/** Salary is owner/admin only — mask everywhere else (vcut-app rule). */
export function canSeeSalary(role: Role): boolean {
  return role === Role.OWNER || role === Role.ADMIN;
}

export const SALARY_MASK = '•••••';
