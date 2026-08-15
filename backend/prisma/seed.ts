/**
 * Seed: roles, permissions, products, plans and rating tables.
 *
 * Runs on every deploy and is idempotent — it reconciles the database against
 * the permission catalogue in @lih/domain rather than inserting blindly. A
 * permission added in code but missing in production would silently deny an
 * action to everyone, so this closes that gap automatically.
 *
 * Demo accounts are created in development only.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

import { PERMISSIONS, ROLES } from '../../packages/domain/src/rbac/permissions';

const prisma = new PrismaClient();
const TENANT = '00000000-0000-0000-0000-000000000001';

async function seedRbac(): Promise<void> {
  console.log('→ permissions');
  for (const [code, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, description },
      update: { description },
    });
  }

  console.log('→ roles');
  for (const [code, def] of Object.entries(ROLES)) {
    const role = await prisma.role.upsert({
      where: { code },
      create: {
        tenantId: TENANT, code, nameEn: def.nameEn, nameFr: def.nameFr, isSystem: true,
      },
      update: { nameEn: def.nameEn, nameFr: def.nameFr },
    });

    // The wildcard role holds no explicit rows — hasPermission() resolves '*'
    // in code, and enumerating every permission for super_admin would mean
    // re-seeding it each time one is added.
    if ((def.permissions as readonly string[]).includes('*')) continue;

    // Replace the bundle wholesale so a permission removed from the catalogue
    // is actually revoked, not left behind.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    const permissions = await prisma.permission.findMany({
      where: { code: { in: def.permissions as unknown as string[] } },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
  }
}

/** MVP catalogue: the three product lines the launch opens with. */
const CATALOGUE = [
  {
    code: 'PLI' as const,
    nameEn: 'Professional Liability',
    nameFr: 'Responsabilité civile professionnelle',
    descriptionEn: 'Cover against claims arising from professional advice and representation.',
    descriptionFr: "Couverture des réclamations liées au conseil et à la représentation.",
    plans: [
      {
        code: 'PLI-SILVER', nameEn: 'Silver', nameFr: 'Argent',
        basePremiumXaf: 200_000n,
        coverage: {
          limitXaf: '25000000', deductibleXaf: '250000',
          exclusionsEn: ['Fraud', 'Criminal acts'],
          exclusionsFr: ['Fraude', 'Actes criminels'],
        },
      },
      {
        code: 'PLI-GOLD', nameEn: 'Gold', nameFr: 'Or',
        basePremiumXaf: 450_000n,
        coverage: {
          limitXaf: '75000000', deductibleXaf: '150000',
          exclusionsEn: ['Fraud'], exclusionsFr: ['Fraude'],
        },
      },
    ],
    rating: {
      rules: [
        {
          kind: 'lookup', field: 'practice_areas',
          values: { criminal: 1.35, litigation: 1.25, corporate: 1.0, notarial: 0.95 },
          default: 1.1,
        },
        {
          kind: 'band', field: 'years_admitted',
          bands: [
            { max: 3, multiplier: 1.2 },
            { min: 3, max: 10, multiplier: 1.0 },
            { min: 10, multiplier: 0.9 },
          ],
        },
        {
          kind: 'band', field: 'firm_size',
          bands: [
            { max: 2, multiplier: 1.0 },
            { min: 2, max: 10, multiplier: 1.15 },
            { min: 10, multiplier: 1.3 },
          ],
          default: 1.0,
        },
        { kind: 'flag', field: 'prior_claims', whenTrue: 1.25 },
        { kind: 'discount', field: 'multi_policy', values: { true: 0.9 } },
      ],
      minPremiumXaf: 50_000,
      maxPremiumXaf: 5_000_000,
    },
  },
  {
    code: 'VEH' as const,
    nameEn: 'Vehicle Insurance',
    nameFr: 'Assurance véhicule',
    descriptionEn: 'CEMAC-compliant motor cover with instant certificates.',
    descriptionFr: 'Assurance automobile conforme CEMAC avec attestation immédiate.',
    plans: [
      {
        code: 'VEH-THIRD', nameEn: 'Third party', nameFr: 'Tiers',
        basePremiumXaf: 85_000n,
        coverage: { limitXaf: '10000000', typeEn: 'Third-party liability', typeFr: 'Responsabilité civile' },
      },
      {
        code: 'VEH-FULL', nameEn: 'Comprehensive', nameFr: 'Tous risques',
        basePremiumXaf: 240_000n,
        coverage: { limitXaf: '50000000', typeEn: 'Comprehensive', typeFr: 'Tous risques' },
      },
    ],
    rating: {
      rules: [
        {
          kind: 'band', field: 'vehicle_value_xaf',
          bands: [
            { max: 5_000_000, multiplier: 0.85 },
            { min: 5_000_000, max: 15_000_000, multiplier: 1.0 },
            { min: 15_000_000, max: 30_000_000, multiplier: 1.35 },
            { min: 30_000_000, multiplier: 1.8 },
          ],
          default: 1.0,
        },
        {
          kind: 'band', field: 'vehicle_age',
          bands: [
            { max: 5, multiplier: 1.0 },
            { min: 5, max: 12, multiplier: 1.15 },
            { min: 12, multiplier: 1.4 },
          ],
          default: 1.0,
        },
        { kind: 'lookup', field: 'usage', values: { private: 1.0, professional: 1.2 }, default: 1.0 },
      ],
      minPremiumXaf: 45_000,
    },
  },
  {
    code: 'MED' as const,
    nameEn: 'Medical Insurance',
    nameFr: 'Assurance santé',
    descriptionEn: 'Health cover for the lawyer and registered beneficiaries.',
    descriptionFr: "Couverture santé de l'avocat et de ses bénéficiaires.",
    plans: [
      {
        code: 'MED-FAMILY', nameEn: 'Family', nameFr: 'Famille',
        basePremiumXaf: 320_000n,
        coverage: { annualLimitXaf: '15000000', coInsurancePct: 20 },
      },
    ],
    rating: {
      rules: [
        {
          kind: 'band', field: 'beneficiary_count',
          bands: [
            { max: 2, multiplier: 1.0 },
            { min: 2, max: 5, multiplier: 1.4 },
            { min: 5, multiplier: 1.9 },
          ],
          default: 1.0,
        },
        {
          kind: 'band', field: 'eldest_age',
          bands: [
            { max: 45, multiplier: 1.0 },
            { min: 45, max: 60, multiplier: 1.25 },
            { min: 60, multiplier: 1.6 },
          ],
          default: 1.0,
        },
      ],
      minPremiumXaf: 120_000,
    },
  },
];

