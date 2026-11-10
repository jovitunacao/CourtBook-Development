import React, { useState, useMemo, useEffect } from 'react';
import {
  Building2,
  Calendar,
  Clock,
  ArrowLeft,
  Search,
  Filter,
  CheckCircle2,
  Trophy,
  MapPin,
  Sparkles,
  RefreshCw,
  Loader2,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';
import { SportCategoryPills } from './SportCategoryPills';
import { LocationCascadeSelector } from './LocationCascadeSelector';
import { VenueDirectoryCard } from './VenueDirectoryCard';
import { CourtSlotPicker } from './CourtSlotPicker';
import { GuestCheckoutForm } from './GuestCheckoutForm';
import { PaymentCheckoutBridge } from './PaymentCheckoutBridge';
import { BookingConfirmationCard } from './BookingConfirmationCard';
import {
  BookingStep,
  PhilippineLocation,
  CustomerConfirmationDetails,
} from '../../types/customerBooking';
import {
  SupabaseFacility,
  SupabaseCourt,
  createBookingCheckoutSession,
  CreateBookingCheckoutResult,
  getTodayStringInTimezone,
} from '../../lib/supabaseClient';
import { useSupabaseAuth } from '../../context/SupabaseAuthContext';

interface CustomerBookingFlowProps {
  initialSport?: string;
  initialFacilityId?: string;
  onNavigateHome: () => void;
  onBookingConfirmed?: (details: CustomerConfirmationDetails) => void;
}

export const CustomerBookingFlow: React.FC<CustomerBookingFlowProps> = ({
  initialSport,
  initialFacilityId,
  onNavigateHome,
  onBookingConfirmed,
}) => {
  const {
    publicFacilities,
    publicCourts,
    publicFacilitiesLoading,
    publicFacilitiesError,
    refreshPublicFacilities,
  } = useSupabaseAuth();

  // 8-step flow state
  const [currentStep, setCurrentStep] = useState<BookingStep>(initialFacilityId ? 5 : 2);
  const [selectedSport, setSelectedSport] = useState<string | null>(initialSport || null);
  const [selectedLocation, setSelectedLocation] = useState<PhilippineLocation | null>(null);
  const [selectedFacilityId, setSelectedFacilityId] = useState<string | null>(initialFacilityId || null);
  const [selectedCourtId, setSelectedCourtId] = useState<string | null>(null);

  // Scheduling states
  const [selectedDate, setSelectedDate] = useState<string>(() => getTodayStringInTimezone('Asia/Manila'));
  const [selectedStartTimeIso, setSelectedStartTimeIso] = useState<string | null>(null);
  const [durationMinutes, setDurationMinutes] = useState<number>(60);

  // Guest details
  const [customerName, setCustomerName] = useState<string>('');
  const [customerPhone, setCustomerPhone] = useState<string>('');
  const [customerEmail, setCustomerEmail] = useState<string>('');

  // Checkout & Confirmation
  const [checkoutResult, setCheckoutResult] = useState<CreateBookingCheckoutResult | null>(null);
  const [isSubmittingCheckout, setIsSubmittingCheckout] = useState<boolean>(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [confirmedPassDetails, setConfirmedPassDetails] = useState<CustomerConfirmationDetails | null>(null);

  // Reset selected court if facility changes
  useEffect(() => {
    if (selectedFacilityId) {
      const facilityCourts = publicCourts.filter((c) => c.facility_id === selectedFacilityId && c.is_enabled);
      if (facilityCourts.length > 0) {
        setSelectedCourtId(facilityCourts[0].id);
      } else {
        setSelectedCourtId(null);
      }
    }
  }, [selectedFacilityId, publicCourts]);

  // Active facility object
  const activeFacility = useMemo(() => {
    return publicFacilities.find((f) => f.id === selectedFacilityId) || publicFacilities[0] || null;
  }, [publicFacilities, selectedFacilityId]);

  // Active court object
  const activeCourt = useMemo(() => {
    return publicCourts.find((c) => c.id === selectedCourtId) || null;
  }, [publicCourts, selectedCourtId]);

  // Sport court counts calculation
  const sportCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of publicCourts) {
      if (c.is_enabled && c.sport_type) {
        const key = c.sport_type.toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    return counts;
  }, [publicCourts]);

  // Filter facilities based on selected sport and location
  const filteredFacilities = useMemo(() => {
    return publicFacilities.filter((facility) => {
      const facilityCourts = publicCourts.filter((c) => c.facility_id === facility.id && c.is_enabled);
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
        const bgyMatch = selectedLocation.barangay ? addr.includes(selectedLocation.barangay.toLowerCase()) : true;

        // If facility has no specific address or matches any city/province token
        if (!cityMatch && !provMatch && facility.address) {
          return false;
        }
      }

      return true;
    });
  }, [publicFacilities, publicCourts, selectedSport, selectedLocation]);

  // Step 5 -> Step 6 (Court & Slot selected -> Guest Details)
  const handleProceedToGuestDetails = () => {
    if (!selectedStartTimeIso) return;
    setCurrentStep(6);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Step 6 -> Step 7 (Submit Checkout Session to PayMongo)
  const handleInitiatePayment = async () => {
    if (!activeFacility || !activeCourt || !selectedStartTimeIso) return;

    setCurrentStep(7);
    setIsSubmittingCheckout(true);
    setCheckoutError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Generate client idempotency key (min 16 chars)
    const idempotencyKey = `idem_cust_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

    const res = await createBookingCheckoutSession({
      facility_id: activeFacility.id,
      court_id: activeCourt.id,
      customer_name: customerName.trim(),
      customer_phone: customerPhone.trim() || undefined,
      customer_email: customerEmail.trim() || undefined,
      booking_date: selectedDate,
      start_time: selectedStartTimeIso,
      duration_minutes: durationMinutes,
      idempotency_key: idempotencyKey,
      provider_name: 'paymongo',
    });

    setIsSubmittingCheckout(false);

    if (res.success) {
      setCheckoutResult(res);
    } else {
      setCheckoutError(res.error || 'Failed to initialize payment checkout session.');
    }
  };

  // Step 7 -> Step 8 (Simulate Payment or PayMongo Webhook Captured)
  const handleCompletePaymentAndShowPass = () => {
    if (!activeFacility || !activeCourt || !checkoutResult) return;

    const startDate = new Date(selectedStartTimeIso || new Date().toISOString());
    const startH = startDate.getHours() % 12 || 12;
    const startM = String(startDate.getMinutes()).padStart(2, '0');
    const ampm = startDate.getHours() < 12 ? 'AM' : 'PM';

    const details: CustomerConfirmationDetails = {
      reservationId: checkoutResult.reservation_id || crypto.randomUUID(),
      referenceCode: checkoutResult.reference_code || `CB-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
      facilityName: activeFacility.name,
      facilityAddress: activeFacility.address || 'Metro Manila, Philippines',
      courtName: activeCourt.name,
      sportType: activeCourt.sport_type,
      bookingDate: selectedDate,
      timeSlotLabel: checkoutResult.time_slot_label || `${startH}:${startM} ${ampm}`,
      durationMinutes,
      totalPrice: Number(checkoutResult.expected_amount || activeCourt.hourly_rate),
      currency: activeFacility.currency || '₱',
      customerName,
      customerPhone,
      customerEmail,
      confirmedAt: new Date().toISOString(),
    };

    setConfirmedPassDetails(details);
    if (onBookingConfirmed) onBookingConfirmed(details);
    setCurrentStep(8);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Step names for stepper indicator
  const stepLabels: Record<BookingStep, string> = {
    1: 'Start',
    2: 'Choose Sport',
    3: 'Choose Location',
    4: 'Browse Venues',
    5: 'Select Court & Time',
    6: 'Guest Details',
    7: 'Payment',
    8: 'Confirmation',
  };

  return (
    <div className="bg-slate-50 min-h-[calc(100vh-64px)] py-8 sm:py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Progress Stepper Header */}
        <div className="bg-white rounded-3xl border border-slate-200/90 p-4 sm:p-6 shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {currentStep > 2 && currentStep < 8 && (
                <button
                  type="button"
                  onClick={() => {
                    if (currentStep === 5 && !initialFacilityId) {
                      setCurrentStep(4);
                    } else if (currentStep > 2) {
                      setCurrentStep((prev) => Math.max(2, prev - 1) as BookingStep);
                    }
                  }}
                  className="p-1.5 rounded-xl hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition-colors cursor-pointer"
                  title="Go back to previous step"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}
              <div>
                <span className="text-[11px] font-extrabold uppercase tracking-widest text-blue-600">
                  Step {currentStep} of 8
                </span>
                <h1 className="text-base sm:text-xl font-extrabold text-slate-900 tracking-tight">
                  {stepLabels[currentStep]}
                </h1>
              </div>
            </div>

            {/* Quick Change / Reset */}
            {currentStep > 2 && currentStep < 8 && (
              <button
                type="button"
                onClick={() => {
                  setSelectedFacilityId(null);
                  setCurrentStep(2);
                }}
                className="text-xs font-bold text-slate-500 hover:text-blue-600 transition-colors cursor-pointer"
              >
                Change Sport / Venue
              </button>
            )}
          </div>

          {/* Stepper Progress Bar */}
          <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden flex">
            <div
              className="bg-blue-600 h-full transition-all duration-300 rounded-full"
              style={{ width: `${(currentStep / 8) * 100}%` }}
            />
          </div>
        </div>

        {/* STEP 2, 3, 4: Sport Selection, Location Cascade & Venue Directory */}
        {currentStep <= 4 && (
          <div className="space-y-6">
            {/* Step 2: Choose Sport */}
            <div className="bg-white rounded-3xl border border-slate-200/90 p-5 sm:p-6 shadow-xs space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-xs">
                    2
                  </div>
                  <h2 className="text-sm sm:text-base font-extrabold text-slate-900">
                    Choose Sport
                  </h2>
                </div>
                {selectedSport && (
                  <span className="text-xs font-semibold text-blue-600">
                    Showing {selectedSport} Courts
                  </span>
                )}
              </div>
              <SportCategoryPills
                selectedSport={selectedSport}
                onSelectSport={(sport) => {
                  setSelectedSport(sport);
                  if (currentStep === 2) setCurrentStep(3);
                }}
                sportCounts={sportCounts}
              />
            </div>

            {/* Step 3: Choose Location */}
            <div className="bg-white rounded-3xl border border-slate-200/90 p-5 sm:p-6 shadow-xs space-y-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-xs">
                  3
                </div>
                <div>
                  <h2 className="text-sm sm:text-base font-extrabold text-slate-900">
                    Choose Location
                  </h2>
                  <p className="text-xs text-slate-500">
                    Filter by Philippine Region, Province, City/Municipality, or Barangay
                  </p>
                </div>
              </div>

              <LocationCascadeSelector
                selectedLocation={selectedLocation}
                onSelectLocation={(loc) => {
                  setSelectedLocation(loc);
                  setCurrentStep(4);
                }}
              />
            </div>

            {/* Step 4: Browse Available Court Businesses */}
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-xs">
                    4
                  </div>
                  <div>
                    <h2 className="text-base sm:text-lg font-extrabold text-slate-900">
                      Available Court Businesses
                    </h2>
                    <p className="text-xs text-slate-500">
                      Browse venues with photos, transparent hourly rates, and verified amenities
                    </p>
                  </div>
                </div>

                <div className="text-xs font-bold text-slate-600">
                  {filteredFacilities.length} {filteredFacilities.length === 1 ? 'Venue' : 'Venues'} Listed
                </div>
              </div>

              {publicFacilitiesLoading ? (
                <div className="py-16 text-center space-y-3 bg-white rounded-3xl border border-slate-200">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600 mx-auto" />
                  <p className="text-xs font-semibold text-slate-500">
                    Loading verified court facilities...
                  </p>
                </div>
              ) : filteredFacilities.length === 0 ? (
                <div className="bg-white rounded-3xl border border-slate-200 p-8 text-center space-y-3 max-w-md mx-auto">
                  <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
                    <Building2 className="w-6 h-6" />
                  </div>
                  <h3 className="text-base font-bold text-slate-900">No Venues Found</h3>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    No active court businesses matched your location or sport filters. Try choosing "All Sports" or clearing the location filter.
                  </p>
                  <div className="pt-2 flex justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSport(null);
                        setSelectedLocation(null);
                      }}
                      className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 cursor-pointer"
                    >
                      Clear All Filters
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredFacilities.map((facility) => (
                    <VenueDirectoryCard
                      key={facility.id}
                      facility={facility}
                      courts={publicCourts}
                      selectedSport={selectedSport}
                      onSelectVenue={(facilityId) => {
                        setSelectedFacilityId(facilityId);
                        setCurrentStep(5);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* STEP 5: Select Court, Booking Date & Available Time Slot */}
        {currentStep === 5 && activeFacility && (
          <div className="bg-white rounded-3xl border border-slate-200/90 p-5 sm:p-8 shadow-xs">
            <CourtSlotPicker
              facility={activeFacility}
              courts={publicCourts}
              selectedCourtId={selectedCourtId}
              onSelectCourt={setSelectedCourtId}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
              selectedStartTime={selectedStartTimeIso}
              onSelectStartTime={setSelectedStartTimeIso}
              durationMinutes={durationMinutes}
              onSelectDuration={setDurationMinutes}
              onProceed={handleProceedToGuestDetails}
              onBack={() => setCurrentStep(4)}
            />
          </div>
        )}

        {/* STEP 6: Guest Checkout Form */}
        {currentStep === 6 && activeFacility && activeCourt && selectedStartTimeIso && (
          <div className="bg-white rounded-3xl border border-slate-200/90 p-5 sm:p-8 shadow-xs">
            <GuestCheckoutForm
              facility={activeFacility}
              court={activeCourt}
              selectedDate={selectedDate}
              startTimeIso={selectedStartTimeIso}
              durationMinutes={durationMinutes}
              customerName={customerName}
              onNameChange={setCustomerName}
              customerPhone={customerPhone}
              onPhoneChange={setCustomerPhone}
              customerEmail={customerEmail}
              onEmailChange={setCustomerEmail}
              onProceedToPayment={handleInitiatePayment}
              onBack={() => setCurrentStep(5)}
            />
          </div>
        )}

        {/* STEP 7: Payment & Hold Bridge */}
        {currentStep === 7 && (
          <PaymentCheckoutBridge
            checkoutResult={checkoutResult}
            isLoading={isSubmittingCheckout}
            errorMessage={checkoutError}
            onSimulateSuccess={handleCompletePaymentAndShowPass}
            onRetry={handleInitiatePayment}
            onCancel={() => setCurrentStep(5)}
          />
        )}

        {/* STEP 8: Digital Booking Confirmation Pass */}
        {currentStep === 8 && confirmedPassDetails && (
          <BookingConfirmationCard
            details={confirmedPassDetails}
            onBookAnother={() => {
              setSelectedFacilityId(null);
              setSelectedCourtId(null);
              setSelectedStartTimeIso(null);
              setCheckoutResult(null);
              setConfirmedPassDetails(null);
              setCurrentStep(2);
            }}
            onDone={onNavigateHome}
          />
        )}
      </div>
    </div>
  );
};
