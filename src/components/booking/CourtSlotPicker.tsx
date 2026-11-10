import React, { useState, useEffect, useMemo } from 'react';
import {
  Calendar as CalendarIcon,
  Clock,
  Check,
  AlertCircle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Tag,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import { SupabaseFacility, SupabaseCourt, getCourtBusySlots, BusySlotRow, getTodayStringInTimezone } from '../../lib/supabaseClient';
import { formatHour12 } from '../../types/booking';

interface CourtSlotPickerProps {
  facility: SupabaseFacility;
  courts: SupabaseCourt[];
  selectedCourtId: string | null;
  onSelectCourt: (courtId: string) => void;
  selectedDate: string; // YYYY-MM-DD
  onSelectDate: (date: string) => void;
  selectedStartTime: string | null; // ISO UTC string
  onSelectStartTime: (isoStartTime: string | null) => void;
  durationMinutes: number;
  onSelectDuration: (duration: number) => void;
  onProceed: () => void;
  onBack: () => void;
}

export const CourtSlotPicker: React.FC<CourtSlotPickerProps> = ({
  facility,
  courts,
  selectedCourtId,
  onSelectCourt,
  selectedDate,
  onSelectDate,
  selectedStartTime,
  onSelectStartTime,
  durationMinutes,
  onSelectDuration,
  onProceed,
  onBack,
}) => {
  const [busySlots, setBusySlots] = useState<BusySlotRow[]>([]);
  const [isLoadingSlots, setIsLoadingSlots] = useState<boolean>(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);

  const timezone = facility.timezone || 'Asia/Manila';
  const todayInTimezone = useMemo(() => getTodayStringInTimezone(timezone), [timezone]);

  // Filter courts for this venue
  const enabledCourts = useMemo(() => {
    return courts.filter((c) => c.facility_id === facility.id && c.is_enabled);
  }, [courts, facility.id]);

  // Active selected court object
  const activeCourt = useMemo(() => {
    return enabledCourts.find((c) => c.id === selectedCourtId) || enabledCourts[0];
  }, [enabledCourts, selectedCourtId]);

  // Keep court selection synchronized
  useEffect(() => {
    if (activeCourt && activeCourt.id !== selectedCourtId) {
      onSelectCourt(activeCourt.id);
    }
  }, [activeCourt, selectedCourtId, onSelectCourt]);

  // Fetch busy slots whenever court or date changes
  useEffect(() => {
    let isCancelled = false;
    async function fetchAvailability() {
      if (!activeCourt?.id || !selectedDate) return;
      setIsLoadingSlots(true);
      setSlotsError(null);

      try {
        const slots = await getCourtBusySlots(activeCourt.id, selectedDate);
        if (!isCancelled) {
          setBusySlots(slots || []);
          setIsLoadingSlots(false);
        }
      } catch (err: any) {
        if (!isCancelled) {
          setBusySlots([]);
          setSlotsError(err?.message || 'Failed to load court availability');
          setIsLoadingSlots(false);
        }
      }
    }

    fetchAvailability();
    return () => {
      isCancelled = true;
    };
  }, [activeCourt?.id, selectedDate]);

  // Compute 7-day horizontal date selector starting today
  const next7Days = useMemo(() => {
    const days: { dateStr: string; dayLabel: string; monthDay: string; isToday: boolean }[] = [];
    const baseDate = new Date();

    for (let i = 0; i < 7; i++) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      const dayLabel = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short' });
      const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      days.push({
        dateStr,
        dayLabel,
        monthDay,
        isToday: i === 0,
      });
    }
    return days;
  }, []);

  // Generate available time slots based on facility open and close hours (30-min intervals)
  const timeSlots = useMemo(() => {
    const openH = facility.open_hour ?? 8;
    const closeH = facility.close_hour ?? 22;
    const slots: { label: string; hour: number; minute: number; isoUtc: string; isBusy: boolean; isPast: boolean }[] = [];

    const now = new Date();

    for (let h = openH; h < closeH; h++) {
      for (const m of [0, 30]) {
        // If close hour would be exceeded by duration, skip
        const slotEndMinutes = h * 60 + m + durationMinutes;
        if (slotEndMinutes > closeH * 60) continue;

        const h12 = h % 12 === 0 ? 12 : h % 12;
        const ampm = h < 12 ? 'AM' : 'PM';
        const label = `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;

        // Construct ISO UTC timestamp representation for Asia/Manila (UTC+8)
        const manilaOffset = '+08:00';
        const isoString = `${selectedDate}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00${manilaOffset}`;
        const slotDateObj = new Date(isoString);
        const isPast = slotDateObj.getTime() <= now.getTime();

        // Check against busy slots
        const slotStartMs = slotDateObj.getTime();
        const slotEndMs = slotStartMs + durationMinutes * 60 * 1000;

        const isBusy = busySlots.some((busy) => {
          const busyStartMs = new Date(busy.start_time).getTime();
          const busyEndMs = new Date(busy.end_time).getTime();
          return slotStartMs < busyEndMs && slotEndMs > busyStartMs;
        });

        slots.push({
          label,
          hour: h,
          minute: m,
          isoUtc: slotDateObj.toISOString(),
          isBusy,
          isPast,
        });
      }
    }

    return slots;
  }, [facility.open_hour, facility.close_hour, selectedDate, durationMinutes, busySlots]);

  // Price calculation
  const hourlyRate = activeCourt?.hourly_rate ? Number(activeCourt.hourly_rate) : 350;
  const totalPrice = Math.round((hourlyRate * (durationMinutes / 60)) * 100) / 100;

  return (
    <div className="space-y-6">
      {/* 1. Court Selector */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-extrabold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <Tag className="w-4 h-4 text-blue-600" />
            <span>Step 5A: Select Court</span>
          </label>
          <span className="text-xs text-slate-500 font-medium">
            {enabledCourts.length} {enabledCourts.length === 1 ? 'Court' : 'Courts'} Available
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {enabledCourts.map((court) => {
            const isSelected = court.id === activeCourt?.id;
            return (
              <button
                key={court.id}
                type="button"
                onClick={() => {
                  onSelectCourt(court.id);
                  onSelectStartTime(null);
                }}
                className={`text-left p-4 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between ${
                  isSelected
                    ? 'border-blue-600 bg-blue-50/60 ring-2 ring-blue-500/20 shadow-xs'
                    : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-extrabold text-sm text-slate-900">{court.name}</span>
                    <span className="text-xs font-bold text-blue-700 bg-blue-100/70 px-2 py-0.5 rounded-md">
                      {court.sport_type}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1 line-clamp-1">
                    {court.surface_type || court.tag || 'Standard surface'}
                  </p>
                </div>

                <div className="mt-3 pt-2 border-t border-slate-100 flex items-center justify-between text-xs">
                  <span className="font-extrabold text-slate-900">
                    {facility.currency || '₱'}{Number(court.hourly_rate).toFixed(0)}/hr
                  </span>
                  {isSelected && (
                    <span className="flex items-center gap-1 text-[11px] font-bold text-blue-600">
                      <Check className="w-3.5 h-3.5" />
                      <span>Selected</span>
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. Date Picker (7-Day Strip) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-extrabold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <CalendarIcon className="w-4 h-4 text-blue-600" />
            <span>Step 5B: Select Date ({timezone})</span>
          </label>
        </div>

        <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
          {next7Days.map((d) => {
            const isSelected = d.dateStr === selectedDate;
            return (
              <button
                key={d.dateStr}
                type="button"
                onClick={() => {
                  onSelectDate(d.dateStr);
                  onSelectStartTime(null);
                }}
                className={`py-3 px-2 rounded-2xl border text-center transition-all cursor-pointer flex flex-col items-center justify-center ${
                  isSelected
                    ? 'border-blue-600 bg-blue-600 text-white shadow-sm ring-2 ring-blue-500/20'
                    : 'border-slate-200 bg-white text-slate-800 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <span className={`text-[11px] font-bold ${isSelected ? 'text-blue-100' : 'text-slate-500'}`}>
                  {d.dayLabel}
                </span>
                <span className="text-sm font-extrabold mt-0.5">{d.monthDay}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. Duration Selector */}
      <div className="space-y-2">
        <label className="text-xs font-extrabold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
          <Clock className="w-4 h-4 text-blue-600" />
          <span>Step 5C: Select Duration</span>
        </label>
        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none no-scrollbar">
          {[30, 60, 90, 120, 180].map((dur) => (
            <button
              key={dur}
              type="button"
              onClick={() => {
                onSelectDuration(dur);
                onSelectStartTime(null);
              }}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                durationMinutes === dur
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300'
              }`}
            >
              {dur >= 60 ? `${dur / 60} ${dur === 60 ? 'Hour' : 'Hours'}` : `${dur} Mins`}
            </button>
          ))}
        </div>
      </div>

      {/* 4. Time Slot Grid */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-extrabold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-blue-600" />
            <span>Step 5D: Select Available Time Slot</span>
          </label>
          <div className="flex items-center gap-3 text-[11px] font-medium text-slate-500">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span> Open
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-300"></span> Booked / Held
            </span>
          </div>
        </div>

        {isLoadingSlots ? (
          <div className="py-12 flex flex-col items-center justify-center gap-2 bg-slate-50 rounded-2xl border border-slate-200 text-slate-500 text-xs font-semibold">
            <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
            <span>Checking live court schedule in Supabase...</span>
          </div>
        ) : timeSlots.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500 bg-slate-50 rounded-2xl border border-slate-200">
            No operating hours configured for this day or duration exceeds closing time.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
            {timeSlots.map((slot) => {
              const isSelected = selectedStartTime === slot.isoUtc;
              const isDisabled = slot.isBusy || slot.isPast;

              return (
                <button
                  key={slot.isoUtc}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => onSelectStartTime(slot.isoUtc)}
                  className={`py-3 px-2 rounded-xl text-xs font-extrabold transition-all flex flex-col items-center justify-center gap-0.5 ${
                    isSelected
                      ? 'bg-blue-600 text-white shadow-sm ring-2 ring-blue-500/20 cursor-pointer'
                      : isDisabled
                      ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed opacity-60 line-through'
                      : 'bg-white text-slate-800 border border-slate-200 hover:border-blue-400 hover:bg-blue-50/50 cursor-pointer'
                  }`}
                >
                  <span>{slot.label}</span>
                  <span className={`text-[10px] font-normal ${isSelected ? 'text-blue-100' : 'text-slate-400'}`}>
                    {isDisabled ? (slot.isPast ? 'Passed' : 'Unavailable') : 'Available'}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 5. Pricing Preview Bar & Proceed CTA */}
      <div className="pt-4 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Booking Total (All Inclusive)
          </div>
          <div className="text-xl sm:text-2xl font-extrabold text-slate-900">
            {facility.currency || '₱'}{totalPrice.toLocaleString('en-PH', { minimumFractionDigits: 2 })}
            <span className="text-xs font-medium text-slate-500 ml-1.5">
              ({durationMinutes} mins on {activeCourt?.name})
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5 w-full sm:w-auto">
          <button
            type="button"
            onClick={onBack}
            className="w-1/3 sm:w-auto px-4 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition-colors cursor-pointer"
          >
            Back
          </button>
          <button
            type="button"
            disabled={!selectedStartTime}
            onClick={onProceed}
            className="w-2/3 sm:w-auto px-6 py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white text-xs sm:text-sm font-extrabold flex items-center justify-center gap-2 disabled:opacity-50 transition-all cursor-pointer shadow-sm shadow-blue-500/20"
          >
            <span>Continue to Guest Details</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
