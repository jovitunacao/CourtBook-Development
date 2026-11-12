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
  verifyPublicBookingPaymentStatus,
  CreateBookingCheckoutResult,
} from '../../lib/supabaseClient';
import { CustomerConfirmationDetails } from '../../types/customerBooking';

export const PaymentReviewPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    inventorySource,
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

    // Check if previous checkout result has expired
    const isHoldExpired = Boolean(
      checkoutResult?.hold_expires_at &&
      new Date(checkoutResult.hold_expires_at).getTime() <= Date.now()
    );

    // If an authoritative unexpired checkout result already exists for this exact slot, reuse it
    if (
      checkoutResult &&
      checkoutResult.success &&
      !isHoldExpired &&
      lastCreatedSignatureRef.current === currentSlotSignature
    ) {
      return;
    }

    // If hold expired, clear stale attempt storage to generate a fresh booking attempt
    if (isHoldExpired) {
      const attemptStorageKey = `courtbook_attempt_${currentSlotSignature}`;
      try {
        sessionStorage.removeItem(attemptStorageKey);
      } catch {}
      lastCreatedSignatureRef.current = null;
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

      // CRITICAL DEMO ISOLATION:
      // Only explicitly selected frontend fictional inventory (inventorySource === 'demo')
      // may use the zero-network simulation path.
      // A Supabase-backed facility with is_demo = true is NOT a frontend-only demo and MUST
      // use the secured backend sandbox booking flow.
      const isFrontendDemo = inventorySource === 'demo';

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
        is_frontend_demo: isFrontendDemo,
        hourly_rate: Number(activeCourt!.hourly_rate),
        currency: activeFacility!.currency || '₱',
        court_name: activeCourt!.name,
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

  // Handle successful payment simulation (RESTRICTED TO EXPLICIT FRONTEND-ONLY DEMO INVENTORY)
  // Supabase facilities (even with is_demo = true) require authoritative backend verification.
  const handleSimulatePaymentSuccess = () => {
    if (!activeFacility || !activeCourt || !checkoutResult) return;

    // Strict guard: Only explicitly selected frontend fictional inventory (inventorySource === 'demo')
    // may use the frontend simulation path. Supabase-backed facilities must NOT bypass real payment.
    if (inventorySource !== 'demo') {
      setErrorMessage(
        'Payment simulation is disabled for Supabase-backed facilities. Please complete official payment verification via the backend.'
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

  const [isCheckingStatus, setIsCheckingStatus] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Authoritative status-check path for live/Supabase bookings
  const handleCheckPaymentStatus = async () => {
    if (!checkoutResult?.reference_code || !checkoutResult?.reservation_id || !activeFacility || !activeCourt) {
      return;
    }

    setIsCheckingStatus(true);
    setStatusMessage(null);

    const res = await verifyPublicBookingPaymentStatus({
      reference_code: checkoutResult.reference_code,
      reservation_id: checkoutResult.reservation_id,
      payment_id: checkoutResult.payment_id,
      customer_phone_or_email: customerPhone || customerEmail,
    });

    setIsCheckingStatus(false);

    if (res.verified && res.status === 'confirmed') {
      // Authoritative backend confirmed state established!
      const confirmation: CustomerConfirmationDetails = {
        reservationId: res.reservation_id || checkoutResult.reservation_id,
        referenceCode: res.reference_code || checkoutResult.reference_code,
        facilityName: res.facility_name || activeFacility.name,
        facilityAddress: activeFacility.address || 'Metro Manila, Philippines',
        courtName: res.court_name || activeCourt.name,
        sportType: activeCourt.sport_type,
        bookingDate: res.booking_date || selectedDate,
        timeSlotLabel: res.time_slot_label || checkoutResult.time_slot_label || 'Reserved Slot',
        durationMinutes,
        totalPrice: Number(res.total_price || checkoutResult.expected_amount || activeCourt.hourly_rate),
        currency: res.currency || activeFacility.currency || '₱',
        customerName,
        customerPhone,
        customerEmail,
        confirmedAt: res.confirmed_at || new Date().toISOString(),
        isDemo: false,
        isSimulated: false,
      };

      setConfirmedPassDetails(confirmation);
      navigate('/book/confirmation');
    } else if (res.status === 'expired') {
      setStatusMessage('This booking hold has expired. Please select a new time slot.');
      const attemptStorageKey = `courtbook_attempt_${currentSlotSignature}`;
      try {
        sessionStorage.removeItem(attemptStorageKey);
      } catch {}
      lastCreatedSignatureRef.current = null;
    } else if (res.status === 'failed' || res.status === 'cancelled') {
      setStatusMessage('Payment capture could not be completed or was cancelled.');
    } else {
      setStatusMessage(
        res.error || 'Payment confirmation is still pending from the provider webhook. If you have completed checkout, please wait a moment and try again.'
      );
    }
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
        isDemoFacility={inventorySource === 'demo'}
        isCheckingStatus={isCheckingStatus}
        statusMessage={statusMessage}
        onSimulateSuccess={handleSimulatePaymentSuccess}
        onCheckPaymentStatus={handleCheckPaymentStatus}
        onRetry={handleRetry}
        onCancel={() => navigate('/book/schedule')}
      />
    </BookingPageLayout>
  );
};
