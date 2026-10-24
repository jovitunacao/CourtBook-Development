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
 */
export async function fetchPublicFacilities(): Promise<SupabaseFacility[]> {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('facilities')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) {
      console.warn('Error fetching public facilities:', error.message);
      return [];
    }

    return (data as SupabaseFacility[]) || [];
  } catch (err) {
    console.error('Failed to fetch public facilities:', err);
    return [];
  }
}

/**
 * Public courts query for anonymous visitors.
 * RLS policy "public_can_view_enabled_courts" grants SELECT on enabled courts of active facilities.
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
      console.warn('Error fetching public courts:', error.message);
      return [];
    }

    return (data as SupabaseCourt[]) || [];
  } catch (err) {
    console.error('Failed to fetch public courts:', err);
    return [];
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
  if (!supabase) return null;

  try {
    // 1. Fetch all organization memberships for current user
    const { data: memberRows, error: memberErr } = await supabase
      .from('organization_members')
      .select('id, organization_id, user_id, role, created_at')
      .eq('user_id', userId);

    if (memberErr || !memberRows || memberRows.length === 0) {
      console.warn('No organization memberships found for user:', userId, memberErr);
      return null;
    }

    const orgIds = memberRows.map((m) => m.organization_id);

    // 2. Fetch all organizations the user belongs to
    const { data: orgRows, error: orgErr } = await supabase
      .from('organizations')
      .select('*')
      .in('id', orgIds)
      .order('name', { ascending: true });

    if (orgErr || !orgRows || orgRows.length === 0) {
      console.warn('Organizations not accessible:', orgIds, orgErr);
      return null;
    }

    // 3. Fetch all facilities for these organizations
    const { data: facilityRows, error: facErr } = await supabase
      .from('facilities')
      .select('*')
      .in('organization_id', orgIds)
      .order('created_at', { ascending: true });

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
      return null;
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

    // 4. Fetch courts for the active facility
    let courts: SupabaseCourt[] = [];
    if (chosenFacility) {
      const { data: courtRows, error: courtErr } = await supabase
        .from('courts')
        .select('*')
        .eq('facility_id', chosenFacility.id)
        .order('display_order', { ascending: true });

      if (!courtErr && courtRows) {
        courts = courtRows as SupabaseCourt[];
      }
    }

    return {
      userOrganizations,
      activeOrganization: activeOrg,
      activeRole,
      activeFacility: chosenFacility || null,
      availableFacilities,
      courts,
    };
  } catch (err) {
    console.error('Error fetching authenticated staff data:', err);
    return null;
  }
}

/**
 * Fetches reservations for a given facility via Supabase.
 * Allowed ONLY for authenticated staff members through RLS policy `staff_can_view_facility_reservations`.
 */
export async function fetchFacilityReservations(
  facilityId: string
): Promise<SupabaseReservationRow[]> {
  if (!supabase || !isValidUuid(facilityId)) return [];

  try {
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData?.session?.user) {
      // Must be authenticated to view private reservation records
      return [];
    }

    const { data, error } = await supabase
      .from('reservations')
      .select('*')
      .eq('facility_id', facilityId)
      .order('start_time', { ascending: false });

    if (error) {
      console.warn('Could not fetch reservations for facility:', facilityId, error.message);
      return [];
    }

    return (data as SupabaseReservationRow[]) || [];
  } catch (err) {
    console.error('Failed to fetch reservations from Supabase:', err);
    return [];
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

export interface PublicBookingResult {
  success: boolean;
  data?: any;
  error?: string;
  isConflict?: boolean;
  isRateLimited?: boolean;
  isCaptchaRequired?: boolean;
  isNetworkError?: boolean;
  retryAfter?: number;
  idempotentReplayed?: boolean;
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

  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const result = await response.json().catch(() => null);

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
      };
    }

    return {
      success: true,
      data: result?.data,
      idempotentReplayed: Boolean(result?.idempotent_replayed),
    };
  } catch (err: any) {
    return {
      success: false,
      isNetworkError: true,
      error: err?.message || 'Network error connecting to booking service.',
    };
  }
}



