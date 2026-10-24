import { SupabaseClient } from '@supabase/supabase-js';
import { EXISTING_FIXTURES } from './config';

export interface FacilityFixture {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  open_hour: number;
  close_hour: number;
  timezone: string;
  currency: string;
  default_hourly_rate: number;
  is_active: boolean;
}

export interface CourtFixture {
  id: string;
  facility_id: string;
  name: string;
  sport_type: string;
  hourly_rate: number;
  is_enabled: boolean;
}

export interface ReservationFixture {
  id: string;
  facility_id: string;
  court_id: string;
  reference_code: string;
  customer_name: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  price: number;
  is_demo: boolean;
}

export interface UserContext {
  client: SupabaseClient;
  userId: string;
  email: string;
  orgId?: string;
  orgSlug?: string;
  orgName?: string;
  facility?: FacilityFixture;
  courts: CourtFixture[];
  enabledCourt?: CourtFixture;
  disabledCourt?: CourtFixture;
  disposableReservation?: ReservationFixture;
  disposableCompletedReservation?: ReservationFixture;
}

/**
 * Loads the user's specific fictional organization and facility without creating duplicates.
 * Targets:
 * - User A: slug 'courtbook-test-pickleball-a' -> facility 'courtbook-pickleball-test'
 * - User B: slug 'courtbook-test-badminton-b'  -> facility 'courtbook-badminton-test'
 */
export async function loadUserContext(
  client: SupabaseClient,
  userId: string,
  email: string,
  expectedOrgSlug: string,
  expectedFacilitySlug: string
): Promise<UserContext> {
  const ctx: UserContext = {
    client,
    userId,
    email,
    courts: [],
  };

  // 1. Fetch organization by exact expected slug
  const { data: orgData, error: orgErr } = await client
    .from('organizations')
    .select('id, name, slug')
    .eq('slug', expectedOrgSlug)
    .limit(1);

  if (orgData && orgData.length > 0) {
    ctx.orgId = orgData[0].id;
    ctx.orgSlug = orgData[0].slug;
    ctx.orgName = orgData[0].name;

    // 2. Fetch primary facility by exact expected facility slug
    const { data: facData } = await client
      .from('facilities')
      .select('*')
      .eq('organization_id', ctx.orgId)
      .eq('slug', expectedFacilitySlug)
      .limit(1);

    if (facData && facData.length > 0) {
      ctx.facility = facData[0] as FacilityFixture;

      // 3. Fetch courts for this facility
      const { data: courtData } = await client
        .from('courts')
        .select('*')
        .eq('facility_id', ctx.facility.id)
        .order('display_order', { ascending: true });

      if (courtData) {
        ctx.courts = courtData as CourtFixture[];
        ctx.enabledCourt = ctx.courts.find((c) => c.is_enabled);
        ctx.disabledCourt = ctx.courts.find((c) => !c.is_enabled);
      }

      // 4. Fetch designated disposable test reservations (strictly matching 'TD-%' or 'TEST-DISPOSABLE-%')
      const { data: resData } = await client
        .from('reservations')
        .select('*')
        .eq('facility_id', ctx.facility.id)
        .or('reference_code.like.TD-%,reference_code.like.TEST-DISPOSABLE-%');

      if (resData && resData.length > 0) {
        ctx.disposableReservation = resData.find(
          (r) => r.status === 'confirmed' && (r.reference_code.startsWith('TD-') || r.reference_code.startsWith('TEST-DISPOSABLE-'))
        ) as ReservationFixture;

        ctx.disposableCompletedReservation = resData.find(
          (r) => r.status === 'completed' && (r.reference_code.startsWith('TD-') || r.reference_code.startsWith('TEST-DISPOSABLE-'))
        ) as ReservationFixture;
      }
    }
  }

  return ctx;
}

/**
 * Validates that an error is an intended database security rejection (RLS, permission denied,
 * or security trigger exception), rather than a network disconnect, DNS failure, or unrelated crash.
 */
export function isIntendedSecurityRejection(error: any): boolean {
  if (!error) return false;

  const msg: string = String(error.message || error.details || error).toLowerCase();
  const code: string = String(error.code || '').toLowerCase();

  // Runtime bugs, crashes, 5xx errors, network timeouts, and connection drops
  // must NEVER be counted as successful security rejections
  if (
    msg.includes('fetcherror') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('aborted') ||
    msg.includes('jwt') ||
    msg.includes('invalid refresh token') ||
    msg.includes('invalid path specified') ||
    msg.includes('invalid login credentials') ||
    msg.includes('invalid_grant') ||
    msg.includes('typeerror') ||
    msg.includes('referenceerror') ||
    msg.includes('syntaxerror') ||
    msg.includes('cannot read property') ||
    msg.includes('cannot read properties') ||
    msg.includes('is not a function') ||
    msg.includes('internal server error') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504')
  ) {
    return false;
  }

  // Intended PostgreSQL and application security error codes / domain messages:
  // 42501: insufficient_privilege (RLS or direct REVOKE)
  // P0001: raise_exception from SECURITY DEFINER / security triggers
  // 23P01: exclusion_violation (court schedule conflict)
  // 23514: check_violation
  // 23505: unique_violation
  if (
    code === '42501' ||
    code === 'p0001' ||
    code === '23p01' ||
    code === '23514' ||
    code === '23505' ||
    msg.includes('row-level security') ||
    msg.includes('permission denied') ||
    msg.includes('access denied') ||
    msg.includes('strictly prohibited') ||
    msg.includes('not permitted') ||
    msg.includes('exclusion violation') ||
    msg.includes('cannot modify') ||
    msg.includes('cannot re-activate') ||
    msg.includes('users cannot alter their own') ||
    msg.includes('cannot remove or demote the last owner') ||
    msg.includes('operating hours') ||
    msg.includes('cannot reschedule') ||
    msg.includes('already cancelled') ||
    msg.includes('completed reservations cannot be cancelled') ||
    msg.includes('court slot is already booked') ||
    msg.includes('held for another pending request') ||
    msg.includes('court is blocked')
  ) {
    return true;
  }

  return false;
}
