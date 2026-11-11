// ==============================================================================
// CourtBook / BookSuite — Step 7: Booking Confirmation Page
// File: src/pages/book/ConfirmationPage.tsx
// Route: /book/confirmation
// ==============================================================================

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Calendar, ArrowRight } from 'lucide-react';
import { BookingPageLayout } from '../../components/booking/BookingPageLayout';
import { useCustomerBooking } from '../../context/CustomerBookingContext';
import { BookingConfirmationCard } from '../../components/booking/BookingConfirmationCard';

export const ConfirmationPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    confirmedPassDetails,
    resetBooking,
  } = useCustomerBooking();

  if (!confirmedPassDetails) {
    return (
      <BookingPageLayout
        currentStep={7}
        title="Booking Confirmation"
        subtitle="View your digital court reservation ticket"
      >
        <div className="bg-white rounded-3xl border border-slate-200 p-8 text-center space-y-4 max-w-md mx-auto shadow-xs">
          <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
            <Calendar className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-bold text-slate-900">No Active Confirmation Found</h3>
            <p className="text-xs text-slate-500">
              You haven't completed a court reservation yet, or the previous confirmation has expired.
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
