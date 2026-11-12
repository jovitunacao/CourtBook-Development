import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Environment variables for Supabase browser client
// Respects strictly VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (with fallback to VITE_SUPABASE_ANON_KEY)
const envMeta = typeof import.meta !== 'undefined' && (import.meta as any).env ? (import.meta as any).env : {};
const envProc = typeof process !== 'undefined' && process.env ? process.env : {};

const rawUrl = (envMeta.VITE_SUPABASE_URL || envProc.VITE_SUPABASE_URL || envProc.SUPABASE_URL) as string | undefined;
const rawKey = (
  envMeta.VITE_SUPABASE_PUBLISHABLE_KEY ||
  envMeta.VITE_SUPABASE_ANON_KEY ||
  envProc.VITE_SUPABASE_PUBLISHABLE_KEY ||
  envProc.VITE_SUPABASE_ANON_KEY ||
  envProc.SUPABASE_ANON_KEY
) as string | undefined;

export const supabaseUrl = rawUrl?.trim() || '';
export const supabasePublishableKey = rawKey?.trim() || '';

// Validate that configuration is present and structurally sound
export const isSupabaseConfigured: boolean = Boolean(
  supabaseUrl &&
    supabasePublishableKey &&
    supabaseUrl.startsWith('http') &&
    !supabaseUrl.includes('your-project') &&
    supabasePublishableKey.length > 20
);

/**
 * Reusable Supabase browser client initialized with safe publishable key.
 * Never uses service-role or secret keys in client-side code.
 */
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'courtbook_supabase_auth_token',
      },
    })
  : null;

