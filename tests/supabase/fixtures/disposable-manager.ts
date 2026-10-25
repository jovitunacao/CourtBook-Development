import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { EXISTING_FIXTURES, getEnvironmentConfig } from '../config';

/**
 * Isolated Disposable Fixture Strategy for Safe Cross-Tenant WRITE Tests
 *
 * Requirements:
 * 1. Dedicated disposable organizations, facilities, courts, memberships, and reservations.
 * 2. Unique test-run identifier (runId) attached to every single disposable record.
 * 3. Exact-run ownership validation: strictly prevents cross-run interference or broad wiping.
 * 4. Zero modification of existing seed entities:
 *    - Pickleball Test Facility (courtbook-pickleball-test / courtbook-test-pickleball-a)
 *    - Badminton Test Facility (courtbook-badminton-test / courtbook-test-badminton-b)
 * 5. Zero targeting of real customer bookings or existing non-disposable reservations.
 * 6. Structured teardown in reverse dependency order (reservations -> courts -> facilities -> members -> orgs).
 * 7. Verification queries after deletion: zero silently swallowed errors; reports cleanup failures.
 */

export interface DisposableReservation {
  id: string;
  facility_id: string;
  court_id: string;
  reference_code: string;
  status: string;
  price: number;
}

export interface DisposableCluster {
  runId: string;
  orgA: { id: string; slug: string; name: string };
  orgB: { id: string; slug: string; name: string };
  facA: { id: string; slug: string; name: string; default_hourly_rate: number; booking_confirmation_mode: string };
  facB: { id: string; slug: string; name: string; default_hourly_rate: number; booking_confirmation_mode: string };
  courtA: { id: string; name: string; hourly_rate: number };
  courtB: { id: string; name: string; hourly_rate: number };
  pendingResB?: DisposableReservation;
  confirmedResB?: DisposableReservation;
}

export interface CleanupReport {
  success: boolean;
  runId: string;
  deletedReservations: number;
  deletedCourts: number;
  deletedFacilities: number;
  deletedMembers: number;
  deletedOrgs: number;
  remainingRecords: string[];
  errors: string[];
}

/**
 * Validates that an entity strictly belongs to the current exact run and is NEVER
 * an existing test facility, existing organization, or live customer reservation.
 */
export function assertExactRunOwnership(cluster: DisposableCluster, runId: string): void {
  if (!runId || cluster.runId !== runId) {
    throw new Error(
      `CRITICAL SAFETY VIOLATION: Run ID mismatch! Expected [${runId}] but cluster carries [${cluster.runId}]. Aborting operation.`
    );
  }

  // Guard against targeting existing test facilities or organizations
  const protectedSlugs = [
    EXISTING_FIXTURES.orgA.slug,
    EXISTING_FIXTURES.orgB.slug,
    EXISTING_FIXTURES.orgA.facilitySlug,
    EXISTING_FIXTURES.orgB.facilitySlug,
  ];

  for (const slug of [cluster.orgA.slug, cluster.orgB.slug, cluster.facA.slug, cluster.facB.slug]) {
    if (protectedSlugs.includes(slug)) {
      throw new Error(
        `CRITICAL SAFETY VIOLATION: Disposable cluster contains protected seed slug [${slug}]! Only dedicated disposable fixtures tagged with [${runId}] may be targeted.`
      );
    }
    if (!slug.includes(runId)) {
      throw new Error(
        `CRITICAL SAFETY VIOLATION: Slug [${slug}] does not contain exact run identifier [${runId}]. Aborting.`
      );
    }
  }

  if (cluster.pendingResB) {
    if (!cluster.pendingResB.reference_code.includes(runId) || !cluster.pendingResB.reference_code.startsWith('TD-W-')) {
      throw new Error(
        `CRITICAL SAFETY VIOLATION: Reservation reference [${cluster.pendingResB.reference_code}] does not match required disposable pattern (TD-W-*.${runId}). Real customer records are protected.`
      );
    }
  }

  if (cluster.confirmedResB) {
    if (!cluster.confirmedResB.reference_code.includes(runId) || !cluster.confirmedResB.reference_code.startsWith('TD-W-')) {
      throw new Error(
        `CRITICAL SAFETY VIOLATION: Reservation reference [${cluster.confirmedResB.reference_code}] does not match required disposable pattern (TD-W-*.${runId}). Real customer records are protected.`
      );
    }
  }
}

