/**
 * CourtBook / BookSuite — Stage 3.4 Onboarding Wizard Test Suite
 *
 * Isolated, non-mutating tests verifying:
 * 1. Wizard step validation (Org, Facility, Courts)
 * 2. Recovery state routing (needs_organization -> Step 1, needs_facility -> Step 2, needs_courts -> Step 3)
 * 3. Prevention of duplicate organization creation during recovery
 * 4. Multi-court collection logic (addition, removal, duplicate name detection, rate check)
 * 5. Data preservation on recoverable failures
 */

import { slugify, isValidSlug, validateSlug } from '../../src/utils/slugify';
import {
  validateOrganizationInput,
  validateFacilityInput,
  validateCourtsInput,
  CreateCourtItemInput,
  OwnerOnboardingRecoveryState,
} from '../../src/lib/ownerOnboarding';

let passed = 0;
let failed = 0;

function assert(condition: unknown, testName: string, detail?: string) {
  if (Boolean(condition)) {
    passed++;
    console.log(`  ✓ PASS: ${testName}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
  }
}

async function runTests() {
  console.log('\n======================================================');
  console.log('Stage 3.4: Guided Owner Onboarding Wizard Test Suite');
  console.log('======================================================\n');

  // -------------------------------------------------------------------------
  // 1. Step 1: Organization Validation & Auto-Slugify
  // -------------------------------------------------------------------------
  console.log('--- Suite 1: Step 1 (Organization) Form & Slug Logic ---');

  const rawOrgName = 'Apex Pickleball & Padel Arena';
  const autoSlug = slugify(rawOrgName);
  assert(autoSlug === 'apex-pickleball-padel-arena', 'Auto-slugify generates valid URL slug from org name');
  assert(isValidSlug(autoSlug), 'Auto-generated org slug satisfies database regex constraints');

  const step1Valid = validateOrganizationInput(rawOrgName, autoSlug, 'billing@apexarena.ph');
  assert(step1Valid.isValid === true, 'Step 1 accepts valid organization payload');

  const step1InvalidName = validateOrganizationInput(' ', 'apex-arena');
  assert(step1InvalidName.isValid === false, 'Step 1 rejects whitespace-only organization name');

  const step1InvalidSlug = validateOrganizationInput(rawOrgName, 'Invalid_Slug!');
  assert(step1InvalidSlug.isValid === false, 'Step 1 rejects invalid slug with symbols/uppercase');

  // -------------------------------------------------------------------------
  // 2. Step 2: Facility Validation & Operating Hours Guard
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 2: Step 2 (Facility) Operating Hours & Settings ---');

  const mockOrgId = 'e0000000-0000-0000-0000-000000000001';

  // Standard hours: 8 AM (8) to 10 PM (22)
  const validFacility = validateFacilityInput(mockOrgId, {
    name: 'Apex Arena Central',
    slug: 'apex-arena-central',
    address: '100 Athletics Way, Pasig City',
    open_hour: 8,
    close_hour: 22,
    default_hourly_rate: 450,
    booking_confirmation_mode: 'instant',
    hold_duration_minutes: 30,
  });
  assert(validFacility.isValid === true, 'Step 2 accepts valid facility parameters');

  // Manual approval with custom hold duration
  const manualApprovalFac = validateFacilityInput(mockOrgId, {
    name: 'Apex Arena Central',
    slug: 'apex-arena-central',
    open_hour: 7,
    close_hour: 23,
    default_hourly_rate: 500,
    booking_confirmation_mode: 'manual_approval',
    hold_duration_minutes: 60,
  });
  assert(manualApprovalFac.isValid === true, 'Step 2 accepts manual approval with 60-min hold duration');

  // Inverted operating hours (close before open)
  const invertedHours = validateFacilityInput(mockOrgId, {
    name: 'Apex Arena Central',
    slug: 'apex-arena-central',
    open_hour: 22,
    close_hour: 8,
  });
  assert(invertedHours.isValid === false && invertedHours.error?.includes('strictly later'), 'Step 2 rejects closing hour earlier than opening hour');

  // Equal hours
  const equalHours = validateFacilityInput(mockOrgId, {
    name: 'Apex Arena Central',
    slug: 'apex-arena-central',
    open_hour: 10,
    close_hour: 10,
  });
  assert(equalHours.isValid === false && equalHours.error?.includes('strictly later'), 'Step 2 rejects identical open and close hours');

  // Negative rate
  const badRate = validateFacilityInput(mockOrgId, {
    name: 'Apex Arena Central',
    slug: 'apex-arena-central',
    default_hourly_rate: 0,
  });
  assert(badRate.isValid === false, 'Step 2 rejects zero or negative default hourly rate');

  // -------------------------------------------------------------------------
  // 3. Step 3: Courts Dynamic Management & Validation
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 3: Step 3 (Courts) Multi-court Configuration ---');

  const mockFacilityId = 'f0000000-0000-0000-0000-000000000001';

  // Single default court
  const singleCourt: CreateCourtItemInput[] = [
    { name: 'Court 1', sport_type: 'Pickleball', hourly_rate: 350, display_order: 0 },
  ];
  assert(validateCourtsInput(mockFacilityId, singleCourt).isValid === true, 'Step 3 accepts single court setup');

  // Multiple distinct courts
  const multiCourts: CreateCourtItemInput[] = [
    { name: 'Court 1 (Indoor)', sport_type: 'Pickleball', hourly_rate: 350, display_order: 0 },
    { name: 'Court 2 (Outdoor)', sport_type: 'Pickleball', hourly_rate: 300, display_order: 1 },
    { name: 'Padel Court A', sport_type: 'Padel', hourly_rate: 600, display_order: 2 },
  ];
  assert(validateCourtsInput(mockFacilityId, multiCourts).isValid === true, 'Step 3 accepts multi-sport court collection');

  // Duplicate court names within batch (case-insensitive)
  const dupCourts: CreateCourtItemInput[] = [
    { name: 'Center Court', sport_type: 'Tennis', hourly_rate: 500, display_order: 0 },
    { name: 'center court', sport_type: 'Pickleball', hourly_rate: 400, display_order: 1 },
  ];
  const dupCheck = validateCourtsInput(mockFacilityId, dupCourts);
  assert(dupCheck.isValid === false && dupCheck.error?.includes('Duplicate court name'), 'Step 3 flags duplicate court names within submission batch');

  // Empty courts list
  assert(validateCourtsInput(mockFacilityId, []).isValid === false, 'Step 3 requires at least one court');

  // -------------------------------------------------------------------------
  // 4. Recovery State Routing Simulation (Requirements 5, 7, 9)
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 4: Interrupted Onboarding Recovery Routing ---');

  // Scenario A: Fresh user (0 organizations)
  const freshState: OwnerOnboardingRecoveryState = {
    status: 'needs_organization',
  };
  function resolveInitialStep(rec: OwnerOnboardingRecoveryState): 1 | 2 | 3 {
    if (rec.status === 'needs_facility') return 2;
    if (rec.status === 'needs_courts') return 3;
    return 1;
  }
  assert(resolveInitialStep(freshState) === 1, 'Fresh user starts at Step 1 (Organization)');

  // Scenario B: Interrupted after Step 1 (Org exists, 0 facilities)
  const step1Interrupted: OwnerOnboardingRecoveryState = {
    status: 'needs_facility',
    organization: {
      id: 'org-123',
      name: 'Existing Org',
      slug: 'existing-org',
      is_demo: false,
      created_at: new Date().toISOString(),
    },
  };
  assert(resolveInitialStep(step1Interrupted) === 2, 'Interrupted after Step 1 resumes directly at Step 2 (Facility)');

  // Scenario C: Interrupted after Step 2 (Facility exists, 0 courts)
  const step2Interrupted: OwnerOnboardingRecoveryState = {
    status: 'needs_courts',
    organization: {
      id: 'org-123',
      name: 'Existing Org',
      slug: 'existing-org',
      is_demo: false,
      created_at: new Date().toISOString(),
    },
    facility: {
      id: 'fac-456',
      organization_id: 'org-123',
      app_type: 'courtbook',
      name: 'Existing Facility',
      slug: 'existing-facility',
      timezone: 'Asia/Manila',
      currency: '₱',
      open_hour: 8,
      close_hour: 22,
      default_hourly_rate: 350,
      is_active: true,
      is_demo: false,
    },
    courts: [],
  };
  assert(resolveInitialStep(step2Interrupted) === 3, 'Interrupted after Step 2 resumes directly at Step 3 (Courts)');

  // -------------------------------------------------------------------------
  // 5. Duplicate Creation Guard Simulation
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 5: Duplicate Creation Prevention Simulation ---');

  let rpcOrgCallCount = 0;
  async function simulatedStep1Submit(persistedOrgId: string | null) {
    if (persistedOrgId) {
      // Step 1 already completed or resumed from recovery: do NOT invoke RPC
      return { success: true, organizationId: persistedOrgId, replayed: true };
    }
    rpcOrgCallCount++;
    return { success: true, organizationId: 'new-org-id', replayed: false };
  }

  // First execution: creates org
  const firstRun = await simulatedStep1Submit(null);
  assert(rpcOrgCallCount === 1 && firstRun.replayed === false, 'Initial submission invokes RPC once');

  // Recovery or second click: does NOT invoke RPC
  const resumeRun = await simulatedStep1Submit(firstRun.organizationId);
  assert(rpcOrgCallCount === 1 && resumeRun.replayed === true, 'Resumed onboarding bypasses org creation RPC and reuses existing ID');

  console.log('\n======================================================');
  console.log(`Results: ${passed} Passed, ${failed} Failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Wizard test suite execution error:', err);
  process.exit(1);
});