// Helper to check if a string is a valid UUID
export function isValidUuid(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// Database Types for Phase 1 Supabase Integration
export interface SupabaseOrganization {
  id: string;
  name: string;
  slug: string;
  billing_email?: string | null;
  is_demo: boolean;
  created_at: string;
}

export interface SupabaseOrgMember {
  id: string;
  organization_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'staff';
  created_at: string;
}

export interface SupabaseFacility {
  id: string;
  organization_id: string;
  app_type: string;
  name: string;
  slug: string;
  tagline?: string | null;
  address?: string | null;
  timezone: string;
  currency: string;
  open_hour: number;
  close_hour: number;
  default_hourly_rate: number;
  booking_confirmation_mode?: 'instant' | 'manual_approval';
  hold_duration_minutes?: number;
  is_active: boolean;
  is_demo: boolean;
}

export interface SupabaseCourt {
  id: string;
  facility_id: string;
  name: string;
  sport_type: string;
  tag?: string | null;
  surface_type?: string | null;
  description?: string | null;
  hourly_rate: number;
  is_enabled: boolean;
  display_order: number;
}

export interface SupabaseReservationRow {
  id: string;
  facility_id: string;
  court_id: string;
  reference_code: string;
  customer_name: string;
  customer_email?: string | null;
  customer_phone?: string | null;
  booking_date: string;
  start_time: string;
  end_time: string;
  time_slot_label: string;
  duration_minutes: number;
  price: number;
  status: 'confirmed' | 'cancelled' | 'pending' | 'declined' | 'expired' | 'completed' | 'no_show';
  hold_expires_at?: string | null;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  review_notes?: string | null;
  created_at: string;
}

export interface OrgWithFacilities {
  organization: SupabaseOrganization;
  role: 'owner' | 'admin' | 'staff';
  facilities: SupabaseFacility[];
}

export interface StaffMembershipData {
  userOrganizations: OrgWithFacilities[];
  activeOrganization: SupabaseOrganization | null;
  activeRole: 'owner' | 'admin' | 'staff';
  activeFacility: SupabaseFacility | null;
  availableFacilities: SupabaseFacility[];
  courts: SupabaseCourt[];
}

export interface CourtBookingStatusResult {
  court_id: string;
  court_name?: string;
  sport_type?: string;
  hourly_rate?: number;
  currency?: string;
  facility_id?: string;
  facility_name?: string;
  timezone?: string;
  open_hour?: number;
  close_hour?: number;
  booking_confirmation_mode?: 'instant' | 'manual_approval';
  hold_duration_minutes?: number;
  is_bookable: boolean;
  reason?: string;
}

export interface BusySlotRow {
  start_time: string;
  end_time: string;
  slot_type: 'reserved' | 'blocked' | 'held';
}

/**
 * Public RPC call: check_court_booking_status(p_court_id)
 * Available to anon and authenticated.
 */
export async function checkCourtBookingStatus(
  courtId: string
): Promise<CourtBookingStatusResult | null> {
  if (!supabase || !isValidUuid(courtId)) return null;

  try {
    const { data, error } = await supabase.rpc('check_court_booking_status', {
      p_court_id: courtId,
    });

    if (error) {
      console.warn('check_court_booking_status RPC error:', error.message);
      return null;
    }

    return data as CourtBookingStatusResult;
  } catch (err) {
    console.error('Failed to execute check_court_booking_status:', err);
    return null;
  }
}

/**
 * Public RPC call: get_court_busy_slots(p_court_id, p_date)
 * Available to anon and authenticated.
 * Returns busy and blocked time intervals using the facility's local IANA timezone.
 */
export async function getCourtBusySlots(
  courtId: string,
  dateStr: string
): Promise<BusySlotRow[]> {
  if (!supabase || !isValidUuid(courtId)) return [];

  try {
    const { data, error } = await supabase.rpc('get_court_busy_slots', {
      p_court_id: courtId,
      p_date: dateStr,
    });

    if (error) {
      console.warn('get_court_busy_slots RPC error:', error.message);
      return [];
    }

    return (data as BusySlotRow[]) || [];
  } catch (err) {
    console.error('Failed to execute get_court_busy_slots:', err);
    return [];
  }
}

/**
 * Computes exact UTC start and end timestamps for a local slot on a given date in a specific IANA timezone.
 * Robust across standard time and daylight saving time transitions.
 */
export function getLocalSlotUtcBounds(
  dateStr: string,
  startHour: number,
  endHour: number,
  timeZone: string
): { startUtcMs: number; endUtcMs: number } {
  const tz = timeZone || 'Asia/Manila';
  const startLocalStr = `${dateStr}T${String(startHour).padStart(2, '0')}:00:00`;
  const endLocalStr = `${dateStr}T${String(endHour).padStart(2, '0')}:00:00`;

  const guessStart = new Date(`${startLocalStr}Z`);
  const guessEnd = new Date(`${endLocalStr}Z`);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  function getOffsetMs(d: Date): number {
    const parts = fmt.formatToParts(d);
    const m: Record<string, string> = {};
    for (const p of parts) {
      m[p.type] = p.value;
    }
    const hourVal = parseInt(m.hour, 10);
    const asUtc = Date.UTC(
      parseInt(m.year, 10),
      parseInt(m.month, 10) - 1,
      parseInt(m.day, 10),
      hourVal === 24 ? 0 : hourVal,
      parseInt(m.minute, 10),
      parseInt(m.second, 10)
    );
    return asUtc - d.getTime();
  }

  const offsetStart = getOffsetMs(guessStart);
  const offsetEnd = getOffsetMs(guessEnd);

  return {
    startUtcMs: guessStart.getTime() - offsetStart,
    endUtcMs: guessEnd.getTime() - offsetEnd,
  };
}

/**
 * Returns today's date formatted as YYYY-MM-DD in the specified IANA timezone.
 * Robust against differences between the user's browser timezone and facility timezone.
 */
export function getTodayStringInTimezone(timeZone: string): string {
  const tz = timeZone || 'Asia/Manila';
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(new Date()); // Formats as YYYY-MM-DD
  } catch {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

/**
 * Determines whether a slot (startHour to endHour on slotDate in facilityTimezone)
 * is busy or blocked given busy intervals returned by get_court_busy_slots.
 */
export function isSlotBusyInTimezone(
  slotDate: string,
  slotStartHour: number,
  slotEndHour: number,
  facilityTimezone: string,
  busySlots: BusySlotRow[]
): { isBusy: boolean; slotType?: 'reserved' | 'blocked' | 'held' } {
  if (!busySlots || busySlots.length === 0) {
    return { isBusy: false };
  }

  const { startUtcMs, endUtcMs } = getLocalSlotUtcBounds(
    slotDate,
    slotStartHour,
    slotEndHour,
    facilityTimezone
  );

  for (const b of busySlots) {
    const bStart = new Date(b.start_time).getTime();
    const bEnd = new Date(b.end_time).getTime();

    // Overlap: bStart < endUtcMs && bEnd > startUtcMs
    if (bStart < endUtcMs && bEnd > startUtcMs) {
      return { isBusy: true, slotType: b.slot_type };
    }
  }

  return { isBusy: false };
}

/**
 * Public facilities query for anonymous visitors.
 * RLS policy "public_can_view_active_facilities" grants SELECT on active facilities.
 * Returns genuine database results without silent fallback substitution.
 */
export async function fetchPublicFacilitiesWithStatus(): Promise<{
  data: SupabaseFacility[];
  error: string | null;
}> {
  if (!supabase) return { data: [], error: null };

  try {
    const { data, error } = await supabase
      .from('facilities')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) {
      console.warn('Error fetching public facilities from Supabase:', error.message);
      return { data: [], error: error.message };
    }

    return { data: (data as SupabaseFacility[]) || [], error: null };
  } catch (err: any) {
    console.error('Failed to fetch public facilities:', err);
    return { data: [], error: err?.message || 'Failed to load public facilities.' };
  }
}

export async function fetchPublicFacilities(): Promise<SupabaseFacility[]> {
  const res = await fetchPublicFacilitiesWithStatus();
  return res.data;
}

/**
 * Public courts query for anonymous visitors.
 * RLS policy "public_can_view_enabled_courts" grants SELECT on enabled courts of active facilities.
 * Returns genuine database results without silent fallback substitution.
 */
export async function fetchPublicCourts(facilityId?: string): Promise<SupabaseCourt[]> {
  if (!supabase) return [];

  try {
    let query = supabase
      .from('courts')
      .select('*')
      .eq('is_enabled', true)
      .order('display_order', { ascending: true });

    if (facilityId) {
      query = query.eq('facility_id', facilityId);
    }

    const { data, error } = await query;
    if (error) {
      console.warn('Error fetching public courts from Supabase:', error.message);
      return [];
    }

    return (data as SupabaseCourt[]) || [];
  } catch (err) {
    console.error('Failed to fetch public courts:', err);
    return [];
  }
}

export interface StaffLookupResult {
  data: StaffMembershipData | null;
  hasMemberships: boolean;
  error: string | null;
}

/**
 * Performs a rigorous lookup of an authenticated user's organization memberships.
 * Strictly distinguishes between:
 *   - Query error / failure (error: string, hasMemberships: false) -> maps to 'error' onboarding state
 *   - Verified successful query returning 0 memberships (error: null, hasMemberships: false) -> maps to 'needs_onboarding' state
 *   - Successful query with >=1 memberships (error: null, hasMemberships: true, data: StaffMembershipData) -> maps to 'ready' state
 */
export async function fetchStaffMembershipLookup(
  userId: string,
  preferredOrgId?: string,
  preferredFacilityId?: string
): Promise<StaffLookupResult> {
  if (!supabase) {
    return {
      data: null,
      hasMemberships: false,
      error: 'Supabase client is not initialized',
    };
  }

  try {
    // 1. Fetch all organization memberships for current user
    const { data: memberRows, error: memberErr } = await supabase
      .from('organization_members')
      .select('id, organization_id, user_id, role, created_at')
      .eq('user_id', userId);

    if (memberErr) {
      console.warn('Database error querying organization memberships:', memberErr.message);
      return {
        data: null,
        hasMemberships: false,
        error: memberErr.message,
      };
    }

    // Query succeeded, but user belongs to 0 organizations -> confirmed needs onboarding
    if (!memberRows || memberRows.length === 0) {
      return {
        data: null,
        hasMemberships: false,
        error: null,
      };
    }

    const orgIds = memberRows.map((m) => m.organization_id);

    // 2. Fetch all organizations the user belongs to
    const { data: orgRows, error: orgErr } = await supabase
      .from('organizations')
      .select('*')
      .in('id', orgIds)
      .order('name', { ascending: true });

    if (orgErr) {
      console.warn('Database error querying organizations:', orgErr.message);
      return {
        data: null,
        hasMemberships: true,
        error: orgErr.message,
      };
    }

    if (!orgRows || orgRows.length === 0) {
      return {
        data: null,
        hasMemberships: true,
        error: 'Organizations associated with user memberships could not be loaded.',
      };
    }

    // 3. Fetch all facilities for these organizations
    const { data: facilityRows, error: facErr } = await supabase
      .from('facilities')
      .select('*')
      .in('organization_id', orgIds)
      .order('created_at', { ascending: true });

    if (facErr) {
      console.warn('Database error querying facilities:', facErr.message);
      return {
        data: null,
        hasMemberships: true,
        error: facErr.message,
      };
    }

    const allFacilities = (facilityRows as SupabaseFacility[]) || [];

    // Group facilities by organization
    const userOrganizations: OrgWithFacilities[] = (orgRows as SupabaseOrganization[]).map((org) => {
      const membership = memberRows.find((m) => m.organization_id === org.id);
      const facilities = allFacilities.filter((f) => f.organization_id === org.id);
      return {
        organization: org,
        role: (membership?.role || 'staff') as 'owner' | 'admin' | 'staff',
        facilities,
      };
    });

    if (userOrganizations.length === 0) {
      return {
        data: null,
        hasMemberships: true,
        error: 'No accessible organizations found for your membership.',
      };
    }

    // Determine active organization
    let chosenOrgGroup = userOrganizations.find(
      (uo) => uo.organization.id === preferredOrgId
    );
    if (!chosenOrgGroup) {
      chosenOrgGroup = userOrganizations[0];
    }

    const activeOrg = chosenOrgGroup.organization;
    const activeRole = chosenOrgGroup.role;
    const availableFacilities = chosenOrgGroup.facilities;

    // Determine active facility within active organization
    let chosenFacility = availableFacilities.find(
      (f) => f.id === preferredFacilityId
    );
    if (!chosenFacility && availableFacilities.length > 0) {
      chosenFacility = availableFacilities[0];
    }

    // If user has organization memberships but no facilities exist, return data with null activeFacility
    // (incomplete onboarding state, not an authentication failure)
    if (allFacilities.length === 0 || !chosenFacility) {
      return {
        data: {
          userOrganizations,
          activeOrganization: activeOrg,
          activeRole,
          activeFacility: null,
          availableFacilities: [],
          courts: [],
        },
        hasMemberships: true,
        error: null,
      };
    }

    // 4. Fetch courts for the active facility
    let courts: SupabaseCourt[] = [];
    if (chosenFacility) {
      const { data: courtRows, error: courtErr } = await supabase
        .from('courts')
        .select('*')
        .eq('facility_id', chosenFacility.id)
        .order('display_order', { ascending: true });

      if (courtErr) {
        console.error('Database error querying courts for facility:', courtErr.message);
        return {
          data: null,
          hasMemberships: true,
          error: `Failed to load courts for facility "${chosenFacility.name}": ${courtErr.message}`,
        };
      } else if (courtRows) {
        courts = courtRows as SupabaseCourt[];
      }
    }

    return {
      data: {
        userOrganizations,
        activeOrganization: activeOrg,
        activeRole,
        activeFacility: chosenFacility,
        availableFacilities,
        courts,
      },
      hasMemberships: true,
      error: null,
    };
  } catch (err: any) {
    console.error('Unexpected exception during staff membership lookup:', err);
    return {
      data: null,
      hasMemberships: false,
      error: err?.message || 'Unexpected failure loading staff data',
    };
  }
}

/**
 * Fetches the authenticated staff member's organizations, roles, facilities, and courts.
 * Supports multiple organizations and facilities, relying strictly on Supabase RLS policies.
 */
export async function fetchAuthenticatedStaffData(
  userId: string,
  preferredOrgId?: string,
  preferredFacilityId?: string
): Promise<StaffMembershipData | null> {
  const result = await fetchStaffMembershipLookup(userId, preferredOrgId, preferredFacilityId);
  return result.data;
}

export interface FacilityReservationsResult {
  data: SupabaseReservationRow[];
  error: string | null;
}

/**
 * Fetches reservations for a given facility via Supabase.
 * Allowed ONLY for authenticated staff members through RLS policy `staff_can_view_facility_reservations`.
 * Returns an explicit error object when query fails rather than silently returning an empty array.
 */
export async function fetchFacilityReservations(
  facilityId: string
): Promise<FacilityReservationsResult> {
  if (!supabase) {
    return {
      data: [],
      error: 'Supabase client is not initialized',
    };
  }

  if (!isValidUuid(facilityId)) {
    return {
      data: [],
      error: `Invalid facility ID: ${facilityId}`,
    };
  }

  try {
    const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
    if (sessionErr) {
      console.warn('Could not verify session for reservation query:', sessionErr.message);
      return {
        data: [],
        error: `Session verification error: ${sessionErr.message}`,
      };
    }

    if (!sessionData?.session?.user) {
      // Must be authenticated to view private reservation records
      return {
        data: [],
        error: 'Authentication required to view facility reservations.',
      };
    }

    const { data, error } = await supabase
      .from('reservations')
      .select('*')
      .eq('facility_id', facilityId)
      .order('start_time', { ascending: false });

    if (error) {
      console.error('Database error querying reservations for facility:', facilityId, error.message);
      return {
        data: [],
        error: error.message,
      };
    }

    return {
      data: (data as SupabaseReservationRow[]) || [],
      error: null,
    };
  } catch (err: any) {
    console.error('Unexpected exception querying reservations from Supabase:', err);
    return {
      data: [],
      error: err?.message || 'Unexpected failure loading reservations',
    };
  }
}

/**
 * Staff cancellation through validated SECURITY DEFINER RPC `cancel_reservation_as_staff`.
 * Migration 002 revokes direct UPDATE on reservations and enforces this routine.
 */
export async function cancelReservationViaRpc(
  reservationId: string,
  reason: string = 'Staff cancellation via admin portal'
): Promise<{ success: boolean; error?: string }> {
  if (!supabase) {
    return { success: false, error: 'Supabase client is not configured.' };
  }

  try {
    const { error } = await supabase.rpc('cancel_reservation_as_staff', {
      p_reservation_id: reservationId,
      p_reason: reason,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to cancel reservation.' };
  }
}

/**
 * Staff approval for pending booking requests via approve_booking_request_as_staff.
 */
export async function approveBookingRequestViaRpc(
  reservationId: string,
  notes?: string
): Promise<{ success: boolean; error?: string; data?: any }> {
  if (!supabase) {
    return { success: false, error: 'Supabase client is not configured.' };
  }

  try {
    const { data, error } = await supabase.rpc('approve_booking_request_as_staff', {
      p_reservation_id: reservationId,
      p_notes: notes || null,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    if (data && data.success === false) {
      return { success: false, error: data.error || 'Failed to approve booking request.', data };
    }

    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to approve booking request.' };
  }
}

/**
 * Staff decline for pending booking requests via decline_booking_request_as_staff.
 */
export async function declineBookingRequestViaRpc(
  reservationId: string,
  reason?: string
): Promise<{ success: boolean; error?: string; data?: any }> {
  if (!supabase) {
    return { success: false, error: 'Supabase client is not configured.' };
  }

  try {
    const { data, error } = await supabase.rpc('decline_booking_request_as_staff', {
      p_reservation_id: reservationId,
      p_reason: reason || null,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to decline booking request.' };
  }
}

/**
 * Facility settings update for confirmation mode & hold duration via update_facility_confirmation_settings.
 */
export async function updateFacilityConfirmationSettingsViaRpc(
  facilityId: string,
  mode: 'instant' | 'manual_approval',
  holdMinutes: number = 30
): Promise<{ success: boolean; error?: string; data?: any }> {
  if (!supabase) {
    return { success: false, error: 'Supabase client is not configured.' };
  }

  try {
    const { data, error } = await supabase.rpc('update_facility_confirmation_settings', {
      p_facility_id: facilityId,
      p_mode: mode,
      p_hold_minutes: holdMinutes,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to update confirmation settings.' };
  }
}

/**
 * Staff-triggered facility-scoped stale hold expiration cleanup.
 */
export async function expireFacilityStaleReservationsViaRpc(
  facilityId: string
): Promise<{ success: boolean; expiredCount?: number; error?: string }> {
  if (!supabase) {
    return { success: false, error: 'Supabase client is not configured.' };
  }

  try {
    const { data, error } = await supabase.rpc('expire_facility_stale_reservations', {
      p_facility_id: facilityId,
    });

    return { success: true, expiredCount: Number(data) || 0 };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to clean up stale holds.' };
  }
}

/**
 * Calls the secure create-booking Edge Function for public customer reservations.
 * Keeps service-role credentials exclusively on the server.
 */
export interface PublicBookingInput {
  facility_id: string;
  court_id: string;
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  booking_date: string; // YYYY-MM-DD
  start_time: string; // ISO 8601 UTC string
  duration_minutes?: number;
  idempotency_key: string; // Mandatory idempotency key (16-128 chars)
  captcha_token?: string;
  cf_turnstile_response?: string;
  is_demo?: boolean;
}

export interface AuthoritativeReservationDetails {
  reservationId: string;
  referenceCode: string;
  status: 'confirmed' | 'pending';
  price: number;
  holdExpiresAt: string | null;
  courtName?: string;
  facilityName?: string;
  bookingDate?: string;
  timeSlotLabel?: string;
  currency?: string;
  createdAt?: string;
}

/**
 * Robustly inspects all candidate objects and nested envelopes returned by
 * the create-booking Edge Function or database RPC (e.g. result.reservation,
 * result.data.reservation, result.data, top-level result) and validates that
 * an authentic, non-fictional reservation was created.
 */
export function extractAuthoritativeReservation(
  rawResponse: any
): AuthoritativeReservationDetails | null {
  if (!rawResponse || typeof rawResponse !== 'object') {
    return null;
  }

  // Candidate sources ordered from most specific reservation object to top-level envelope
  const candidateObjects = [
    rawResponse.reservation,
    rawResponse.data?.reservation,
    rawResponse.data?.data,
    rawResponse.data,
    rawResponse.booking,
    rawResponse,
  ].filter((obj): obj is Record<string, any> => Boolean(obj && typeof obj === 'object'));

  // 1. Reference Code
  let referenceCode: string | null = null;
  for (const obj of candidateObjects) {
    const val =
      obj.reference_code ??
      obj.referenceCode ??
      obj.booking_reference ??
      obj.bookingReference ??
      obj.ref_code ??
      obj.refCode ??
      obj.reference;
    if (val !== undefined && val !== null) {
      const s = String(val).trim();
      if (s.length > 0) {
        referenceCode = s;
        break;
      }
    }
  }

  // 2. Reservation ID
  let reservationId: string | null = null;
  for (const obj of candidateObjects) {
    const val =
      obj.reservation_id ??
      obj.reservationId ??
      obj.id ??
      obj.res_id ??
      obj.resId ??
      obj.booking_id ??
      obj.bookingId;
    if (val !== undefined && val !== null) {
      const s = String(val).trim();
      if (s.length > 0) {
        reservationId = s;
        break;
      }
    }
  }

  // 3. Authoritative Status ('confirmed' | 'pending')
  let status: 'confirmed' | 'pending' | null = null;
  for (const obj of candidateObjects) {
    const val =
      obj.status ??
      obj.reservation_status ??
      obj.reservationStatus ??
      obj.booking_status ??
      obj.bookingStatus;
    if (val && typeof val === 'string') {
      const lower = val.toLowerCase().trim();
      if (lower === 'confirmed' || lower === 'pending') {
        status = lower as 'confirmed' | 'pending';
        break;
      }
    }
  }

  // 4. Total Price
  let price: number | null = null;
  for (const obj of candidateObjects) {
    const val =
      obj.total_price ??
      obj.totalPrice ??
      obj.price ??
      obj.total ??
      obj.amount ??
      obj.total_amount ??
      obj.totalAmount;
    if (val !== undefined && val !== null && val !== '') {
      if (typeof val === 'number' && !isNaN(val)) {
        price = val;
        break;
      }
      if (typeof val === 'string') {
        // Strip any currency prefixes/symbols: e.g. "₱350.00", "PHP 350", "350"
        const cleaned = val.replace(/[^0-9.-]/g, '').trim();
        const num = Number(cleaned);
        if (!isNaN(num) && cleaned.length > 0) {
          price = num;
          break;
        }
      }
    }
  }

  // If any required authoritative field is missing or invalid, response is incomplete
  if (!referenceCode || !reservationId || !status || price === null) {
    return null;
  }

  // 5. Hold Expiration (null if instant or omitted, never invented)
  let holdExpiresAt: string | null = null;
  for (const obj of candidateObjects) {
    const val =
      obj.hold_expires_at ??
      obj.holdExpiresAt ??
      obj.expires_at ??
      obj.expiresAt ??
      obj.hold_expiration ??
      obj.holdExpiration;
    if (val && typeof val === 'string' && val.trim().length > 0) {
      holdExpiresAt = val.trim();
      break;
    }
  }

  // Authoritative metadata from database RPC
  let courtName: string | undefined;
  let facilityName: string | undefined;
  let bookingDate: string | undefined;
  let timeSlotLabel: string | undefined;
  let currency: string | undefined;
  let createdAt: string | undefined;

  for (const obj of candidateObjects) {
    if (!courtName && (obj.court_name || obj.courtName)) courtName = String(obj.court_name || obj.courtName).trim();
    if (!facilityName && (obj.facility_name || obj.facilityName)) facilityName = String(obj.facility_name || obj.facilityName).trim();
    if (!bookingDate && (obj.booking_date || obj.bookingDate || obj.date)) bookingDate = String(obj.booking_date || obj.bookingDate || obj.date).trim();
    if (!timeSlotLabel && (obj.time_slot_label || obj.timeSlotLabel || obj.time_slot || obj.timeSlot)) timeSlotLabel = String(obj.time_slot_label || obj.timeSlotLabel || obj.time_slot || obj.timeSlot).trim();
    if (!currency && (obj.currency || obj.currency_symbol)) currency = String(obj.currency || obj.currency_symbol).trim();
    if (!createdAt && (obj.created_at || obj.createdAt)) createdAt = String(obj.created_at || obj.createdAt).trim();
  }

  return {
    referenceCode,
    reservationId,
    status,
    price,
    holdExpiresAt,
    courtName,
    facilityName,
    bookingDate,
    timeSlotLabel,
    currency,
    createdAt,
  };
}

export interface PublicBookingResult {
  success: boolean;
  data?: any;
  authoritative?: AuthoritativeReservationDetails;
  raw?: any;
  error?: string;
  isConflict?: boolean;
  isRateLimited?: boolean;
  isCaptchaRequired?: boolean;
  isNetworkError?: boolean;
  isTimeout?: boolean;
  isIncompleteResponse?: boolean;
  retryAfter?: number;
  idempotentReplayed?: boolean;
  httpStatus?: number;
}

export async function submitPublicBookingViaFunction(
  input: PublicBookingInput
): Promise<PublicBookingResult> {
  if (!supabaseUrl) {
    return { success: false, error: 'Supabase URL is not configured.' };
  }

  // Mandatory idempotency key validation
  const idempotencyKey = input.idempotency_key ? input.idempotency_key.trim() : '';
  if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 128) {
    return {
      success: false,
      error: 'A valid idempotency key (16 to 128 characters) is required for booking submission.',
    };
  }

  const endpointUrl = `${supabaseUrl}/functions/v1/create-booking`;

  const payload: Record<string, any> = {
    ...input,
    idempotency_key: idempotencyKey,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: supabasePublishableKey,
    Authorization: `Bearer ${supabasePublishableKey}`,
    'Idempotency-Key': idempotencyKey,
  };

  if (input.captcha_token) {
    headers['x-turnstile-token'] = input.captcha_token;
  }

  const controller = new AbortController();
  const timeoutMs = 20000; // 20-second timeout guard
  const timeoutTimer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutTimer);

    let result: any = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (!response.ok) {
      const isConflict =
        response.status === 409 ||
        Boolean(result?.error?.includes('already booked')) ||
        Boolean(result?.error?.includes('held for another pending request'));

      const isRateLimited = response.status === 429 || result?.code === 'RATE_LIMIT_EXCEEDED';
      const isCaptchaRequired =
        response.status === 403 ||
        result?.code === 'CAPTCHA_REQUIRED' ||
        result?.code === 'CAPTCHA_REJECTED';

      return {
        success: false,
        isConflict,
        isRateLimited,
        isCaptchaRequired,
        retryAfter: result?.retry_after,
        error: result?.error || `Booking failed with status ${response.status}`,
        httpStatus: response.status,
      };
    }

    // Success response handling (HTTP 200 or HTTP 201):
    // Authoritative field extraction & completeness validation across all response envelope shapes
    const authDetails = extractAuthoritativeReservation(result);

    if (!authDetails) {
      return {
        success: false,
        isIncompleteResponse: true,
        data: result?.reservation || result?.data || result || {},
        raw: result,
        error:
          'Booking status could not be verified: The booking service returned an incomplete or invalid reservation response. ' +
          'Your booking attempt key has been preserved. If your reservation was already processed, complete bot verification and click retry to safely retrieve your confirmed booking without double-booking.',
        httpStatus: response.status,
      };
    }

    const reservationData = {
      ...(result?.reservation || result?.data || result || {}),
      reservation_id: authDetails.reservationId,
      id: authDetails.reservationId,
      reference_code: authDetails.referenceCode,
      status: authDetails.status,
      total_price: authDetails.price,
      price: authDetails.price,
      hold_expires_at: authDetails.holdExpiresAt,
      court_name: authDetails.courtName,
      facility_name: authDetails.facilityName,
      booking_date: authDetails.bookingDate,
      time_slot_label: authDetails.timeSlotLabel,
      currency: authDetails.currency,
    };

    return {
      success: true,
      data: reservationData,
      authoritative: authDetails,
      raw: result,
      idempotentReplayed: Boolean(
        result?.idempotent_replayed ||
        reservationData?.idempotent_replayed ||
        response.status === 200
      ),
      httpStatus: response.status,
    };
  } catch (err: any) {
    clearTimeout(timeoutTimer);
    const isTimeout =
      err?.name === 'AbortError' ||
      err?.message?.toLowerCase().includes('timeout') ||
      err?.message?.toLowerCase().includes('aborted');

    return {
      success: false,
      isNetworkError: true,
      isTimeout,
      error: isTimeout
        ? 'Network request timed out waiting for booking response.'
        : err?.message || 'Network error connecting to booking service.',
    };
  }
}

export interface CreateBookingCheckoutInput {
  facility_id: string;
  court_id: string;
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  booking_date: string; // YYYY-MM-DD
  start_time: string; // ISO 8601 UTC
  duration_minutes: number;
  idempotency_key: string;
  provider_name?: 'paymongo' | 'xendit' | 'manual_test';
  is_demo?: boolean;
  is_frontend_demo?: boolean; // Explicit flag for frontend-only fictional inventory
  hourly_rate?: number; // Used to calculate accurate amounts for demo checkout
  currency?: string;
  court_name?: string;
}

export interface CreateBookingCheckoutResult {
  success: boolean;
  reservation_id?: string;
  payment_id?: string;
  reference_code?: string;
  checkout_session_id?: string;
  expected_amount?: number;
  currency?: string;
  commission_rate?: number;
  commission_amount?: number;
  owner_gross_share?: number;
  hold_expires_at?: string;
  time_slot_label?: string;
  court_name?: string;
  checkout_url?: string;
  idempotent_replayed?: boolean;
  isConflict?: boolean;
  isSimulated?: boolean;
  error?: string;
}

/**
 * Creates an authoritative booking checkout session via create-checkout-session Edge Function
 * with graceful RPC fallback if the Edge Function is not reachable.
 * 
 * CRITICAL ISOLATION RULE:
 * If input.is_frontend_demo is true, returns immediately with an in-memory simulated checkout
 * without making ANY network calls to Supabase or PayMongo.
 */
export async function createBookingCheckoutSession(
  input: CreateBookingCheckoutInput
): Promise<CreateBookingCheckoutResult> {
  const idempotencyKey = input.idempotency_key.trim();
  if (!idempotencyKey || idempotencyKey.length < 16) {
    return {
      success: false,
      error: 'A valid idempotency key (min 16 characters) is required.',
    };
  }

  // ============================================================================
  // EARLY ISOLATION BRANCH: FRONTEND-ONLY DEMO MODE
  // MUST execute BEFORE any Supabase or PayMongo network calls.
  // ============================================================================
  if (input.is_frontend_demo) {
    const rate = Number(input.hourly_rate) > 0 ? Number(input.hourly_rate) : 350.0;
    const duration = input.duration_minutes > 0 ? input.duration_minutes : 60;
    const totalAmount = Math.round((rate * (duration / 60)) * 100) / 100;
    const commissionRate = 0.05;
    const commissionAmount = Math.round((totalAmount * commissionRate) * 100) / 100;
    const ownerGrossShare = Math.round((totalAmount - commissionAmount) * 100) / 100;

    const startDate = new Date(input.start_time || new Date().toISOString());
    const startH = startDate.getHours() % 12 || 12;
    const startM = String(startDate.getMinutes()).padStart(2, '0');
    const ampm = startDate.getHours() < 12 ? 'AM' : 'PM';
    const endDate = new Date(startDate.getTime() + duration * 60000);
    const endH = endDate.getHours() % 12 || 12;
    const endM = String(endDate.getMinutes()).padStart(2, '0');
    const endAmpm = endDate.getHours() < 12 ? 'AM' : 'PM';
    const timeSlotLabel = `${startH}:${startM} ${ampm} – ${endH}:${endM} ${endAmpm}`;

    const nowUtc = new Date();
    const holdExpiry = new Date(nowUtc.getTime() + 15 * 60 * 1000).toISOString();
    const deterministicSuffix = idempotencyKey.substring(Math.max(0, idempotencyKey.length - 6)).toUpperCase();
    const demoRef = `DEMO-${deterministicSuffix}`;

    return {
      success: true,
      reservation_id: `demo-res-${idempotencyKey.substring(0, 12)}`,
      payment_id: `demo-pay-${idempotencyKey.substring(0, 12)}`,
      reference_code: demoRef,
      checkout_session_id: `cs_demo_${idempotencyKey.substring(0, 16)}`,
      expected_amount: totalAmount,
      currency: input.currency || '₱',
      commission_rate: commissionRate,
      commission_amount: commissionAmount,
      owner_gross_share: ownerGrossShare,
      hold_expires_at: holdExpiry,
      time_slot_label: timeSlotLabel,
      court_name: input.court_name || 'Demo Court',
      checkout_url: undefined, // Zero fake PayMongo URL
      isSimulated: true,
    };
  }

  // ============================================================================
  // LIVE SUPABASE-BACKED FACILITY CHECKOUT PATH
  // ============================================================================
  // If Supabase URL is available, try Edge Function first
  if (supabaseUrl) {
    try {
      const endpoint = `${supabaseUrl}/functions/v1/create-checkout-session`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabasePublishableKey,
          Authorization: `Bearer ${supabasePublishableKey}`,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          facility_id: input.facility_id,
          court_id: input.court_id,
          customer_name: input.customer_name,
          customer_phone: input.customer_phone || undefined,
          customer_email: input.customer_email || undefined,
          booking_date: input.booking_date,
          start_time: input.start_time,
          duration_minutes: input.duration_minutes,
          idempotency_key: idempotencyKey,
          provider_name: input.provider_name || 'paymongo',
        }),
      });

      const json = await res.json().catch(() => null);

      if (res.ok && json?.success) {
        return {
          success: true,
          reservation_id: json.reservation_id,
          payment_id: json.payment_id,
          reference_code: json.reference_code,
          checkout_session_id: json.checkout_session_id,
          expected_amount: Number(json.expected_amount),
          currency: json.currency || '₱',
          commission_rate: Number(json.commission_rate || 0.05),
          commission_amount: Number(json.commission_amount || 0),
          owner_gross_share: Number(json.owner_gross_share || 0),
          hold_expires_at: json.hold_expires_at,
          time_slot_label: json.time_slot_label,
          court_name: json.court_name,
          checkout_url: json.checkout_url,
          idempotent_replayed: Boolean(json.idempotent_replayed),
          isSimulated: Boolean(json.is_simulated),
        };
      }

      if (res.status === 409 || json?.error?.includes('already reserved') || json?.error?.includes('exclusion_violation')) {
        return {
          success: false,
          isConflict: true,
          error: 'This court slot was just selected by another player. Please select another time or court.',
        };
      }

      if (json?.error && res.status !== 404) {
        return {
          success: false,
          error: json.error,
        };
      }
    } catch {
      // Edge function failed or offline, fall through to direct RPC / client fallback
    }
  }

  // Fallback: Direct Database RPC invocation if Supabase client is connected
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc('create_booking_checkout_session', {
        p_idempotency_key: idempotencyKey,
        p_facility_id: input.facility_id,
        p_court_id: input.court_id,
        p_customer_name: input.customer_name,
        p_customer_phone: input.customer_phone || null,
        p_customer_email: input.customer_email || null,
        p_booking_date: input.booking_date,
        p_start_time: input.start_time,
        p_duration_minutes: input.duration_minutes,
        p_provider_name: input.provider_name || 'paymongo',
      });

      if (error) {
        const isConflict =
          error.message.includes('already reserved') ||
          error.message.includes('exclusion_violation') ||
          error.message.includes('conflicting hold');
        return {
          success: false,
          isConflict,
          error: isConflict
            ? 'This court slot is currently held or already booked. Please choose another slot.'
            : error.message,
        };
      }

      if (data && data.success) {
        return {
          success: true,
          reservation_id: data.reservation_id,
          payment_id: data.payment_id,
          reference_code: data.reference_code,
          checkout_session_id: data.checkout_session_id,
          expected_amount: Number(data.expected_amount),
          currency: data.currency || '₱',
          commission_rate: Number(data.commission_rate || 0.05),
          commission_amount: Number(data.commission_amount || 0),
          owner_gross_share: Number(data.owner_gross_share || 0),
          hold_expires_at: data.hold_expires_at,
          time_slot_label: data.time_slot_label,
          court_name: data.court_name,
          checkout_url: `https://checkout.paymongo.com/${data.checkout_session_id}`,
          isSimulated: Boolean(input.is_demo),
        };
      }
    } catch (rpcErr: any) {
      return {
        success: false,
        error: rpcErr?.message || 'Database error initializing checkout session.',
      };
    }
  }

  // Strict Fail-Closed Rule for Live / Supabase-backed Facilities:
  // If Edge Function and Database RPC could not be completed, NEVER fabricate simulated reservation or payment IDs.
  return {
    success: false,
    error: 'Unable to establish authoritative backend checkout session with payment provider. Please verify connection and retry.',
  };
}