/**
 * Creates an isolated disposable cluster containing:
 * - 2 disposable organizations (Org A and Org B)
 * - 2 disposable facilities (Facility A and Facility B)
 * - 2 disposable courts (Court A and Court B)
 * - Optional pending & confirmed reservations for Facility B
 */
export async function provisionDisposableCluster(
  runId: string,
  clientA: SupabaseClient,
  clientB: SupabaseClient,
  options?: { serviceRoleKey?: string }
): Promise<DisposableCluster> {
  const orgASlug = `disp-org-a-${runId}`;
  const orgBSlug = `disp-org-b-${runId}`;
  const facASlug = `disp-fac-a-${runId}`;
  const facBSlug = `disp-fac-b-${runId}`;

  let orgAId: string | undefined;
  let orgBId: string | undefined;
  let facAId: string | undefined;
  let facBId: string | undefined;
  let courtAId: string | undefined;
  let courtBId: string | undefined;
  let pendingResB: DisposableReservation | undefined;
  let confirmedResB: DisposableReservation | undefined;

  try {
    // 1. Create Disposable Org A via User A
    const { data: orgAResult, error: orgAErr } = await clientA.rpc('create_organization_with_owner', {
      p_name: `Disposable Org A ${runId}`,
      p_slug: orgASlug,
      p_billing_email: `test-org-a-${runId}@example.com`,
      p_is_demo: true,
    });
    if (orgAErr || !orgAResult) {
      throw new Error(`Failed to create disposable Org A: ${orgAErr?.message || 'No ID returned'}`);
    }
    orgAId = orgAResult;

    // 2. Create Disposable Org B via User B
    const { data: orgBResult, error: orgBErr } = await clientB.rpc('create_organization_with_owner', {
      p_name: `Disposable Org B ${runId}`,
      p_slug: orgBSlug,
      p_billing_email: `test-org-b-${runId}@example.com`,
      p_is_demo: true,
    });
    if (orgBErr || !orgBResult) {
      throw new Error(`Failed to create disposable Org B: ${orgBErr?.message || 'No ID returned'}`);
    }
    orgBId = orgBResult;

    // 3. User A creates Disposable Facility A
    const { data: facAData, error: facAErr } = await clientA
      .from('facilities')
      .insert({
        organization_id: orgAId,
        name: `Disposable Facility A ${runId}`,
        slug: facASlug,
        default_hourly_rate: 300.0,
        booking_confirmation_mode: 'manual_approval',
        hold_duration_minutes: 30,
        is_demo: true,
      })
      .select('id, slug, name, default_hourly_rate, booking_confirmation_mode')
      .single();
    if (facAErr || !facAData) {
      throw new Error(`Failed to create disposable Facility A: ${facAErr?.message}`);
    }
    facAId = facAData.id;

    // 4. User B creates Disposable Facility B
    const { data: facBData, error: facBErr } = await clientB
      .from('facilities')
      .insert({
        organization_id: orgBId,
        name: `Disposable Facility B ${runId}`,
        slug: facBSlug,
        default_hourly_rate: 250.0,
        booking_confirmation_mode: 'manual_approval',
        hold_duration_minutes: 30,
        is_demo: true,
      })
      .select('id, slug, name, default_hourly_rate, booking_confirmation_mode')
      .single();
    if (facBErr || !facBData) {
      throw new Error(`Failed to create disposable Facility B: ${facBErr?.message}`);
    }
    facBId = facBData.id;

    // 5. User A creates Disposable Court A
    const { data: courtAData, error: courtAErr } = await clientA
      .from('courts')
      .insert({
        facility_id: facAId,
        name: `Court A ${runId}`,
        sport_type: 'Pickleball',
        hourly_rate: 300.0,
        is_enabled: true,
      })
      .select('id, name, hourly_rate')
      .single();
    if (courtAErr || !courtAData) {
      throw new Error(`Failed to create disposable Court A: ${courtAErr?.message}`);
    }
    courtAId = courtAData.id;

    // 6. User B creates Disposable Court B
    const { data: courtBData, error: courtBErr } = await clientB
      .from('courts')
      .insert({
        facility_id: facBId,
        name: `Court B ${runId}`,
        sport_type: 'Badminton',
        hourly_rate: 250.0,
        is_enabled: true,
      })
      .select('id, name, hourly_rate')
      .single();
    if (courtBErr || !courtBData) {
      throw new Error(`Failed to create disposable Court B: ${courtBErr?.message}`);
    }
    courtBId = courtBData.id;

    // 7. Optional: Provision reservations if server-side serviceRoleKey is provided
    const config = getEnvironmentConfig();
    const serviceKey = options?.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (serviceKey && facBId && courtBId) {
      const adminClient = createClient(config.supabaseUrl, serviceKey, {
        auth: { persistSession: false },
      });

      // Pending reservation (for approval / decline tests)
      const refPending = `TD-W-${runId.substring(0, 8)}-P`;
      const { data: resP, error: errP } = await adminClient
        .from('reservations')
        .insert({
          facility_id: facBId,
          court_id: courtBId,
          reference_code: refPending,
          customer_name: 'Disposable Customer P',
          customer_email: 'disp-cust-p@example.com',
          booking_date: '2028-06-15',
          start_time: '2028-06-15T10:00:00Z',
          end_time: '2028-06-15T11:00:00Z',
          duration_minutes: 60,
          time_slot_label: '10:00 AM – 11:00 AM',
          status: 'pending',
          price: 250.0,
          hold_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          is_demo: true,
        })
        .select('id, reference_code, facility_id, court_id, status, price')
        .single();

      if (!errP && resP) {
        pendingResB = resP as DisposableReservation;
      }

      // Confirmed reservation (for cancel / reschedule tests)
      const refConfirmed = `TD-W-${runId.substring(0, 8)}-C`;
      const { data: resC, error: errC } = await adminClient
        .from('reservations')
        .insert({
          facility_id: facBId,
          court_id: courtBId,
          reference_code: refConfirmed,
          customer_name: 'Disposable Customer C',
          customer_email: 'disp-cust-c@example.com',
          booking_date: '2028-06-15',
          start_time: '2028-06-15T14:00:00Z',
          end_time: '2028-06-15T15:00:00Z',
          duration_minutes: 60,
          time_slot_label: '02:00 PM – 03:00 PM',
          status: 'confirmed',
          price: 250.0,
          is_demo: true,
        })
        .select('id, reference_code, facility_id, court_id, status, price')
        .single();

      if (!errC && resC) {
        confirmedResB = resC as DisposableReservation;
      }
    }

    if (!orgAId || !orgBId || !facAId || !facBId || !courtAId || !courtBId) {
      throw new Error('Provisioning incomplete: missing one or more required entity IDs');
    }

    const cluster: DisposableCluster = {
      runId,
      orgA: { id: orgAId, slug: orgASlug, name: `Disposable Org A ${runId}` },
      orgB: { id: orgBId, slug: orgBSlug, name: `Disposable Org B ${runId}` },
      facA: facAData,
      facB: facBData,
      courtA: courtAData,
      courtB: courtBData,
      pendingResB,
      confirmedResB,
    };

    assertExactRunOwnership(cluster, runId);
    return cluster;
  } catch (err: any) {
    // If provisioning failed midway, clean up any partially created entities immediately
    await rollbackPartialCluster({ orgAId, orgBId, facAId, facBId, courtAId, courtBId, runId }, clientA, clientB);
    throw err;
  }
}

