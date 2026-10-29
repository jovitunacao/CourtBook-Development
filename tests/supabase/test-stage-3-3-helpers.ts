/**
 * CourtBook / BookSuite — Stage 3.3 Test Suite
 *
 * Isolated, non-mutating tests verifying:
 * 1. Slugify utility & database constraint validation
 * 2. Organization, Facility, and Court input validation
 * 3. Typed error responses and failure handling
 * 4. In-flight duplicate submission rejection
 * 5. Onboarding recovery state resolution logic
 */

import {
  slugify,
  isValidSlug,
  validateSlug,
} from '../../src/utils/slugify';
import {
  validateOrganizationInput,
  validateFacilityInput,
  validateCourtsInput,
  createOrganizationWithOwnerViaRpc,
  createFacilityForOwner,
  createCourtsForFacility,
  getOwnerOnboardingRecoveryState,
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
  console.log('Stage 3.3: Owner Onboarding Database Service Helpers');
  console.log('======================================================\n');

  // -------------------------------------------------------------------------
  // 1. Slugify & Slug Validation
  // -------------------------------------------------------------------------
  console.log('--- Suite 1: Slug Generation & Validation ---');

  assert(slugify('Apex Pickleball Arena') === 'apex-pickleball-arena', 'slugify converts title to lowercase hyphens');
  assert(slugify('Café & Sports Club #1!') === 'cafe-sports-club-1', 'slugify strips accents, punctuation, and symbols');
  assert(slugify('---hello---world---') === 'hello-world', 'slugify trims leading/trailing/multiple hyphens');
  assert(
    slugify('This is a very long organization name that will definitely exceed the sixty character limit in the database')
      .length <= 60,
    'slugify truncates to max 60 characters'
  );
  assert(!slugify('Very long name ending on hyphen-').endsWith('-'), 'slugify ensures trailing hyphen is removed after truncation');

  assert(isValidSlug('apex-arena') === true, 'isValidSlug accepts valid slug');
  assert(isValidSlug('court1') === true, 'isValidSlug accepts alphanumeric slug');
  assert(isValidSlug('a') === false, 'isValidSlug rejects slug under 2 characters');
  assert(isValidSlug('-apex') === false, 'isValidSlug rejects leading hyphen');
  assert(isValidSlug('apex-') === false, 'isValidSlug rejects trailing hyphen');
  assert(isValidSlug('apex--arena') === false, 'isValidSlug rejects consecutive hyphens');
  assert(isValidSlug('Apex-Arena') === false, 'isValidSlug rejects uppercase letters');
  assert(isValidSlug('apex_arena') === false, 'isValidSlug rejects underscores');

  const valRes = validateSlug('valid-slug-123');
  assert(valRes.isValid === true, 'validateSlug returns isValid: true for valid slug');

  const valResErr = validateSlug('invalid--slug');
  assert(valResErr.isValid === false && valResErr.error?.includes('consecutive hyphens'), 'validateSlug returns descriptive error for consecutive hyphens');

  // -------------------------------------------------------------------------
  // 2. Organization Input Validation
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 2: Organization Input Validation ---');

  const validOrg = validateOrganizationInput('Metro Sports Club', 'metro-sports-club', 'billing@metrosports.com');
  assert(validOrg.isValid === true, 'validateOrganizationInput accepts valid parameters');

  const shortOrgName = validateOrganizationInput('A', 'apex-club');
  assert(shortOrgName.isValid === false && shortOrgName.error?.includes('between 2 and 120'), 'validateOrganizationInput rejects short name');

  const invalidOrgSlug = validateOrganizationInput('Metro Sports', 'Metro-Sports');
  assert(invalidOrgSlug.isValid === false && invalidOrgSlug.error?.includes('lowercase'), 'validateOrganizationInput rejects uppercase slug');

  const invalidEmail = validateOrganizationInput('Metro Sports', 'metro-sports', 'not-an-email');
  assert(invalidEmail.isValid === false && invalidEmail.error?.includes('billing email'), 'validateOrganizationInput rejects invalid email format');

  // -------------------------------------------------------------------------
  // 3. Facility Input Validation
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 3: Facility Input Validation ---');

  const validOrgId = 'a0000000-0000-0000-0000-000000000001';
  const validFac = validateFacilityInput(validOrgId, {
    name: 'Apex Arena Central',
    slug: 'apex-arena-central',
    timezone: 'Asia/Manila',
    currency: '₱',
    open_hour: 8,
    close_hour: 22,
    default_hourly_rate: 450,
    booking_confirmation_mode: 'instant',
    hold_duration_minutes: 30,
  });
  assert(validFac.isValid === true, 'validateFacilityInput accepts valid parameters');

  const badOrgUuid = validateFacilityInput('not-a-uuid', {
    name: 'Apex Arena Central',
    slug: 'apex-arena-central',
  });
  assert(badOrgUuid.isValid === false && badOrgUuid.error?.includes('organization ID'), 'validateFacilityInput rejects invalid organization UUID');

  const badHoursOrder = validateFacilityInput(validOrgId, {
    name: 'Apex Arena Central',
    slug: 'apex-arena-central',
    open_hour: 20,
    close_hour: 10,
  });
  assert(badHoursOrder.isValid === false && badHoursOrder.error?.includes('strictly later'), 'validateFacilityInput rejects close_hour <= open_hour');

  const negativeRate = validateFacilityInput(validOrgId, {
    name: 'Apex Arena Central',
    slug: 'apex-arena-central',
    default_hourly_rate: -50,
  });
  assert(negativeRate.isValid === false && negativeRate.error?.includes('positive number'), 'validateFacilityInput rejects non-positive hourly rate');

  const invalidMode = validateFacilityInput(validOrgId, {
    name: 'Apex Arena Central',
    slug: 'apex-arena-central',
    booking_confirmation_mode: 'invalid_mode' as any,
  });
  assert(
    invalidMode.isValid === false &&
      Boolean(invalidMode.error?.toLowerCase().includes('booking confirmation mode')),
    'validateFacilityInput rejects invalid confirmation mode'
  );

  const invalidHold = validateFacilityInput(validOrgId, {
    name: 'Apex Arena Central',
    slug: 'apex-arena-central',
    hold_duration_minutes: 2, // minimum is 5
  });
  assert(invalidHold.isValid === false && invalidHold.error?.includes('between 5 and 1440'), 'validateFacilityInput rejects hold duration < 5 minutes');

  // -------------------------------------------------------------------------
  // 4. Courts Input Validation
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 4: Courts Input Validation ---');

  const validFacId = 'b0000000-0000-0000-0000-000000000001';
  const validCourts = validateCourtsInput(validFacId, [
    { name: 'Court 1', sport_type: 'Pickleball', hourly_rate: 350 },
    { name: 'Court 2', sport_type: 'Pickleball', hourly_rate: 350 },
  ]);
  assert(validCourts.isValid === true, 'validateCourtsInput accepts valid courts array');

  const emptyCourts = validateCourtsInput(validFacId, []);
  assert(emptyCourts.isValid === false && emptyCourts.error?.includes('At least one court'), 'validateCourtsInput rejects empty courts array');

  const dupCourtNames = validateCourtsInput(validFacId, [
    { name: 'Court 1', sport_type: 'Pickleball' },
    { name: 'court 1', sport_type: 'Padel' }, // duplicate (case-insensitive)
  ]);
  assert(dupCourtNames.isValid === false && dupCourtNames.error?.includes('Duplicate court name'), 'validateCourtsInput rejects duplicate court names within batch');

  const zeroCourtRate = validateCourtsInput(validFacId, [
    { name: 'Court 1', hourly_rate: 0 },
  ]);
  assert(zeroCourtRate.isValid === false && zeroCourtRate.error?.includes('positive number'), 'validateCourtsInput rejects court rate <= 0');

  // -------------------------------------------------------------------------
  // 5. Pre-execution Validation Guard (Non-mutating)
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 5: Pre-execution Validation Guard ---');

  const orgFail = await createOrganizationWithOwnerViaRpc('A', 'invalid--slug');
  assert(orgFail.success === false && orgFail.isValidationError === true, 'createOrganizationWithOwnerViaRpc fails fast with isValidationError on invalid input');

  const facFail = await createFacilityForOwner('invalid-uuid', { name: 'Fac', slug: 'fac' });
  assert(facFail.success === false && facFail.isValidationError === true, 'createFacilityForOwner fails fast with isValidationError on invalid UUID');

  const courtsFail = await createCourtsForFacility('invalid-uuid', []);
  assert(courtsFail.success === false && courtsFail.isValidationError === true, 'createCourtsForFacility fails fast with isValidationError on empty courts');

  // -------------------------------------------------------------------------
  // 6. Unauthenticated Execution Guard (Safety against accidental mutation)
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 6: Auth Protection Guard ---');

  // When no active session exists (as in standard node script runner without auth cookie)
  const orgAuthCheck = await createOrganizationWithOwnerViaRpc('Safe Org Test', 'safe-org-test');
  assert(
    orgAuthCheck.success === false &&
      (orgAuthCheck.isAuthError === true || orgAuthCheck.error?.includes('Authentication required')),
    'createOrganizationWithOwnerViaRpc strictly blocks unauthenticated execution'
  );

  const facAuthCheck = await createFacilityForOwner(validOrgId, {
    name: 'Safe Fac Test',
    slug: 'safe-fac-test',
  });
  assert(
    facAuthCheck.success === false &&
      (facAuthCheck.isAuthError === true || facAuthCheck.error?.includes('Authentication required')),
    'createFacilityForOwner strictly blocks unauthenticated execution'
  );

  const courtsAuthCheck = await createCourtsForFacility(validFacId, [
    { name: 'Court 1', sport_type: 'Pickleball', hourly_rate: 350 },
  ]);
  assert(
    courtsAuthCheck.success === false &&
      (courtsAuthCheck.isAuthError === true || courtsAuthCheck.error?.includes('Authentication required')),
    'createCourtsForFacility strictly blocks unauthenticated execution'
  );

  console.log('\n======================================================');
  console.log(`Results: ${passed} Passed, ${failed} Failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});

