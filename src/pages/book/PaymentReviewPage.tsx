// ==============================================================================
// CourtBook / BookSuite — Step 6: Payment Review Page
// File: src/pages/book/PaymentReviewPage.tsx
// Route: /book/payment
// ==============================================================================

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, AlertCircle, Loader2 } from 'lucide-react';
import { BookingPageLayout } from '../../components/booking/BookingPageLayout';
import { useCustomerBooking } from '../../context/CustomerBookingContext';
import { PaymentCheckoutBridge } from '../../components/booking/PaymentCheckoutBridge';
import {
  createBookingCheckoutSession,
  CreateBookingCheckoutResult,
} from '../../lib/supabaseClient';
import { CustomerConfirmationDetails } from '../../types/customerBooking';

export const PaymentReviewPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    activeFacility,
    activeCourt,
    selectedDate,
    selectedStartTimeIso,
    durationMinutes,
    customerName,
    customerPhone,
    customerEmail,
    checkoutResult,
    setCheckoutResult,
    setConfirmedPassDetails,
  } = useCustomerBooking();

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);

  // Missing prerequisites check
  const isMissingPrerequisites =
    !activeFacility ||
    !activeCourt ||
    !selectedStartTimeIso ||
    !customerName.trim() ||
    !customerPhone.trim();

  // Stable signature of current booking slot to avoid duplicate session creations
  const currentSlotSignature = `${activeFacility?.id}_${activeCourt?.id}_${selectedDate}_${selectedStartTimeIso}_${durationMinutes}_${customerName.trim()}_${customerPhone.trim()}`;
  const inFlightRef = React.useRef<boolean>(false);
  const lastCreatedSignatureRef = React.useRef<string | null>(null);

  // Initiate checkout session on mount if not already created for this slot
  useEffect(() => {
    if (isMissingPrerequisites) return;

    // If an authoritative checkout result already exists for this exact slot, reuse it
    if (
      checkoutResult &&
      checkoutResult.success &&
      lastCreatedSignatureRef.current === currentSlotSignature
    ) {
      return;
    }

    if (inFlightRef.current) return;

    let isMounted = true;
    inFlightRef.current = true;

    async function initCheckout() {
      setIsLoading(true);
      // Generate or retrieve a persistent booking-attempt token for this exact slot
      // Guarantees stable idempotency across page refreshes, remounts, and network retries
      const attemptStorageKey = `courtbook_attempt_${currentSlotSignature}`;
      let attemptToken = sessionStorage.getItem(attemptStorageKey);
      if (!attemptToken) {
        attemptToken = `${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        sessionStorage.setItem(attemptStorageKey, attemptToken);
      }

      // Compact, compliant 32-64 char deterministic key: idem_<facPrefix>_<courtPrefix>_<token>
      const facPrefix = (activeFacility!.id || '').replace(/-/g, '').substring(0, 8);
      const courtPrefix = (activeCourt!.id || '').replace(/-/g, '').substring(0, 8);
      const idempotencyKey = `idem_${facPrefix}_${courtPrefix}_${attemptToken}`.substring(0, 64);

      const res = await createBookingCheckoutSession({
        facility_id: activeFacility!.id,
        court_id: activeCourt!.id,
        customer_name: customerName.trim(),
        customer_phone: customerPhone.trim() || undefined,
        customer_email: customerEmail.trim() || undefined,
        booking_date: selectedDate,
        start_time: selectedStartTimeIso!,
        duration_minutes: durationMinutes,
        idempotency_key: idempotencyKey,
        provider_name: 'paymongo',
        is_demo: Boolean(activeFacility?.is_demo),
      });

      inFlightRef.current = false;

      if (isMounted) {
        setIsLoading(false);
        if (res.success) {
          lastCreatedSignatureRef.current = currentSlotSignature;
          setCheckoutResult(res);
        } else {
          setErrorMessage(res.error || 'Failed to initialize payment checkout session.');
        }
      }
    }

    initCheckout();

    return () => {
      isMounted = false;
      inFlightRef.current = false;
    };
  }, [
    isMissingPrerequisites,
    currentSlotSignature,
    activeFacility,
    activeCourt,
    selectedStartTimeIso,
    customerName,
    customerPhone,
    customerEmail,
    selectedDate,
    durationMinutes,
    checkoutResult,
    setCheckoutResult,
  ]);

  if (isMissingPrerequisites) {
    return (
      <BookingPageLayout
        currentStep={6}
        title="Payment & Checkout"
        subtitle="Review your court booking and complete secure payment"
        backUrl="/book/details"
      >
        <div className="bg-white rounded-3xl border border-amber-200 p-8 text-center space-y-4 max-w-md mx-auto">
          <div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto">
            <AlertCircle className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-bold text-slate-900">Incomplete Booking Details</h3>
            <p className="text-xs text-slate-500">
              Please enter your full name and Philippine mobile number before proceeding to payment.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/book/details')}
            className="px-5 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 cursor-pointer"
          >
            Enter Guest Details
          </button>
        </div>
      </BookingPageLayout>
    );
  }

  // Handle successful payment simulation (RESTRICTED TO ISOLATED DEMO EXPERIENCE ONLY)
  // Real live facilities require authoritative backend webhook capture and verified database confirmation.
  const handleSimulatePaymentSuccess = () => {
    if (!activeFacility || !activeCourt || !checkoutResult) return;

    // Strict guard: Real live facilities can NEVER simulate payment on the frontend
    if (!activeFacility.is_demo) {
      setErrorMessage(
        'Payment simulation is disabled for live registered facilities. Please complete official payment via PayMongo.'
      );
      return;
    }

    // Require authoritative reservation ID and reference code from checkoutResult (NEVER invent on frontend)
    if (!checkoutResult.reservation_id || !checkoutResult.reference_code) {
      setErrorMessage(
        'Authoritative reservation details missing from checkout session. Please re-initialize checkout.'
      );
      return;
    }

    setIsSimulating(true);

    const confirmation: CustomerConfirmationDetails = {
      reservationId: checkoutResult.reservation_id,
      referenceCode: checkoutResult.reference_code,
      facilityName: activeFacility.name,
      facilityAddress: activeFacility.address || 'Metro Manila, Philippines',
      courtName: activeCourt.name,
      sportType: activeCourt.sport_type,
      bookingDate: selectedDate,
      timeSlotLabel: checkoutResult.time_slot_label || 'Reserved Slot',
      durationMinutes,
      totalPrice: Number(checkoutResult.expected_amount || activeCourt.hourly_rate),
      currency: activeFacility.currency || '₱',
      customerName,
      customerPhone,
      customerEmail,
      confirmedAt: new Date().toISOString(),
      isDemo: true,
      isSimulated: true,
    };

    setConfirmedPassDetails(confirmation);
    navigate('/book/confirmation');
  };

  const handleRetry = async () => {
    const attemptStorageKey = `courtbook_attempt_${currentSlotSignature}`;
    try {
      sessionStorage.removeItem(attemptStorageKey);
    } catch {}
    lastCreatedSignatureRef.current = null;
    inFlightRef.current = false;
    setCheckoutResult(null);
  };

  return (
    <BookingPageLayout
      currentStep={6}
      title="Review & Complete Payment"
      subtitle="Pay securely via PayMongo (GCash, Maya, Credit/Debit Card, Bank Transfer)"
      backUrl="/book/details"
    >
      <PaymentCheckoutBridge
        checkoutResult={checkoutResult}
        isLoading={isLoading}
        errorMessage={errorMessage}
        isDemoFacility={Boolean(activeFacility?.is_demo)}
        onSimulateSuccess={handleSimulatePaymentSuccess}
        onRetry={handleRetry}
        onCancel={() => navigate('/book/schedule')}
      />
    </BookingPageLayout>
  );
};
