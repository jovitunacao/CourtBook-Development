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

  // Missing prerequisites check
  const isMissingPrerequisites =
    !activeFacility ||
    !activeCourt ||
    !selectedStartTimeIso ||
    !customerName.trim() ||
    !customerPhone.trim();

  // Initiate checkout session on mount if not already created
  useEffect(() => {
    if (isMissingPrerequisites) return;
    if (checkoutResult && checkoutResult.success) return;

    let isMounted = true;

    async function initCheckout() {
      setIsLoading(true);
      setErrorMessage(null);

      const idempotencyKey = `idem_page_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

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
      });

      if (isMounted) {
        setIsLoading(false);
        if (res.success) {
          setCheckoutResult(res);
        } else {
          setErrorMessage(res.error || 'Failed to initialize payment checkout session.');
        }
      }
    }

    initCheckout();

    return () => {
      isMounted = false;
    };
  }, [
    isMissingPrerequisites,
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
            className="px-5 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700"
          >
            Enter Guest Details
          </button>
        </div>
      </BookingPageLayout>
    );
  }

  // Handle successful payment simulation / webhook capture
  const handleSimulatePaymentSuccess = () => {
    if (!activeFacility || !activeCourt || !checkoutResult) return;

    const startDate = new Date(selectedStartTimeIso || new Date().toISOString());
    const startH = startDate.getHours() % 12 || 12;
    const startM = String(startDate.getMinutes()).padStart(2, '0');
    const ampm = startDate.getHours() < 12 ? 'AM' : 'PM';

    const confirmation: CustomerConfirmationDetails = {
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

    setConfirmedPassDetails(confirmation);
    navigate('/book/confirmation');
  };

  const handleRetry = async () => {
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
        onSimulateSuccess={handleSimulatePaymentSuccess}
        onRetry={handleRetry}
        onCancel={() => navigate('/book/schedule')}
      />
    </BookingPageLayout>
  );
};