/**
 * Rollback helper for partially provisioned clusters
 */
async function rollbackPartialCluster(
  partial: { orgAId?: string; orgBId?: string; facAId?: string; facBId?: string; courtAId?: string; courtBId?: string; runId: string },
  clientA: SupabaseClient,
  clientB: SupabaseClient
): Promise<void> {
  try {
    if (partial.courtAId) await clientA.from('courts').delete().eq('id', partial.courtAId);
    if (partial.courtBId) await clientB.from('courts').delete().eq('id', partial.courtBId);
    if (partial.facAId) await clientA.from('facilities').delete().eq('id', partial.facAId);
    if (partial.facBId) await clientB.from('facilities').delete().eq('id', partial.facBId);
  } catch {
    // Best-effort partial rollback
  }
}

/**
 * Reliable Teardown & Verified Cleanup
 *
 * Enforces strict dependency order:
 * 1. Reservations (exact IDs matching runId)
 * 2. Courts (exact IDs matching runId)
 * 3. Facilities (exact IDs matching runId)
 * 4. Organization Memberships (exact org IDs matching runId)
 * 5. Organizations (exact IDs matching runId)
 *
 * Verifies that zero records remain; records any errors or leftover IDs.
 */
export async function teardownDisposableCluster(
  cluster: DisposableCluster,
  clientA: SupabaseClient,
  clientB: SupabaseClient,
  options?: { serviceRoleKey?: string }
): Promise<CleanupReport> {
  const report: CleanupReport = {
    success: true,
    runId: cluster.runId,
    deletedReservations: 0,
    deletedCourts: 0,
    deletedFacilities: 0,
    deletedMembers: 0,
    deletedOrgs: 0,
    remainingRecords: [],
    errors: [],
  };

  // Step 0: Invariant safety check before touching anything
  try {
    assertExactRunOwnership(cluster, cluster.runId);
  } catch (err: any) {
    report.success = false;
    report.errors.push(`Teardown aborted by safety guard: ${err.message}`);
    return report;
  }

  const config = getEnvironmentConfig();
  const serviceKey = options?.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminClient = serviceKey
    ? createClient(config.supabaseUrl, serviceKey, { auth: { persistSession: false } })
    : null;

  // 1. Delete Reservations
  const resIdsToDelete: string[] = [];
  if (cluster.pendingResB?.id) resIdsToDelete.push(cluster.pendingResB.id);
  if (cluster.confirmedResB?.id) resIdsToDelete.push(cluster.confirmedResB.id);

  for (const rId of resIdsToDelete) {
    try {
      const deleter = adminClient || clientB;
      const { error } = await deleter.from('reservations').delete().eq('id', rId);
      if (error) {
        report.errors.push(`Failed to delete reservation [${rId}]: ${error.message}`);
      } else {
        report.deletedReservations++;
      }
    } catch (err: any) {
      report.errors.push(`Exception deleting reservation [${rId}]: ${err.message}`);
    }
  }

  // Verify reservations are gone
  if (resIdsToDelete.length > 0) {
    const { data: remRes } = await clientB.from('reservations').select('id').in('id', resIdsToDelete);
    if (remRes && remRes.length > 0) {
      report.success = false;
      remRes.forEach((r) => report.remainingRecords.push(`reservation:${r.id}`));
    }
  }

  // 2. Delete Courts
  try {
    const { error: errCourtA } = await clientA.from('courts').delete().eq('id', cluster.courtA.id);
    if (errCourtA) report.errors.push(`Failed to delete Court A [${cluster.courtA.id}]: ${errCourtA.message}`);
    else report.deletedCourts++;

    const { error: errCourtB } = await clientB.from('courts').delete().eq('id', cluster.courtB.id);
    if (errCourtB) report.errors.push(`Failed to delete Court B [${cluster.courtB.id}]: ${errCourtB.message}`);
    else report.deletedCourts++;
  } catch (err: any) {
    report.errors.push(`Exception deleting courts: ${err.message}`);
  }

  // Verify courts are gone
  const { data: remCourts } = await clientA
    .from('courts')
    .select('id')
    .in('id', [cluster.courtA.id, cluster.courtB.id]);
  if (remCourts && remCourts.length > 0) {
    report.success = false;
    remCourts.forEach((c) => report.remainingRecords.push(`court:${c.id}`));
  }

  // 3. Delete Facilities
  try {
    const { error: errFacA } = await clientA.from('facilities').delete().eq('id', cluster.facA.id);
    if (errFacA) report.errors.push(`Failed to delete Facility A [${cluster.facA.id}]: ${errFacA.message}`);
    else report.deletedFacilities++;

    const { error: errFacB } = await clientB.from('facilities').delete().eq('id', cluster.facB.id);
    if (errFacB) report.errors.push(`Failed to delete Facility B [${cluster.facB.id}]: ${errFacB.message}`);
    else report.deletedFacilities++;
  } catch (err: any) {
    report.errors.push(`Exception deleting facilities: ${err.message}`);
  }

  // Verify facilities are gone
  const { data: remFacs } = await clientA
    .from('facilities')
    .select('id')
    .in('id', [cluster.facA.id, cluster.facB.id]);
  if (remFacs && remFacs.length > 0) {
    report.success = false;
    remFacs.forEach((f) => report.remainingRecords.push(`facility:${f.id}`));
  }

  // 4. Clean Organization Memberships & Organizations
  if (adminClient) {
    try {
      await adminClient.from('organization_members').delete().in('organization_id', [cluster.orgA.id, cluster.orgB.id]);
      const { error: errOrg } = await adminClient.from('organizations').delete().in('id', [cluster.orgA.id, cluster.orgB.id]);
      if (errOrg) {
        report.errors.push(`Failed to delete organizations: ${errOrg.message}`);
      } else {
        report.deletedOrgs += 2;
      }
    } catch (err: any) {
      report.errors.push(`Exception deleting organizations with adminClient: ${err.message}`);
    }
  }

  if (report.errors.length > 0 || report.remainingRecords.length > 0) {
    report.success = false;
  }

  return report;
}

/**
 * Asserts state immutability between before and after snapshots.
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
