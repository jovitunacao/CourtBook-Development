import { SupabaseClient } from '@supabase/supabase-js';
import { EXISTING_FIXTURES } from '../config';

/**
 * Isolated Disposable Fixture Strategy for Safe Cross-Tenant WRITE Tests
 *
 * Safety Invariants:
 * 1. ZERO modification of existing production/seed entities:
 *    - Pickleball Test Facility (courtbook-pickleball-test / courtbook-test-pickleball-a)
 *    - Badminton Test Facility (courtbook-badminton-test / courtbook-test-badminton-b)
 * 2. ZERO targeting of real customer bookings or existing non-disposable reservations.
 * 3. Dedicated naming and reference tagging:
 *    - Prefix 'TD-W-' for disposable write-test reservations
 *    - Prefix 'test-disposable-' for disposable facilities, courts, and organizations
 * 4. Two-phase verification:
 *    - Before snapshot: captures exact state before mutation attempt
 *    - After snapshot: asserts state remains 100% unchanged on rejected operations
 * 5. Complete cleanup strategy:
 *    - Structured teardown in finally blocks
 *    - Pre-run and post-run sweeps to remove any orphaned disposable fixtures
 */

export interface DisposableReservationFixture {
  id: string;
  facility_id: string;
  court_id: string;
  reference_code: string;
  customer_name: string;
  customer_email: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  price: number;
}

export interface DisposableTenantCluster {
  tag: string;
  orgA: { id: string; slug: string; name: string };
  orgB: { id: string; slug: string; name: string };
  facA: { id: string; slug: string; name: string; default_hourly_rate: number; booking_confirmation_mode: string };
  facB: { id: string; slug: string; name: string; default_hourly_rate: number; booking_confirmation_mode: string };
  courtA: { id: string; name: string };
  courtB: { id: string; name: string };
  pendingResB?: DisposableReservationFixture;
  confirmedResB?: DisposableReservationFixture;
}

/**
 * Asserts that an entity is strictly a disposable test fixture and NOT an existing
 * fixture from Pickleball Test Facility or Badminton Test Facility.
 */
export function assertStrictlyDisposable(id: string, slugOrRef?: string): void {
  // Guard against targeting existing test facilities or organizations
  if (
    slugOrRef === EXISTING_FIXTURES.orgA.slug ||
    slugOrRef === EXISTING_FIXTURES.orgB.slug ||
    slugOrRef === EXISTING_FIXTURES.orgA.facilitySlug ||
    slugOrRef === EXISTING_FIXTURES.orgB.facilitySlug
  ) {
    throw new Error(
      `CRITICAL SAFETY VIOLATION: Attempted to target existing fixture [${slugOrRef}] as a write-test target! Only dedicated disposable fixtures tagged TD-W- or test-disposable- may be modified.`
    );
  }

  // If a reference code is provided, it must strictly follow disposable naming
  if (slugOrRef && !slugOrRef.startsWith('TD-') && !slugOrRef.startsWith('test-disposable-') && !slugOrRef.startsWith('td-')) {
    throw new Error(
      `CRITICAL SAFETY VIOLATION: Reference or slug [${slugOrRef}] does not carry required disposable prefix (TD- / test-disposable-). Real customer records are protected.`
    );
  }
}

/**
 * Sweeps any orphaned disposable write-test records from prior aborted runs.
 * Strictly constrained to reference codes starting with 'TD-W-' and slugs starting with 'test-disposable-'.
 */
export async function sweepOrphanedDisposableWriteFixtures(
  clientA: SupabaseClient,
  clientB: SupabaseClient
): Promise<{ cleanedReservations: number; cleanedCourts: number; cleanedFacilities: number }> {
  let cleanedReservations = 0;
  let cleanedCourts = 0;
  let cleanedFacilities = 0;

  try {
    // 1. Clean disposable reservations tagged 'TD-W-%'
    const { data: staleRes } = await clientA
      .from('reservations')
      .select('id, reference_code')
      .like('reference_code', 'TD-W-%');

    if (staleRes && staleRes.length > 0) {
      for (const r of staleRes) {
        assertStrictlyDisposable(r.id, r.reference_code);
        await clientA.from('reservations').delete().eq('id', r.id);
        cleanedReservations++;
      }
    }

    // 2. Clean disposable courts tagged 'test-disposable-%'
    const { data: staleCourts } = await clientA
      .from('courts')
      .select('id, name')
      .like('name', 'test-disposable-%');

    if (staleCourts && staleCourts.length > 0) {
      for (const c of staleCourts) {
        assertStrictlyDisposable(c.id, c.name);
        await clientA.from('courts').delete().eq('id', c.id);
        cleanedCourts++;
      }
    }

    // 3. Clean disposable facilities tagged 'test-disposable-%'
    const { data: staleFacs } = await clientA
      .from('facilities')
      .select('id, slug')
      .like('slug', 'test-disposable-%');

    if (staleFacs && staleFacs.length > 0) {
      for (const f of staleFacs) {
        assertStrictlyDisposable(f.id, f.slug);
        await clientA.from('facilities').delete().eq('id', f.id);
        cleanedFacilities++;
      }
    }
  } catch {
    // Non-blocking cleanup sweep
  }

  return { cleanedReservations, cleanedCourts, cleanedFacilities };
}

/**
 * Compares before and after snapshots of an object to verify that none of its
 * sensitive security fields were modified during a rejected operation.
 */
export function assertStateUnchanged(
  entityName: string,
  before: Record<string, any>,
  after: Record<string, any>,
  fieldsToCheck: string[]
): { isUnchanged: boolean; differences: string[] } {
  const differences: string[] = [];

  for (const field of fieldsToCheck) {
    if (before[field] !== after[field]) {
      differences.push(
        `${field} changed from [${JSON.stringify(before[field])}] to [${JSON.stringify(after[field])}]`
      );
    }
  }

  return {
    isUnchanged: differences.length === 0,
    differences,
  };
}
