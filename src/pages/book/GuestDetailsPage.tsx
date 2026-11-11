// ==============================================================================
// CourtBook / BookSuite — Step 5: Guest Details Page
// File: src/pages/book/GuestDetailsPage.tsx
// Route: /book/details
// ==============================================================================

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { UserCheck, AlertCircle, ArrowLeft } from 'lucide-react';
import { BookingPageLayout } from '../../components/booking/BookingPageLayout';
import { useCustomerBooking } from '../../context/CustomerBookingContext';
import { GuestCheckoutForm } from '../../components/booking/GuestCheckoutForm';

export const GuestDetailsPage: React.FC = () => {
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
    setGuestDetails,
  } = useCustomerBooking();

  // If missing previous required scheduling state, redirect back to schedule
  if (!activeFacility || !activeCourt || !selectedStartTimeIso) {
    return (
      <BookingPageLayout
        currentStep={5}
        title="Guest Information"
        subtitle="Provide guest details for your court booking reservation voucher"
        backUrl="/book/schedule"
      >
        <div className="bg-white rounded-3xl border border-amber-200 p-8 text-center space-y-4 max-w-md mx-auto">
          <div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto">
            <AlertCircle className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-bold text-slate-900">Court Slot Required</h3>
            <p className="text-xs text-slate-500">
              Please select a court and time slot before entering guest contact details.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/book/schedule')}
            className="px-5 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700"
          >
            Go to Schedule Selection
          </button>
        </div>
      </BookingPageLayout>
    );
  }

  const handleProceedToPayment = () => {
    navigate('/book/payment');
  };

  return (
    <BookingPageLayout
      currentStep={5}
      title="Guest Information"
      subtitle="Pure guest checkout with zero mandatory password or account registration"
      backUrl="/book/schedule"
    >
      <div className="bg-white rounded-3xl border border-slate-200/90 p-5 sm:p-8 shadow-xs">
        <GuestCheckoutForm
          facility={activeFacility}
          court={activeCourt}
          selectedDate={selectedDate}
          startTimeIso={selectedStartTimeIso}
          durationMinutes={durationMinutes}
          customerName={customerName}
          onNameChange={(name) => setGuestDetails(name, customerPhone, customerEmail)}
          customerPhone={customerPhone}
          onPhoneChange={(phone) => setGuestDetails(customerName, phone, customerEmail)}
          customerEmail={customerEmail}
          onEmailChange={(email) => setGuestDetails(customerName, customerPhone, email)}
          onProceedToPayment={handleProceedToPayment}
          onBack={() => navigate('/book/schedule')}
        />
      </div>
    </BookingPageLayout>
  );
};
