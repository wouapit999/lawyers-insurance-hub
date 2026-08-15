import { permissionsForRoles, PERMISSIONS, ROLES } from './permissions';
import { hasPermission } from '../policy/policy-state-machine';

/**
 * The role catalogue decides who can approve a claim, move money, or read
 * another member's file. These tests assert the properties that must hold for
 * the whole authorisation model to mean anything.
 */
describe('permissionsForRoles()', () => {
  it('resolves a single role to its bundle', () => {
    const granted = permissionsForRoles(['lawyer']);
    expectOk(granted.includes('policies:read:own'));
    expectOk(granted.includes('claims:create:own'));
  });

  it('unions multiple roles without duplicating', () => {
    const granted = permissionsForRoles(['lawyer', 'agent']);
    expectEqual(new Set(granted).size, granted.length);
    expectOk(granted.includes('policies:read:own'));
    expectOk(granted.includes('policies:read:all'));
  });

  it('ignores an unknown role rather than throwing', () => {
    // A role removed from the catalogue but still assigned in the database
    // must degrade to "no extra permissions", never crash the request.
    expectDeepEqual(permissionsForRoles(['does_not_exist']), []);
    expectEqual(permissionsForRoles(['lawyer', 'does_not_exist']).length > 0, true);
  });

  it('returns nothing for an empty role list', () => {
    expectDeepEqual(permissionsForRoles([]), []);
  });
});

describe('role catalogue invariants', () => {
  it('grants no :system permission to any human role', () => {
    // :system permissions exist for internal callers only. The clearest case
    // is policies:activate:system — if a human role held it, a member could
    // be given cover without paying.
    for (const [code, def] of Object.entries(ROLES)) {
      for (const permission of def.permissions as readonly string[]) {
        expectOk(
          !permission.endsWith(':system'),
          `Role "${code}" holds "${permission}" — :system is for internal callers only`,
        );
      }
    }
  });

  it('references only permissions that exist in the catalogue', () => {
    // A typo in a bundle silently grants nothing, which is invisible until a
    // user cannot do their job in production.
    const known = new Set(Object.keys(PERMISSIONS));
    for (const [code, def] of Object.entries(ROLES)) {
      for (const permission of def.permissions as readonly string[]) {
        if (permission === '*') continue;
        expectOk(known.has(permission), `Role "${code}" references unknown "${permission}"`);
      }
    }
  });

  it('keeps the Bar Association out of policies, claims and payments', () => {
    // The Bar verifies membership and reads aggregates. Its access to
    // individual insurance records is a partnership boundary, not a
    // preference — widening it would need a new data-sharing agreement.
    const granted = permissionsForRoles(['bar_admin']);
    for (const permission of granted) {
      expectOk(
        !permission.startsWith('policies:') &&
          !permission.startsWith('claims:') &&
          !permission.startsWith('payments:'),
        `bar_admin must not hold "${permission}"`,
      );
    }
  });

  it('gives super_admin a wildcard that satisfies every declared permission', () => {
    const granted = permissionsForRoles(['super_admin']);
    for (const permission of Object.keys(PERMISSIONS)) {
      expectOk(hasPermission(granted, permission), `super_admin should satisfy ${permission}`);
    }
  });

  it('names every role in both English and French', () => {
    for (const [code, def] of Object.entries(ROLES)) {
      expectOk(def.nameEn.length > 0, `${code} has no English name`);
      expectOk(def.nameFr.length > 0, `${code} has no French name`);
    }
  });

  it('describes every permission, so the admin UI can explain a grant', () => {
    for (const [code, description] of Object.entries(PERMISSIONS)) {
      expectOk(description.length > 0, `Permission "${code}" has no description`);
    }
  });

  it('separates claim approval from claim payment', () => {
    // Segregation of duties: the person who approves an indemnity must not
    // also be the one who releases the money.
    const officer = permissionsForRoles(['claims_officer']);
    const finance = permissionsForRoles(['finance_officer']);

    expectOk(!officer.includes('claims:approve:all'), 'an officer must not approve');
    expectOk(!officer.includes('claims:pay:all'), 'an officer must not pay');
    expectOk(!finance.includes('claims:approve:all'), 'finance must not approve what it pays');
    expectOk(finance.includes('claims:pay:all'), 'finance releases the payout');
  });
});
