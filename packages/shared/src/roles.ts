/**
 * MVP role set — the minimal practical decomposition from the design doc (R1–R10).
 * Technical-ops and security-custodian roles arrive with the V2 infrastructure
 * they govern; institution manager stays behind governance decision (gap #2).
 */
export const Role = {
  PlatformAdmin: "platform_admin",
  Operator: "operator",
  Approver: "approver",
  LifecycleAdmin: "lifecycle_admin",
  Auditor: "auditor",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const ALL_ROLES: readonly Role[] = Object.values(Role);

export function isRole(value: string): value is Role {
  return (ALL_ROLES as readonly string[]).includes(value);
}
