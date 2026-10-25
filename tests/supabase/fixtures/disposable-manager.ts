import { SupabaseClient } from '@supabase/supabase-js';
import { EXISTING_FIXTURES } from '../config';

/**
 * Disposable Fixture Manager for Cross-Tenant WRITE Authorization Testing
 *
 * Implements strict security governance:
 * 1. Complete test-run ID embedding in all entity slugs, names, and reservation reference codes.
 * 2. Strict adherence to real database constraints (reference_code length BETWEEN 5 AND 20).
 * 3. Exact-run ownership validation guarding existing facilities, live reservations, and seeds.
 * 4. Trusted server-side admin client (service-role) for provisioning, RLS-unbiased cleanup verification, and rollback.
 * 5. Dependency-ordered deletion with zero-swallow error handling and verified zero-residue check.
 */

export interface DisposableOrganization {
  id: string;
  slug: string;
  name: string;
}

export interface DisposableFacility {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  default_hourly_rate: number;
  booking_confirmation_mode: 'instant' | 'manual_approval';
  hold_duration_minutes: number;
}

export interface DisposableCourt {
  id: string;
  facility_id: string;
  name: string;
  sport_type: string;
  hourly_rate: number;
}

export interface DisposableReservation {
  id: string;
  reference_code: string;
  facility_id: string;
  court_id: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'declined';
  price: number;
}

export interface DisposableCluster {
  runId: string;
  orgA: DisposableOrganization;
  orgB: DisposableOrganization;
  facA: DisposableFacility;
  facB: DisposableFacility;
  courtA: DisposableCourt;
  courtB: DisposableCourt;
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
 * Generates an 11-character unique test run identifier:
 * 'w' (1 char) + base36 timestamp (6 chars) + base36 random (4 chars).
 * Embedded in reference_code 'TD-${runId}-P' (16 chars), perfectly within database constraint [5, 20].
 */
export function generateTestRunId(): string {
  const ts = Date.now().toString(36).slice(-6);
  const rand = Math.random().toString(36).slice(-4);
  return `w${ts}${rand}`;
}

/**
 * Validates that all cluster entities belong exclusively to the exact test-run ID
 * and that no protected seeds or live customer records can ever be touched.
 */
export function assertExactRunOwnership(cluster: DisposableCluster, runId: string): void {
  if (!cluster.runId || cluster.runId !== runId) {
    throw new Error(
      `CRITICAL SAFETY VIOLATION: Cluster runId [${cluster.runId}] does not match target runId [${runId}]. Aborting.`
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
        `CRITICAL SAFETY VIOLATION: Slug [${slug}] does not contain complete test-run identifier [${runId}]. Aborting.`
      );
    }
  }

  if (cluster.pendingResB) {
    const ref = cluster.pendingResB.reference_code;
    if (!ref.startsWith('TD-') || !ref.includes(runId)) {
      throw new Error(
        `CRITICAL SAFETY VIOLATION: Pending reservation reference [${ref}] does not contain complete test-run identifier [${runId}] or prefix TD-. Real customer records are protected.`
      );
    }
    if (ref.length < 5 || ref.length > 20) {
      throw new Error(
        `CRITICAL SAFETY VIOLATION: Pending reservation reference [${ref}] length (${ref.length}) violates database constraint CHECK (char_length(reference_code) BETWEEN 5 AND 20).`
      );
    }
  }

  if (cluster.confirmedResB) {
    const ref = cluster.confirmedResB.reference_code;
    if (!ref.startsWith('TD-') || !ref.includes(runId)) {
      throw new Error(
        `CRITICAL SAFETY VIOLATION: Confirmed reservation reference [${ref}] does not contain complete test-run identifier [${runId}] or prefix TD-. Real customer records are protected.`
      );
    }
    if (ref.length < 5 || ref.length > 20) {
      throw new Error(
        `CRITICAL SAFETY VIOLATION: Confirmed reservation reference [${ref}] length (${ref.length}) violates database constraint CHECK (char_length(reference_code) BETWEEN 5 AND 20).`
      );
    }
  }
}

/**
 * Rollback helper for partially provisioned clusters.
 * Cleans up reservations, courts, facilities, organization memberships, and organizations.
 * NEVER silently swallows errors; collects and throws all cleanup failures.
 */
