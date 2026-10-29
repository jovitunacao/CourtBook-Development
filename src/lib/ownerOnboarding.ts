/**
 * CourtBook / BookSuite — Phase 3, Stage 3.3: Owner Onboarding Database Service Helpers
 *
 * Provides typed, secure, and validated Supabase client helpers for creating an owner's
 * organization, primary facility, and initial courts.
 *
 * Enforces all BookSuite database schema constraints and RLS security:
 * - Organization creation via secure public.create_organization_with_owner RPC
 * - Facility creation strictly adhering to RLS owners_can_insert_facilities policy
 * - Court creation strictly adhering to RLS staff_can_manage_facility_courts policy
 * - Client-side validation mirroring database checks
 * - In-flight de-duplication locks to prevent duplicate submissions
 * - Recovery detection to resume incomplete setups without re-creating organizations
 */

import {
  supabase,
  isValidUuid,
  SupabaseOrganization,
  SupabaseFacility,
  SupabaseCourt,
  fetchStaffMembershipLookup,
} from './supabaseClient';
import { slugify, isValidSlug, validateSlug } from '../utils/slugify';

// ==============================================================================
// Types & Interfaces
// ==============================================================================

export interface CreateOrgResult {
  success: boolean;
  organizationId?: string;
  error?: string;
  isDuplicateSlug?: boolean;
  isValidationError?: boolean;
  isAuthError?: boolean;
  isDuplicateSubmission?: boolean;
}

export interface CreateFacilityInput {
  name: string;
  slug: string;
  tagline?: string | null;
  address?: string | null;
  timezone?: string; // Default: 'Asia/Manila'
  currency?: string; // Default: '₱'
  open_hour?: number; // 0 to 23, Default: 8
  close_hour?: number; // 1 to 24 (must be > open_hour), Default: 22
  default_hourly_rate?: number; // Positive number, Default: 350.00
  booking_confirmation_mode?: 'instant' | 'manual_approval'; // Default: 'instant'
  hold_duration_minutes?: number; // 5 to 1440, Default: 30
}

export interface CreateFacilityResult {
  success: boolean;
  facility?: SupabaseFacility;
  error?: string;
  isDuplicateSlug?: boolean;
  isValidationError?: boolean;
  isPermissionDenied?: boolean;
  isAuthError?: boolean;
  isDuplicateSubmission?: boolean;
}

export interface CreateCourtItemInput {
  name: string;
  sport_type?: string; // 2 to 50 chars, Default: 'Pickleball'
  tag?: string | null; // Max 50 chars
  surface_type?: string | null; // Max 100 chars
  description?: string | null; // Max 600 chars
  hourly_rate?: number; // Positive number, Default: facility default
  is_enabled?: boolean; // Default: true
  display_order?: number; // Default: index
}

export interface CreateCourtsResult {
  success: boolean;
  courts?: SupabaseCourt[];
  error?: string;
  isDuplicateCourtName?: boolean;
  isValidationError?: boolean;
  isPermissionDenied?: boolean;
  isAuthError?: boolean;
  isDuplicateSubmission?: boolean;
}

export type OnboardingStepStatus =
  | 'needs_organization'
  | 'needs_facility'
  | 'needs_courts'
  | 'complete'
  | 'error';

export interface OwnerOnboardingRecoveryState {
  status: OnboardingStepStatus;
  organization?: SupabaseOrganization;
  facility?: SupabaseFacility;
  courts?: SupabaseCourt[];
  error?: string;
}

// In-flight operation locks to prevent duplicate submissions
const inFlightLocks = new Set<string>();

function acquireLock(key: string): boolean {
  if (inFlightLocks.has(key)) return false;
  inFlightLocks.add(key);
  return true;
}

function releaseLock(key: string): void {
  inFlightLocks.delete(key);
}

// ==============================================================================
// Validation Helpers (Mirroring Database Schema Constraints)
// ==============================================================================

/**
 * Validates organization parameters matching public.create_organization_with_owner constraints:
 * - name: 2 to 120 characters
 * - slug: valid slug matching ^[a-z0-9]+(-[a-z0-9]+)*$, 2 to 60 characters
 * - billingEmail: optional, valid email format up to 255 characters
 */
