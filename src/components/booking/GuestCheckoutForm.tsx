import React, { useState } from 'react';
import {
  User,
  Phone,
  Mail,
  ShieldCheck,
  ArrowRight,
  Info,
  Calendar,
  Clock,
  MapPin,
  CheckCircle2,
  Tag,
} from 'lucide-react';
import { SupabaseFacility, SupabaseCourt } from '../../lib/supabaseClient';

interface GuestCheckoutFormProps {
  facility: SupabaseFacility;
  court: SupabaseCourt;
  selectedDate: string; // YYYY-MM-DD
  startTimeIso: string;
  durationMinutes: number;
  customerName: string;
  onNameChange: (name: string) => void;
  customerPhone: string;
  onPhoneChange: (phone: string) => void;
  customerEmail: string;
  onEmailChange: (email: string) => void;
  onProceedToPayment: () => void;
  onBack: () => void;
}

export const GuestCheckoutForm: React.FC<GuestCheckoutFormProps> = ({
  facility,
  court,
  selectedDate,
  startTimeIso,
  durationMinutes,
  customerName,
  onNameChange,
  customerPhone,
  onPhoneChange,
  customerEmail,
  onEmailChange,
  onProceedToPayment,
  onBack,
}) => {
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Compute friendly time slot label
  const startDate = new Date(startTimeIso);
  const startHour = startDate.getHours();
  const startMin = startDate.getMinutes();
  const h12 = startHour % 12 === 0 ? 12 : startHour % 12;
  const ampm = startHour < 12 ? 'AM' : 'PM';
  const startLabel = `${String(h12).padStart(2, '0')}:${String(startMin).padStart(2, '0')} ${ampm}`;

  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
  const endHour = endDate.getHours();
  const endMin = endDate.getMinutes();
  const endH12 = endHour % 12 === 0 ? 12 : endHour % 12;
  const endAmpm = endHour < 12 ? 'AM' : 'PM';
  const endLabel = `${String(endH12).padStart(2, '0')}:${String(endMin).padStart(2, '0')} ${endAmpm}`;
  const slotRangeLabel = `${startLabel} – ${endLabel}`;

  // Price calculations
  const hourlyRate = Number(court.hourly_rate);
  const totalPrice = Math.round((hourlyRate * (durationMinutes / 60)) * 100) / 100;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const name = customerName.trim();
    if (name.length < 2) {
      setErrorMsg('Please enter your full name (at least 2 characters).');
      return;
    }

    const phone = customerPhone.trim();
    const email = customerEmail.trim();

    if (!phone && !email) {
      setErrorMsg('Please provide at least a mobile number or email address for your booking pass.');
      return;
    }

    if (phone) {
      // Philippine phone validation: 09XXXXXXXXX or +639XXXXXXXXX
      const cleanPhone = phone.replace(/[\s()-]/g, '');
      const phPhoneRegex = /^(09|\+639)\d{9}$/;
      if (!phPhoneRegex.test(cleanPhone)) {
        setErrorMsg('Please enter a valid Philippine mobile number (e.g., 0917 123 4567 or +63 917 123 4567).');
        return;
      }
    }

    if (email) {
      const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
      if (!emailRegex.test(email)) {
        setErrorMsg('Please enter a valid email address for your confirmation receipt.');
        return;
      }
    }

    onProceedToPayment();
  };

  return (
    <div className="space-y-6">
      {/* Review Summary Card */}
      <div className="bg-slate-50 border border-slate-200/90 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-200">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600 bg-blue-50 px-2 py-0.5 rounded-md">
              Booking Review
            </span>
            <h3 className="text-base font-extrabold text-slate-900 mt-1">
              {facility.name} — {court.name}
            </h3>
          </div>
          <span className="text-xs font-bold text-slate-500 bg-white border border-slate-200 px-2.5 py-1 rounded-xl">
            {court.sport_type}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-slate-700">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
            <span>{selectedDate}</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-400 shrink-0" />
            <span>{slotRangeLabel} ({durationMinutes} mins)</span>
          </div>
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-slate-400 shrink-0" />
            <span className="truncate">{facility.address || 'Metro Manila'}</span>
          </div>
        </div>

        {/* Transparent Fee Breakdown */}
        <div className="pt-3 border-t border-slate-200 flex items-center justify-between">
          <div className="space-y-0.5">
            <div className="text-xs font-semibold text-slate-600">
              Court Rate: {facility.currency || '₱'}{hourlyRate.toFixed(2)}/hr × {(durationMinutes / 60).toFixed(1)} hrs
            </div>
            <div className="text-[11px] text-emerald-600 font-bold flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Zero booking fees or hidden charges (100% transparent pricing)</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase font-bold text-slate-400">Total Due</div>
            <div className="text-xl font-extrabold text-slate-900">
              {facility.currency || '₱'}{totalPrice.toLocaleString('en-PH', { minimumFractionDigits: 2 })}
            </div>
          </div>
        </div>
      </div>

      {/* Guest Checkout Inputs */}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-extrabold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <User className="w-4 h-4 text-blue-600" />
            <span>Step 6: Guest Contact Information</span>
          </h4>
          <span className="text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-md flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>No Account Required</span>
          </span>
        </div>

        {errorMsg && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 font-semibold flex items-center gap-2">
            <Info className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Full Name */}
          <div className="space-y-1 sm:col-span-2">
            <label className="text-xs font-bold text-slate-700">
              Full Name <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <User className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
              <input
                type="text"
                required
                value={customerName}
                onChange={(e) => onNameChange(e.target.value)}
                placeholder="e.g. Juan Dela Cruz"
                className="w-full pl-10 pr-3.5 py-3 bg-white border border-slate-200 rounded-xl text-xs sm:text-sm text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              />
            </div>
          </div>

          {/* Philippine Mobile Number */}
          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-700">
              Philippine Mobile Number <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <Phone className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
              <input
                type="tel"
                required
                value={customerPhone}
                onChange={(e) => onPhoneChange(e.target.value)}
                placeholder="0917 123 4567"
                className="w-full pl-10 pr-3.5 py-3 bg-white border border-slate-200 rounded-xl text-xs sm:text-sm text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              />
            </div>
            <p className="text-[10px] text-slate-400">Used for booking pass verification and venue access.</p>
          </div>

          {/* Email Address */}
          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-700">
              Email Address (Recommended)
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 absolute left-3.5 top-3.5 text-slate-400" />
              <input
                type="email"
                value={customerEmail}
                onChange={(e) => onEmailChange(e.target.value)}
                placeholder="juan@example.com"
                className="w-full pl-10 pr-3.5 py-3 bg-white border border-slate-200 rounded-xl text-xs sm:text-sm text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              />
            </div>
            <p className="text-[10px] text-slate-400">We will email your official booking receipt & calendar invite.</p>
          </div>
        </div>

        {/* Navigation Action Buttons */}
        <div className="pt-4 border-t border-slate-200 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className="px-5 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition-colors cursor-pointer"
          >
            Back to Court Schedule
          </button>
          <button
            type="submit"
            className="px-7 py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white text-xs sm:text-sm font-extrabold flex items-center gap-2 transition-all cursor-pointer shadow-sm shadow-blue-500/20"
          >
            <span>Proceed to Payment</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </form>
    </div>
  );
};
