import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { User, Session } from '@supabase/supabase-js';
import {
  supabase,
  isSupabaseConfigured,
  fetchStaffMembershipLookup,
  fetchAuthenticatedStaffData,
  fetchFacilityReservations,
  cancelReservationViaRpc,
  approveBookingRequestViaRpc,
  declineBookingRequestViaRpc,
  updateFacilityConfirmationSettingsViaRpc,
  fetchPublicFacilitiesWithStatus,
  fetchPublicCourts,
  StaffMembershipData,
  StaffLookupResult,
  SupabaseFacility,
  SupabaseCourt,
  SupabaseReservationRow,
  FacilityReservationsResult,
} from '../lib/supabaseClient';
import { FacilitySettings, Reservation } from '../types/booking';

export type OnboardingState = 'loading' | 'needs_onboarding' | 'ready' | 'error';

export interface DemoAccountProfile {
  email: string;
  role: 'owner' | 'admin' | 'staff';
  orgName: string;
  orgSlug: string;
  facilityName: string;
  facilitySlug: string;
  hourlyRate: number;
  sportType: string;
}

export const FICTIONAL_ACCOUNTS: Record<'user_a' | 'user_b', DemoAccountProfile> = {
  user_a: {
    email: 'user_a_pickleball@booksuite.demo',
    role: 'owner',
    orgName: 'Demo Pickleball Center',
    orgSlug: 'courtbook-test-pickleball-a',
    facilityName: 'Demo Pickleball Center',
    facilitySlug: 'courtbook-pickleball-test',
    hourlyRate: 350,
    sportType: 'Pickleball',
  },
  user_b: {
    email: 'user_b_badminton@booksuite.demo',
    role: 'owner',
    orgName: 'Demo Badminton Center',
    orgSlug: 'courtbook-test-badminton-b',
    facilityName: 'Demo Badminton Center',
    facilitySlug: 'courtbook-badminton-test',
    hourlyRate: 250,
    sportType: 'Badminton',
  },
};

interface SupabaseAuthContextType {
  isConfigured: boolean;
  isLoading: boolean;
  onboardingState: OnboardingState;
  membershipLookupError: string | null;
  user: User | null;
  session: Session | null;
  staffData: StaffMembershipData | null;
  isDemoSession: boolean;
  demoProfile: DemoAccountProfile | null;
  supabaseReservations: Reservation[];
  isUsingSupabaseData: boolean;
  authError: string | null;
  signIn: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signUp: (
    email: string,
    password: string
  ) => Promise<{
    success: boolean;
    sessionCreated: boolean;
    needsEmailVerification?: boolean;
    error?: string;
  }>;
  signOut: () => Promise<void>;
  simulateDemoSignIn: (account: 'user_a' | 'user_b') => void;
  clearAuthError: () => void;
  refreshStaffData: () => Promise<void>;
  switchOrganization: (orgId: string) => Promise<void>;
  switchFacility: (facilityId: string) => Promise<void>;
  cancelStaffReservation: (id: string, reason?: string) => Promise<{ success: boolean; error?: string }>;
  approveStaffReservation: (id: string, notes?: string) => Promise<{ success: boolean; error?: string }>;
  declineStaffReservation: (id: string, reason?: string) => Promise<{ success: boolean; error?: string }>;
  updateConfirmationSettings: (mode: 'instant' | 'manual_approval', holdMinutes?: number) => Promise<{ success: boolean; error?: string }>;
  mappedFacilitySettings: FacilitySettings | null;
  publicFacilitySettings: FacilitySettings | null;
  publicFacilities: SupabaseFacility[];
  publicFacilitiesLoading: boolean;
  publicFacilitiesError: string | null;
  refreshPublicFacilities: () => Promise<void>;
  publicCourts: SupabaseCourt[];
  directoryCourts: SupabaseCourt[];
  publicCourtsLoading: boolean;
  activePublicFacility: SupabaseFacility | null;
  setActivePublicFacilityId: (facilityId: string) => Promise<void>;
}