export async function rollbackPartialCluster(
  partial: {
    orgAId?: string;
    orgBId?: string;
    facAId?: string;
    facBId?: string;
    courtAId?: string;
    courtBId?: string;
    resIds?: string[];
    runId: string;
  },
  adminClient: SupabaseClient
): Promise<void> {
  const rollbackErrors: string[] = [];

  // 1. Delete any created reservations
  if (partial.resIds && partial.resIds.length > 0) {
    try {
      const { error } = await adminClient.from('reservations').delete().in('id', partial.resIds);
      if (error) rollbackErrors.push(`Failed to delete reservations in rollback: ${error.message}`);
    } catch (err: any) {
      rollbackErrors.push(`Exception deleting reservations in rollback: ${err?.message || String(err)}`);
    }
  }

  // 2. Delete courts
  const courtIds = [partial.courtAId, partial.courtBId].filter(Boolean) as string[];
  if (courtIds.length > 0) {
    try {
      const { error } = await adminClient.from('courts').delete().in('id', courtIds);
      if (error) rollbackErrors.push(`Failed to delete courts in rollback: ${error.message}`);
    } catch (err: any) {
      rollbackErrors.push(`Exception deleting courts in rollback: ${err?.message || String(err)}`);
    }
  }

  // 3. Delete facilities
  const facIds = [partial.facAId, partial.facBId].filter(Boolean) as string[];
  if (facIds.length > 0) {
    try {
      const { error } = await adminClient.from('facilities').delete().in('id', facIds);
      if (error) rollbackErrors.push(`Failed to delete facilities in rollback: ${error.message}`);
    } catch (err: any) {
      rollbackErrors.push(`Exception deleting facilities in rollback: ${err?.message || String(err)}`);
    }
  }

  // 4. Delete organization memberships
  const orgIds = [partial.orgAId, partial.orgBId].filter(Boolean) as string[];
  if (orgIds.length > 0) {
    try {
      const { error } = await adminClient.from('organization_members').delete().in('organization_id', orgIds);
      if (error) rollbackErrors.push(`Failed to delete organization members in rollback: ${error.message}`);
    } catch (err: any) {
      rollbackErrors.push(`Exception deleting organization members in rollback: ${err?.message || String(err)}`);
    }

    // 5. Delete organizations
    try {
      const { error } = await adminClient.from('organizations').delete().in('id', orgIds);
      if (error) rollbackErrors.push(`Failed to delete organizations in rollback: ${error.message}`);
    } catch (err: any) {
      rollbackErrors.push(`Exception deleting organizations in rollback: ${err?.message || String(err)}`);
    }
  }

  if (rollbackErrors.length > 0) {
    throw new Error(
      `Rollback encountered failures during partial cluster teardown for run [${partial.runId}]: ${rollbackErrors.join('; ')}`
    );
  }
}

/**
 * Creates an isolated disposable cluster containing:
 * - 2 disposable organizations (Org A and Org B)
 * - 2 disposable facilities (Facility A and Facility B)
 * - 2 disposable courts (Court A and Court B)
 * - Required pending & confirmed reservations for Facility B
 *
 * Requires a trusted server-side admin client (serviceRoleKey).
 * If any creation or reservation insert fails, aborts immediately and rolls back.
 */
