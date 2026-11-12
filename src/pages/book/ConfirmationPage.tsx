// ==============================================================================
// CourtBook / BookSuite — Step 7: Booking Confirmation Page
// File: src/pages/book/ConfirmationPage.tsx
// Route: /book/confirmation
// ==============================================================================

import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Calendar, ArrowRight, Loader2, AlertCircle } from 'lucide-react';
import { BookingPageLayout } from '../../components/booking/BookingPageLayout';
import { useCustomerBooking } from '../../context/CustomerBookingContext';
import { BookingConfirmationCard } from '../../components/booking/BookingConfirmationCard';
import { verifyPublicBookingPaymentStatus } from '../../lib/supabaseClient';

export const ConfirmationPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryRef = searchParams.get('ref');

  const {
    confirmedPassDetails,
    setConfirmedPassDetails,
    checkoutResult,
    resetBooking,
  } = useCustomerBooking();

  const [isLoadingRef, setIsLoadingRef] = useState<boolean>(false);
  const [refError, setRefError] = useState<string | null>(null);

  // If returning with ?ref= and no confirmedPassDetails, verify backend state
  useEffect(() => {
    if (!queryRef || confirmedPassDetails) return;

    let isMounted = true;
    async function verifyFromRef() {
      setIsLoadingRef(true);
      setRefError(null);

      const res = await verifyPublicBookingPaymentStatus({
        reference_code: queryRef!,
        reservation_id: checkoutResult?.reservation_id || '',
        payment_id: checkoutResult?.payment_id,
      });

      if (isMounted) {
        setIsLoadingRef(false);
        if (res.verified && res.status === 'confirmed') {
          setConfirmedPassDetails({
            reservationId: res.reservation_id || 'verified-res',
            referenceCode: res.reference_code || queryRef!,
            facilityName: res.facility_name || 'Court Facility',
            facilityAddress: 'Location details available on digital pass',
            courtName: res.court_name || 'Reserved Court',
            sportType: 'Court Sports',
            bookingDate: res.booking_date || new Date().toISOString().split('T')[0],
            timeSlotLabel: res.time_slot_label || 'Reserved Time Slot',
            durationMinutes: 60,
            totalPrice: res.total_price || 0,
            currency: res.currency || '₱',
            customerName: 'Guest Player',
            confirmedAt: res.confirmed_at || new Date().toISOString(),
            isDemo: false,
            isSimulated: false,
          });
        } else {
          setRefError(
            res.error || 'Payment capture is still pending confirmation from the payment provider. Please refresh shortly.'
          );
        }
      }
    }

    verifyFromRef();

    return () => {
      isMounted = false;
    };
  }, [queryRef, confirmedPassDetails, checkoutResult, setConfirmedPassDetails]);

  if (isLoadingRef) {
    return (
      <BookingPageLayout
        currentStep={7}
        title="Verifying Payment..."
        subtitle="Retrieving server-verified reservation and capture evidence"
      >
        <div className="bg-white rounded-3xl border border-slate-200 p-8 text-center space-y-4 max-w-md mx-auto shadow-xs">
          <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-bold text-slate-900">Verifying Booking Status</h3>
            <p className="text-xs text-slate-500">
              Querying authoritative payment capture record for reference {queryRef}...
            </p>
          </div>
        </div>
      </BookingPageLayout>
    );
  }

  if (!confirmedPassDetails) {
    return (
      <BookingPageLayout
        currentStep={7}
        title="Booking Confirmation"
        subtitle="View your digital court reservation ticket"
      >
        <div className="bg-white rounded-3xl border border-slate-200 p-8 text-center space-y-4 max-w-md mx-auto shadow-xs">
          <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
            {refError ? <AlertCircle className="w-6 h-6 text-amber-600" /> : <Calendar className="w-6 h-6" />}
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-bold text-slate-900">
              {refError ? 'Payment Pending Verification' : 'No Active Confirmation Found'}
            </h3>
            <p className="text-xs text-slate-500">
              {refError || "You haven't completed a court reservation yet, or the previous confirmation has expired."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/book/sport')}
            className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition-colors cursor-pointer"
          >
            Start New Court Booking
          </button>
        </div>
      </BookingPageLayout>
    );
  }

  const handleBookAnother = () => {
    resetBooking();
    navigate('/book/sport');
  };

  const handleDone = () => {
    resetBooking();
    navigate('/');
  };

  return (
    <BookingPageLayout
      currentStep={7}
      title="Booking Confirmed!"
      subtitle="Your court reservation has been verified and recorded with an authoritative reference code"
    >
      <BookingConfirmationCard
        details={confirmedPassDetails}
        onBookAnother={handleBookAnother}
        onDone={handleDone}
      />
    </BookingPageLayout>
  );
};
