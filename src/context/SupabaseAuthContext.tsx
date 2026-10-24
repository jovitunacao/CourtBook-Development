import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { User, Session } from '@supabase/supabase-js';
import {
  supabase,
  isSupabaseConfigured,
  fetchAuthenticatedStaffData,
  fetchFacilityReservations,
  cancelReservationViaRpc,
  approveBookingRequestViaRpc,
  declineBookingRequestViaRpc,
  updateFacilityConfirmationSettingsViaRpc,
  fetchPublicFacilities,
  fetchPublicCourts,
  StaffMembershipData,
  SupabaseFacility,
  SupabaseCourt,
  SupabaseReservationRow,
} from '../lib/supabaseClient';
import { FacilitySettings, Reservation } from '../types/booking';

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
  user: User | null;
  session: Session | null;
  staffData: StaffMembershipData | null;
  isDemoSession: boolean;
  demoProfile: DemoAccountProfile | null;
  supabaseReservations: Reservation[];
  isUsingSupabaseData: boolean;
  authError: string | null;
  signIn: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
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
  publicFacilities: SupabaseFacility[];
  publicCourts: SupabaseCourt[];
  activePublicFacility: SupabaseFacility | null;
  setActivePublicFacilityId: (facilityId: string) => void;
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
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [staffData, setStaffData] = useState<StaffMembershipData | null>(null);
  const [isDemoSession, setIsDemoSession] = useState<boolean>(false);
  const [demoProfile, setDemoProfile] = useState<DemoAccountProfile | null>(null);
  const [supabaseReservations, setSupabaseReservations] = useState<Reservation[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);

  // Public facilities for customers
  const [publicFacilities, setPublicFacilities] = useState<SupabaseFacility[]>([]);
  const [publicCourts, setPublicCourts] = useState<SupabaseCourt[]>([]);
  const [activePublicFacilityId, setActivePublicFacilityId] = useState<string>('');

  // Load public facilities & courts if Supabase is configured
  useEffect(() => {
    let isMounted = true;
    async function loadPublicData() {
      if (!isSupabaseConfigured || !supabase) return;
      try {
        const facs = await fetchPublicFacilities();
        if (isMounted && facs.length > 0) {
          setPublicFacilities(facs);
          const firstFacId = facs[0].id;
          setActivePublicFacilityId(firstFacId);
          const courts = await fetchPublicCourts(firstFacId);
          if (isMounted) {
            setPublicCourts(courts);
          }
        }
      } catch (err) {
        console.warn('Could not load public facilities:', err);
      }
    }
    loadPublicData();
    return () => {
      isMounted = false;
    };
  }, []);

  // When public facility changes, update courts
  const handleSelectPublicFacility = useCallback(async (facilityId: string) => {
    setActivePublicFacilityId(facilityId);
    if (isSupabaseConfigured && supabase) {
      const courts = await fetchPublicCourts(facilityId);
      setPublicCourts(courts);
    }
  }, []);

  // Load real Supabase staff data for an authenticated user
  const loadStaffDataForUser = useCallback(
    async (userId: string, preferredOrgId?: string, preferredFacilityId?: string) => {
      try {
        const data = await fetchAuthenticatedStaffData(userId, preferredOrgId, preferredFacilityId);
        setStaffData(data);
        if (data && data.activeFacility) {
          const reservations = await fetchFacilityReservations(data.activeFacility.id);
          // Set live Supabase reservations (remains [] if facility has 0 reservations)
          setSupabaseReservations(mapSupabaseRowsToReservations(reservations, data.courts));
        } else {
          setSupabaseReservations([]);
        }
      } catch (err) {
        console.error('Failed to load staff data:', err);
        setStaffData(null);
        setSupabaseReservations([]);
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
        } else if (sessionData?.session) {
          if (isMounted) {
            setSession(sessionData.session);
            setUser(sessionData.session.user);
            await loadStaffDataForUser(sessionData.session.user.id);
          }
        }
      } catch (err) {
        console.error('Auth initialization error:', err);
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

      if (data.session) {
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
      const freshRows = await fetchFacilityReservations(staffData.activeFacility.id);
      setSupabaseReservations(mapSupabaseRowsToReservations(freshRows, staffData.courts));
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
      const freshRows = await fetchFacilityReservations(staffData.activeFacility.id);
      setSupabaseReservations(mapSupabaseRowsToReservations(freshRows, staffData.courts));
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
      const freshRows = await fetchFacilityReservations(staffData.activeFacility.id);
      setSupabaseReservations(mapSupabaseRowsToReservations(freshRows, staffData.courts));
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
    publicFacilities.find((f) => f.id === activePublicFacilityId) ||
    publicFacilities[0] ||
    null;

  // Filter public courts for active public facility if available
  const activePublicCourts = activePublicFacility
    ? publicCourts.filter((c) => c.facility_id === activePublicFacility.id)
    : publicCourts;

  // Derive mapped facility settings if available:
  // 1. Staff authenticated active facility
  // 2. Live active public facility (from Supabase BookSuite database)
  // 3. Demo profile if in simulation
  const mappedFacilitySettings: FacilitySettings | null = useMemo(() => {
    if (staffData?.activeFacility) {
      return mapFacilityToSettings(staffData.activeFacility, staffData.courts);
    }
    if (activePublicFacility) {
      const courtsToUse = activePublicCourts.length > 0 ? activePublicCourts : publicCourts;
      return mapFacilityToSettings(activePublicFacility, courtsToUse);
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
  }, [staffData, activePublicFacility, activePublicCourts, publicCourts, demoProfile]);

  const isUsingSupabaseData = Boolean(staffData?.activeFacility) || isDemoSession;

  return (
    <SupabaseAuthContext.Provider
      value={{
        isConfigured: isSupabaseConfigured,
        isLoading,
        user,
        session,
        staffData,
        isDemoSession,
        demoProfile,
        supabaseReservations,
        isUsingSupabaseData,
        authError,
        signIn,
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
        publicFacilities,
        publicCourts,
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
