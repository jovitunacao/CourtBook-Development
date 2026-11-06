import React from 'react';
import {
  MapPin,
  Clock,
  ArrowRight,
  Building2,
  AlertCircle,
  RefreshCw,
  Loader2,
  Trophy,
} from 'lucide-react';
import { SupabaseFacility, SupabaseCourt } from '../lib/supabaseClient';
import { formatHour12 } from '../types/booking';

interface VenueDirectoryProps {
  facilities: SupabaseFacility[];
  directoryCourts: SupabaseCourt[];
  isLoading: boolean;
  error: string | null;
  onSelectFacility: (facilityId: string) => void;
  onRetry: () => void;
}

export const VenueDirectory: React.FC<VenueDirectoryProps> = ({
  facilities,
  directoryCourts,
  isLoading,
  error,
  onSelectFacility,
  onRetry,
}) => {
  if (isLoading) {
    return (
      <div className="bg-slate-50 min-h-[calc(100vh-64px)] py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center max-w-2xl mx-auto mb-10 space-y-2">
            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
              Select a Court Venue
            </h1>
            <p className="text-sm text-slate-600">
              Loading active court businesses and facilities...
            </p>
          </div>

          <div
            data-testid="venue-directory-loading"
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
          >
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs animate-pulse space-y-4"
              >
                <div className="h-5 bg-slate-200 rounded w-2/3" />
                <div className="h-4 bg-slate-100 rounded w-1/2" />
                <div className="flex gap-2">
                  <div className="h-6 bg-slate-100 rounded-md w-20" />
                  <div className="h-6 bg-slate-100 rounded-md w-24" />
                </div>
                <div className="h-10 bg-slate-200 rounded-xl w-full pt-2" />
              </div>
            ))}
          </div>
          <div className="mt-8 flex items-center justify-center gap-2 text-xs font-semibold text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
            <span>Fetching venues from CourtBook directory...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-slate-50 min-h-[calc(100vh-64px)] py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-xl mx-auto">
          <div
            data-testid="venue-directory-error"
            className="bg-white rounded-2xl border border-red-200 p-6 sm:p-8 shadow-sm space-y-5"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-50 border border-red-200 text-red-600 flex items-center justify-center shrink-0">
                <AlertCircle className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h2 className="text-lg font-bold text-slate-900">
                  Unable to Load Venues
                </h2>
                <p className="text-xs text-slate-600 leading-relaxed">
                  We encountered an error while loading active court businesses. Please try again.
                </p>
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-red-50/70 border border-red-200 text-xs font-mono text-red-800 break-words">
              {error}
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={onRetry}
                className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (facilities.length === 0) {
    return (
      <div className="bg-slate-50 min-h-[calc(100vh-64px)] py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-xl mx-auto">
          <div
            data-testid="venue-directory-empty"
            className="bg-white rounded-2xl border border-slate-200 p-8 shadow-sm text-center space-y-4"
          >
            <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-500 flex items-center justify-center mx-auto">
              <Building2 className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-slate-900">
                No Venues Available
              </h2>
              <p className="text-xs text-slate-600 max-w-sm mx-auto leading-relaxed">
                There are currently no active court facilities listed in the directory. Please check back soon.
              </p>
            </div>
            <div className="pt-2">
              <button
                type="button"
                onClick={onRetry}
                className="px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold inline-flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Refresh Directory</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-slate-50 min-h-[calc(100vh-64px)] py-10 sm:py-14 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="text-center max-w-2xl mx-auto mb-10 space-y-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-bold uppercase tracking-wider">
            <Building2 className="w-3.5 h-3.5" />
            <span>CourtBook Venue Directory</span>
          </span>
          <h1 className="text-2xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
            Choose a Court Business
          </h1>
          <p className="text-sm sm:text-base text-slate-600">
            Select a facility below to view its live courts, hourly rates, and real-time availability.
          </p>
        </div>

        <div
          data-testid="venue-directory-grid"
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
        >
          {facilities.map((facility) => {
            const facilityCourts = directoryCourts.filter(
              (c) => c.facility_id === facility.id && c.is_enabled
            );
            const sports = Array.from(
              new Set(facilityCourts.map((c) => c.sport_type).filter(Boolean))
            );
            const openHour = facility.open_hour ?? 8;
            const closeHour = facility.close_hour ?? 22;

            return (
              <div
                key={facility.id}
                data-testid={`venue-card-${facility.id}`}
                className="bg-white rounded-2xl border border-slate-200/90 p-6 shadow-xs hover:shadow-md hover:border-blue-300 transition-all flex flex-col justify-between"
              >
                <div className="space-y-4">
                  <div>
                    <h2 className="text-lg font-extrabold text-slate-900 tracking-tight">
                      {facility.name}
                    </h2>
                    {facility.tagline && (
                      <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">
                        {facility.tagline}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2 text-xs text-slate-600">
                    <div className="flex items-start gap-2">
                      <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                      <span>{facility.address || 'Location details inside'}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-slate-400 shrink-0" />
                      <span>
                        {formatHour12(openHour)} – {formatHour12(closeHour)} ({facility.timezone || 'Asia/Manila'})
                      </span>
                    </div>
                  </div>

                  {/* Available Sports */}
                  <div className="pt-1">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1">
                      <Trophy className="w-3 h-3" />
                      <span>Available Sports</span>
                    </div>
                    {sports.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {sports.map((sport) => (
                          <span
                            key={sport}
                            className="px-2.5 py-1 rounded-md bg-blue-50 text-blue-700 border border-blue-100 text-xs font-semibold"
                          >
                            {sport}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="inline-block px-2.5 py-1 rounded-md bg-slate-100 text-slate-600 text-xs font-medium">
                        Multi-Sport Facility
                      </span>
                    )}
                  </div>
                </div>

                <div className="pt-6 mt-6 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => onSelectFacility(facility.id)}
                    className="w-full py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer shadow-xs"
                  >
                    <span>View Courts</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
