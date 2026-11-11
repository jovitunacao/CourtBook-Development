// ==============================================================================
// CourtBook / BookSuite — Multi-Page Customer Booking Context
// File: src/context/CustomerBookingContext.tsx
// Description:
//   Persists customer booking draft across dedicated URLs and page refreshes.
//   Strictly enforces:
//     - Explicit separation of live vs demo inventory (never mixed, no silent substitution).
//     - Cascading invalidation on sport, location, venue, court, and schedule changes.
//     - Zero silent substitution of invalid IDs.
//     - Zero persistence of sensitive payment information.
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
import { PHILIPPINE_REGIONS } from '../data/philippineLocations';

const STORAGE_KEY = 'courtbook_booking_draft_v3';

export type InventorySource = 'live' | 'demo';

export interface CustomerBookingContextType {
  // Inventory Source & Status
  inventorySource: InventorySource;
  setInventorySource: (source: InventorySource) => void;
  isConfigured: boolean;
  isLoadingFacilities: boolean;
  facilitiesError: string | null;

  // Active Datasets (Strictly isolated by inventorySource)
  facilities: SupabaseFacility[];
  courts: SupabaseCourt[];
  filteredFacilities: SupabaseFacility[];
  sportCounts: Record<string, number>;

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

  // Derived Objects (Strictly null if unselected or invalid — zero silent substitution)
  activeFacility: SupabaseFacility | null;
  activeCourt: SupabaseCourt | null;

