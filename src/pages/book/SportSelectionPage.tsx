// ==============================================================================
// CourtBook / BookSuite — Step 1: Sport Selection Page
// File: src/pages/book/SportSelectionPage.tsx
// Route: /book/sport
// ==============================================================================

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Trophy, Sparkles, CheckCircle2 } from 'lucide-react';
import { BookingPageLayout } from '../../components/booking/BookingPageLayout';
import { useCustomerBooking } from '../../context/CustomerBookingContext';
import { SPORTS_REGISTRY } from '../../data/sportsRegistry';
import { SportCategoryPills } from '../../components/booking/SportCategoryPills';

export const SportSelectionPage: React.FC = () => {
  const navigate = useNavigate();
  const { selectedSport, setSelectedSport, sportCounts } = useCustomerBooking();

  const handleSelectSport = (sportName: string | null) => {
    setSelectedSport(sportName);
    navigate('/book/location');
  };

  return (
    <BookingPageLayout
      currentStep={1}
      title="Choose Your Sport"
      subtitle="Select the sport or court game you want to book today"
    >
      <div className="bg-white rounded-3xl border border-slate-200/90 p-5 sm:p-8 shadow-xs space-y-8">
        {/* Top Sport Pills Filter */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Quick Filter
            </span>
            {selectedSport && (
              <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full border border-blue-200">
                Selected: {selectedSport}
              </span>
            )}
          </div>
          <SportCategoryPills
            selectedSport={selectedSport}
            onSelectSport={handleSelectSport}
            sportCounts={sportCounts}
          />
        </div>

        {/* Rich Sport Visual Cards Grid */}
        <div className="space-y-4 pt-4 border-t border-slate-100">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-extrabold text-slate-900">
              Featured Sports Categories
            </h2>
            <button
              type="button"
              onClick={() => handleSelectSport(null)}
              className="text-xs font-bold text-blue-600 hover:text-blue-700 hover:underline cursor-pointer flex items-center gap-1"
            >
              <span>Skip &amp; Browse All Venues</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {SPORTS_REGISTRY.map((sport) => {
              const count = sportCounts[sport.id] || 0;
              const isSelected = selectedSport?.toLowerCase() === sport.name.toLowerCase();

              return (
                <div
                  key={sport.id}
                  onClick={() => handleSelectSport(sport.name)}
                  className={`relative rounded-2xl border overflow-hidden p-4 flex flex-col justify-between transition-all cursor-pointer group text-left ${
                    isSelected
                      ? 'border-blue-500 bg-blue-50/40 ring-2 ring-blue-500/20 shadow-md'
                      : 'border-slate-200 bg-white hover:border-blue-300 hover:shadow-md'
                  }`}
                >
                  {/* Sport Header Image / Banner */}
                  <div className="h-32 -mx-4 -mt-4 mb-4 relative overflow-hidden bg-slate-900">
                    <img
                      src={sport.bannerUrl}
                      alt={sport.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 opacity-80"
                      loading="lazy"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-black/20 to-transparent" />
                    <div className="absolute top-2.5 right-2.5 bg-black/50 backdrop-blur-md px-2 py-0.5 rounded-md text-[10px] font-bold text-white uppercase">
                      {sport.standardDurationMinutes} mins standard
                    </div>
                    <div className="absolute bottom-2.5 left-3 text-white">
                      <div className="text-lg font-extrabold leading-tight">
                        {sport.name}
                      </div>
                      <div className="text-[11px] text-slate-300">
                        {count} {count === 1 ? 'court' : 'courts'} available
                      </div>
                    </div>
                  </div>

                  {/* Surface description and CTA */}
                  <div className="space-y-3">
                    <p className="text-xs text-slate-600 line-clamp-2 leading-relaxed">
                      {sport.tagline}
                    </p>

                    <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-slate-500 truncate max-w-[140px]">
                        {sport.popularSurfaces[0] || 'Standard Surface'}
                      </span>
                      <button
                        type="button"
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1 transition-colors ${
                          isSelected
                            ? 'bg-blue-600 text-white'
                            : 'bg-slate-100 text-slate-700 group-hover:bg-blue-600 group-hover:text-white'
                        }`}
                      >
                        <span>Select</span>
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Bottom Continue Action */}
        <div className="pt-4 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-slate-500 text-center sm:text-left">
            Not sure which sport? You can choose a location first and filter later.
          </p>
          <button
            type="button"
            onClick={() => handleSelectSport(null)}
            className="w-full sm:w-auto px-6 py-3 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <span>Continue to Location</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </BookingPageLayout>
  );
};