export function validateOrganizationInput(
  name: string,
  slug: string,
  billingEmail?: string | null
): { isValid: boolean; error?: string } {
  const cleanName = (name || '').trim();
  if (cleanName.length < 2 || cleanName.length > 120) {
    return {
      isValid: false,
      error: 'Organization name must be between 2 and 120 characters.',
    };
  }

  const slugValidation = validateSlug(slug, 'Organization slug');
  if (!slugValidation.isValid) {
    return slugValidation;
  }

  if (billingEmail && billingEmail.trim().length > 0) {
    const cleanEmail = billingEmail.trim();
    if (cleanEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return {
        isValid: false,
        error: 'Please provide a valid billing email address.',
      };
    }
  }

  return { isValid: true };
}

/**
 * Validates facility parameters matching public.facilities table constraints:
 * - name: 2 to 120 characters
 * - slug: valid slug, 2 to 60 characters
 * - open_hour: 0 to 23
 * - close_hour: 1 to 24 and > open_hour
 * - default_hourly_rate: > 0
 * - booking_confirmation_mode: 'instant' | 'manual_approval'
 * - hold_duration_minutes: 5 to 1440
 * - currency: length 1 to 5 chars
 * - tagline: max 250 chars
 * - address: max 300 chars
 */
export function validateFacilityInput(
  organizationId: string,
  input: CreateFacilityInput
): { isValid: boolean; error?: string } {
  if (!isValidUuid(organizationId)) {
    return { isValid: false, error: 'A valid organization ID (UUID) is required.' };
  }

  const cleanName = (input.name || '').trim();
  if (cleanName.length < 2 || cleanName.length > 120) {
    return {
      isValid: false,
      error: 'Facility name must be between 2 and 120 characters.',
    };
  }

  const slugValidation = validateSlug(input.slug, 'Facility slug');
  if (!slugValidation.isValid) {
    return slugValidation;
  }

  const openHour = input.open_hour ?? 8;
  if (!Number.isInteger(openHour) || openHour < 0 || openHour > 23) {
    return {
      isValid: false,
      error: 'Opening hour must be an integer between 0 (midnight) and 23 (11 PM).',
    };
  }

  const closeHour = input.close_hour ?? 22;
  if (!Number.isInteger(closeHour) || closeHour < 1 || closeHour > 24) {
    return {
      isValid: false,
      error: 'Closing hour must be an integer between 1 and 24.',
    };
  }

  if (closeHour <= openHour) {
    return {
      isValid: false,
      error: 'Closing hour must be strictly later than opening hour.',
    };
  }

  const rate = input.default_hourly_rate ?? 350;
  if (typeof rate !== 'number' || isNaN(rate) || rate <= 0) {
    return {
      isValid: false,
      error: 'Default hourly rate must be a positive number greater than 0.',
    };
  }

  const mode = input.booking_confirmation_mode ?? 'instant';
  if (mode !== 'instant' && mode !== 'manual_approval') {
    return {
      isValid: false,
      error: "Booking confirmation mode must be either 'instant' or 'manual_approval'.",
    };
  }

  const holdMins = input.hold_duration_minutes ?? 30;
  if (!Number.isInteger(holdMins) || holdMins < 5 || holdMins > 1440) {
    return {
      isValid: false,
      error: 'Hold duration must be an integer between 5 and 1440 minutes (24 hours).',
    };
  }

  if (input.tagline && input.tagline.trim().length > 250) {
    return { isValid: false, error: 'Tagline cannot exceed 250 characters.' };
  }

  if (input.address && input.address.trim().length > 300) {
    return { isValid: false, error: 'Address cannot exceed 300 characters.' };
  }

  return { isValid: true };
}

/**
 * Validates courts array parameters matching public.courts table constraints:
 * - At least one court is required
 * - Court names: 1 to 80 characters, unique per facility
 * - sport_type: 2 to 50 characters
 * - hourly_rate: positive number > 0
 * - surface_type: max 100 chars
 * - description: max 600 chars
 * - tag: max 50 chars
 */
