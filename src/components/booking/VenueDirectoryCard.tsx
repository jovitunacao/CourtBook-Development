import React from 'react';
import {
  MapPin,
  Clock,
  ArrowRight,
  ShieldCheck,
  Trophy,
  Sparkles,
  Wifi,
  Car,
  ShowerHead,
  Zap,
  Wind,
  Store,
} from 'lucide-react';
import { SupabaseFacility, SupabaseCourt } from '../../lib/supabaseClient';
import { formatHour12 } from '../../types/booking';
import { SPORTS_REGISTRY } from '../../data/sportsRegistry';

interface VenueDirectoryCardProps {
  facility: SupabaseFacility;
  courts: SupabaseCourt[];
  onSelectVenue: (facilityId: string) => void;
  selectedSport?: string | null;
}

export const VenueDirectoryCard: React.FC<VenueDirectoryCardProps> = ({
  facility,
  courts,
  onSelectVenue,
  selectedSport,
}) => {
  const enabledCourts = courts.filter((c) => c.facility_id === facility.id && c.is_enabled);

  // Sports hosted at this venue
  const sports = Array.from(new Set(enabledCourts.map((c) => c.sport_type).filter(Boolean)));

  // Minimum hourly rate
  const rates = enabledCourts.map((c) => Number(c.hourly_rate)).filter((r) => r > 0);
  const minRate = rates.length > 0 ? Math.min(...rates) : facility.default_hourly_rate || 350;

  // Derive sport-matched photo
  const primarySportName = selectedSport || sports[0] || 'Pickleball';
  const sportDef = SPORTS_REGISTRY.find(
    (s) => s.name.toLowerCase() === primarySportName.toLowerCase() || s.id === primarySportName.toLowerCase()
  );
  const coverImage =
    sportDef?.bannerUrl ||
    'https://images.unsplash.com/photo-1599474924187-334a4ae5bd3c?auto=format&fit=crop&w=800&q=80';

  // Standard venue amenities simulation/display based on facility characteristics
  const amenities = [
    { label: 'Indoor Cushioned', icon: Wind },
    { label: 'LED Floodlights', icon: Zap },
    { label: 'Free Parking', icon: Car },
    { label: 'Shower Rooms', icon: ShowerHead },
  ];

  const openHour = facility.open_hour ?? 8;
  const closeHour = facility.close_hour ?? 22;

  return (
    <div
      data-testid={`venue-card-${facility.id}`}
      className="bg-white rounded-3xl border border-slate-200/90 overflow-hidden shadow-xs hover:shadow-lg hover:border-blue-400 transition-all flex flex-col justify-between group"
    >
      <div>
        {/* Cover Photo with Badges */}
        <div className="relative h-48 w-full bg-slate-900 overflow-hidden">
          <img
            src={coverImage}
            alt={facility.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 opacity-90"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-black/20" />

          {/* Pricing Tag */}
          <div className="absolute top-3 right-3 bg-white/95 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-200/80 shadow-md">
            <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500">From</div>
            <div className="text-sm font-extrabold text-slate-900 leading-none">
              {facility.currency || '₱'}{minRate.toLocaleString('en-PH', { minimumFractionDigits: 0 })}
              <span className="text-[10px] font-medium text-slate-500">/hr</span>
            </div>
          </div>

          {/* Business Verification or Demo Badge */}
          {facility.is_demo ? (
            <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/95 backdrop-blur-md text-white text-[10px] font-extrabold tracking-wider uppercase shadow-xs">
              <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
              <span>DEMO VENUE</span>
            </div>
          ) : (
            <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/90 backdrop-blur-md text-white text-[11px] font-bold shadow-xs">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Verified Venue</span>
            </div>
          )}

          {/* Bottom Photo Overlay Info */}
          <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-white">
            <span className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-black/40 backdrop-blur-md">
              {enabledCourts.length} {enabledCourts.length === 1 ? 'Court' : 'Courts'} Available
            </span>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-blue-600/90 backdrop-blur-md">
              Instant Booking
            </span>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-5 sm:p-6 space-y-4">
          <div>
            <h3 className="text-lg sm:text-xl font-extrabold text-slate-900 tracking-tight group-hover:text-blue-600 transition-colors">
              {facility.name}
            </h3>
            {facility.tagline && (
              <p className="text-xs text-slate-500 mt-1 line-clamp-1">
                {facility.tagline}
              </p>
            )}
          </div>

          {/* Location & Hours */}
          <div className="space-y-2 text-xs text-slate-600">
            <div className="flex items-start gap-2">
              <MapPin className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
              <span className="line-clamp-2">{facility.address || 'Metro Manila, Philippines'}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-slate-400 shrink-0" />
              <span>
                {formatHour12(openHour)} – {formatHour12(closeHour)} ({facility.timezone || 'Asia/Manila'})
              </span>
            </div>
          </div>

          {/* Sports Hosted */}
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1">
              <Trophy className="w-3 h-3 text-blue-600" />
              <span>Supported Sports</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {sports.map((sport) => {
                const isMatched = selectedSport?.toLowerCase() === sport.toLowerCase();
                return (
                  <span
                    key={sport}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-colors ${
                      isMatched
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    {sport}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Venue Amenities */}
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-amber-500" />
              <span>Amenities & Features</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 text-[11px] text-slate-600 font-medium">
              {amenities.map((amenity, idx) => {
                const IconComponent = amenity.icon;
                return (
                  <div key={idx} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-50 border border-slate-100">
                    <IconComponent className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    <span className="truncate">{amenity.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Card Action Footer */}
      <div className="p-5 sm:p-6 pt-0">
        <button
          type="button"
          onClick={() => onSelectVenue(facility.id)}
          className="w-full py-3.5 px-4 rounded-2xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-xs sm:text-sm font-extrabold flex items-center justify-center gap-2 transition-all cursor-pointer shadow-sm shadow-blue-500/20 group-hover:scale-[1.01]"
        >
          <span>Select Venue & View Schedule</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
