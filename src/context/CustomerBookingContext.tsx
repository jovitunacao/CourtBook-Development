// ==============================================================================
// CourtBook / BookSuite — Multi-Page Customer Booking Context
// File: src/context/CustomerBookingContext.tsx
// Description:
//   Persists customer booking draft across dedicated URLs and page refreshes.
//   Strictly avoids persisting any sensitive payment information.
// ==============================================================================

import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import {
  PhilippineLocation,
  CustomerConfirmationDetails,
} from '../types/customerBooking';
import {
  SupabaseFacility,
  SupabaseCourt,
  CreateBookingCheckoutResult,
  getTodayStringInTimezone,
} from '../lib/supabaseClient';
import { useSupabaseAuth } from './SupabaseAuthContext';
import { DEMO_FACILITIES, DEMO_COURTS } from '../data/demoVenues';

const STORAGE_KEY = 'courtbook_booking_draft_v2';

export interface CustomerBookingContextType {
  // Selections
  selectedSport: string | null;
  selectedLocation: PhilippineLocation | null;
  selectedFacilityId: string | null;
  selectedCourtId: string | null;
  selectedDate: string;
  selectedStartTimeIso: string | null;
  durationMinutes: number;

  // Guest Details (Non-sensitive contact details for guest checkout)
  customerName: string;
  customerPhone: string;
  customerEmail: string;

  // Checkout and Confirmation States
  checkoutResult: CreateBookingCheckoutResult | null;
  confirmedPassDetails: CustomerConfirmationDetails | null;

  // Derived Objects
  activeFacility: SupabaseFacility | null;
  activeCourt: SupabaseCourt | null;
  allFacilities: SupabaseFacility[];
  allCourts: SupabaseCourt[];
  filteredFacilities: SupabaseFacility[];
  sportCounts: Record<string, number>;
  isLoadingFacilities: boolean;

  // Updaters
  setSelectedSport: (sport: string | null) => void;
  setSelectedLocation: (loc: PhilippineLocation | null) => void;
  setSelectedFacilityId: (facilityId: string | null) => void;
  setSelectedCourtId: (courtId: string | null) => void;
  setSchedule: (date: string, startTimeIso: string | null, durationMinutes: number) => void;
  setGuestDetails: (name: string, phone: string, email: string) => void;
  setCheckoutResult: (result: CreateBookingCheckoutResult | null) => void;
  setConfirmedPassDetails: (details: CustomerConfirmationDetails | null) => void;
  resetBooking: () => void;
}

const CustomerBookingContext = createContext<CustomerBookingContextType | undefined>(undefined);