async function seedCatalogue(): Promise<void> {
  console.log('→ products, plans and rating tables');

  for (const [index, entry] of CATALOGUE.entries()) {
    const product = await prisma.product.upsert({
      where: { code: entry.code },
      create: {
        tenantId: TENANT, code: entry.code,
        nameEn: entry.nameEn, nameFr: entry.nameFr,
        descriptionEn: entry.descriptionEn, descriptionFr: entry.descriptionFr,
        sortOrder: index,
      },
      update: { nameEn: entry.nameEn, nameFr: entry.nameFr, sortOrder: index },
    });

    for (const [planIndex, planDef] of entry.plans.entries()) {
      const plan = await prisma.plan.upsert({
        where: { productId_code: { productId: product.id, code: planDef.code } },
        create: {
          tenantId: TENANT, productId: product.id, code: planDef.code,
          nameEn: planDef.nameEn, nameFr: planDef.nameFr,
          coverage: planDef.coverage,
          basePremiumXaf: planDef.basePremiumXaf,
          sortOrder: planIndex,
        },
        update: { coverage: planDef.coverage, basePremiumXaf: planDef.basePremiumXaf },
      });

      // Version 1, effective from the epoch of the scheme. Later repricings
      // insert version 2 with a future effective date; existing policies keep
      // pointing at the version that priced them.
      await prisma.ratingTable.upsert({
        where: { planId_version: { planId: plan.id, version: 1 } },
        create: {
          tenantId: TENANT, planId: plan.id, version: 1,
          factors: entry.rating,
          effectiveFrom: new Date('2026-01-01'),
        },
        update: { factors: entry.rating },
      });
    }
  }
}

async function seedDemoUsers(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.log('→ skipping demo accounts (production)');
    return;
  }

  console.log('→ demo accounts (development only)');
  const password = await argon2.hash('Demo-Passw0rd-2026', {
    type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1,
  });

  const accounts = [
    { email: 'avocat@demo.lih.cm', role: 'lawyer', phone: '+237670000001' },
    { email: 'barreau@demo.lih.cm', role: 'bar_admin', phone: '+237670000002' },
    { email: 'sinistres@demo.lih.cm', role: 'claims_officer', phone: '+237670000003' },
    { email: 'finance@demo.lih.cm', role: 'finance_officer', phone: '+237670000004' },
    { email: 'manager@demo.lih.cm', role: 'insurance_manager', phone: '+237670000005' },
  ];

  for (const account of accounts) {
    const user = await prisma.user.upsert({
      where: { email: account.email },
      create: {
        tenantId: TENANT, email: account.email, phoneE164: account.phone,
        passwordHash: password, status: 'active', preferredLang: 'fr',
        emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(),
      },
      update: { status: 'active' },
    });

    const role = await prisma.role.findUnique({ where: { code: account.role } });
    if (role) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId: role.id } },
        create: { userId: user.id, roleId: role.id },
        update: {},
      });
    }

    if (account.role === 'lawyer') {
      await prisma.lawyerProfile.upsert({
        where: { userId: user.id },
        create: {
          tenantId: TENANT, userId: user.id,
          barNumber: 'CM/BAR/2016/0412',
          fullName: 'Marie ANGO NKOLO',
          admittedOn: new Date('2016-11-18'),
          specialization: ['corporate', 'litigation'],
          // Pre-verified so the demo can subscribe without a second account
          // having to work the Bar queue first.
          verificationStatus: 'verified',
          verifiedAt: new Date(),
        },
        update: {},
      });
    }
  }

  console.log('   demo password for every account: Demo-Passw0rd-2026');
}

async function main(): Promise<void> {
  console.log('Seeding Lawyers Insurance Hub…');
  await seedRbac();
  await seedCatalogue();
  await seedDemoUsers();
  console.log('Seed complete.');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
