// ==============================================================================
// CourtBook / BookSuite — Customer Booking Flow Types
// File: src/types/customerBooking.ts
// ==============================================================================

export type BookingStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface PhilippineLocation {
  regionCode: string;
  regionName: string;
  province: string;
  city: string;
  barangay?: string;
}

export interface VenueAmenity {
  id: string;
  label: string;
  iconName: string;
}

export interface VenuePhoto {
  url: string;
  caption: string;
  isCover?: boolean;
}

export interface CustomerBookingState {
  step: BookingStep;
  selectedSport: string | null;
  selectedLocation: PhilippineLocation | null;
  locationSearchQuery: string;
  selectedFacilityId: string | null;
  selectedCourtId: string | null;
  selectedDate: string; // YYYY-MM-DD (Asia/Manila)
  selectedSlotStartTime: string | null; // ISO 8601 UTC
  selectedDurationMinutes: number; // 30, 60, 90, 120, etc.
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  // Temporary Hold & Checkout
  idempotencyKey: string | null;
  reservationId: string | null;
  paymentId: string | null;
  referenceCode: string | null;
  checkoutUrl: string | null;
  holdExpiresAt: string | null;
  paymentStatus: 'idle' | 'holding' | 'redirecting' | 'paid' | 'failed';
}

export interface CustomerConfirmationDetails {
  reservationId: string;
  referenceCode: string;
  facilityName: string;
  facilityAddress: string;
  courtName: string;
  sportType: string;
  bookingDate: string; // YYYY-MM-DD
  timeSlotLabel: string;
  durationMinutes: number;
  totalPrice: number;
  currency: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  confirmedAt: string;
  isDemo?: boolean;
  isSimulated?: boolean;
}