export type AuthoritativeBookingStatus =
  | 'pending'
  | 'processing'
  | 'confirmed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface VerifyBookingPaymentStatusResult {
  verified: boolean;
  status: AuthoritativeBookingStatus;
  reservation_id?: string;
  reference_code?: string;
  payment_id?: string;
  payment_status?: string;
  hold_expires_at?: string;
  total_price?: number;
  currency?: string;
  facility_name?: string;
  court_name?: string;
  booking_date?: string;
  time_slot_label?: string;
  confirmed_at?: string;
  error?: string;
}

/**
 * Authoritative payment status retrieval:
 * Queries the backend for server-verified reservation and payment state using
 * reference_code and reservation_id.
 * 
 * Never marks a reservation paid from frontend state.
 * Fails closed if the backend returns incomplete or unverifiable state.
 */
export async function verifyPublicBookingPaymentStatus(input: {
  reference_code: string;
  reservation_id: string;
  payment_id?: string;
  customer_phone_or_email?: string;
}): Promise<VerifyBookingPaymentStatusResult> {
  const refCode = input.reference_code.trim();
  const resId = input.reservation_id.trim();

  if (!refCode || !resId) {
    return {
      verified: false,
      status: 'failed',
      error: 'Missing required reservation reference or ID for status verification.',
    };
  }

  // Invoke the authoritative backend get-booking-status Edge Function
  const endpoint = supabaseUrl
    ? `${supabaseUrl}/functions/v1/get-booking-status`
    : 'https://backend.courtbook.ph/functions/v1/get-booking-status';

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (supabasePublishableKey) {
      headers.apikey = supabasePublishableKey;
      headers.Authorization = `Bearer ${supabasePublishableKey}`;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
        body: JSON.stringify({
          reference_code: refCode,
          reservation_id: resId,
          payment_id: input.payment_id,
          contact: input.customer_phone_or_email,
        }),
      });

      if (res.ok) {
        const json = await res.json().catch(() => null);
        // Authoritative verification contract:
        // Must contain success: true, matching reference_code and reservation_id
        if (
          json &&
          json.success === true &&
          json.reference_code === refCode &&
          json.reservation_id === resId
        ) {
          const rawStatus = String(json.status || json.reservation_status || '').toLowerCase().trim();
          let status: AuthoritativeBookingStatus = 'pending';
          if (rawStatus === 'confirmed' || rawStatus === 'captured') status = 'confirmed';
          else if (rawStatus === 'processing') status = 'processing';
          else if (rawStatus === 'expired') status = 'expired';
          else if (rawStatus === 'cancelled') status = 'cancelled';
          else if (rawStatus === 'failed') status = 'failed';

          // Strictly require verified flag from backend
          const verified = Boolean(json.verified) && status === 'confirmed';

          return {
            verified,
            status,
            reservation_id: json.reservation_id,
            reference_code: json.reference_code,
            payment_id: json.payment_id,
            payment_status: json.payment_status,
            hold_expires_at: json.hold_expires_at,
            total_price: json.total_price ? Number(json.total_price) : undefined,
            currency: json.currency || '₱',
            facility_name: json.facility_name,
            court_name: json.court_name,
            booking_date: json.booking_date,
            time_slot_label: json.time_slot_label,
            confirmed_at: json.confirmed_at || json.updated_at,
          };
        } else if (json && json.error) {
          return {
            verified: false,
            status: 'failed',
            error: json.error,
          };
        }
      } else if (res.status === 404) {
        return {
          verified: false,
          status: 'failed',
          error: 'Reservation record not found. Please verify your reference code.',
        };
      } else if (res.status === 429) {
        return {
          verified: false,
          status: 'pending',
          error: 'Rate limit exceeded. Please wait a moment before checking status again.',
        };
      }
    } catch {
      // Network failure or offline
    }

  // Fails closed: Server verification is unavailable or unconfirmed
  return {
    verified: false,
    status: 'pending',
    error: 'Backend payment status verification is in progress or currently unreachable. Please refresh to check confirmation.',
  };
}

// Re-export slug utilities
export { slugify, isValidSlug, validateSlug } from '../utils/slugify';

// Re-export owner onboarding service helpers & types (Phase 3 Stage 3.3)
export {
  createOrganizationWithOwnerViaRpc,
  createFacilityForOwner,
  createCourtsForFacility,
  getOwnerOnboardingRecoveryState,
  validateOrganizationInput,
  validateFacilityInput,
  validateCourtsInput,
  type CreateOrgResult,
  type CreateFacilityInput,
  type CreateFacilityResult,
  type CreateCourtItemInput,
  type CreateCourtsResult,
  type OwnerOnboardingRecoveryState,
  type OnboardingStepStatus,
} from './ownerOnboarding';