const SupabaseAuthContext = createContext<SupabaseAuthContextType | undefined>(undefined);

function mapSupabaseRowsToReservations(
  rows: SupabaseReservationRow[],
  courts: SupabaseCourt[]
): Reservation[] {
  return rows.map((r) => {
    const court = courts.find((c) => c.id === r.court_id);
    return {
      id: r.id,
      referenceCode: r.reference_code,
      courtId: r.court_id,
      courtName: court ? court.name : 'Court',
      date: r.booking_date,
      timeSlotId: `${r.start_time}`,
      timeSlotLabel: r.time_slot_label || 'Reserved Slot',
      customerName: r.customer_name,
      customerPhone: r.customer_phone || undefined,
      customerEmail: r.customer_email || undefined,
      price: Number(r.price),
      status: r.status,
      holdExpiresAt: r.hold_expires_at,
      reviewedAt: r.reviewed_at,
      reviewedBy: r.reviewed_by,
      reviewNotes: r.review_notes,
      createdAt: r.created_at,
    };
  });
}

function mapFacilityToSettings(
  facility: SupabaseFacility,
  courts: SupabaseCourt[]
): FacilitySettings {
  return {
    id: facility.id,
    slug: facility.slug,
    name: facility.name,
    tagline: facility.tagline || 'Professional Court Reservations',
    address: facility.address || 'Facility Grounds',
    currency: facility.currency || '₱',
    timezone: facility.timezone || 'Asia/Manila',
    bookingConfirmationMode: facility.booking_confirmation_mode || 'instant',
    holdDurationMinutes: facility.hold_duration_minutes || 30,
    openHour: facility.open_hour || 8,
    closeHour: facility.close_hour || 22,
    defaultHourlyRate: facility.default_hourly_rate || 350,
    courts: courts.map((c) => ({
      id: c.id,
      facilityId: c.facility_id || facility.id,
      name: c.name,
      sportType: c.sport_type,
      tag: c.tag || 'Standard Court',
      type: c.surface_type || 'Professional Surface',
      description: c.description || 'Regulation sports court.',
      hourlyRate: Number(c.hourly_rate),
      isEnabled: c.is_enabled,
    })),
  };
}

