// ==============================================================================
// CourtBook / BookSuite — Step 3: Venue Directory Page
// File: src/pages/book/VenueDirectoryPage.tsx
// Route: /book/venues
// ==============================================================================

import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2,
  Filter,
  MapPin,
  Trophy,
  X,
  RotateCcw,
  Loader2,
  AlertCircle,
  Database,
  Sparkles,
} from 'lucide-react';
import { BookingPageLayout } from '../../components/booking/BookingPageLayout';
import { useCustomerBooking } from '../../context/CustomerBookingContext';
import { VenueDirectoryCard } from '../../components/booking/VenueDirectoryCard';

export const VenueDirectoryPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    inventorySource,
    setInventorySource,
    isConfigured,
    selectedSport,
    selectedLocation,
    setSelectedSport,
    setSelectedLocation,
    setSelectedFacilityId,
    filteredFacilities,
    facilities,
    courts,
    isLoadingFacilities,
    facilitiesError,
  } = useCustomerBooking();

  const handleSelectVenue = (facilityId: string) => {
    setSelectedFacilityId(facilityId);
    navigate('/book/schedule');
  };

  const handleClearFilters = () => {
    setSelectedSport(null);
    setSelectedLocation(null);
  };

  const hasActiveFilters = Boolean(selectedSport || selectedLocation);

  return (
    <BookingPageLayout
      currentStep={3}
      title="Browse Court Businesses"
      subtitle="Select a verified sports facility to check real-time court availability"
      backUrl="/book/location"
    >
      <div className="space-y-6">
        {/* Inventory Source Bar & Status */}
        <div className="bg-white rounded-3xl border border-slate-200/90 p-4 sm:p-5 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-blue-600 shrink-0" />
            <div className="text-xs">
              <span className="font-bold text-slate-800">Inventory Mode: </span>
              {inventorySource === 'live' ? (
                <span className="text-emerald-700 font-extrabold bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
                  Live Supabase Database
                </span>
              ) : (
                <span className="text-amber-800 font-extrabold bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md">
                  Demo Test Dataset (12 Venues / 36 Courts)
                </span>
              )}
            </div>
          </div>

          {/* Toggle between Live and Demo if Supabase is configured */}
          {isConfigured && (
            <div className="flex items-center gap-1.5 self-start sm:self-auto bg-slate-100 p-1 rounded-xl">
              <button
                type="button"
                onClick={() => setInventorySource('live')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  inventorySource === 'live'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Live Venues
              </button>
              <button
                type="button"
                onClick={() => setInventorySource('demo')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  inventorySource === 'demo'
                    ? 'bg-white text-amber-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Demo Dataset
              </button>
            </div>
          )}
        </div>

        {/* Active Filters Bar */}
        <div className="bg-white rounded-3xl border border-slate-200/90 p-4 sm:p-5 shadow-xs flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
              <Filter className="w-3.5 h-3.5 text-blue-600" />
              <span>Filters:</span>
            </span>

            {selectedSport ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-blue-50 text-blue-700 text-xs font-bold border border-blue-200">
                <Trophy className="w-3 h-3 text-blue-600" />
                <span>{selectedSport}</span>
                <button
                  type="button"
                  onClick={() => setSelectedSport(null)}
                  className="hover:text-blue-900 p-0.5 rounded cursor-pointer"
                  title="Remove sport filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ) : (
              <span className="text-xs font-semibold text-slate-400">
                All Sports
              </span>
            )}

            {selectedLocation ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-emerald-50 text-emerald-700 text-xs font-bold border border-emerald-200">
                <MapPin className="w-3 h-3 text-emerald-600" />
                <span className="max-w-[200px] truncate">
                  {selectedLocation.barangay ? `${selectedLocation.barangay}, ` : ''}
                  {selectedLocation.city}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedLocation(null)}
                  className="hover:text-emerald-900 p-0.5 rounded cursor-pointer"
                  title="Remove location filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ) : (
              <span className="text-xs font-semibold text-slate-400">
                Nationwide
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-slate-600">
              {filteredFacilities.length} {filteredFacilities.length === 1 ? 'Venue' : 'Venues'} Listed
            </span>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleClearFilters}
                className="text-xs font-bold text-slate-500 hover:text-red-600 flex items-center gap-1 cursor-pointer transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Reset Filters</span>
              </button>
            )}
          </div>
        </div>

        {/* Loading State */}
        {isLoadingFacilities && (
          <div className="py-20 text-center space-y-3 bg-white rounded-3xl border border-slate-200">
            <Loader2 className="w-7 h-7 animate-spin text-blue-600 mx-auto" />
            <p className="text-xs font-semibold text-slate-500">
              Querying database for verified court facilities...
            </p>
          </div>
        )}

        {/* Error State */}
        {!isLoadingFacilities && facilitiesError && (
          <div className="bg-white rounded-3xl border border-red-200 p-8 text-center space-y-4 max-w-lg mx-auto shadow-xs">
            <div className="w-12 h-12 rounded-2xl bg-red-50 text-red-600 flex items-center justify-center mx-auto">
              <AlertCircle className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-bold text-slate-900">Database Connection Error</h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                {facilitiesError}
              </p>
            </div>
            <div className="pt-2 flex justify-center gap-3">
              <button
                type="button"
                onClick={() => setInventorySource('demo')}
                className="px-5 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800"
              >
                Switch to Demo Dataset (12 Venues)
              </button>
            </div>
          </div>
        )}

        {/* Empty State: Live Database has 0 facilities */}
        {!isLoadingFacilities && !facilitiesError && facilities.length === 0 && (
          <div className="bg-white rounded-3xl border border-slate-200 p-10 text-center space-y-4 max-w-md mx-auto shadow-xs">
            <div className="w-14 h-14 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
              <Building2 className="w-7 h-7" />
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-bold text-slate-900">No Facilities in Database</h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                The connected Supabase database currently has 0 registered court facilities. No sample records were silently substituted into your live inventory.
              </p>
            </div>
            <div className="pt-2 flex justify-center gap-3">
              <button
                type="button"
                onClick={() => setInventorySource('demo')}
                className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition-colors cursor-pointer"
              >
                Explore Demo Dataset (12 Venues)
              </button>
            </div>
          </div>
        )}

        {/* Filter Mismatch Empty State: Facilities exist, but 0 match current filter */}
        {!isLoadingFacilities && !facilitiesError && facilities.length > 0 && filteredFacilities.length === 0 && (
          <div className="bg-white rounded-3xl border border-slate-200 p-10 text-center space-y-4 max-w-md mx-auto shadow-xs">
            <div className="w-14 h-14 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
              <Building2 className="w-7 h-7" />
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-bold text-slate-900">No Matching Venues Found</h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                No active court businesses matched your location or sport filters. Try clearing the location filter or choosing "All Sports".
              </p>
            </div>
            <div className="pt-2 flex justify-center gap-3">
              <button
                type="button"
                onClick={handleClearFilters}
                className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition-colors cursor-pointer"
              >
                Clear Filters &amp; View All {facilities.length} Venues
              </button>
            </div>
          </div>
        )}

        {/* Venues Grid */}
        {!isLoadingFacilities && !facilitiesError && filteredFacilities.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredFacilities.map((facility) => (
              <VenueDirectoryCard
                key={facility.id}
                facility={facility}
                courts={courts}
                selectedSport={selectedSport}
                onSelectVenue={handleSelectVenue}
              />
            ))}
          </div>
        )}
      </div>
    </BookingPageLayout>
  );
};
