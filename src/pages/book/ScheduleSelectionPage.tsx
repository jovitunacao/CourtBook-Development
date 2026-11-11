// ==============================================================================
// CourtBook / BookSuite — Step 4: Schedule Selection Page
// File: src/pages/book/ScheduleSelectionPage.tsx
// Route: /book/schedule
// ==============================================================================

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, ChevronDown, Sparkles } from 'lucide-react';
import { BookingPageLayout } from '../../components/booking/BookingPageLayout';
import { useCustomerBooking } from '../../context/CustomerBookingContext';
import { CourtSlotPicker } from '../../components/booking/CourtSlotPicker';

export const ScheduleSelectionPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    activeFacility,
    activeCourt,
    allFacilities,
    allCourts,
    selectedCourtId,
    selectedDate,
    selectedStartTimeIso,
    durationMinutes,
    setSelectedFacilityId,
    setSelectedCourtId,
    setSchedule,
  } = useCustomerBooking();

  // If activeFacility is somehow null, redirect to /book/venues
  if (!activeFacility) {
    return (
      <BookingPageLayout
        currentStep={4}
        title="Select Court & Schedule"
        subtitle="Choose your preferred court, date, duration and time slot"
        backUrl="/book/venues"
      >
        <div className="bg-white rounded-3xl border border-slate-200 p-8 text-center space-y-4">
          <p className="text-sm text-slate-600">Please choose a sports venue first.</p>
          <button
            type="button"
            onClick={() => navigate('/book/venues')}
            className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-bold"
          >
            Browse Venues
          </button>
        </div>
      </BookingPageLayout>
    );
  }

  const handleProceed = () => {
    if (!selectedStartTimeIso) return;
    navigate('/book/details');
  };

  return (
    <BookingPageLayout
      currentStep={4}
      title="Select Court & Schedule"
      subtitle="Choose your preferred court, date, duration and available time slot"
      backUrl="/book/venues"
    >
      <div className="space-y-6">
        {/* Venue Switcher Bar */}
        <div className="bg-white rounded-3xl border border-slate-200/90 p-4 sm:p-5 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Active Venue
                </span>
                {activeFacility.is_demo && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-extrabold bg-amber-100 text-amber-800 border border-amber-200">
                    DEMO
                  </span>
                )}
              </div>
              <h2 className="text-base font-extrabold text-slate-900 leading-tight">
                {activeFacility.name}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5 truncate max-w-sm sm:max-w-md">
                {activeFacility.address}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => navigate('/book/venues')}
            className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition-colors cursor-pointer self-start sm:self-center"
          >
            Change Venue
          </button>
        </div>

        {/* Real-time Court Slot Picker Component */}
        <div className="bg-white rounded-3xl border border-slate-200/90 p-5 sm:p-8 shadow-xs">
          <CourtSlotPicker
            facility={activeFacility}
            courts={allCourts}
            selectedCourtId={selectedCourtId}
            onSelectCourt={setSelectedCourtId}
            selectedDate={selectedDate}
            onSelectDate={(d) => setSchedule(d, null, durationMinutes)}
            selectedStartTime={selectedStartTimeIso}
            onSelectStartTime={(iso) => setSchedule(selectedDate, iso, durationMinutes)}
            durationMinutes={durationMinutes}
            onSelectDuration={(mins) => setSchedule(selectedDate, selectedStartTimeIso, mins)}
            onProceed={handleProceed}
            onBack={() => navigate('/book/venues')}
          />
        </div>
      </div>
    </BookingPageLayout>
  );
};