export const CustomerBookingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const {
    publicFacilities,
    publicCourts,
    publicFacilitiesLoading,
  } = useSupabaseAuth();

  // Combine public facilities from database or fallback to demo facilities
  const allFacilities = useMemo(() => {
    if (publicFacilities && publicFacilities.length > 0) {
      return publicFacilities;
    }
    return DEMO_FACILITIES;
  }, [publicFacilities]);

  const allCourts = useMemo(() => {
    if (publicCourts && publicCourts.length > 0) {
      return publicCourts;
    }
    return DEMO_COURTS;
  }, [publicCourts]);

  // Read initial draft from sessionStorage
  const [selectedSport, setSelectedSportState] = useState<string | null>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.selectedSport || null;
      }
    } catch {}
    return null;
  });

  const [selectedLocation, setSelectedLocationState] = useState<PhilippineLocation | null>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.selectedLocation || null;
      }
    } catch {}
    return null;
  });

  const [selectedFacilityId, setSelectedFacilityIdState] = useState<string | null>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.selectedFacilityId || null;
      }
    } catch {}
    return null;
  });

  const [selectedCourtId, setSelectedCourtIdState] = useState<string | null>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.selectedCourtId || null;
      }
    } catch {}
    return null;
  });

  const [selectedDate, setSelectedDateState] = useState<string>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.selectedDate) return parsed.selectedDate;
      }
    } catch {}
    return getTodayStringInTimezone('Asia/Manila');
  });

  const [selectedStartTimeIso, setSelectedStartTimeIsoState] = useState<string | null>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.selectedStartTimeIso || null;
      }
    } catch {}
    return null;
  });

  const [durationMinutes, setDurationMinutesState] = useState<number>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.durationMinutes) return Number(parsed.durationMinutes);
      }
    } catch {}
    return 60;
  });

  const [customerName, setCustomerNameState] = useState<string>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.customerName || '';
      }
    } catch {}
    return '';
  });

  const [customerPhone, setCustomerPhoneState] = useState<string>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.customerPhone || '';
      }
    } catch {}
    return '';
  });

  const [customerEmail, setCustomerEmailState] = useState<string>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.customerEmail || '';
      }
    } catch {}
    return '';
  });

  const [checkoutResult, setCheckoutResult] = useState<CreateBookingCheckoutResult | null>(null);
  const [confirmedPassDetails, setConfirmedPassDetails] = useState<CustomerConfirmationDetails | null>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.confirmedPassDetails || null;
      }
    } catch {}
    return null;
  });

  // Save non-sensitive draft to sessionStorage on state changes
  useEffect(() => {
    try {
      const draft = {
        selectedSport,
        selectedLocation,
        selectedFacilityId,
        selectedCourtId,
        selectedDate,
        selectedStartTimeIso,
        durationMinutes,
        customerName,
        customerPhone,
        customerEmail,
        confirmedPassDetails,
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    } catch (e) {
      console.warn('Could not persist booking draft:', e);
    }
  }, [
    selectedSport,
    selectedLocation,
    selectedFacilityId,
    selectedCourtId,
    selectedDate,
    selectedStartTimeIso,
    durationMinutes,
    customerName,
    customerPhone,
    customerEmail,
    confirmedPassDetails,
  ]);

  // Derive active facility
  const activeFacility = useMemo(() => {
    if (!selectedFacilityId) return allFacilities[0] || null;
    return allFacilities.find((f) => f.id === selectedFacilityId) || allFacilities[0] || null;
  }, [allFacilities, selectedFacilityId]);

  // Derive active court
  const activeCourt = useMemo(() => {
    if (selectedCourtId) {
      const found = allCourts.find((c) => c.id === selectedCourtId);
      if (found) return found;
    }
    if (activeFacility) {
      const facilityCourts = allCourts.filter((c) => c.facility_id === activeFacility.id && c.is_enabled);
      return facilityCourts[0] || null;
    }
    return allCourts[0] || null;
  }, [allCourts, selectedCourtId, activeFacility]);

  // Calculate sport court inventory counts
  const sportCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of allCourts) {
      if (c.is_enabled && c.sport_type) {
        const key = c.sport_type.toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    return counts;
  }, [allCourts]);

  // Filter facilities based on sport and location
  const filteredFacilities = useMemo(() => {
    return allFacilities.filter((facility) => {
      const facilityCourts = allCourts.filter((c) => c.facility_id === facility.id && c.is_enabled);
      if (facilityCourts.length === 0) return false;

      // Filter by sport
      if (selectedSport) {
        const matchesSport = facilityCourts.some(
          (c) => c.sport_type.toLowerCase() === selectedSport.toLowerCase()
        );
        if (!matchesSport) return false;
      }

      // Filter by location
      if (selectedLocation) {
        const addr = (facility.address || '').toLowerCase();
        const cityMatch = addr.includes(selectedLocation.city.toLowerCase());
        const provMatch = addr.includes(selectedLocation.province.toLowerCase());
        const bgyMatch = selectedLocation.barangay
          ? addr.includes(selectedLocation.barangay.toLowerCase())
          : true;

        if (!cityMatch && !provMatch && facility.address) {
          return false;
        }
      }

      return true;
    });
  }, [allFacilities, allCourts, selectedSport, selectedLocation]);

  // State setters
  const setSelectedSport = useCallback((sport: string | null) => {
    setSelectedSportState(sport);
  }, []);

  const setSelectedLocation = useCallback((loc: PhilippineLocation | null) => {
    setSelectedLocationState(loc);
  }, []);

  const setSelectedFacilityId = useCallback((facilityId: string | null) => {
    setSelectedFacilityIdState(facilityId);
    if (facilityId) {
      const courtsForFacility = allCourts.filter((c) => c.facility_id === facilityId && c.is_enabled);
      if (courtsForFacility.length > 0) {
        setSelectedCourtIdState(courtsForFacility[0].id);
      }
    }
  }, [allCourts]);

  const setSelectedCourtId = useCallback((courtId: string | null) => {
    setSelectedCourtIdState(courtId);
  }, []);

  const setSchedule = useCallback((date: string, startTimeIso: string | null, durationMinutes: number) => {
    setSelectedDateState(date);
    setSelectedStartTimeIsoState(startTimeIso);
    setDurationMinutesState(durationMinutes);
  }, []);

  const setGuestDetails = useCallback((name: string, phone: string, email: string) => {
    setCustomerNameState(name);
    setCustomerPhoneState(phone);
    setCustomerEmailState(email);
  }, []);

  const resetBooking = useCallback(() => {
    setSelectedSportState(null);
    setSelectedLocationState(null);
    setSelectedFacilityIdState(null);
    setSelectedCourtIdState(null);
    setSelectedDateState(getTodayStringInTimezone('Asia/Manila'));
    setSelectedStartTimeIsoState(null);
    setDurationMinutesState(60);
    setCustomerNameState('');
    setCustomerPhoneState('');
    setCustomerEmailState('');
    setCheckoutResult(null);
    setConfirmedPassDetails(null);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {}
  }, []);

  return (
    <CustomerBookingContext.Provider
      value={{
        selectedSport,
        selectedLocation,
        selectedFacilityId,
        selectedCourtId,
        selectedDate,
        selectedStartTimeIso,
        durationMinutes,
        customerName,
        customerPhone,
        customerEmail,
        checkoutResult,
        confirmedPassDetails,
        activeFacility,
        activeCourt,
        allFacilities,
        allCourts,
        filteredFacilities,
        sportCounts,
        isLoadingFacilities: publicFacilitiesLoading,
        setSelectedSport,
        setSelectedLocation,
        setSelectedFacilityId,
        setSelectedCourtId,
        setSchedule,
        setGuestDetails,
        setCheckoutResult,
        setConfirmedPassDetails,
        resetBooking,
      }}
    >
      {children}
    </CustomerBookingContext.Provider>
  );
};

export const useCustomerBooking = () => {
  const context = useContext(CustomerBookingContext);
  if (!context) {
    throw new Error('useCustomerBooking must be used within a CustomerBookingProvider');
  }
  return context;
};
