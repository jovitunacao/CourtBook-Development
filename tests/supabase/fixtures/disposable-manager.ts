import { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { EXISTING_FIXTURES } from '../config';

/**
 * Disposable Fixture Manager for Cross-Tenant WRITE Authorization Testing
 *
 * Implements strict security governance and real database constraint verification:
 * 1. Unique test-run UUID (crypto.randomUUID()) for internal ownership tracking.
 * 2. Compact reference token (8-char) derived from UUID so reservation reference codes
 *    (e.g., 'TD-xxxxxxxx-P', 13 chars) strictly satisfy the database limit (5–20 chars).
 * 3. Does NOT require full 36-char textual UUID inside reservation reference codes.
 * 4. Cleanup targets ONLY exact database UUIDs recorded during the current run;
 *    never uses broad name, slug, or reference prefixes to select deletion targets.
 * 5. Complete constraint validation:
 *    - reservations.reference_code: 5–20 characters.
 *    - facilities.currency & reservations.currency: 1–5 characters.
 *    - organizations.slug & facilities.slug: lowercase alphanumeric with hyphens, 2–60 characters.
 *    - Pending reservations require hold_expires_at.
 *    - Reservation duration must be 30–480 minutes.
 *    - Court hourly_rate must be greater than zero (> 0).
 * 6. Partial-provisioning failures trigger verified cleanup of every created record.
 * 7. Inspects errors from every organization_members deletion operation.
 * 8. Verifies that every recorded membership UUID has actually been removed.
 * 9. Checks errors from every cleanup-verification SELECT query; unsuccessful queries never count as successful cleanup.
 * 10. Preserves original provisioning errors and reports cleanup errors separately.
 */

export interface DisposableOrganization {
  id: string;
  slug: string;
  name: string;
  billing_email: string;
}

export interface DisposableFacility {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  currency: string;
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
  status: 'pending' | 'confirmed' | 'cancelled' | 'declined' | 'completed' | 'no_show' | 'expired';
  price: number;
  currency: string;
  duration_minutes: number;
  booking_date: string;
  start_time: string;
  end_time: string;
  time_slot_label: string;
  hold_expires_at?: string | null;
}

export interface DisposableCluster {
  runId: string; // Full unique test-run UUID
  refToken: string; // 8-character compact token for slugs & reference codes
  orgA: DisposableOrganization;
  orgB: DisposableOrganization;
  facA: DisposableFacility;
  facB: DisposableFacility;
  courtA: DisposableCourt;
  courtB: DisposableCourt;
  memberAId?: string;
  memberBId?: string;
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
 * Generates a full standard UUID v4 for unique test-run tracking.
 */
export function generateTestRunUuid(): string {
  return crypto.randomUUID();
}

/**
 * Derives an 8-character compact alphanumeric token from a UUID.
 * Used for slugs and reference codes to stay well within database string limits.
 */
export function generateRefToken(uuid: string): string {
  return uuid.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().substring(0, 8);
}

/**
 * Generates a reservation reference code satisfying CHECK (char_length(reference_code) BETWEEN 5 AND 20).
 * e.g., 'TD-' (3) + refToken (8) + '-P' (2) = 13 characters.
 */
export function generateReservationRef(type: 'pending' | 'confirmed', refToken: string): string {
  const suffix = type === 'pending' ? 'P' : 'C';
  return `TD-${refToken}-${suffix}`;
}

/**
 * Validates all cluster entities against real database schema constraints:
 * - reservations.reference_code: 5–20 characters.
 * - facilities.currency & reservations.currency: 1–5 characters.
 * - organizations.slug & facilities.slug: lowercase alphanumeric with hyphens, 2–60 characters.
 * - Pending reservations require hold_expires_at.
 * - Reservation duration: 30–480 minutes.
 * - Court hourly_rate: must be greater than zero (> 0).
 */
export function validateDatabaseConstraints(cluster: DisposableCluster): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  const slugRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  // 1. Organizations validation
  for (const org of [cluster.orgA, cluster.orgB]) {
    if (!org.slug || !slugRegex.test(org.slug) || org.slug.length < 2 || org.slug.length > 60) {
      errors.push(`Organization slug [${org.slug}] violates constraint: lowercase alphanumeric with hyphens (2–60 chars).`);
    }
    if (!org.name || org.name.trim().length < 2 || org.name.trim().length > 120) {
      errors.push(`Organization name [${org.name}] violates constraint (2–120 chars).`);
    }
  }

  // 2. Facilities validation
  for (const fac of [cluster.facA, cluster.facB]) {
    if (!fac.slug || !slugRegex.test(fac.slug) || fac.slug.length < 2 || fac.slug.length > 60) {
      errors.push(`Facility slug [${fac.slug}] violates constraint: lowercase alphanumeric with hyphens (2–60 chars).`);
    }
    if (!fac.name || fac.name.trim().length < 2 || fac.name.trim().length > 100) {
      errors.push(`Facility name [${fac.name}] violates constraint (2–100 chars).`);
    }
    if (!fac.currency || fac.currency.length < 1 || fac.currency.length > 5) {
      errors.push(`Facility currency [${fac.currency}] violates constraint (1–5 chars).`);
    }
    if (fac.default_hourly_rate < 0) {
      errors.push(`Facility default_hourly_rate [${fac.default_hourly_rate}] must be >= 0.`);
    }
    if (fac.hold_duration_minutes < 5 || fac.hold_duration_minutes > 1440) {
      errors.push(`Facility hold_duration_minutes [${fac.hold_duration_minutes}] must be between 5 and 1440.`);
    }
  }

  // 3. Courts validation
  for (const court of [cluster.courtA, cluster.courtB]) {
    if (court.hourly_rate <= 0) {
      errors.push(`Court [${court.name}] hourly_rate [${court.hourly_rate}] must be greater than zero.`);
    }
    if (!court.name || court.name.trim().length < 1 || court.name.trim().length > 100) {
      errors.push(`Court name [${court.name}] violates constraint (1–100 chars).`);
    }
    if (!court.sport_type || court.sport_type.trim().length < 2 || court.sport_type.trim().length > 50) {
      errors.push(`Court sport_type [${court.sport_type}] violates constraint (2–50 chars).`);
    }
  }

  // 4. Reservations validation
  const reservationsToCheck = [cluster.pendingResB, cluster.confirmedResB].filter(Boolean) as DisposableReservation[];
  for (const res of reservationsToCheck) {
    if (!res.reference_code || res.reference_code.length < 5 || res.reference_code.length > 20) {
      errors.push(`Reservation reference_code [${res.reference_code}] violates constraint: length (${res.reference_code?.length}) must be between 5 and 20 chars.`);
    }
    if (!res.currency || res.currency.length < 1 || res.currency.length > 5) {
      errors.push(`Reservation currency [${res.currency}] violates constraint: length (${res.currency?.length}) must be 1–5 chars.`);
    }
    if (res.duration_minutes < 30 || res.duration_minutes > 480) {
      errors.push(`Reservation duration_minutes [${res.duration_minutes}] must be between 30 and 480.`);
    }
    if (res.status === 'pending' && !res.hold_expires_at) {
      errors.push(`Pending reservation [${res.reference_code}] violates constraint: hold_expires_at is required for pending holds.`);
    }
    if (res.price < 0) {
      errors.push(`Reservation price [${res.price}] must be >= 0.`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validates that all cluster entities belong exclusively to the exact test-run identifier
 * and that no protected seed facilities or live customer records can ever be targeted.
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
        `CRITICAL SAFETY VIOLATION: Disposable cluster contains protected seed slug [${slug}]! Only dedicated disposable fixtures tagged with [${cluster.refToken}] may be targeted.`
      );
    }
    if (!slug.includes(cluster.refToken)) {
      throw new Error(
        `CRITICAL SAFETY VIOLATION: Slug [${slug}] does not contain run reference token [${cluster.refToken}]. Aborting.`
      );
    }
  }

  if (cluster.pendingResB) {
    const ref = cluster.pendingResB.reference_code;
    if (!ref.startsWith('TD-') || !ref.includes(cluster.refToken)) {
      throw new Error(
        `CRITICAL SAFETY VIOLATION: Pending reservation reference [${ref}] does not contain run reference token [${cluster.refToken}] or prefix TD-. Real customer records are protected.`
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
    if (!ref.startsWith('TD-') || !ref.includes(cluster.refToken)) {
      throw new Error(
        `CRITICAL SAFETY VIOLATION: Confirmed reservation reference [${ref}] does not contain run reference token [${cluster.refToken}] or prefix TD-. Real customer records are protected.`
      );
    }
    if (ref.length < 5 || ref.length > 20) {
      throw new Error(
        `CRITICAL SAFETY VIOLATION: Confirmed reservation reference [${ref}] length (${ref.length}) violates database constraint CHECK (char_length(reference_code) BETWEEN 5 AND 20).`
      );
    }
  }

  const constraintResult = validateDatabaseConstraints(cluster);
  if (!constraintResult.isValid) {
    throw new Error(
      `CRITICAL SAFETY VIOLATION: Disposable cluster failed database constraint validation: ${constraintResult.errors.join('; ')}`
    );
  }
}

/**
 * Rollback helper for partially provisioned clusters.
 * Targets ONLY exact recorded UUIDs.
 * - Inspects errors from every organization_members deletion operation.
 * - Checks errors from every cleanup-verification SELECT query (unsuccessful queries fail cleanup).
 * - Positively confirms that every recorded membership, reservation, court, facility, and org UUID is gone.
 * - Never silently swallows any cleanup error.
 */
export async function rollbackPartialCluster(
  partial: {
    orgAId?: string;
    orgBId?: string;
    facAId?: string;
    facBId?: string;
    courtAId?: string;
    courtBId?: string;
    resIds: string[];
    memberIds: string[];
    runId: string;
  },
  adminClient: SupabaseClient
): Promise<void> {
  const rollbackErrors: string[] = [];

  // 1. Delete exact recorded reservation UUIDs
  if (partial.resIds.length > 0) {
    try {
      const { error } = await adminClient.from('reservations').delete().in('id', partial.resIds);
      if (error) rollbackErrors.push(`Failed to delete reservations in rollback: ${error.message}`);
    } catch (err: any) {
      rollbackErrors.push(`Exception deleting reservations in rollback: ${err?.message || String(err)}`);
    }
  }

  // 2. Delete exact recorded court UUIDs
  const courtIds = [partial.courtAId, partial.courtBId].filter(Boolean) as string[];
  if (courtIds.length > 0) {
    try {
      const { error } = await adminClient.from('courts').delete().in('id', courtIds);
      if (error) rollbackErrors.push(`Failed to delete courts in rollback: ${error.message}`);
    } catch (err: any) {
      rollbackErrors.push(`Exception deleting courts in rollback: ${err?.message || String(err)}`);
    }
  }

  // 3. Delete exact recorded facility UUIDs
  const facIds = [partial.facAId, partial.facBId].filter(Boolean) as string[];
  if (facIds.length > 0) {
    try {
      const { error } = await adminClient.from('facilities').delete().in('id', facIds);
      if (error) rollbackErrors.push(`Failed to delete facilities in rollback: ${error.message}`);
    } catch (err: any) {
      rollbackErrors.push(`Exception deleting facilities in rollback: ${err?.message || String(err)}`);
    }
  }

  // 4. Delete exact recorded membership and organization UUIDs
  // Inspect errors from EVERY organization_members deletion operation!
  if (partial.memberIds.length > 0) {
    try {
      const { error: errMemberIds } = await adminClient
        .from('organization_members')
        .delete()
        .in('id', partial.memberIds);
      if (errMemberIds) {
        rollbackErrors.push(`Failed to delete organization members by exact id in rollback: ${errMemberIds.message}`);
      }
    } catch (err: any) {
      rollbackErrors.push(`Exception deleting organization members by id in rollback: ${err?.message || String(err)}`);
    }
  }

  const orgIds = [partial.orgAId, partial.orgBId].filter(Boolean) as string[];
  if (orgIds.length > 0) {
    try {
      const { error: errMembersByOrg } = await adminClient
        .from('organization_members')
        .delete()
        .in('organization_id', orgIds);
      if (errMembersByOrg) {
        rollbackErrors.push(`Failed to delete organization members by organization_id in rollback: ${errMembersByOrg.message}`);
      }

      const { error: errOrgs } = await adminClient
        .from('organizations')
        .delete()
        .in('id', orgIds);
      if (errOrgs) {
        rollbackErrors.push(`Failed to delete organizations in rollback: ${errOrgs.message}`);
      }
    } catch (err: any) {
      rollbackErrors.push(`Exception deleting organizations in rollback: ${err?.message || String(err)}`);
    }
  }

  // 5. Positive verification: Check errors from EVERY cleanup-verification SELECT query.
  // An unsuccessful query must never count as successful cleanup!
  const remainingResiduals: string[] = [];

  if (partial.resIds.length > 0) {
    const { data: remRes, error: errRemRes } = await adminClient
      .from('reservations')
      .select('id')
      .in('id', partial.resIds);
    if (errRemRes) {
      rollbackErrors.push(`Cleanup verification query failed for reservations: ${errRemRes.message}`);
    } else if (remRes && remRes.length > 0) {
      remRes.forEach((r) => remainingResiduals.push(`reservation:${r.id}`));
    }
  }

  if (courtIds.length > 0) {
    const { data: remCourts, error: errRemCourts } = await adminClient
      .from('courts')
      .select('id')
      .in('id', courtIds);
    if (errRemCourts) {
      rollbackErrors.push(`Cleanup verification query failed for courts: ${errRemCourts.message}`);
    } else if (remCourts && remCourts.length > 0) {
      remCourts.forEach((c) => remainingResiduals.push(`court:${c.id}`));
    }
  }

  if (facIds.length > 0) {
    const { data: remFacs, error: errRemFacs } = await adminClient
      .from('facilities')
      .select('id')
      .in('id', facIds);
    if (errRemFacs) {
      rollbackErrors.push(`Cleanup verification query failed for facilities: ${errRemFacs.message}`);
    } else if (remFacs && remFacs.length > 0) {
      remFacs.forEach((f) => remainingResiduals.push(`facility:${f.id}`));
    }
  }

  // Verify that every recorded membership UUID has actually been removed
  if (partial.memberIds.length > 0) {
    const { data: remMembers, error: errRemMembers } = await adminClient
      .from('organization_members')
      .select('id')
      .in('id', partial.memberIds);
    if (errRemMembers) {
      rollbackErrors.push(`Cleanup verification query failed for organization members by id: ${errRemMembers.message}`);
    } else if (remMembers && remMembers.length > 0) {
      remMembers.forEach((m) => remainingResiduals.push(`member:${m.id}`));
    }
  }

  if (orgIds.length > 0) {
    const { data: remOrgMembers, error: errRemOrgMembers } = await adminClient
      .from('organization_members')
      .select('id')
      .in('organization_id', orgIds);
    if (errRemOrgMembers) {
      rollbackErrors.push(`Cleanup verification query failed for organization members by org_id: ${errRemOrgMembers.message}`);
    } else if (remOrgMembers && remOrgMembers.length > 0) {
      remOrgMembers.forEach((m) => remainingResiduals.push(`member:${m.id}`));
    }

    const { data: remOrgs, error: errRemOrgs } = await adminClient
      .from('organizations')
      .select('id')
      .in('id', orgIds);
    if (errRemOrgs) {
      rollbackErrors.push(`Cleanup verification query failed for organizations: ${errRemOrgs.message}`);
    } else if (remOrgs && remOrgs.length > 0) {
      remOrgs.forEach((o) => remainingResiduals.push(`org:${o.id}`));
    }
  }

  if (remainingResiduals.length > 0) {
    rollbackErrors.push(`Positive verification failed! Residual records remain after rollback: ${remainingResiduals.join(', ')}`);
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
 * Requirements:
 * - Requires verified authentication context on clientA and clientB for create_organization_with_owner.
 * - Requires trusted server-side admin client (service-role) for reservation seeding and exact-UUID teardown.
 * - If any creation or reservation insert fails, aborts immediately and performs verified rollback.
 * - Preserves original provisioning errors and reports cleanup errors separately.
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

  // 1. Verify caller authentication context and auth.uid() before invoking RPC
  const { data: userAData, error: userAErr } = await clientA.auth.getUser();
  if (userAErr || !userAData?.user?.id) {
    throw new Error(`Client A has invalid authentication context: ${userAErr?.message || 'auth.uid() is null'}`);
  }

  const { data: userBData, error: userBErr } = await clientB.auth.getUser();
  if (userBErr || !userBData?.user?.id) {
    throw new Error(`Client B has invalid authentication context: ${userBErr?.message || 'auth.uid() is null'}`);
  }

  const refToken = generateRefToken(runId);
  const orgASlug = `disp-oa-${refToken}`;
  const orgBSlug = `disp-ob-${refToken}`;
  const facASlug = `disp-fa-${refToken}`;
  const facBSlug = `disp-fb-${refToken}`;

  let orgAId: string | undefined;
  let orgBId: string | undefined;
  let facAId: string | undefined;
  let facBId: string | undefined;
  let courtAId: string | undefined;
  let courtBId: string | undefined;
  const resIds: string[] = [];
  const memberIds: string[] = [];
  let pendingResB: DisposableReservation | undefined;
  let confirmedResB: DisposableReservation | undefined;

  try {
    // 2. User A creates Disposable Org A via create_organization_with_owner(p_name, p_slug, p_billing_email, p_is_demo)
    const { data: orgAResult, error: orgAErr } = await clientA.rpc('create_organization_with_owner', {
      p_name: `Disposable Org A ${refToken}`,
      p_slug: orgASlug,
      p_billing_email: `disp-org-a-${refToken}@example.com`,
      p_is_demo: true,
    });
    if (orgAErr || !orgAResult) {
      throw new Error(`Failed to create disposable Org A: ${orgAErr?.message || 'No ID returned'}`);
    }
    orgAId = orgAResult;

    // Record created membership ID for Org A
    const { data: memberAData, error: errMemberA } = await adminClient
      .from('organization_members')
      .select('id')
      .eq('organization_id', orgAId)
      .eq('user_id', userAData.user.id)
      .single();
    if (errMemberA) {
      throw new Error(`Failed to record membership for Org A: ${errMemberA.message}`);
    }
    if (memberAData?.id) memberIds.push(memberAData.id);

    // 3. User B creates Disposable Org B via create_organization_with_owner(p_name, p_slug, p_billing_email, p_is_demo)
    const { data: orgBResult, error: orgBErr } = await clientB.rpc('create_organization_with_owner', {
      p_name: `Disposable Org B ${refToken}`,
      p_slug: orgBSlug,
      p_billing_email: `disp-org-b-${refToken}@example.com`,
      p_is_demo: true,
    });
    if (orgBErr || !orgBResult) {
      throw new Error(`Failed to create disposable Org B: ${orgBErr?.message || 'No ID returned'}`);
    }
    orgBId = orgBResult;

    // Record created membership ID for Org B
    const { data: memberBData, error: errMemberB } = await adminClient
      .from('organization_members')
      .select('id')
      .eq('organization_id', orgBId)
      .eq('user_id', userBData.user.id)
      .single();
    if (errMemberB) {
      throw new Error(`Failed to record membership for Org B: ${errMemberB.message}`);
    }
    if (memberBData?.id) memberIds.push(memberBData.id);

    // 4. User A creates Disposable Facility A
    const { data: facAData, error: facAErr } = await clientA
      .from('facilities')
      .insert({
        organization_id: orgAId,
        name: `Facility A ${refToken}`,
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
      .select('id, organization_id, slug, name, currency, default_hourly_rate, booking_confirmation_mode, hold_duration_minutes')
      .single();
    if (facAErr || !facAData) {
      throw new Error(`Failed to create disposable Facility A: ${facAErr?.message}`);
    }
    facAId = facAData.id;

    // 5. User B creates Disposable Facility B
    const { data: facBData, error: facBErr } = await clientB
      .from('facilities')
      .insert({
        organization_id: orgBId,
        name: `Facility B ${refToken}`,
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
      .select('id, organization_id, slug, name, currency, default_hourly_rate, booking_confirmation_mode, hold_duration_minutes')
      .single();
    if (facBErr || !facBData) {
      throw new Error(`Failed to create disposable Facility B: ${facBErr?.message}`);
    }
    facBId = facBData.id;

    // 6. User A creates Disposable Court A (hourly_rate > 0)
    const { data: courtAData, error: courtAErr } = await clientA
      .from('courts')
      .insert({
        facility_id: facAId,
        name: `Court A ${refToken}`,
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

    // 7. User B creates Disposable Court B (hourly_rate > 0)
    const { data: courtBData, error: courtBErr } = await clientB
      .from('courts')
      .insert({
        facility_id: facBId,
        name: `Court B ${refToken}`,
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

    // 8. Provision Required Pending Reservation on Facility B
    // Reference code: 'TD-' (3) + refToken (8) + '-P' (2) = 13 chars, within [5, 20]
    const refPending = generateReservationRef('pending', refToken);
    const holdExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const { data: resP, error: errP } = await adminClient
      .from('reservations')
      .insert({
        facility_id: facBId,
        court_id: courtBId,
        reference_code: refPending,
        customer_name: `Disposable Customer P ${refToken}`,
        customer_email: `disp-cust-p-${refToken}@example.com`,
        customer_phone: '+639170000001',
        booking_date: '2028-06-15',
        start_time: '2028-06-15T10:00:00Z',
        end_time: '2028-06-15T11:00:00Z',
        duration_minutes: 60,
        time_slot_label: '10:00 AM – 11:00 AM',
        status: 'pending',
        price: 250.0,
        currency: '₱',
        hold_expires_at: holdExpiresAt,
        is_demo: true,
      })
      .select('id, reference_code, facility_id, court_id, status, price, currency, duration_minutes, booking_date, start_time, end_time, time_slot_label, hold_expires_at')
      .single();

    if (errP || !resP) {
      throw new Error(`Failed to insert required pending reservation: ${errP?.message || 'No reservation returned'}`);
    }
    pendingResB = resP as DisposableReservation;
    resIds.push(resP.id);

    // 9. Provision Required Confirmed Reservation on Facility B
    // Reference code: 'TD-' (3) + refToken (8) + '-C' (2) = 13 chars, within [5, 20]
    // Non-overlapping time slot: 14:00-15:00 vs 10:00-11:00
    const refConfirmed = generateReservationRef('confirmed', refToken);
    const { data: resC, error: errC } = await adminClient
      .from('reservations')
      .insert({
        facility_id: facBId,
        court_id: courtBId,
        reference_code: refConfirmed,
        customer_name: `Disposable Customer C ${refToken}`,
        customer_email: `disp-cust-c-${refToken}@example.com`,
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
      .select('id, reference_code, facility_id, court_id, status, price, currency, duration_minutes, booking_date, start_time, end_time, time_slot_label')
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
      refToken,
      orgA: { id: orgAId, slug: orgASlug, name: `Disposable Org A ${refToken}`, billing_email: `disp-org-a-${refToken}@example.com` },
      orgB: { id: orgBId, slug: orgBSlug, name: `Disposable Org B ${refToken}`, billing_email: `disp-org-b-${refToken}@example.com` },
      facA: facAData as DisposableFacility,
      facB: facBData as DisposableFacility,
      courtA: courtAData as DisposableCourt,
      courtB: courtBData as DisposableCourt,
      memberAId: memberIds[0],
      memberBId: memberIds[1],
      pendingResB,
      confirmedResB,
    };

    assertExactRunOwnership(cluster, runId);
    return cluster;
  } catch (err: any) {
    // Preserve the original provisioning error and report any cleanup errors separately
    let cleanupErr: any = null;
    try {
      await rollbackPartialCluster(
        { orgAId, orgBId, facAId, facBId, courtAId, courtBId, resIds, memberIds, runId },
        adminClient
      );
    } catch (cErr: any) {
      cleanupErr = cErr;
    }

    if (cleanupErr) {
      const combined = new Error(
        `Provisioning failed: ${err?.message || String(err)} | Cleanup error: ${cleanupErr?.message || String(cleanupErr)}`
      );
      (combined as any).originalProvisioningError = err;
      (combined as any).cleanupError = cleanupErr;
      throw combined;
    }

    throw err;
  }
}

/**
 * Reliable Teardown & Verified Cleanup
 *
 * Targets ONLY exact database UUIDs recorded during the current run.
 * Never uses broad reference prefixes or names.
 *
 * Enforces strict dependency order:
 * 1. Reservations (exact recorded UUIDs)
 * 2. Courts (exact recorded UUIDs)
 * 3. Facilities (exact recorded UUIDs)
 * 4. Organization Memberships (exact recorded UUIDs and org IDs)
 * 5. Organizations (exact recorded UUIDs)
 *
 * Checks errors from every cleanup-verification query:
 * An unsuccessful query never counts as successful cleanup.
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

  // 1. Delete Reservations by EXACT recorded UUIDs
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

    // Positive confirmation: Verify reservations are gone via adminClient
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

  // 2. Delete Courts by EXACT recorded UUIDs
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

  // Positive confirmation: Verify courts are gone
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

  // 3. Delete Facilities by EXACT recorded UUIDs
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

  // Positive confirmation: Verify facilities are gone
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

  // 4. Delete Organization Memberships by EXACT recorded UUIDs and Org IDs
  const orgIds = [cluster.orgA.id, cluster.orgB.id];
  const memberIds = [cluster.memberAId, cluster.memberBId].filter(Boolean) as string[];

  // Inspect errors from every organization_members deletion operation
  if (memberIds.length > 0) {
    try {
      const { count, error: errMemberIds } = await adminClient
        .from('organization_members')
        .delete({ count: 'exact' })
        .in('id', memberIds);
      if (errMemberIds) {
        report.errors.push(`Failed to delete organization members by exact id: ${errMemberIds.message}`);
      } else {
        report.deletedMembers += count ?? 0;
      }
    } catch (err: any) {
      report.errors.push(`Exception deleting organization members by id: ${err?.message || String(err)}`);
    }
  }

  try {
    const { count, error: errOrgMembers } = await adminClient
      .from('organization_members')
      .delete({ count: 'exact' })
      .in('organization_id', orgIds);

    if (errOrgMembers) {
      report.errors.push(`Failed to delete organization members by organization_id: ${errOrgMembers.message}`);
    } else {
      report.deletedMembers += count ?? 0;
    }
  } catch (err: any) {
    report.errors.push(`Exception deleting organization members: ${err?.message || String(err)}`);
  }

  // Positive confirmation: Verify memberships are gone by both exact member IDs and org IDs
  if (memberIds.length > 0) {
    const { data: remMembersById, error: errRemMembersById } = await adminClient
      .from('organization_members')
      .select('id')
      .in('id', memberIds);

    if (errRemMembersById) {
      report.errors.push(`Verification query failed for memberships by exact id: ${errRemMembersById.message}`);
    } else if (remMembersById && remMembersById.length > 0) {
      report.success = false;
      remMembersById.forEach((m) => report.remainingRecords.push(`member:${m.id}`));
    }
  }

  const { data: remMembers, error: errRemMembers } = await adminClient
    .from('organization_members')
    .select('id')
    .in('organization_id', orgIds);

  if (errRemMembers) {
    report.errors.push(`Verification query failed for memberships by org_id: ${errRemMembers.message}`);
  } else if (remMembers && remMembers.length > 0) {
    report.success = false;
    remMembers.forEach((m) => report.remainingRecords.push(`member:${m.id}`));
  }

  // 5. Delete Organizations by EXACT recorded UUIDs
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

  // Positive confirmation: Verify organizations are gone
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
 * Creates an offline mock admin client to simulate failure scenarios:
 * - Failed deletes
 * - Failed verification queries
 * - Remaining residual records
 */
export function createMockAdminClient(options?: {
  deleteError?: { message: string };
  selectError?: { message: string };
  remainingRecords?: any[];
}): SupabaseClient {
  const handler = {
    delete: (_opts?: any) => ({
      in: async (_col: string, ids: any[]) => ({
        count: options?.deleteError ? 0 : ids.length,
        error: options?.deleteError || null,
      }),
    }),
    select: (_cols?: any) => ({
      in: async (_col: string, _ids: any[]) => ({
        data: options?.selectError ? null : (options?.remainingRecords || []),
        error: options?.selectError || null,
      }),
    }),
  };

  return {
    from: (_table: string) => handler,
  } as unknown as SupabaseClient;
}