  // Updaters with Cascading Invalidation
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
    isConfigured,
    publicFacilities,
    publicCourts,
    publicFacilitiesLoading,
    publicFacilitiesError,
  } = useSupabaseAuth();

  // Inventory source: defaults to 'live' if Supabase is configured; otherwise 'demo'.
  // User can explicitly toggle, but live and demo records are NEVER mixed.
  const [inventorySource, setInventorySourceState] = useState<InventorySource>(() => {
    return isConfigured ? 'live' : 'demo';
  });

  // Automatically update source if configuration changes
  useEffect(() => {
    if (!isConfigured) {
      setInventorySourceState('demo');
    }
  }, [isConfigured]);

  // Determine active facilities & courts strictly by source (Zero silent mixing)
  const facilities = useMemo<SupabaseFacility[]>(() => {
    if (inventorySource === 'demo') {
      return DEMO_FACILITIES;
    }
    // Live mode: return genuine Supabase results without substituting demo records
    return publicFacilities || [];
  }, [inventorySource, publicFacilities]);

  const courts = useMemo<SupabaseCourt[]>(() => {
    if (inventorySource === 'demo') {
      return DEMO_COURTS;
    }
    // Live mode: return genuine Supabase courts
    return publicCourts || [];
  }, [inventorySource, publicCourts]);

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

  // Derived active facility: Strictly null if no selection or not found (NO SILENT SUBSTITUTION)
  const activeFacility = useMemo<SupabaseFacility | null>(() => {
    if (!selectedFacilityId) return null;
    return facilities.find((f) => f.id === selectedFacilityId) || null;
  }, [facilities, selectedFacilityId]);

  // Derived active court: Strictly null if no selection, or if court does not belong to activeFacility (NO SILENT SUBSTITUTION)
  const activeCourt = useMemo<SupabaseCourt | null>(() => {
    if (!selectedCourtId || !activeFacility) return null;
    return courts.find(
      (c) => c.id === selectedCourtId && c.facility_id === activeFacility.id && c.is_enabled
    ) || null;
  }, [courts, selectedCourtId, activeFacility]);

  // Calculate sport court inventory counts strictly for active dataset
  const sportCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of courts) {
      if (c.is_enabled && c.sport_type) {
        const key = c.sport_type.toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    return counts;
  }, [courts]);

  // Filter facilities based on sport and location
  const filteredFacilities = useMemo(() => {
    return facilities.filter((facility) => {
      const facilityCourts = courts.filter((c) => c.facility_id === facility.id && c.is_enabled);
      if (facilityCourts.length === 0) return false;

      // Filter by sport
      if (selectedSport) {
        const matchesSport = facilityCourts.some(
          (c) => c.sport_type.toLowerCase() === selectedSport.toLowerCase()
        );
        if (!matchesSport) return false;
      }

      // Filter by location (Strict hierarchical matching: barangay -> city -> province -> region)
      if (selectedLocation) {
        const addr = (facility.address || '').toLowerCase();
        
        // 1. If a specific barangay was selected, facility address MUST contain the barangay name
        if (selectedLocation.barangay && selectedLocation.barangay.trim()) {
          const bgy = selectedLocation.barangay.toLowerCase().trim();
          if (!addr.includes(bgy)) {
            return false;
          }
        }

        // 2. If a specific city/municipality was selected, facility address MUST contain the city name
        // (Prevents unrelated venues in the same province from falsely matching)
        if (selectedLocation.city && selectedLocation.city.trim()) {
          const city = selectedLocation.city.toLowerCase().trim();
          const cleanCity = city.replace(/\s+city$/i, '');
          if (!addr.includes(city) && !addr.includes(cleanCity)) {
            return false;
          }
        }

        // 3. If a province was selected, facility address MUST contain the province name or its known cities
        if (selectedLocation.province && selectedLocation.province.trim()) {
          const prov = selectedLocation.province.toLowerCase().trim();
          if (!addr.includes(prov)) {
            // Also check if address contains any city within the selected province
            const regionObj = PHILIPPINE_REGIONS.find((r) => r.code === selectedLocation.regionCode);
            const provObj = regionObj?.provinces.find((p) => p.name.toLowerCase() === prov);
            const hasCityInProvince = provObj?.cities.some((c) => {
              const cName = c.name.toLowerCase().trim().replace(/\s+city$/i, '');
              return addr.includes(cName);
            });
            if (!hasCityInProvince) {
              return false;
            }
          }
        }

        // 4. Region-only selection (when province and city are omitted or general)
        if (
          selectedLocation.regionCode &&
          (!selectedLocation.province || !selectedLocation.province.trim()) &&
          (!selectedLocation.city || !selectedLocation.city.trim())
        ) {
          const regionObj = PHILIPPINE_REGIONS.find((r) => r.code === selectedLocation.regionCode);
          if (regionObj) {
            const matchesAnyInRegion = regionObj.provinces.some((p) => {
              const pName = p.name.toLowerCase().trim();
              if (addr.includes(pName)) return true;
              return p.cities.some((c) => {
                const cName = c.name.toLowerCase().trim().replace(/\s+city$/i, '');
                return addr.includes(cName);
              });
            });
            if (!matchesAnyInRegion) {
              return false;
            }
          }
        }
      }

      return true;
    });
  }, [facilities, courts, selectedSport, selectedLocation]);

  // Explicit Inventory Source Setter: Resets any active draft to prevent mixing
  const setInventorySource = useCallback((source: InventorySource) => {
    setInventorySourceState(source);
    setSelectedFacilityIdState(null);
    setSelectedCourtIdState(null);
    setSelectedStartTimeIsoState(null);
    setCheckoutResult(null);
    setConfirmedPassDetails(null);
  }, []);

  // Cascading Invalidation on Sport Change:
  // If the active facility does NOT support the new sport, clear facility, court, slot, and payment state.
  const setSelectedSport = useCallback((newSport: string | null) => {
    setSelectedSportState(newSport);

    if (newSport && selectedFacilityId) {
      const facilityCourts = courts.filter(
        (c) => c.facility_id === selectedFacilityId && c.is_enabled
      );
      const supportsSport = facilityCourts.some(
        (c) => c.sport_type.toLowerCase() === newSport.toLowerCase()
      );

      if (!supportsSport) {
        setSelectedFacilityIdState(null);
        setSelectedCourtIdState(null);
        setSelectedStartTimeIsoState(null);
        setCheckoutResult(null);
        setConfirmedPassDetails(null);
        return;
      }

      // If facility supports the sport but the currently selected court doesn't, clear court and schedule
      if (selectedCourtId) {
        const currentCourt = facilityCourts.find((c) => c.id === selectedCourtId);
        if (!currentCourt || currentCourt.sport_type.toLowerCase() !== newSport.toLowerCase()) {
          setSelectedCourtIdState(null);
          setSelectedStartTimeIsoState(null);
          setCheckoutResult(null);
          setConfirmedPassDetails(null);
        }
      }
    }
  }, [selectedFacilityId, selectedCourtId, courts]);

  // Cascading Invalidation on Location Change:
  // If the active facility does NOT match the new location, clear facility, court, slot, and payment state.
  const setSelectedLocation = useCallback((newLoc: PhilippineLocation | null) => {
    setSelectedLocationState(newLoc);

    if (newLoc && selectedFacilityId) {
      const currentFac = facilities.find((f) => f.id === selectedFacilityId);
      if (currentFac) {
        const addr = (currentFac.address || '').toLowerCase();
        const city = newLoc.city.toLowerCase().trim();
        const cleanCity = city.replace(/\s+city$/i, '');
        const cityMatch = addr.includes(city) || addr.includes(cleanCity);
        const provMatch = newLoc.province ? addr.includes(newLoc.province.toLowerCase().trim()) : true;
        const bgyMatch = newLoc.barangay ? addr.includes(newLoc.barangay.toLowerCase().trim()) : true;

        if (!cityMatch || !provMatch || !bgyMatch) {
          setSelectedFacilityIdState(null);
          setSelectedCourtIdState(null);
          setSelectedStartTimeIsoState(null);
          setCheckoutResult(null);
          setConfirmedPassDetails(null);
        }
      }
    }
  }, [selectedFacilityId, facilities]);

  // Cascading Invalidation on Venue Change:
  // Changing venue MUST reset selected court, schedule, and payment state.
  const setSelectedFacilityId = useCallback((facilityId: string | null) => {
    setSelectedFacilityIdState(facilityId);
    // Explicitly reset dependent selections (NO SILENT COURT SELECTION)
    setSelectedCourtIdState(null);
    setSelectedStartTimeIsoState(null);
    setCheckoutResult(null);
    setConfirmedPassDetails(null);
  }, []);

  // Cascading Invalidation on Court Change:
  // Changing court resets slot time, checkout, and confirmation state.
  const setSelectedCourtId = useCallback((courtId: string | null) => {
    setSelectedCourtIdState(courtId);
    setSelectedStartTimeIsoState(null);
    setCheckoutResult(null);
    setConfirmedPassDetails(null);
  }, []);

  // Cascading Invalidation on Schedule Change:
  // Changing date, slot time, or duration invalidates any active checkout session or previous confirmation.
  const setSchedule = useCallback((date: string, startTimeIso: string | null, newDurationMinutes: number) => {
    setSelectedDateState(date);
    setSelectedStartTimeIsoState(startTimeIso);
    setDurationMinutesState(newDurationMinutes);
    setCheckoutResult(null);
    setConfirmedPassDetails(null);
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
        inventorySource,
        setInventorySource,
        isConfigured,
        isLoadingFacilities: inventorySource === 'live' ? publicFacilitiesLoading : false,
        facilitiesError: inventorySource === 'live' ? publicFacilitiesError : null,
        facilities,
        courts,
        filteredFacilities,
        sportCounts,
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