export function validateCourtsInput(
  facilityId: string,
  courts: CreateCourtItemInput[]
): { isValid: boolean; error?: string } {
  if (!isValidUuid(facilityId)) {
    return { isValid: false, error: 'A valid facility ID (UUID) is required.' };
  }

  if (!Array.isArray(courts) || courts.length === 0) {
    return { isValid: false, error: 'At least one court is required to complete facility setup.' };
  }

  const nameSet = new Set<string>();

  for (let i = 0; i < courts.length; i++) {
    const c = courts[i];
    const cleanName = (c.name || '').trim();

    if (cleanName.length < 1 || cleanName.length > 80) {
      return {
        isValid: false,
        error: `Court #${i + 1} name must be between 1 and 80 characters.`,
      };
    }

    const lowerName = cleanName.toLowerCase();
    if (nameSet.has(lowerName)) {
      return {
        isValid: false,
        error: `Duplicate court name "${cleanName}" found in the submission. Court names must be unique within a facility.`,
      };
    }
    nameSet.add(lowerName);

    const sportType = (c.sport_type || 'Pickleball').trim();
    if (sportType.length < 2 || sportType.length > 50) {
      return {
        isValid: false,
        error: `Court "${cleanName}" sport type must be between 2 and 50 characters.`,
      };
    }

    if (c.hourly_rate !== undefined) {
      if (typeof c.hourly_rate !== 'number' || isNaN(c.hourly_rate) || c.hourly_rate <= 0) {
        return {
          isValid: false,
          error: `Court "${cleanName}" hourly rate must be a positive number greater than 0.`,
        };
      }
    }

    if (c.tag && c.tag.trim().length > 50) {
      return {
        isValid: false,
        error: `Court "${cleanName}" tag cannot exceed 50 characters.`,
      };
    }

    if (c.surface_type && c.surface_type.trim().length > 100) {
      return {
        isValid: false,
        error: `Court "${cleanName}" surface type cannot exceed 100 characters.`,
      };
    }

    if (c.description && c.description.trim().length > 600) {
      return {
        isValid: false,
        error: `Court "${cleanName}" description cannot exceed 600 characters.`,
      };
    }
  }

  return { isValid: true };
}

// ==============================================================================
// Service Helpers
// ==============================================================================

/**
 * Creates an organization and assigns the caller as initial owner via the secure
 * public.create_organization_with_owner RPC.
 *
 * Security & Constraints:
 * - Requires authenticated session (auth.uid() checked inside the SECURITY DEFINER RPC).
 * - Enforces unique organization slug constraint.
 * - Prevents duplicate concurrent in-flight submissions with identical slugs.
 */
export async function createOrganizationWithOwnerViaRpc(
  name: string,
  slug: string,
  billingEmail?: string | null
): Promise<CreateOrgResult> {
  if (!supabase) {
    return { success: false, error: 'Supabase client is not initialized.' };
  }

  const cleanName = (name || '').trim();
  const cleanSlug = slugify(slug);
  const cleanEmail = billingEmail && billingEmail.trim().length > 0 ? billingEmail.trim() : null;

  // 1. Client-side validation mirroring database constraints
  const validation = validateOrganizationInput(cleanName, cleanSlug, cleanEmail);
  if (!validation.isValid) {
    return {
      success: false,
      isValidationError: true,
      error: validation.error,
    };
  }

  // 2. Authentication check
  const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
  if (sessionErr || !sessionData?.session?.user) {
    return {
      success: false,
      isAuthError: true,
      error: 'Authentication required: You must be signed in to create an organization.',
    };
  }

  // 3. De-duplication lock to prevent duplicate submissions
  const lockKey = `create-org:${cleanSlug}`;
  if (!acquireLock(lockKey)) {
    return {
      success: false,
      isDuplicateSubmission: true,
      error: 'An organization creation request for this slug is already in progress.',
    };
  }

  try {
    const { data, error } = await supabase.rpc('create_organization_with_owner', {
      p_name: cleanName,
      p_slug: cleanSlug,
      p_billing_email: cleanEmail,
      p_is_demo: false,
    });

    if (error) {
      const errorMsg = error.message || '';
      const isDuplicate =
        error.code === '23505' ||
        errorMsg.toLowerCase().includes('already exists') ||
        errorMsg.toLowerCase().includes('duplicate key') ||
        errorMsg.toLowerCase().includes('slug');

      return {
        success: false,
        isDuplicateSlug: isDuplicate,
        error: isDuplicate
          ? `An organization with slug "${cleanSlug}" already exists. Please choose a different slug.`
          : errorMsg,
      };
    }

    if (!data || typeof data !== 'string') {
      return {
        success: false,
        error: 'Failed to create organization: No organization ID was returned by the database.',
      };
    }

    return {
      success: true,
      organizationId: data,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Unexpected network error during organization creation.',
    };
  } finally {
    releaseLock(lockKey);
  }
}

/**
 * Creates a facility for the specified organization.
 *
 * Security & Constraints:
 * - Authorized strictly via Supabase RLS policy `owners_can_insert_facilities`
 *   (public.is_org_member(organization_id, ARRAY['owner'])).
 * - Enforces unique facility slug constraint across the platform.
 * - Adheres strictly to timezone ('Asia/Manila'), currency ('₱'), and app_type ('courtbook').
 */
