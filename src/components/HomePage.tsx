import React from 'react';
import {
  Calendar,
  Zap,
  Smartphone,
  Clock,
  MapPin,
  Check,
  ArrowRight,
  ShieldCheck,
  ChevronRight,
  Sparkles,
} from 'lucide-react';
import { FacilitySettings, formatHour12 } from '../types/booking';

interface HomePageProps {
  settings: FacilitySettings;
  onStartBooking: (courtId?: string) => void;
  onOpenAdmin: () => void;
  activeReservationsCount: number;
}

export const HomePage: React.FC<HomePageProps> = ({
  settings,
  onStartBooking,
  onOpenAdmin,
  activeReservationsCount,
}) => {
  const enabledCourts = settings.courts.filter((c) => c.isEnabled);
  const minRate = Math.min(...settings.courts.map((c) => c.hourlyRate));
  const maxRate = Math.max(...settings.courts.map((c) => c.hourlyRate));
  const rateLabel =
    minRate === maxRate
      ? `${settings.currency}${minRate}`
      : `${settings.currency}${minRate} – ${settings.currency}${maxRate}`;

  return (
    <div className="bg-white">
      {/* Hero Section */}
      <section className="relative overflow-hidden pt-10 pb-16 sm:pb-24 lg:pt-16">
        {/* Subtle background decoration */}
        <div className="absolute inset-0 pointer-events-none -z-10">
          <div className="absolute -top-40 right-1/2 translate-x-1/2 w-[700px] h-[350px] bg-gradient-to-b from-blue-50 to-transparent rounded-full blur-3xl opacity-70"></div>
          <div className="absolute top-60 right-10 w-72 h-72 bg-blue-100/40 rounded-full blur-2xl"></div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto space-y-6">
            {/* Pill tag */}
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-bold tracking-wide uppercase shadow-xs">
              <Sparkles className="w-3.5 h-3.5 text-blue-600" />
              <span>Simple &bull; Fast &bull; Instant Confirmation</span>
            </div>

            {/* Main Heading */}
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-slate-900 leading-[1.15]">
              Book Your Court in <span className="text-blue-600">Seconds.</span>
            </h1>

            {/* Short Explanation */}
            <p className="text-lg sm:text-xl text-slate-600 leading-relaxed max-w-2xl mx-auto">
              CourtBook is the streamlined reservation system built for pickleball & sports facilities.
              Check live court availability, select your hour, and reserve instantly without delays or hassle.
            </p>

            {/* CTA Buttons */}
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4">
              <button
                onClick={() => onStartBooking()}
                className="w-full sm:w-auto px-8 py-3.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold text-base rounded-xl shadow-md hover:shadow-blue-500/20 transition-all flex items-center justify-center gap-2 group cursor-pointer"
              >
                <span>Book a Court</span>
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </button>

              <button
                onClick={onOpenAdmin}
                className="w-full sm:w-auto px-6 py-3.5 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 font-semibold text-base rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer shadow-xs"
              >
                <ShieldCheck className="w-4 h-4 text-slate-500" />
                <span>Admin Reservations</span>
                {activeReservationsCount > 0 && (
                  <span className="bg-slate-100 text-slate-700 text-xs font-bold px-2 py-0.5 rounded-full border border-slate-200">
                    {activeReservationsCount} demo
                  </span>
                )}
              </button>
            </div>

            {/* Key trust bullets */}
            <div className="pt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs sm:text-sm text-slate-600 font-medium">
              <div className="flex items-center gap-1.5">
                <Check className="w-4 h-4 text-emerald-600" />
                <span>{rateLabel}/hr rates</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Check className="w-4 h-4 text-emerald-600" />
                <span>Zero upfront deposits required</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Check className="w-4 h-4 text-emerald-600" />
                <span>
                  {formatHour12(settings.openHour)} – {settings.closeHour === 24 ? 'Midnight' : formatHour12(settings.closeHour)} daily
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Feature Highlights Section */}
      <section className="py-16 bg-slate-50/75 border-y border-slate-200/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto mb-12">
            <h2 className="text-xs font-bold uppercase tracking-wider text-blue-600 mb-2">
              Why Players & Facilities Prefer CourtBook
            </h2>
            <p className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
              Designed for Speed & Simplicity
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Feature 1: Live Availability */}
            <div className="bg-white rounded-2xl p-8 border border-slate-200 shadow-xs hover:shadow-md transition-shadow relative group">
              <div className="w-12 h-12 rounded-xl bg-blue-100/80 text-blue-600 flex items-center justify-center mb-6 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                <Zap className="w-6 h-6" />
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-2">
                Live Availability
              </h3>
              <p className="text-slate-600 text-sm leading-relaxed mb-4">
                View real-time open and occupied court slots throughout daily operating hours. No more back-and-forth phone calls or waiting for chat replies.
              </p>
              <div className="flex items-center text-xs font-bold text-blue-600 gap-1">
                <span>Updated in real time</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </div>
            </div>

            {/* Feature 2: Easy Reservations */}
            <div className="bg-white rounded-2xl p-8 border border-slate-200 shadow-xs hover:shadow-md transition-shadow relative group">
              <div className="w-12 h-12 rounded-xl bg-blue-100/80 text-blue-600 flex items-center justify-center mb-6 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                <Calendar className="w-6 h-6" />
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-2">
                Easy Reservations
              </h3>
              <p className="text-slate-600 text-sm leading-relaxed mb-4">
                Pick your preferred court, select your one-hour slot, and provide your name. Your booking is confirmed with an instant reference code.
              </p>
              <div className="flex items-center text-xs font-bold text-blue-600 gap-1">
                <span>Instant reservation voucher</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </div>
            </div>

            {/* Feature 3: Mobile Friendly */}
            <div className="bg-white rounded-2xl p-8 border border-slate-200 shadow-xs hover:shadow-md transition-shadow relative group">
              <div className="w-12 h-12 rounded-xl bg-blue-100/80 text-blue-600 flex items-center justify-center mb-6 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                <Smartphone className="w-6 h-6" />
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-2">
                Mobile Friendly
              </h3>
              <p className="text-slate-600 text-sm leading-relaxed mb-4">
                Engineered with a responsive, thumb-friendly layout. Whether you are on your smartphone court-side or on your laptop at home, booking is effortless.
              </p>
              <div className="flex items-center text-xs font-bold text-blue-600 gap-1">
                <span>100% responsive design</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Featured Facility & Courts Section */}
      <section className="py-16 sm:py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Facility Header Card */}
          <div className="bg-slate-900 text-white rounded-3xl p-6 sm:p-10 mb-12 shadow-xl relative overflow-hidden">
            <div className="absolute right-0 top-0 translate-x-12 -translate-y-12 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl pointer-events-none"></div>

            <div className="relative z-10 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
              <div className="space-y-3">
                <div className="inline-flex items-center gap-2 bg-blue-500/20 text-blue-300 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider border border-blue-400/30">
                  <MapPin className="w-3.5 h-3.5 text-blue-400" />
                  <span>Featured Facility &bull; Sports & Athletic Club</span>
                </div>
                <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
                  {settings.name}
                </h2>
                <p className="text-slate-300 text-sm sm:text-base max-w-xl">
                  {settings.tagline} {settings.address ? `• ${settings.address}` : ''}
                </p>
                <div className="flex flex-wrap items-center gap-4 text-xs sm:text-sm text-slate-300 pt-2">
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-4 h-4 text-blue-400" />
                    <span>
                      {formatHour12(settings.openHour)} – {settings.closeHour === 24 ? 'Midnight' : formatHour12(settings.closeHour)} Daily
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 font-bold text-blue-400">
                    <span>From {rateLabel} per hour</span>
                  </div>
                </div>
              </div>

              <div>
                <button
                  onClick={() => onStartBooking()}
                  className="w-full sm:w-auto px-6 py-3.5 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Calendar className="w-4 h-4" />
                  <span>Select Date & Court</span>
                </button>
              </div>
            </div>
          </div>

          {/* Courts Grid */}
          <div className="mb-6">
            <h3 className="text-xl font-bold text-slate-900 mb-1">
              Available Sports Courts ({enabledCourts.length})
            </h3>
            <p className="text-sm text-slate-600">
              Select any court below to jump straight into time slot selection.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {settings.courts.map((court, idx) => {
              const isDisabled = !court.isEnabled;
              return (
                <div
                  key={court.id}
                  className={`bg-white rounded-2xl border p-6 flex flex-col justify-between transition-all ${
                    isDisabled
                      ? 'border-slate-200 bg-slate-50 opacity-60'
                      : 'border-slate-200 hover:border-blue-300 hover:shadow-md group'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                          {court.sportType}
                        </span>
                        {court.tag && (
                          <span className="text-xs font-medium text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                            {court.tag}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-slate-600 font-semibold">
                        Court #{idx + 1}
                      </span>
                    </div>

                    <h4 className="text-2xl font-bold text-slate-900 group-hover:text-blue-600 transition-colors mb-1">
                      {court.name}
                    </h4>
                    <p className="text-xs font-semibold text-slate-600 mb-3">
                      {court.type || 'Standard Court Surface'}
                    </p>
                    <p className="text-sm text-slate-600 leading-relaxed mb-6">
                      {court.description}
                    </p>
                  </div>

                  <div className="pt-4 border-t border-slate-100 flex items-center justify-between">
                    <div>
                      <span className="text-xs text-slate-600 block">Rate</span>
                      <span className="text-lg font-bold text-slate-900">
                        {settings.currency}{court.hourlyRate}
                        <span className="text-xs font-normal text-slate-600">/hr</span>
                      </span>
                    </div>
                    {isDisabled ? (
                      <span className="px-3 py-1.5 bg-slate-100 text-slate-600 text-xs font-bold rounded-lg">
                        Disabled
                      </span>
                    ) : (
                      <button
                        onClick={() => onStartBooking(court.id)}
                        className="px-4 py-2 bg-blue-50 group-hover:bg-blue-600 text-blue-700 group-hover:text-white rounded-lg text-xs font-bold transition-all flex items-center gap-1 cursor-pointer"
                      >
                        <span>Book {court.name}</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* BookSuite Ecosystem Banner */}
      <section className="bg-slate-50 border-t border-slate-200 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-6 p-6 rounded-2xl bg-white border border-slate-200">
            <div className="space-y-1 text-center sm:text-left">
              <div className="text-xs font-bold uppercase tracking-wider text-blue-600">
                BookSuite Product Roadmap
              </div>
              <h3 className="text-lg font-bold text-slate-900">
                Specialized Booking Engines for Every Venue
              </h3>
              <p className="text-slate-600 text-xs sm:text-sm max-w-xl">
                CourtBook is Phase 1 of BookSuite. Future editions will deliver dedicated booking workflows for health clinics, hair & nail salons, and boutique fitness gyms.
              </p>
            </div>
            <button
              onClick={() => onStartBooking()}
              className="whitespace-nowrap px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-xl transition-colors cursor-pointer"
            >
              Try Customer Booking Now
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
