/**
 * The permission catalogue and the role bundles built from it.
 *
 * Permissions are `resource:action:scope`. Scope is `own` (rows belonging to
 * the caller), `all` (every row in the tenant), or `system` (reserved for
 * internal callers such as the payment module activating a policy — no human
 * role is ever granted a `system` permission).
 *
 * This file is the seed source of truth. At runtime the bundles live in the
 * database and are editable from the admin portal without a redeploy; the
 * seeder reconciles the database against this catalogue on every deploy so a
 * newly added permission is never silently missing in production.
 */

export const PERMISSIONS = {
  // --- policies ----------------------------------------------------------
  'policies:read:own': 'View your own policies',
  'policies:read:all': 'View any policy',
  'policies:create:own': 'Subscribe to a policy',
  'policies:submit:own': 'Submit a drafted application',
  'policies:review:all': 'Take an application under review',
  'policies:approve:all': 'Approve or decline an application',
  'policies:activate:system': 'Activate cover once payment settles (internal)',
  'policies:suspend:all': 'Suspend or reinstate cover',
  'policies:expire:system': 'Expire a policy at term end (internal)',
  'policies:cancel:own': 'Cancel your own policy',
  'policies:cancel:all': 'Cancel any policy',
  'policies:renew:own': 'Renew your own policy',

  // --- quotes ------------------------------------------------------------
  'quotes:create:own': 'Request a quotation',
  'quotes:read:own': 'View your own quotations',
  'quotes:create:all': 'Quote on behalf of a client',

  // --- claims ------------------------------------------------------------
  'claims:create:own': 'File a claim on your own policy',
  'claims:read:own': 'Track your own claims',
  'claims:read:all': 'View any claim',
  'claims:investigate:all': 'Begin investigation',
  'claims:assess:all': 'Assess quantum',
  'claims:approve:all': 'Approve or reject a claim',
  'claims:pay:all': 'Release a claim payout',
  'claims:close:all': 'Close a claim file',
  'claims:reopen:all': 'Reopen a closed claim',

  // --- payments ----------------------------------------------------------
  'payments:create:own': 'Pay your own premium',
  'payments:read:own': 'View your own payment history',
  'payments:read:all': 'View any payment',
  'payments:refund:all': 'Issue a refund',
  'payments:reconcile:all': 'Run financial reconciliation',

  // --- members -----------------------------------------------------------
  'members:read:own': 'View your own profile',
  'members:update:own': 'Update your own profile',
  'members:read:all': 'View any member profile',
  'beneficiaries:manage:own': 'Manage your family and beneficiaries',
  'vehicles:manage:own': 'Manage your vehicles',
  'firms:manage:own': 'Manage your law firm and its assets',

  // --- Bar Association ---------------------------------------------------
  'bar:verify:all': 'Approve or reject membership verifications',
  'bar:stats:read': 'View aggregate Bar statistics',

  // --- documents ---------------------------------------------------------
  'documents:read:own': 'Download your own documents',
  'documents:read:all': 'Access any document',
  'documents:upload:own': 'Upload documents to your file',

  // --- administration ----------------------------------------------------
  'admin:users:manage': 'Create, suspend and manage users',
  'admin:roles:manage': 'Edit roles and permissions',
  'admin:products:manage': 'Manage products, plans and pricing',
  'admin:audit:read': 'Read the audit log',
  'reports:read:all': 'Run financial, claims and risk reports',
  'reports:read:own': 'View your own statements',
} as const;

export type PermissionCode = keyof typeof PERMISSIONS;

export const ROLES = {
  lawyer: {
    nameEn: 'Lawyer',
    nameFr: 'Avocat',
    permissions: [
      'policies:read:own', 'policies:create:own', 'policies:submit:own',
      'policies:cancel:own', 'policies:renew:own',
      'quotes:create:own', 'quotes:read:own',
      'claims:create:own', 'claims:read:own',
      'payments:create:own', 'payments:read:own',
      'members:read:own', 'members:update:own',
      'beneficiaries:manage:own', 'vehicles:manage:own', 'firms:manage:own',
      'documents:read:own', 'documents:upload:own',
      'reports:read:own',
    ],
  },
  family_member: {
    nameEn: 'Family member',
    nameFr: 'Membre de la famille',
    permissions: [
      'policies:read:own', 'claims:create:own', 'claims:read:own',
      'members:read:own', 'documents:read:own',
    ],
  },
  agent: {
    nameEn: 'Insurance agent',
    nameFr: "Agent d'assurance",
    permissions: [
      'policies:read:all', 'policies:create:own',
      'quotes:create:all', 'quotes:read:own',
      'claims:read:all', 'payments:create:own', 'payments:read:all',
      'members:read:all', 'documents:read:all', 'reports:read:own',
    ],
  },
  claims_officer: {
    nameEn: 'Claims officer',
    nameFr: 'Gestionnaire de sinistres',
    permissions: [
      'policies:read:all', 'claims:read:all',
      'claims:investigate:all', 'claims:assess:all',
      'documents:read:all', 'members:read:all', 'reports:read:all',
    ],
  },
  finance_officer: {
    nameEn: 'Finance officer',
    nameFr: 'Responsable financier',
    permissions: [
      'policies:read:all', 'claims:read:all', 'claims:pay:all',
      'payments:read:all', 'payments:refund:all', 'payments:reconcile:all',
      'documents:read:all', 'reports:read:all',
    ],
  },
  insurance_manager: {
    nameEn: 'Insurance manager',
    nameFr: 'Manager assurance',
    permissions: [
      'policies:read:all', 'policies:review:all', 'policies:approve:all',
      'policies:suspend:all', 'policies:cancel:all',
      'claims:read:all', 'claims:approve:all', 'claims:close:all', 'claims:reopen:all',
      'payments:read:all', 'members:read:all', 'documents:read:all',
      'admin:products:manage', 'admin:users:manage', 'reports:read:all',
    ],
  },
  bar_admin: {
    nameEn: 'Bar Association administrator',
    nameFr: 'Administrateur du Barreau',
    // Deliberately narrow: the Bar verifies membership and sees aggregates.
    // It has no access to any individual policy, claim or payment.
    permissions: ['bar:verify:all', 'bar:stats:read', 'members:read:all'],
  },
  super_admin: {
    nameEn: 'Super administrator',
    nameFr: 'Super administrateur',
    permissions: ['*'],
  },
} as const;

export type RoleCode = keyof typeof ROLES;

export function permissionsForRoles(roles: readonly string[]): string[] {
  const set = new Set<string>();
  for (const role of roles) {
    const def = ROLES[role as RoleCode];
    if (!def) continue;
    for (const p of def.permissions) set.add(p);
  }
  return [...set];
}
