// ==============================================================================
// CourtBook / BookSuite — Step 7: Booking Confirmation Page
// File: src/pages/book/ConfirmationPage.tsx
// Route: /book/confirmation
// ==============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Calendar, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { BookingPageLayout } from '../../components/booking/BookingPageLayout';
import { useCustomerBooking } from '../../context/CustomerBookingContext';
import { BookingConfirmationCard } from '../../components/booking/BookingConfirmationCard';
import {
  verifyPublicBookingPaymentStatus,
  VerifyBookingPaymentStatusResult,
} from '../../lib/supabaseClient';
import { CustomerConfirmationDetails } from '../../types/customerBooking';

function buildAuthoritativeConfirmation(
  res: VerifyBookingPaymentStatusResult
): CustomerConfirmationDetails | null {
  if (
    !res.verified ||
    res.status !== 'confirmed' ||
    !res.reservation_id ||
    !res.reference_code ||
    !res.facility_name ||
    !res.court_name ||
    !res.booking_date ||
    !res.time_slot_label ||
    res.total_price === undefined ||
    !res.confirmed_at
  ) {
    return null;
  }

  return {
    reservationId: res.reservation_id,
    referenceCode: res.reference_code,
    facilityName: res.facility_name,
    facilityAddress: res.facility_address || '',
    courtName: res.court_name,
    sportType: res.sport_type || 'Court Sports',
    bookingDate: res.booking_date,
    timeSlotLabel: res.time_slot_label,
    durationMinutes: res.duration_minutes || 60,
    totalPrice: res.total_price,
    currency: res.currency || '₱',
    customerName: res.customer_name || 'Verified Guest',
    confirmedAt: res.confirmed_at,
    isDemo: false,
    isSimulated: false,
  };
}