export const SupabaseAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [onboardingState, setOnboardingState] = useState<OnboardingState>('ready');
  const [membershipLookupError, setMembershipLookupError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [staffData, setStaffData] = useState<StaffMembershipData | null>(null);
  const [isDemoSession, setIsDemoSession] = useState<boolean>(false);
  const [demoProfile, setDemoProfile] = useState<DemoAccountProfile | null>(null);
  const [supabaseReservations, setSupabaseReservations] = useState<Reservation[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);

  // Public facilities for customers (never auto-selects first facility)
  const PUBLIC_FACILITY_STORAGE_KEY = 'courtbook_selected_public_facility_id';
  const [publicFacilities, setPublicFacilities] = useState<SupabaseFacility[]>([]);
  const [publicFacilitiesLoading, setPublicFacilitiesLoading] = useState<boolean>(isSupabaseConfigured);
  const [publicFacilitiesError, setPublicFacilitiesError] = useState<string | null>(null);
  const [publicCourts, setPublicCourts] = useState<SupabaseCourt[]>([]);
  const [directoryCourts, setDirectoryCourts] = useState<SupabaseCourt[]>([]);
  const [publicCourtsLoading, setPublicCourtsLoading] = useState<boolean>(false);
  const [activePublicFacilityId, setActivePublicFacilityId] = useState<string>('');
  const publicFacilityRequestRef = React.useRef<number>(0);

  const loadPublicData = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setPublicFacilitiesLoading(false);
      setPublicFacilitiesError(null);
      return;
    }

    setPublicFacilitiesLoading(true);
    setPublicFacilitiesError(null);
    try {
      const [facRes, allCourts] = await Promise.all([
        fetchPublicFacilitiesWithStatus(),
        fetchPublicCourts(),
      ]);

      if (facRes.error) {
        setPublicFacilities([]);
        setDirectoryCourts([]);
        setPublicFacilitiesError(facRes.error);
        setPublicFacilitiesLoading(false);
        return;
      }

      const facs = facRes.data;
      setPublicFacilities(facs);
      setDirectoryCourts(allCourts);

      // Restore previously selected venue from sessionStorage if still active
      let savedId = '';
      try {
        savedId = sessionStorage.getItem(PUBLIC_FACILITY_STORAGE_KEY) || '';
      } catch {}

      if (savedId && facs.some((f) => f.id === savedId)) {
        const reqId = ++publicFacilityRequestRef.current;
        setActivePublicFacilityId(savedId);
        setPublicCourtsLoading(true);
        const courts = await fetchPublicCourts(savedId);
        if (publicFacilityRequestRef.current === reqId) {
          setPublicCourts(courts);
          setPublicCourtsLoading(false);
        }
      } else {
        if (savedId) {
          try {
            sessionStorage.removeItem(PUBLIC_FACILITY_STORAGE_KEY);
          } catch {}
        }
        setActivePublicFacilityId('');
        setPublicCourts([]);
      }
    } catch (err: any) {
      console.warn('Could not load public facilities:', err);
      setPublicFacilities([]);
      setPublicFacilitiesError(err?.message || 'Failed to load public venues.');
    } finally {
      setPublicFacilitiesLoading(false);
    }
  }, []);

  // Load public facilities & directory courts on mount
  useEffect(() => {
    loadPublicData();
  }, [loadPublicData]);

  // When public facility changes, immediately clear stale courts and load only the selected facility's courts
  const handleSelectPublicFacility = useCallback(async (facilityId: string) => {
    const reqId = ++publicFacilityRequestRef.current;

    if (!facilityId) {
      setActivePublicFacilityId('');
      setPublicCourts([]);
      setPublicCourtsLoading(false);
      try {
        sessionStorage.removeItem(PUBLIC_FACILITY_STORAGE_KEY);
      } catch {}
      return;
    }

    setActivePublicFacilityId(facilityId);
    setPublicCourts([]);
    try {
      sessionStorage.setItem(PUBLIC_FACILITY_STORAGE_KEY, facilityId);
    } catch {}

    if (isSupabaseConfigured && supabase) {
      setPublicCourtsLoading(true);
      try {
        const courts = await fetchPublicCourts(facilityId);
        if (publicFacilityRequestRef.current === reqId) {
          setPublicCourts(courts);
        }
      } finally {
        if (publicFacilityRequestRef.current === reqId) {
          setPublicCourtsLoading(false);
        }
      }
    }
  }, []);

  // Load real Supabase staff data for an authenticated user
  // Strictly complies with Requirement 7:
  // Determine needs_onboarding ONLY after successful authenticated membership lookup confirms the user has no organization membership (0 rows).
  // Never infer it solely from staffData === null (if query fails/errors, state must be 'error').
  const loadStaffDataForUser = useCallback(
    async (userId: string, preferredOrgId?: string, preferredFacilityId?: string) => {
      setOnboardingState('loading');
      setMembershipLookupError(null);
      try {
        const lookup = await fetchStaffMembershipLookup(userId, preferredOrgId, preferredFacilityId);

        if (lookup.error) {
          console.error('Membership lookup failed for user:', userId, lookup.error);
          setStaffData(null);
          setSupabaseReservations([]);
          setMembershipLookupError(lookup.error);
          setOnboardingState('error');
          return;
        }

        if (!lookup.hasMemberships || !lookup.data) {
          // Query succeeded with 0 memberships -> strictly confirmed needs_onboarding
          setStaffData(null);
          setSupabaseReservations([]);
          setMembershipLookupError(null);
          setOnboardingState('needs_onboarding');
          return;
        }

        // Requirement 7: Treat an organization with no facility or a facility with no courts as an incomplete
        // onboarding state (needs_onboarding), not an authentication failure or database error.
        if (!lookup.data.activeFacility || lookup.data.courts.length === 0) {
          setStaffData(lookup.data);
          setSupabaseReservations([]);
          setMembershipLookupError(null);
          setOnboardingState('needs_onboarding');
          return;
        }

        // Query reservations for active facility BEFORE declaring workspace ready
        const resResult = await fetchFacilityReservations(lookup.data.activeFacility.id);

        if (resResult.error) {
          console.error('Failed to load reservations for active facility:', resResult.error);
          setStaffData(lookup.data);
          setSupabaseReservations([]);
          setMembershipLookupError(
            `Failed to load facility reservations: ${resResult.error}`
          );
          setOnboardingState('error');
          return;
        }

        // All required workspace data (organization, facility, courts, and reservations query)
        // successfully loaded without error -> set workspace ready!
        // Legitimate organizations with zero reservations (resResult.data is []) are preserved as valid, ready workspaces.
        setStaffData(lookup.data);
        setSupabaseReservations(mapSupabaseRowsToReservations(resResult.data, lookup.data.courts));
        setMembershipLookupError(null);
        setOnboardingState('ready');
      } catch (err: any) {
        console.error('Failed to load staff data:', err);
        setStaffData(null);
        setSupabaseReservations([]);
        setMembershipLookupError(err?.message || 'Failed to verify organization membership');
        setOnboardingState('error');
      }
    },
    []
  );

  // Initialize and restore session from Supabase on mount
  useEffect(() => {
    let isMounted = true;

    async function initAuth() {
      if (!isSupabaseConfigured || !supabase) {
        if (isMounted) setIsLoading(false);
        return;
      }

      try {
        const { data: sessionData, error } = await supabase.auth.getSession();
        if (error) {
          console.warn('Error reading stored session:', error);
          if (isMounted) setOnboardingState('ready');
        } else if (sessionData?.session) {
          if (isMounted) {
            setSession(sessionData.session);
            setUser(sessionData.session.user);
            await loadStaffDataForUser(sessionData.session.user.id);
          }
        } else {
          if (isMounted) setOnboardingState('ready');
        }
      } catch (err) {
        console.error('Auth initialization error:', err);
        if (isMounted) setOnboardingState('ready');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    initAuth();

    // Listen for auth state changes
    if (supabase) {
      const { data: authListener } = supabase.auth.onAuthStateChange(
        async (_event, newSession) => {
          if (!isMounted) return;
          setSession(newSession);
          setUser(newSession?.user || null);

          if (newSession?.user) {
            setIsDemoSession(false);
            setDemoProfile(null);
            await loadStaffDataForUser(newSession.user.id);
          } else {
            setStaffData(null);
            setSupabaseReservations([]);
            setOnboardingState('ready');
            setMembershipLookupError(null);
          }
        }
      );

      return () => {
        isMounted = false;
        authListener?.subscription.unsubscribe();
      };
    } else {
      return () => {
        isMounted = false;
      };
    }
  }, [loadStaffDataForUser]);

  // Real Supabase sign in - strictly uses credentials provided by user
  const signIn = async (
    email: string,
    password: string
  ): Promise<{ success: boolean; error?: string }> => {
    setAuthError(null);
    if (!isSupabaseConfigured || !supabase) {
      const err =
        'Supabase credentials (VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY) are not configured. Sign-in operates in local demo mode.';
      setAuthError(err);
      return { success: false, error: err };
    }

    setIsLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        setAuthError(error.message);
        return { success: false, error: error.message };
      }

      if (data.session && data.user) {
        setSession(data.session);
        setUser(data.user);
        setIsDemoSession(false);
        setDemoProfile(null);
        await loadStaffDataForUser(data.user.id);
      }

      return { success: true };
    } catch (err: any) {
      const msg = err.message || 'An unexpected error occurred during sign-in.';
      setAuthError(msg);
      return { success: false, error: msg };
    } finally {
      setIsLoading(false);
    }
  };

  // Real Supabase sign up for prospective court owners (Phase 3 Stage 3.2)
  const signUp = async (
    email: string,
    password: string
  ): Promise<{
    success: boolean;
    sessionCreated: boolean;
    needsEmailVerification?: boolean;
    error?: string;
  }> => {
    setAuthError(null);
    if (!isSupabaseConfigured || !supabase) {
      const err = 'Supabase credentials are not configured in this environment.';
      setAuthError(err);
      return { success: false, sessionCreated: false, error: err };
    }

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      const err = 'Please enter a valid email address.';
      setAuthError(err);
      return { success: false, sessionCreated: false, error: err };
    }

    if (!password || password.length < 8) {
      const err = 'Password must be at least 8 characters long.';
      setAuthError(err);
      return { success: false, sessionCreated: false, error: err };
    }

    setIsLoading(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email: cleanEmail,
        password,
      });

      const isDuplicateError = error && (
        error.message.toLowerCase().includes('already registered') ||
        error.message.toLowerCase().includes('already exists') ||
        error.message.toLowerCase().includes('user already has an account')
      );

      // Supabase GoTrue with user enumeration protection returns data.user with empty identities if already registered
      const identities = data?.user?.identities;
      const isDuplicateIdentity = identities && identities.length === 0;

      if (isDuplicateError || isDuplicateIdentity) {
        // Privacy-preserving: Do not disclose whether this email address is already registered.
        // Return a generic response indicating a confirmation message is sent if eligible.
        return {
          success: true,
          sessionCreated: false,
          needsEmailVerification: true,
        };
      }

      if (error) {
        setAuthError(error.message);
        return { success: false, sessionCreated: false, error: error.message };
      }

      if (data?.session && data.user) {
        // Active session created immediately (e.g., auto-confirm is enabled)
        setSession(data.session);
        setUser(data.user);
        setIsDemoSession(false);
        setDemoProfile(null);
        await loadStaffDataForUser(data.user.id);
        return { success: true, sessionCreated: true, needsEmailVerification: false };
      }

      // No active session: email confirmation required
      // Crucial: Do NOT start onboarding or set user session until confirmed session exists
      return { success: true, sessionCreated: false, needsEmailVerification: true };
    } catch (err: any) {
      const msg = err.message || 'An unexpected error occurred during owner registration.';
      setAuthError(msg);
      return { success: false, sessionCreated: false, error: msg };
    } finally {
      setIsLoading(false);
    }
  };

  // Sign out (handles both real and demo sessions)
  const signOut = async () => {
    setIsLoading(true);
    try {
      if (supabase && session) {
        await supabase.auth.signOut();
      }
    } catch (err) {
      console.warn('Error during Supabase sign-out:', err);
    } finally {
      setUser(null);
      setSession(null);
      setStaffData(null);
      setIsDemoSession(false);
      setDemoProfile(null);
      setSupabaseReservations([]);
      setAuthError(null);
      setOnboardingState('ready');
      setMembershipLookupError(null);
      setIsLoading(false);
    }
  };

  // Demo simulation mode when Supabase is not connected - local state ONLY
  const simulateDemoSignIn = (account: 'user_a' | 'user_b') => {
    const profile = FICTIONAL_ACCOUNTS[account];
    setIsDemoSession(true);
    setDemoProfile(profile);
    setUser(null);
    setSession(null);
    setStaffData(null);
    setAuthError(null);

    // Provide mock demo reservations for this fictional account
    const sampleDemoReservations: Reservation[] = [
      {
        id: `demo-${account}-1`,
        referenceCode: account === 'user_a' ? 'PKB-DEMO-01' : 'BDM-DEMO-01',
        courtId: account === 'user_a' ? 'court-a' : 'court-b',
        courtName: account === 'user_a' ? 'Court A' : 'Court B',
        date: new Date().toISOString().split('T')[0],
        timeSlotId: '10:00 AM - 11:00 AM',
        timeSlotLabel: '10:00 AM - 11:00 AM',
        customerName: account === 'user_a' ? 'Sofia Chen' : 'Liam Gallagher',
        customerPhone: '+63 917 555 0192',
        price: profile.hourlyRate,
        status: 'confirmed',
        createdAt: new Date().toISOString(),
      },
    ];
    setSupabaseReservations(sampleDemoReservations);
  };

  const clearAuthError = () => {
    setAuthError(null);
  };

  const refreshStaffData = async () => {
    if (user) {
      setIsLoading(true);
      await loadStaffDataForUser(
        user.id,
        staffData?.activeOrganization?.id,
        staffData?.activeFacility?.id
      );
      setIsLoading(false);
    }
  };

  // Support switching organization for multi-org staff members
  const switchOrganization = async (orgId: string) => {
    if (user) {
      setIsLoading(true);
      await loadStaffDataForUser(user.id, orgId);
      setIsLoading(false);
    }
  };

  // Support switching facility for multi-facility organizations
  const switchFacility = async (facilityId: string) => {
    if (user && staffData?.activeOrganization) {
      setIsLoading(true);
      await loadStaffDataForUser(user.id, staffData.activeOrganization.id, facilityId);
      setIsLoading(false);
    }
  };

  const cancelStaffReservation = async (
    id: string,
    reason: string = 'Staff cancellation'
  ): Promise<{ success: boolean; error?: string }> => {
    if (isDemoSession) {
      // In demo simulation mode, update local state only
      setSupabaseReservations((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: 'cancelled' } : r))
      );
      return { success: true };
    }

    if (!supabase || !staffData?.activeFacility) {
      return { success: false, error: 'Not authenticated with Supabase.' };
    }

    const res = await cancelReservationViaRpc(id, reason);
    if (res.success) {
      // Refresh reservations for the active facility
      const freshResult = await fetchFacilityReservations(staffData.activeFacility.id);
      if (!freshResult.error) {
        setSupabaseReservations(mapSupabaseRowsToReservations(freshResult.data, staffData.courts));
      }
    }
    return res;
  };

  const approveStaffReservation = async (
    id: string,
    notes?: string
  ): Promise<{ success: boolean; error?: string }> => {
    if (isDemoSession) {
      setSupabaseReservations((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: 'confirmed', reviewNotes: notes } : r))
      );
      return { success: true };
    }

    if (!supabase || !staffData?.activeFacility) {
      return { success: false, error: 'Not authenticated with Supabase.' };
    }

    const res = await approveBookingRequestViaRpc(id, notes);
    if (res.success) {
      const freshResult = await fetchFacilityReservations(staffData.activeFacility.id);
      if (!freshResult.error) {
        setSupabaseReservations(mapSupabaseRowsToReservations(freshResult.data, staffData.courts));
      }
    }
    return res;
  };

  const declineStaffReservation = async (
    id: string,
    reason?: string
  ): Promise<{ success: boolean; error?: string }> => {
    if (isDemoSession) {
      setSupabaseReservations((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: 'declined', reviewNotes: reason } : r))
      );
      return { success: true };
    }

    if (!supabase || !staffData?.activeFacility) {
      return { success: false, error: 'Not authenticated with Supabase.' };
    }

    const res = await declineBookingRequestViaRpc(id, reason);
    if (res.success) {
      const freshResult = await fetchFacilityReservations(staffData.activeFacility.id);
      if (!freshResult.error) {
        setSupabaseReservations(mapSupabaseRowsToReservations(freshResult.data, staffData.courts));
      }
    }
    return res;
  };

  const updateConfirmationSettings = async (
    mode: 'instant' | 'manual_approval',
    holdMinutes: number = 30
  ): Promise<{ success: boolean; error?: string }> => {
    if (isDemoSession) {
      return { success: true };
    }

    if (!supabase || !staffData?.activeFacility) {
      return { success: false, error: 'Not authenticated with Supabase.' };
    }

    const res = await updateFacilityConfirmationSettingsViaRpc(
      staffData.activeFacility.id,
      mode,
      holdMinutes
    );

    if (res.success) {
      await refreshStaffData();
    }
    return res;
  };

  const activePublicFacility =
    publicFacilities.find((f) => f.id === activePublicFacilityId) || null;

  // Filter public courts strictly for active public facility (never fall back to other facilities)
  const activePublicCourts = activePublicFacility
    ? publicCourts.filter((c) => c.facility_id === activePublicFacility.id)
    : [];

  const publicFacilitySettings: FacilitySettings | null = useMemo(() => {
    if (!activePublicFacility) return null;
    return mapFacilityToSettings(activePublicFacility, activePublicCourts);
  }, [activePublicFacility, activePublicCourts]);

  // Derive mapped facility settings if available:
  // 1. Staff authenticated active facility
  // 2. If authenticated without organization (needs_onboarding), do NOT fall back to Tenant A
  // 3. Live active public facility (from Supabase BookSuite database) for visitors
  // 4. Demo profile if in simulation
  const mappedFacilitySettings: FacilitySettings | null = useMemo(() => {
    if (staffData?.activeFacility) {
      return mapFacilityToSettings(staffData.activeFacility, staffData.courts);
    }
    // Requirement 10: Do not fall back to displaying Tenant A's administrative data for an authenticated user without an organization
    if (user && (onboardingState === 'needs_onboarding' || onboardingState === 'error')) {
      return null;
    }
    if (publicFacilitySettings) {
      return publicFacilitySettings;
    }
    if (demoProfile) {
      return {
        id: undefined,
        name: demoProfile.facilityName,
        tagline: `${demoProfile.sportType} Center & Court Management`,
        address: '100 Athletics Way, Sports Complex',
        currency: '₱',
        timezone: 'Asia/Manila',
        openHour: 8,
        closeHour: 22,
        defaultHourlyRate: demoProfile.hourlyRate,
        courts: [
          {
            id: demoProfile.sportType === 'Pickleball' ? 'court-a' : 'court-b',
            facilityId: undefined,
            name: demoProfile.sportType === 'Pickleball' ? 'Court A' : 'Court B',
            sportType: demoProfile.sportType,
            tag: 'Competition Court',
            type: 'Indoor Cushioned Pro Surface',
            description: `Regulation ${demoProfile.sportType} court at ₱${demoProfile.hourlyRate}/hr.`,
            hourlyRate: demoProfile.hourlyRate,
            isEnabled: true,
          },
        ],
      };
    }
    return null;
  }, [staffData, user, onboardingState, activePublicFacility, activePublicCourts, publicCourts, demoProfile]);

  const isUsingSupabaseData = Boolean(staffData?.activeFacility) || isDemoSession;

  return (
    <SupabaseAuthContext.Provider
      value={{
        isConfigured: isSupabaseConfigured,
        isLoading,
        onboardingState,
        membershipLookupError,
        user,
        session,
        staffData,
        isDemoSession,
        demoProfile,
        supabaseReservations,
        isUsingSupabaseData,
        authError,
        signIn,
        signUp,
        signOut,
        simulateDemoSignIn,
        clearAuthError,
        refreshStaffData,
        switchOrganization,
        switchFacility,
        cancelStaffReservation,
        approveStaffReservation,
        declineStaffReservation,
        updateConfirmationSettings,
        mappedFacilitySettings,
        publicFacilitySettings,
        publicFacilities,
        publicFacilitiesLoading,
        publicFacilitiesError,
        refreshPublicFacilities: loadPublicData,
        publicCourts: activePublicCourts,
        directoryCourts,
        publicCourtsLoading,
        activePublicFacility,
        setActivePublicFacilityId: handleSelectPublicFacility,
      }}
    >
      {children}
    </SupabaseAuthContext.Provider>
  );
};

export function useSupabaseAuth(): SupabaseAuthContextType {
  const context = useContext(SupabaseAuthContext);
  if (!context) {
    throw new Error('useSupabaseAuth must be used within a SupabaseAuthProvider');
  }
  return context;
}