export async function createFacilityForOwner(
  organizationId: string,
  facilityInput: CreateFacilityInput
): Promise<CreateFacilityResult> {
  if (!supabase) {
    return { success: false, error: 'Supabase client is not initialized.' };
  }

  const cleanSlug = slugify(facilityInput.slug);
  const normalizedInput: CreateFacilityInput = {
    ...facilityInput,
    name: (facilityInput.name || '').trim(),
    slug: cleanSlug,
    tagline: facilityInput.tagline?.trim() || null,
    address: facilityInput.address?.trim() || null,
    timezone: facilityInput.timezone || 'Asia/Manila',
    currency: facilityInput.currency || '₱',
    open_hour: facilityInput.open_hour ?? 8,
    close_hour: facilityInput.close_hour ?? 22,
    default_hourly_rate: facilityInput.default_hourly_rate ?? 350,
    booking_confirmation_mode: facilityInput.booking_confirmation_mode || 'instant',
    hold_duration_minutes: facilityInput.hold_duration_minutes ?? 30,
  };

  // 1. Client-side validation mirroring database constraints
  const validation = validateFacilityInput(organizationId, normalizedInput);
  if (!validation.isValid) {
    return {
      success: false,
      isValidationError: true,
      error: validation.error,
    };
  }

  // 2. Authentication check
  const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
  if (sessionErr || !sessionData?.session?.user) {
    return {
      success: false,
      isAuthError: true,
      error: 'Authentication required: You must be signed in to create a facility.',
    };
  }

  // 3. De-duplication lock to prevent duplicate submissions
  const lockKey = `create-facility:${organizationId}:${cleanSlug}`;
  if (!acquireLock(lockKey)) {
    return {
      success: false,
      isDuplicateSubmission: true,
      error: 'A facility creation request for this slug is already in progress.',
    };
  }

  try {
    const { data, error } = await supabase
      .from('facilities')
      .insert({
        organization_id: organizationId,
        app_type: 'courtbook',
        name: normalizedInput.name,
        slug: cleanSlug,
        tagline: normalizedInput.tagline,
        address: normalizedInput.address,
        timezone: normalizedInput.timezone,
        currency: normalizedInput.currency,
        open_hour: normalizedInput.open_hour,
        close_hour: normalizedInput.close_hour,
        default_hourly_rate: normalizedInput.default_hourly_rate,
        booking_confirmation_mode: normalizedInput.booking_confirmation_mode,
        hold_duration_minutes: normalizedInput.hold_duration_minutes,
        is_active: true,
        is_demo: false,
      })
      .select('*')
      .single();

    if (error) {
      const errorMsg = error.message || '';
      const isDuplicate =
        error.code === '23505' ||
        errorMsg.includes('facilities_slug_key') ||
        errorMsg.toLowerCase().includes('already exists');
      const isPermissionDenied =
        error.code === '42501' ||
        errorMsg.toLowerCase().includes('row-level security') ||
        errorMsg.toLowerCase().includes('permission denied');

      return {
        success: false,
        isDuplicateSlug: isDuplicate,
        isPermissionDenied,
        error: isDuplicate
          ? `A facility with slug "${cleanSlug}" already exists. Please choose a different slug.`
          : isPermissionDenied
            ? 'Permission denied: You must be an organization owner to create a facility.'
            : errorMsg,
      };
    }

    return {
      success: true,
      facility: data as SupabaseFacility,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Unexpected network error during facility creation.',
    };
  } finally {
    releaseLock(lockKey);
  }
}

/**
 * Creates initial courts under a facility the owner is authorized to manage.
 *
 * Security & Constraints:
 * - Authorized strictly via Supabase RLS policy `staff_can_manage_facility_courts`
 *   (public.is_facility_staff(facility_id, ARRAY['owner', 'admin'])).
 * - Enforces unique court name per facility (uq_court_name_per_facility constraint).
 * - Enforces positive hourly rates (> 0).
 */
