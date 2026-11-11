// ==============================================================================
// CourtBook / BookSuite — Step 2: Location Selection Page
// File: src/pages/book/LocationSelectionPage.tsx
// Route: /book/location
// ==============================================================================

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, MapPin, Sparkles, Navigation } from 'lucide-react';
import { BookingPageLayout } from '../../components/booking/BookingPageLayout';
import { useCustomerBooking } from '../../context/CustomerBookingContext';
import { LocationCascadeSelector } from '../../components/booking/LocationCascadeSelector';
import { PhilippineLocation } from '../../types/customerBooking';

export const LocationSelectionPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    selectedSport,
    selectedLocation,
    setSelectedLocation,
  } = useCustomerBooking();

  const handleSelectLocation = (loc: PhilippineLocation | null) => {
    setSelectedLocation(loc);
    navigate('/book/venues');
  };

  return (
    <BookingPageLayout
      currentStep={2}
      title="Choose Your Location"
      subtitle="Find court facilities by Philippine Region, Province, City, or Barangay"
      backUrl="/book/sport"
    >
      <div className="bg-white rounded-3xl border border-slate-200/90 p-5 sm:p-8 shadow-xs space-y-6">
        {/* Selected Sport Banner if applicable */}
        {selectedSport && (
          <div className="flex items-center justify-between p-3.5 rounded-2xl bg-blue-50/70 border border-blue-200/80 text-xs">
            <div className="flex items-center gap-2 text-blue-900 font-bold">
              <Sparkles className="w-4 h-4 text-blue-600" />
              <span>Looking for {selectedSport} Courts</span>
            </div>
            <button
              type="button"
              onClick={() => navigate('/book/sport')}
              className="text-blue-600 hover:text-blue-800 font-bold underline cursor-pointer"
            >
              Change Sport
            </button>
          </div>
        )}

        {/* Location Cascade & Search Selector */}
        <div className="space-y-4">
          <LocationCascadeSelector
            selectedLocation={selectedLocation}
            onSelectLocation={handleSelectLocation}
          />
        </div>

        {/* Bottom Actions */}
        <div className="pt-4 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => handleSelectLocation(null)}
            className="w-full sm:w-auto px-5 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition-colors cursor-pointer text-center"
          >
            Show All Venues Nationwide (No Location Filter)
          </button>

          <button
            type="button"
            onClick={() => navigate('/book/venues')}
            className="w-full sm:w-auto px-6 py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <span>Browse Venues</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </BookingPageLayout>
  );
};