export async function provisionDisposableCluster(
  runId: string,
  clientA: SupabaseClient,
  clientB: SupabaseClient,
  adminClient: SupabaseClient
): Promise<DisposableCluster> {
  if (!adminClient) {
    throw new Error('Trusted adminClient (service-role) is required for disposable fixture provisioning.');
  }

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
  const resIds: string[] = [];
  let pendingResB: DisposableReservation | undefined;
  let confirmedResB: DisposableReservation | undefined;

  try {
    // 1. Create Disposable Org A via User A
    const { data: orgAResult, error: orgAErr } = await clientA.rpc('create_organization_with_owner', {
      p_name: `Disposable Org A ${runId}`,
      p_slug: orgASlug,
      p_billing_email: `disp-org-a-${runId}@example.com`,
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
      p_billing_email: `disp-org-b-${runId}@example.com`,
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
        name: `Facility A ${runId}`,
        slug: facASlug,
        address: '123 Disposable Way, Zone A',
        timezone: 'Asia/Manila',
        currency: '₱',
        default_hourly_rate: 350.0,
        booking_confirmation_mode: 'manual_approval',
        hold_duration_minutes: 30,
        is_active: true,
        is_demo: true,
      })
      .select('id, organization_id, slug, name, default_hourly_rate, booking_confirmation_mode, hold_duration_minutes')
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
        name: `Facility B ${runId}`,
        slug: facBSlug,
        address: '456 Disposable Way, Zone B',
        timezone: 'Asia/Manila',
        currency: '₱',
        default_hourly_rate: 250.0,
        booking_confirmation_mode: 'manual_approval',
        hold_duration_minutes: 30,
        is_active: true,
        is_demo: true,
      })
      .select('id, organization_id, slug, name, default_hourly_rate, booking_confirmation_mode, hold_duration_minutes')
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
        hourly_rate: 350.0,
        is_enabled: true,
        is_demo: true,
      })
      .select('id, facility_id, name, sport_type, hourly_rate')
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
        is_demo: true,
      })
      .select('id, facility_id, name, sport_type, hourly_rate')
      .single();
    if (courtBErr || !courtBData) {
      throw new Error(`Failed to create disposable Court B: ${courtBErr?.message}`);
    }
    courtBId = courtBData.id;

    // 7. Provision Required Pending Reservation on Facility B
    // reference_code is exactly 16 chars: 'TD-' (3) + runId (11) + '-P' (2), within CHECK (5-20)
    const refPending = `TD-${runId}-P`;
    const { data: resP, error: errP } = await adminClient
      .from('reservations')
      .insert({
        facility_id: facBId,
        court_id: courtBId,
        reference_code: refPending,
        customer_name: `Disposable Customer P ${runId}`,
        customer_email: `disp-cust-p-${runId}@example.com`,
        customer_phone: '+639170000001',
        booking_date: '2028-06-15',
        start_time: '2028-06-15T10:00:00Z',
        end_time: '2028-06-15T11:00:00Z',
        duration_minutes: 60,
        time_slot_label: '10:00 AM – 11:00 AM',
        status: 'pending',
        price: 250.0,
        currency: '₱',
        hold_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        is_demo: true,
      })
      .select('id, reference_code, facility_id, court_id, status, price')
      .single();

    if (errP || !resP) {
      throw new Error(`Failed to insert required pending reservation: ${errP?.message || 'No reservation returned'}`);
    }
    pendingResB = resP as DisposableReservation;
    resIds.push(resP.id);

    // 8. Provision Required Confirmed Reservation on Facility B
    // Non-overlapping timeslot: 14:00-15:00 vs 10:00-11:00
    // reference_code is exactly 16 chars: 'TD-' (3) + runId (11) + '-C' (2), within CHECK (5-20)
    const refConfirmed = `TD-${runId}-C`;
    const { data: resC, error: errC } = await adminClient
      .from('reservations')
      .insert({
        facility_id: facBId,
        court_id: courtBId,
        reference_code: refConfirmed,
        customer_name: `Disposable Customer C ${runId}`,
        customer_email: `disp-cust-c-${runId}@example.com`,
        customer_phone: '+639170000002',
        booking_date: '2028-06-15',
        start_time: '2028-06-15T14:00:00Z',
        end_time: '2028-06-15T15:00:00Z',
        duration_minutes: 60,
        time_slot_label: '02:00 PM – 03:00 PM',
        status: 'confirmed',
        price: 250.0,
        currency: '₱',
        is_demo: true,
      })
      .select('id, reference_code, facility_id, court_id, status, price')
      .single();

    if (errC || !resC) {
      throw new Error(`Failed to insert required confirmed reservation: ${errC?.message || 'No reservation returned'}`);
    }
    confirmedResB = resC as DisposableReservation;
    resIds.push(resC.id);

    if (!orgAId || !orgBId || !facAId || !facBId || !courtAId || !courtBId) {
      throw new Error('Provisioning failed: One or more required entity IDs are missing.');
    }

    const cluster: DisposableCluster = {
      runId,
      orgA: { id: orgAId, slug: orgASlug, name: `Disposable Org A ${runId}` },
      orgB: { id: orgBId, slug: orgBSlug, name: `Disposable Org B ${runId}` },
      facA: facAData as DisposableFacility,
      facB: facBData as DisposableFacility,
      courtA: courtAData as DisposableCourt,
      courtB: courtBData as DisposableCourt,
      pendingResB,
      confirmedResB,
    };

    assertExactRunOwnership(cluster, runId);
    return cluster;
  } catch (err: any) {
    // Abort provisioning immediately and clean up all partially created entities
    await rollbackPartialCluster(
      { orgAId, orgBId, facAId, facBId, courtAId, courtBId, resIds, runId },
      adminClient
    );
    throw err;
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
 * Uses trusted server-side admin client to bypass RLS, guaranteeing complete visibility
 * of all created records during verification.
 */
export async function teardownDisposableCluster(
  cluster: DisposableCluster,
  adminClient: SupabaseClient
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

  if (!adminClient) {
    report.success = false;
    report.errors.push('Admin client is required for trusted teardown and RLS-unbiased verification.');
    return report;
  }

  // Step 0: Invariant safety check before touching anything
  try {
    assertExactRunOwnership(cluster, cluster.runId);
  } catch (err: any) {
    report.success = false;
    report.errors.push(`Teardown aborted by safety guard: ${err.message}`);
    return report;
  }

  // 1. Delete Reservations
  const resIdsToDelete: string[] = [];
  if (cluster.pendingResB?.id) resIdsToDelete.push(cluster.pendingResB.id);
  if (cluster.confirmedResB?.id) resIdsToDelete.push(cluster.confirmedResB.id);

  if (resIdsToDelete.length > 0) {
    try {
      const { count, error } = await adminClient
        .from('reservations')
        .delete({ count: 'exact' })
        .in('id', resIdsToDelete);

      if (error) {
        report.errors.push(`Failed to delete reservations: ${error.message}`);
      } else {
        report.deletedReservations += count ?? resIdsToDelete.length;
      }
    } catch (err: any) {
      report.errors.push(`Exception deleting reservations: ${err?.message || String(err)}`);
    }

    // Verify reservations are gone via adminClient (bypassing RLS)
    const { data: remRes, error: errRemRes } = await adminClient
      .from('reservations')
      .select('id, reference_code')
      .in('id', resIdsToDelete);

    if (errRemRes) {
      report.errors.push(`Verification query failed for reservations: ${errRemRes.message}`);
    } else if (remRes && remRes.length > 0) {
      report.success = false;
      remRes.forEach((r) => report.remainingRecords.push(`reservation:${r.id}:${r.reference_code}`));
    }
  }

  // 2. Delete Courts
  const courtIds = [cluster.courtA.id, cluster.courtB.id];
  try {
    const { count, error } = await adminClient
      .from('courts')
      .delete({ count: 'exact' })
      .in('id', courtIds);

    if (error) {
      report.errors.push(`Failed to delete courts: ${error.message}`);
    } else {
      report.deletedCourts += count ?? courtIds.length;
    }
  } catch (err: any) {
    report.errors.push(`Exception deleting courts: ${err?.message || String(err)}`);
  }

  // Verify courts are gone via adminClient
  const { data: remCourts, error: errRemCourts } = await adminClient
    .from('courts')
    .select('id')
    .in('id', courtIds);

  if (errRemCourts) {
    report.errors.push(`Verification query failed for courts: ${errRemCourts.message}`);
  } else if (remCourts && remCourts.length > 0) {
    report.success = false;
    remCourts.forEach((c) => report.remainingRecords.push(`court:${c.id}`));
  }

  // 3. Delete Facilities
  const facIds = [cluster.facA.id, cluster.facB.id];
  try {
    const { count, error } = await adminClient
      .from('facilities')
      .delete({ count: 'exact' })
      .in('id', facIds);

    if (error) {
      report.errors.push(`Failed to delete facilities: ${error.message}`);
    } else {
      report.deletedFacilities += count ?? facIds.length;
    }
  } catch (err: any) {
    report.errors.push(`Exception deleting facilities: ${err?.message || String(err)}`);
  }

  // Verify facilities are gone via adminClient
  const { data: remFacs, error: errRemFacs } = await adminClient
    .from('facilities')
    .select('id')
    .in('id', facIds);

  if (errRemFacs) {
    report.errors.push(`Verification query failed for facilities: ${errRemFacs.message}`);
  } else if (remFacs && remFacs.length > 0) {
    report.success = false;
    remFacs.forEach((f) => report.remainingRecords.push(`facility:${f.id}`));
  }

  // 4. Delete Organization Memberships
  const orgIds = [cluster.orgA.id, cluster.orgB.id];
  try {
    const { count, error } = await adminClient
      .from('organization_members')
      .delete({ count: 'exact' })
      .in('organization_id', orgIds);

    if (error) {
      report.errors.push(`Failed to delete organization members: ${error.message}`);
    } else {
      report.deletedMembers += count ?? 0;
    }
  } catch (err: any) {
    report.errors.push(`Exception deleting organization members: ${err?.message || String(err)}`);
  }

  // Verify memberships are gone via adminClient
  const { data: remMembers, error: errRemMembers } = await adminClient
    .from('organization_members')
    .select('id')
    .in('organization_id', orgIds);

  if (errRemMembers) {
    report.errors.push(`Verification query failed for memberships: ${errRemMembers.message}`);
  } else if (remMembers && remMembers.length > 0) {
    report.success = false;
    remMembers.forEach((m) => report.remainingRecords.push(`member:${m.id}`));
  }

  // 5. Delete Organizations
  try {
    const { count, error } = await adminClient
      .from('organizations')
      .delete({ count: 'exact' })
      .in('id', orgIds);

    if (error) {
      report.errors.push(`Failed to delete organizations: ${error.message}`);
    } else {
      report.deletedOrgs += count ?? orgIds.length;
    }
  } catch (err: any) {
    report.errors.push(`Exception deleting organizations: ${err?.message || String(err)}`);
  }

  // Verify organizations are gone via adminClient
  const { data: remOrgs, error: errRemOrgs } = await adminClient
    .from('organizations')
    .select('id')
    .in('id', orgIds);

  if (errRemOrgs) {
    report.errors.push(`Verification query failed for organizations: ${errRemOrgs.message}`);
  } else if (remOrgs && remOrgs.length > 0) {
    report.success = false;
    remOrgs.forEach((o) => report.remainingRecords.push(`org:${o.id}`));
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