export async function createCourtsForFacility(
  facilityId: string,
  courtsInput: CreateCourtItemInput[]
): Promise<CreateCourtsResult> {
  if (!supabase) {
    return { success: false, error: 'Supabase client is not initialized.' };
  }

  // 1. Client-side validation mirroring database constraints
  const validation = validateCourtsInput(facilityId, courtsInput);
  if (!validation.isValid) {
    return {
      success: false,
      isValidationError: true,
      error: validation.error,
    };
  }

  // 2. Authentication check
  const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
  if (sessionErr || !sessionData?.session?.user) {
    return {
      success: false,
      isAuthError: true,
      error: 'Authentication required: You must be signed in to configure courts.',
    };
  }

  // 3. De-duplication lock to prevent duplicate submissions
  const lockKey = `create-courts:${facilityId}`;
  if (!acquireLock(lockKey)) {
    return {
      success: false,
      isDuplicateSubmission: true,
      error: 'A court creation request for this facility is already in progress.',
    };
  }

  try {
    const courtRows = courtsInput.map((c, index) => ({
      facility_id: facilityId,
      name: c.name.trim(),
      sport_type: (c.sport_type || 'Pickleball').trim(),
      tag: c.tag?.trim() || null,
      surface_type: c.surface_type?.trim() || null,
      description: c.description?.trim() || null,
      hourly_rate: c.hourly_rate ?? 350.0,
      is_enabled: c.is_enabled !== false,
      display_order: c.display_order ?? index,
    }));

    const { data, error } = await supabase
      .from('courts')
      .insert(courtRows)
      .select('*')
      .order('display_order', { ascending: true });

    if (error) {
      const errorMsg = error.message || '';
      const isDuplicateName =
        error.code === '23505' ||
        errorMsg.includes('uq_court_name_per_facility') ||
        errorMsg.toLowerCase().includes('already exists');
      const isPermissionDenied =
        error.code === '42501' ||
        errorMsg.toLowerCase().includes('row-level security') ||
        errorMsg.toLowerCase().includes('permission denied');

      return {
        success: false,
        isDuplicateCourtName: isDuplicateName,
        isPermissionDenied,
        error: isDuplicateName
          ? 'One or more court names already exist in this facility. Court names must be unique.'
          : isPermissionDenied
            ? 'Permission denied: You must be an authorized facility administrator to create courts.'
            : errorMsg,
      };
    }

    return {
      success: true,
      courts: (data as SupabaseCourt[]) || [],
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Unexpected network error during court creation.',
    };
  } finally {
    releaseLock(lockKey);
  }
}

/**
 * Recovery Helper for Incomplete Onboarding Setups.
 *
 * Inspects the authenticated user's organization, facility, and court configuration in Supabase.
 * Determines the exact resume stage to support safe recovery without creating duplicate organizations:
 * - 'needs_organization': User has no organizations yet. Safe to start Stage 1 (Org creation).
 * - 'needs_facility': Organization exists, but has 0 facilities. Safe to resume at Stage 2 with existing organizationId.
 * - 'needs_courts': Organization & Facility exist, but facility has 0 courts. Safe to resume at Stage 3 with existing facilityId.
 * - 'complete': All assets exist and workspace is ready.
 * - 'error': Query failure (preserves user state, does not assume 0 organizations).
 */
export async function getOwnerOnboardingRecoveryState(
  userId?: string
): Promise<OwnerOnboardingRecoveryState> {
  if (!supabase) {
    return {
      status: 'error',
      error: 'Supabase client is not initialized.',
    };
  }

  let effectiveUserId = userId;
  if (!effectiveUserId) {
    const { data: sessionData } = await supabase.auth.getSession();
    effectiveUserId = sessionData?.session?.user?.id;
  }

  if (!effectiveUserId) {
    return {
      status: 'error',
      error: 'Authentication required to inspect onboarding recovery status.',
    };
  }

  const lookup = await fetchStaffMembershipLookup(effectiveUserId);

  if (lookup.error) {
    return {
      status: 'error',
      error: `Could not check onboarding recovery state: ${lookup.error}`,
    };
  }

  // 1. User has no organizations at all
  if (!lookup.hasMemberships || !lookup.data || lookup.data.userOrganizations.length === 0) {
    return {
      status: 'needs_organization',
    };
  }

  const activeOrg = lookup.data.activeOrganization || lookup.data.userOrganizations[0]?.organization;
  const activeFac = lookup.data.activeFacility || lookup.data.availableFacilities[0] || null;

  // 2. Organization exists, but 0 facilities
  if (!activeFac) {
    return {
      status: 'needs_facility',
      organization: activeOrg || undefined,
    };
  }

  // 3. Organization & Facility exist, check courts count
  const courts = lookup.data.courts || [];
  if (courts.length === 0) {
    return {
      status: 'needs_courts',
      organization: activeOrg || undefined,
      facility: activeFac,
      courts: [],
    };
  }

  // 4. Complete
  return {
    status: 'complete',
    organization: activeOrg || undefined,
    facility: activeFac,
    courts,
  };
}
