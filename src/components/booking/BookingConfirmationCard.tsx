import React from 'react';
import {
  CheckCircle2,
  Calendar,
  Clock,
  MapPin,
  Share2,
  Download,
  ExternalLink,
  Tag,
  ArrowRight,
  ShieldCheck,
  Building,
  User,
} from 'lucide-react';
import { CustomerConfirmationDetails } from '../../types/customerBooking';

interface BookingConfirmationCardProps {
  details: CustomerConfirmationDetails;
  onBookAnother: () => void;
  onDone: () => void;
}

export const BookingConfirmationCard: React.FC<BookingConfirmationCardProps> = ({
  details,
  onBookAnother,
  onDone,
}) => {
  // Generate downloadable .ics calendar file
  const handleDownloadCalendar = () => {
    const title = `Court Booking: ${details.courtName} at ${details.facilityName}`;
    const desc = `Reference Code: ${details.referenceCode}\\nSport: ${details.sportType}\\nDuration: ${details.durationMinutes} mins`;
    const loc = `${details.facilityName}, ${details.facilityAddress}`;

    const cleanDate = details.bookingDate.replace(/-/g, '');
    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//CourtBook Philippines//Customer Booking//EN',
      'BEGIN:VEVENT',
      `UID:${details.referenceCode}-${Date.now()}@courtbook.app`,
      `DTSTAMP:${cleanDate}T000000Z`,
      `DTSTART:${cleanDate}T080000Z`,
      `DTEND:${cleanDate}T090000Z`,
      `SUMMARY:${title}`,
      `DESCRIPTION:${desc}`,
      `LOCATION:${loc}`,
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `CourtBook-${details.referenceCode}.ics`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${details.facilityName} ${details.facilityAddress}`
  )}`;

  return (
    <div className="space-y-6 max-w-xl mx-auto">
      {/* Top Success Banner */}
      <div className={`${details.isDemo ? 'bg-amber-600 shadow-amber-600/20' : 'bg-emerald-500 shadow-emerald-500/20'} text-white rounded-3xl p-6 sm:p-8 text-center space-y-3 shadow-lg`}>
        <div className="w-16 h-16 rounded-2xl bg-white/20 backdrop-blur-md flex items-center justify-center mx-auto shadow-inner">
          <CheckCircle2 className="w-10 h-10 text-white" />
        </div>
        <div>
          <span className={`inline-block px-3 py-1 rounded-full ${details.isDemo ? 'bg-amber-700/80 text-amber-100' : 'bg-emerald-600/80 text-emerald-100'} text-[11px] font-extrabold uppercase tracking-wider mb-1`}>
            {details.isDemo ? 'DEMO SIMULATION ONLY • NOT A PAID RESERVATION' : 'Confirmed & Reserved'}
          </span>
          <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
            {details.isDemo ? 'Demo Booking Simulated' : 'Booking Confirmed!'}
          </h2>
          <p className="text-xs sm:text-sm text-white/90 mt-1 max-w-sm mx-auto">
            {details.isDemo
              ? 'This is a fictional demonstration booking pass. No real transaction occurred and no court was reserved.'
              : 'Your court is officially booked. Present this digital pass or your reference code upon arrival.'}
          </p>
        </div>
      </div>

      {/* Official Booking Pass Ticket */}
      <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
        {/* Ticket Header */}
        <div className="p-6 bg-slate-900 text-white flex items-center justify-between">
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400">
              {details.isDemo ? 'Demo Reference Code' : 'Booking Reference'}
            </div>
            <div className={`text-xl sm:text-2xl font-black font-mono tracking-wider ${details.isDemo ? 'text-amber-400' : 'text-emerald-400'} mt-0.5`}>
              {details.referenceCode}
            </div>
          </div>
          <div className="px-3 py-1.5 rounded-xl bg-white/10 backdrop-blur-md text-xs font-bold flex items-center gap-1.5">
            <ShieldCheck className={`w-4 h-4 ${details.isDemo ? 'text-amber-400' : 'text-emerald-400'}`} />
            <span>{details.isDemo ? 'DEMO / SIMULATED' : 'Paid & Verified'}</span>
          </div>
        </div>

        {/* Perforated Divider Simulation */}
        <div className="relative h-4 bg-slate-100 flex items-center justify-between px-2">
          <div className="w-4 h-4 rounded-full bg-white -ml-4" />
          <div className="flex-1 border-b-2 border-dashed border-slate-300 mx-2" />
          <div className="w-4 h-4 rounded-full bg-white -mr-4" />
        </div>

        {/* Ticket Content */}
        <div className="p-6 space-y-5">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600 bg-blue-50 px-2 py-0.5 rounded-md">
              {details.sportType}
            </span>
            <h3 className="text-lg font-extrabold text-slate-900 mt-1">
              {details.facilityName}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">{details.courtName}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 space-y-1">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-blue-600" />
                <span>Date & Schedule</span>
              </div>
              <div className="font-extrabold text-slate-900">{details.bookingDate}</div>
              <div className="text-slate-600 font-medium">
                {details.timeSlotLabel} ({details.durationMinutes} mins)
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 space-y-1">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
                <User className="w-3.5 h-3.5 text-blue-600" />
                <span>Guest Player</span>
              </div>
              <div className="font-extrabold text-slate-900">{details.customerName}</div>
              <div className="text-slate-600 font-medium truncate">
                {details.customerPhone || details.customerEmail || 'Guest'}
              </div>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 flex items-start gap-2 text-xs text-slate-600">
            <MapPin className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
            <span>{details.facilityAddress || 'Location details available on Google Maps'}</span>
          </div>

          <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500">Amount Paid</span>
            <span className="text-lg font-black text-slate-900">
              {details.currency || '₱'}{details.totalPrice.toLocaleString('en-PH', { minimumFractionDigits: 2 })}
            </span>
          </div>
        </div>
      </div>

      {/* Helpful Actions (Calendar Export, Map Directions) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={handleDownloadCalendar}
          className="py-3 px-4 rounded-2xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-800 text-xs font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer shadow-xs"
        >
          <Download className="w-4 h-4 text-blue-600" />
          <span>Add to Calendar (.ics)</span>
        </button>

        <a
          href={googleMapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="py-3 px-4 rounded-2xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-800 text-xs font-bold flex items-center justify-center gap-2 transition-colors shadow-xs"
        >
          <ExternalLink className="w-4 h-4 text-emerald-600" />
          <span>Directions in Google Maps</span>
        </a>
      </div>

      {/* Footer Return Buttons */}
      <div className="pt-2 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBookAnother}
          className="px-5 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition-colors cursor-pointer"
        >
          Book Another Court
        </button>
        <button
          type="button"
          onClick={onDone}
          className="px-6 py-3 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white text-xs sm:text-sm font-extrabold flex items-center gap-2 transition-colors cursor-pointer"
        >
          <span>Return to Directory</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