export const ConfirmationPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryRef = searchParams.get('ref');
  const queryToken = searchParams.get('token');
  const queryRes = searchParams.get('res');
  const queryPay = searchParams.get('pay');

  const {
    confirmedPassDetails,
    setConfirmedPassDetails,
    checkoutResult,
    setCheckoutResult,
    customerPhone,
    customerEmail,
    resetBooking,
  } = useCustomerBooking();

  // Capture one-time URL credentials into ephemeral component state and strip them from the browser URL/history
  const [capturedToken, setCapturedToken] = useState<string | null>(() => queryToken);
  const [capturedResId, setCapturedResId] = useState<string | null>(() => queryRes);
  const [capturedPayId, setCapturedPayId] = useState<string | null>(() => queryPay);

  useEffect(() => {
    if (queryToken && queryToken !== capturedToken) setCapturedToken(queryToken);
    if (queryRes && queryRes !== capturedResId) setCapturedResId(queryRes);
    if (queryPay && queryPay !== capturedPayId) setCapturedPayId(queryPay);

    if (queryToken || queryRes || queryPay) {
      const nextUrl = queryRef
        ? `/book/confirmation?ref=${encodeURIComponent(queryRef)}`
        : '/book/confirmation';
      navigate(nextUrl, { replace: true });
    }
  }, [queryRef, queryToken, queryRes, queryPay, capturedToken, capturedResId, capturedPayId, navigate]);

  const [isLoadingRef, setIsLoadingRef] = useState<boolean>(false);
  const [refError, setRefError] = useState<string | null>(null);
  const [lastStatus, setLastStatus] = useState<string | null>(null);
  const [recoveryContact, setRecoveryContact] = useState<string>('');
  const [isVerifyingContact, setIsVerifyingContact] = useState<boolean>(false);

  const effectiveToken = capturedToken || checkoutResult?.lookup_token || '';
  const effectiveContact = (customerPhone || customerEmail || '').trim();
  const hasAutoVerificationCredential = Boolean(effectiveToken || effectiveContact);

  const runAuthoritativeLookup = useCallback(async () => {
    if (!queryRef) return;

    if (!effectiveToken && !effectiveContact) {
      return;
    }

    const targetResId = capturedResId || checkoutResult?.reservation_id;
    const targetPayId = capturedPayId || checkoutResult?.payment_id;

    setIsLoadingRef(true);
    setRefError(null);

    const res = await verifyPublicBookingPaymentStatus({
      reference_code: queryRef,
      reservation_id: targetResId || undefined,
      payment_id: targetPayId || undefined,
      lookup_token: effectiveToken || undefined,
      customer_phone_or_email: effectiveContact || undefined,
    });

    setIsLoadingRef(false);
    setLastStatus(res.status);

    const authoritativePass = buildAuthoritativeConfirmation(res);
    if (authoritativePass) {
      setConfirmedPassDetails(authoritativePass);
      setCapturedToken(null);
      if (checkoutResult?.lookup_token) {
        const { lookup_token: _omitToken, ...rest } = checkoutResult;
        setCheckoutResult(rest);
      }
    } else if (res.verified && res.status === 'confirmed') {
      setRefError(
        'Server verified payment, but complete authoritative booking details were unavailable. Please refresh to retry.'
      );
    } else if (res.status === 'failed' || res.status === 'cancelled' || res.status === 'expired') {
      setRefError(
        res.error ||
          `Booking status is "${res.status}". No confirmed reservation was created for this reference.`
      );
    } else {
      setRefError(
        res.error ||
          'Payment capture is still pending confirmation from the payment provider webhook. Please refresh shortly.'
      );
    }
  }, [
    queryRef,
    effectiveToken,
    effectiveContact,
    capturedResId,
    capturedPayId,
    checkoutResult,
    setCheckoutResult,
    setConfirmedPassDetails,
  ]);

  // Auto-verify when returning from hosted checkout with queryRef and valid authorization (token or guest contact)
  useEffect(() => {
    if (!queryRef || confirmedPassDetails || !hasAutoVerificationCredential) return;
    runAuthoritativeLookup();
  }, [queryRef, confirmedPassDetails, hasAutoVerificationCredential, runAuthoritativeLookup]);

  // Manual guest recovery verification when returning without existing booking context/token
  const handleManualContactVerification = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!queryRef || !recoveryContact.trim()) return;

    setIsVerifyingContact(true);
    setRefError(null);

    const res = await verifyPublicBookingPaymentStatus({
      reference_code: queryRef,
      reservation_id: capturedResId || undefined,
      lookup_token: effectiveToken || undefined,
      customer_phone_or_email: recoveryContact.trim(),
    });

    setIsVerifyingContact(false);
    setLastStatus(res.status);

    const authoritativePass = buildAuthoritativeConfirmation(res);
    if (authoritativePass) {
      setConfirmedPassDetails(authoritativePass);
      setCapturedToken(null);
    } else {
      setRefError(
        res.error ||
          'Unable to verify a confirmed payment with the provided contact details. Please check and try again.'
      );
    }
  };

  if (isLoadingRef) {
    return (
      <BookingPageLayout
        currentStep={7}
        title="Verifying Payment..."
        subtitle="Retrieving server-verified reservation, capture evidence, and settlement status"
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

  // If returning customer has a reference code but lacks session booking context & token, require contact verification
  if (!confirmedPassDetails && queryRef && !hasAutoVerificationCredential) {
    return (
      <BookingPageLayout
        currentStep={7}
        title="Recover Your Booking Pass"
        subtitle={`Booking reference ${queryRef} detected. Verify your contact to retrieve your pass.`}
      >
        <div className="bg-white rounded-3xl border border-slate-200 p-8 space-y-5 max-w-md mx-auto shadow-xs">
          <div className="text-center space-y-1.5">
            <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
              <Calendar className="w-6 h-6" />
            </div>
            <h3 className="text-base font-bold text-slate-900">Verify Guest Contact</h3>
            <p className="text-xs text-slate-500">
              To protect customer privacy, enter the mobile number or email address used when reserving this court.
            </p>
          </div>

          {refError && (
            <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-700 font-medium">
              {refError}
            </div>
          )}

          <form onSubmit={handleManualContactVerification} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Booking Phone or Email Address
              </label>
              <input
                type="text"
                value={recoveryContact}
                onChange={(e) => setRecoveryContact(e.target.value)}
                placeholder="e.g. 09171234567 or player@example.com"
                required
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
              />
            </div>

            <button
              type="submit"
              disabled={isVerifyingContact || !recoveryContact.trim()}
              className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-2"
            >
              {isVerifyingContact ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Verifying Against Server...
                </>
              ) : (
                'Retrieve Verified Booking Pass'
              )}
            </button>
          </form>

          <div className="pt-2 text-center">
            <button
              type="button"
              onClick={() => navigate('/book/sport')}
              className="text-xs text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
            >
              Start New Court Booking Instead
            </button>
          </div>
        </div>
      </BookingPageLayout>
    );
  }

  if (!confirmedPassDetails) {
    const canRetryPending = Boolean(queryRef && hasAutoVerificationCredential && (!lastStatus || lastStatus === 'pending' || lastStatus === 'processing'));

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
              {refError
                ? lastStatus === 'failed' || lastStatus === 'cancelled' || lastStatus === 'expired'
                  ? 'Booking Not Confirmed'
                  : 'Payment Pending Verification'
                : 'No Active Confirmation Found'}
            </h3>
            <p className="text-xs text-slate-500">
              {refError || "You haven't completed a court reservation yet, or the previous confirmation has expired."}
            </p>
          </div>

          <div className="flex flex-col gap-2.5 pt-1">
            {canRetryPending && (
              <button
                type="button"
                onClick={runAuthoritativeLookup}
                className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition-colors cursor-pointer inline-flex items-center justify-center gap-2"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Check Payment Status Again
              </button>
            )}
            <button
              type="button"
              onClick={() => navigate('/book/sport')}
              className={`px-6 py-2.5 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
                canRetryPending
                  ? 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                  : 'bg-blue-600 hover:bg-blue-700 text-white'
              }`}
            >
              Start New Court Booking
            </button>
          </div>
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
