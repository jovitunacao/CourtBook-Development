import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Calendar as CalendarIcon,
  Clock,
  User,
  Phone,
  Mail,
  CheckCircle,
  AlertCircle,
  Info,
  Check,
  ArrowRight,
  RefreshCw,
  FileCheck2,
  SlidersHorizontal,
  Wrench,
  Database,
  Building,
  ShieldAlert,
  ShieldCheck,
  Loader2,
} from 'lucide-react';
import {
  Court,
  TimeSlot,
  FacilitySettings,
  Reservation,
  generateTimeSlots,
  formatHour12,
} from '../types/booking';
import {
  getTodayString,
  formatDatePretty,
  generateBookingRef,
  isSlotBooked,
} from '../utils/storage';
import {
  checkCourtBookingStatus,
  getCourtBusySlots,
  isSlotBusyInTimezone,
  getLocalSlotUtcBounds,
  getTodayStringInTimezone,
  extractAuthoritativeReservation,
  isValidUuid,
  CourtBookingStatusResult,
  BusySlotRow,
  submitPublicBookingViaFunction,
} from '../lib/supabaseClient';
import { useSupabaseAuth } from '../context/SupabaseAuthContext';

interface BookingPageProps {
  initialCourtId?: string;
  settings: FacilitySettings;
  reservations: Reservation[];
  onAddReservation: (reservation: Reservation) => void;
  onNavigateToAdmin: () => void;
  onNavigateToSettings: () => void;
  onResetToNewBooking: () => void;
}

export const BookingPage: React.FC<BookingPageProps> = ({
  initialCourtId = '',
  settings,
  reservations,
  onAddReservation,
  onNavigateToAdmin,
  onNavigateToSettings,
}) => {
  const { isConfigured, publicFacilities, publicCourts, activePublicFacility, setActivePublicFacilityId } =
    useSupabaseAuth();

  // Cloudflare Turnstile bot verification
  // Supabase RPC states for live court status & busy slots
  const [courtStatus, setCourtStatus] = useState<CourtBookingStatusResult | null>(null);
  const [busySlots, setBusySlots] = useState<BusySlotRow[]>([]);
  const [isLoadingSlots, setIsLoadingSlots] = useState<boolean>(false);

  // Determine effective IANA timezone (from RPC courtStatus, active public facility, or settings)
  const effectiveTimezone = courtStatus?.timezone || activePublicFacility?.timezone || settings.timezone || 'Asia/Manila';

  // Compute current calendar date in the facility's actual timezone (avoids client browser skew)
  const todayInTimezone = useMemo(() => {
    return getTodayStringInTimezone(effectiveTimezone);
  }, [effectiveTimezone]);

  const [selectedDate, setSelectedDate] = useState<string>(() =>
    getTodayStringInTimezone(activePublicFacility?.timezone || settings.timezone || 'Asia/Manila')
  );
  const [customerName, setCustomerName] = useState<string>('');
  const [customerPhone, setCustomerPhone] = useState<string>('');
  const [customerEmail, setCustomerEmail] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isUncertainOutcome, setIsUncertainOutcome] = useState<boolean>(false);
  const [confirmedReservation, setConfirmedReservation] = useState<Reservation | null>(null);

  // If selectedDate is in the past relative to the facility timezone, automatically reset to today
  useEffect(() => {
    if (selectedDate < todayInTimezone) {
      setSelectedDate(todayInTimezone);
      setSelectedSlotId(null);
    }
  }, [selectedDate, todayInTimezone]);

  // Effective courts: Prioritize live Supabase publicCourts when configured, or mapped settings.courts
  const effectiveCourts: Court[] = useMemo(() => {
    if (isConfigured && publicCourts && publicCourts.length > 0) {
      const facilityCourts = activePublicFacility
        ? publicCourts.filter((c) => c.facility_id === activePublicFacility.id)
        : publicCourts;
      const courtSource = facilityCourts.length > 0 ? facilityCourts : publicCourts;
      return courtSource.map((c) => ({
        id: c.id,
        facilityId: c.facility_id,
        name: c.name,
        sportType: c.sport_type,
        tag: c.tag || 'Standard Court',
        type: c.surface_type || 'Professional Surface',
        description: c.description || 'Regulation sports court.',
        hourlyRate: Number(c.hourly_rate),
        isEnabled: c.is_enabled,
      }));
    }
    return settings.courts;
  }, [isConfigured, publicCourts, activePublicFacility, settings.courts]);

  // Enabled courts (disabled courts must not be bookable)
  const enabledCourts = useMemo(() => {
    return effectiveCourts.filter((c) => c.isEnabled);
  }, [effectiveCourts]);

  // Selected court ID state with fallback to first enabled court
  const [selectedCourtId, setSelectedCourtId] = useState<string>(() => {
    if (initialCourtId && effectiveCourts.some((c) => c.id === initialCourtId && c.isEnabled)) {
      return initialCourtId;
    }
    const firstUuidCourt = enabledCourts.find((c) => isValidUuid(c.id));
    return firstUuidCourt?.id || enabledCourts[0]?.id || '';
  });

  // Keep selectedCourtId in sync when courts load/change or when live UUID is required
  useEffect(() => {
    if (enabledCourts.length > 0) {
      const currentValid = enabledCourts.some((c) => c.id === selectedCourtId);
      const isCurrentUuid = isValidUuid(selectedCourtId);

      // If current selected court is not in enabled courts, OR if Supabase is configured and current is not a UUID:
      if (!currentValid || (isConfigured && !isCurrentUuid)) {
        const initialValid =
          initialCourtId &&
          enabledCourts.some((c) => c.id === initialCourtId) &&
          (!isConfigured || isValidUuid(initialCourtId));

        if (initialValid) {
          setSelectedCourtId(initialCourtId);
        } else {
          // Select first court that has a valid UUID (if live) or first enabled court
          const uuidCourt = enabledCourts.find((c) => isValidUuid(c.id));
          setSelectedCourtId(uuidCourt ? uuidCourt.id : enabledCourts[0].id);
        }
      }
    } else if (enabledCourts.length === 0) {
      setSelectedCourtId('');
    }
  }, [enabledCourts, selectedCourtId, isConfigured, initialCourtId]);

  // Selected court object
  const selectedCourt = useMemo(() => {
    return enabledCourts.find((c) => c.id === selectedCourtId) || enabledCourts[0] || null;
  }, [enabledCourts, selectedCourtId]);

  // Dynamic time slots based on configured operating hours
  const openHour = courtStatus?.open_hour || settings.openHour;
  const closeHour = courtStatus?.close_hour || settings.closeHour;
  const timeSlots = useMemo(() => {
    return generateTimeSlots(openHour, closeHour);
  }, [openHour, closeHour]);

  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);

  // Clear selected slot if outside operating hours
  useEffect(() => {
    if (selectedSlotId && !timeSlots.some((s) => s.id === selectedSlotId)) {
      setSelectedSlotId(null);
    }
  }, [timeSlots, selectedSlotId]);

  const selectedSlot = useMemo(() => {
    return timeSlots.find((s) => s.id === selectedSlotId) || null;
  }, [timeSlots, selectedSlotId]);


  // Cloudflare Turnstile bot verification
  const turnstileSiteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined)?.trim() || '';
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const turnstileContainerRef = React.useRef<HTMLDivElement | null>(null);
  const turnstileWidgetIdRef = React.useRef<string | null>(null);

  // Durable Frontend Idempotency: preserved across retries of the SAME booking attempt
  const generateAttemptKey = useCallback(
    () =>
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `cb-idemp-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
    []
  );
  const [bookingAttemptId, setBookingAttemptId] = useState<string>(() =>
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `cb-idemp-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`
  );

  const resetCaptcha = useCallback(() => {
    if (typeof window !== 'undefined' && (window as any).turnstile && turnstileWidgetIdRef.current) {
      try {
        (window as any).turnstile.reset(turnstileWidgetIdRef.current);
      } catch {}
    }
    setCaptchaToken(null);
  }, []);

  // Dynamically load Turnstile script if site key is configured
  useEffect(() => {
    if (!turnstileSiteKey) return;
    const scriptId = 'cf-turnstile-script';
    if (document.getElementById(scriptId)) return;
    const script = document.createElement('script');
    script.id = scriptId;
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }, [turnstileSiteKey]);

  // Render Turnstile widget when script and DOM container are ready
  useEffect(() => {
    if (!turnstileSiteKey) return;
    let isCancelled = false;

    const renderWidget = () => {
      if (isCancelled || !turnstileContainerRef.current || !(window as any).turnstile) return;
      if (turnstileWidgetIdRef.current) return;

      try {
        const id = (window as any).turnstile.render(turnstileContainerRef.current, {
          sitekey: turnstileSiteKey,
          callback: (token: string) => {
            if (!isCancelled) {
              setCaptchaToken(token);
              setCaptchaError(null);
            }
          },
          'expired-callback': () => {
            if (!isCancelled) {
              setCaptchaToken(null);
              setCaptchaError('Verification challenge expired. Please verify again.');
            }
          },
          'error-callback': () => {
            if (!isCancelled) {
              setCaptchaToken(null);
              setCaptchaError('Bot verification service error. Please retry.');
            }
          },
          theme: 'light',
          size: 'flexible',
        });
        turnstileWidgetIdRef.current = id;
      } catch (err) {
        console.warn('Failed to render Turnstile widget:', err);
      }
    };

    const interval = setInterval(() => {
      if ((window as any).turnstile && turnstileContainerRef.current) {
        renderWidget();
        clearInterval(interval);
      }
    }, 200);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [turnstileSiteKey]);

  // Load actual busy slots and booking status via Supabase RPC whenever court or date changes
  useEffect(() => {
    let isCancelled = false;

    async function loadRpcStatusAndBusySlots() {
      if (!selectedCourtId || !isValidUuid(selectedCourtId) || !isConfigured) {
        setCourtStatus(null);
        setBusySlots([]);
        return;
      }

      setIsLoadingSlots(true);

      try {
        // 1. check_court_booking_status RPC
        const status = await checkCourtBookingStatus(selectedCourtId);
        if (isCancelled) return;
        setCourtStatus(status);

        // 2. get_court_busy_slots RPC
        const busy = await getCourtBusySlots(selectedCourtId, selectedDate);
        if (isCancelled) return;
        setBusySlots(busy);
      } catch (err) {
        console.warn('Error querying Supabase booking status or busy slots:', err);
      } finally {
        if (!isCancelled) setIsLoadingSlots(false);
      }
    }

    loadRpcStatusAndBusySlots();

    return () => {
      isCancelled = true;
    };
  }, [selectedCourtId, selectedDate, isConfigured]);

  // Evaluates availability of a specific slot considering Supabase RPC, past time rules & local reservations
  const getSlotAvailability = useCallback(
    (slot: TimeSlot) => {
      // 1. Explicit check if court is marked not bookable in Supabase
      if (courtStatus && !courtStatus.is_bookable) {
        return {
          isAvailable: false,
          reason: courtStatus.reason || 'Court is not available for bookings',
          badge: 'Disabled',
          type: 'disabled' as const,
        };
      }

      // 2. Compute slot start/end using the facility's actual timezone from Supabase
      // Disables all past dates and slots whose start time is less than or equal to current time
      const bounds = getLocalSlotUtcBounds(
        selectedDate,
        slot.hour,
        slot.hour + 1,
        effectiveTimezone
      );
      const nowMs = Date.now();

      if (bounds.startUtcMs <= nowMs) {
        return {
          isAvailable: false,
          reason: 'This time slot has already started or passed',
          badge: 'Past',
          type: 'past' as const,
        };
      }

      // 3. Check Supabase busy / maintenance slots via get_court_busy_slots RPC
      const supabaseCheck = isSlotBusyInTimezone(
        selectedDate,
        slot.hour,
        slot.hour + 1,
        effectiveTimezone,
        busySlots
      );

      if (supabaseCheck.isBusy) {
        if (supabaseCheck.slotType === 'blocked') {
          return {
            isAvailable: false,
            reason: 'Court is blocked for scheduled maintenance',
            badge: 'Maintenance Block',
            type: 'blocked' as const,
          };
        }
        if (supabaseCheck.slotType === 'held') {
          return {
            isAvailable: false,
            reason: 'Court slot is currently on temporary hold pending owner approval',
            badge: 'Pending Hold',
            type: 'reserved' as const,
          };
        }
        return {
          isAvailable: false,
          reason: 'Slot is already reserved in live Supabase database',
          badge: 'Live Reserved',
          type: 'reserved' as const,
        };
      }

      // 4. Check local reservations (for local demo simulation)
      if (selectedCourt && isSlotBooked(reservations, selectedCourt.id, selectedDate, slot.id)) {
        return {
          isAvailable: false,
          reason: 'Reserved in local demo storage',
          badge: 'Demo Reserved',
          type: 'demo_booked' as const,
        };
      }

      return {
        isAvailable: true,
        reason: 'Open for booking',
        badge: 'Available',
        type: 'available' as const,
      };
    },
    [courtStatus, busySlots, selectedDate, effectiveTimezone, selectedCourt, reservations]
  );

  // Clear selected slot if it becomes busy or invalid (e.g. slot has passed)
  useEffect(() => {
    if (selectedSlot) {
      const avail = getSlotAvailability(selectedSlot);
      if (!avail.isAvailable) {
        setSelectedSlotId(null);
      }
    }
  }, [selectedSlot, getSlotAvailability]);

  // Periodic recheck interval (every 15 seconds) so that as time advances, past slots deselect automatically
  useEffect(() => {
    const timer = setInterval(() => {
      if (selectedSlot) {
        const avail = getSlotAvailability(selectedSlot);
        if (!avail.isAvailable) {
          setSelectedSlotId(null);
        }
      }
    }, 15000);
    return () => clearInterval(timer);
  }, [selectedSlot, getSlotAvailability]);

  // Quick dates for next 5 days computed in the facility's actual timezone (never displays past calendar dates)
  const quickDates = useMemo(() => {
    const list = [];
    const [y, m, d] = todayInTimezone.split('-').map(Number);
    const baseDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

    for (let i = 0; i < 5; i++) {
      const targetDate = new Date(baseDate);
      targetDate.setUTCDate(baseDate.getUTCDate() + i);

      const yr = targetDate.getUTCFullYear();
      const mo = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
      const dy = String(targetDate.getUTCDate()).padStart(2, '0');
      const dateStr = `${yr}-${mo}-${dy}`;

      const label =
        i === 0
          ? 'Today'
          : i === 1
          ? 'Tomorrow'
          : targetDate.toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              timeZone: 'UTC',
            });

      list.push({
        dateStr,
        label,
        dayName: targetDate.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
        dayNum: targetDate.getUTCDate(),
      });
    }
    return list;
  }, [todayInTimezone]);

  // Count truly available future slots for all enabled courts on this date
  const courtAvailabilityCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const nowMs = Date.now();

    enabledCourts.forEach((court) => {
      if (!court.isEnabled) {
        counts[court.id] = 0;
        return;
      }
      if (court.id === selectedCourtId) {
        counts[court.id] = timeSlots.filter((slot) => getSlotAvailability(slot).isAvailable).length;
      } else {
        const nonPastCount = timeSlots.filter((slot) => {
          const bounds = getLocalSlotUtcBounds(selectedDate, slot.hour, slot.hour + 1, effectiveTimezone);
          return bounds.startUtcMs > nowMs;
        }).length;
        const localBookedCount = reservations.filter(
          (r) => r.courtId === court.id && r.date === selectedDate && r.status === 'confirmed'
        ).length;
        counts[court.id] = Math.max(0, nonPastCount - localBookedCount);
      }
    });
    return counts;
  }, [enabledCourts, selectedCourtId, timeSlots, getSlotAvailability, selectedDate, effectiveTimezone, reservations]);

  const handleSelectSlot = (slot: TimeSlot) => {
    const avail = getSlotAvailability(slot);
    if (!avail.isAvailable) {
      setErrorMessage(`Cannot select slot: ${avail.reason}`);
      return;
    }
    if (slot.id !== selectedSlotId) {
      // User picked a genuinely different slot: rotate attempt key and reset CAPTCHA
      setBookingAttemptId(generateAttemptKey());
      resetCaptcha();
    }
    setSelectedSlotId(slot.id);
    setErrorMessage(null);
    setIsUncertainOutcome(false);
  };

  const handleDateChange = (newDate: string) => {
    if (newDate < todayInTimezone) {
      setErrorMessage('Cannot select dates in the past. Please select today or a future date.');
      return;
    }
    setSelectedDate(newDate);
    setSelectedSlotId(null);
    setErrorMessage(null);
    setIsUncertainOutcome(false);
    setBookingAttemptId(generateAttemptKey());
    resetCaptcha();
  };

  const handleCourtChange = (courtId: string) => {
    setSelectedCourtId(courtId);
    setErrorMessage(null);
    setIsUncertainOutcome(false);
    setBookingAttemptId(generateAttemptKey());
    resetCaptcha();
  };

  const handleNameChange = (val: string) => {
    setCustomerName(val);
    setErrorMessage(null);
    setIsUncertainOutcome(false);
    setBookingAttemptId(generateAttemptKey());
  };

  const handlePhoneChange = (val: string) => {
    setCustomerPhone(val);
    setErrorMessage(null);
    setIsUncertainOutcome(false);
    setBookingAttemptId(generateAttemptKey());
  };

  const handleEmailChange = (val: string) => {
    setCustomerEmail(val);
    setErrorMessage(null);
    setIsUncertainOutcome(false);
    setBookingAttemptId(generateAttemptKey());
  };

  // Resolve target facility UUID from selected court, RPC court status, active public facility, or settings
  const targetFacilityId =
    selectedCourt?.facilityId ||
    courtStatus?.facility_id ||
    activePublicFacility?.id ||
    settings.id;

  const isFacilityAndCourtValid =
    !isConfigured ||
    (Boolean(targetFacilityId && isValidUuid(targetFacilityId)) &&
      Boolean(selectedCourt?.id && isValidUuid(selectedCourt.id)));

  const handleConfirmReservation = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!selectedCourt) {
      setErrorMessage('Please select an active, enabled court.');
      return;
    }

    if (!selectedSlotId || !selectedSlot) {
      setErrorMessage('Please select an available 1-hour time slot.');
      return;
    }

    if (!customerName.trim()) {
      setErrorMessage('Please enter the customer name for this reservation.');
      return;
    }

    if (!customerPhone.trim() && !customerEmail.trim()) {
      setErrorMessage('Please provide at least one contact method (phone number or email).');
      return;
    }

    // Prevent submission if valid UUIDs cannot be resolved, displaying a clear error without consuming Turnstile token
    if (isConfigured) {
      if (!targetFacilityId || !isValidUuid(targetFacilityId) || !selectedCourt?.id || !isValidUuid(selectedCourt.id)) {
        setErrorMessage('Unable to book: Selected facility or court identifier is invalid.');
        return;
      }
    }

    // Require Turnstile Bot Verification when live bookings are enabled (Never silently bypass)
    if (isConfigured) {
      if (!turnstileSiteKey) {
        setErrorMessage(
          'Bot verification is unavailable: Live court bookings require CAPTCHA protection. Please configure VITE_TURNSTILE_SITE_KEY.'
        );
        return;
      }
      if (!captchaToken) {
        setErrorMessage('Please complete the bot verification challenge before submitting.');
        return;
      }
    }

    // Re-verify availability against live Supabase RPC and local storage
    const availability = getSlotAvailability(selectedSlot);
    if (!availability.isAvailable) {
      setErrorMessage(`This time slot is unavailable: ${availability.reason}`);
      setSelectedSlotId(null);
      resetCaptcha();
      return;
    }

    // Strict Booking Execution & Fallback Rules:
    // 1. If Supabase is configured:
    //    All booking requests MUST go through the authoritative server endpoint (Edge Function).
    //    If the booking fails (service unavailable, 404, network error, conflict, rate limit, validation),
    //    we display the exact server error and NEVER create a simulated or local reservation.
    if (isConfigured) {

      setIsSubmitting(true);

      const bounds = getLocalSlotUtcBounds(
        selectedDate,
        selectedSlot.hour,
        selectedSlot.hour + 1,
        effectiveTimezone
      );
      const startUtcIso = new Date(bounds.startUtcMs).toISOString();

      const functionRes = await submitPublicBookingViaFunction({
        facility_id: targetFacilityId as string,
        court_id: selectedCourt.id,
        customer_name: customerName.trim(),
        customer_phone: customerPhone.trim() || undefined,
        customer_email: customerEmail.trim() || undefined,
        booking_date: selectedDate,
        start_time: startUtcIso,
        duration_minutes: 60,
        idempotency_key: bookingAttemptId, // Preserves identical attempt key on retry
        captcha_token: captchaToken || undefined,
      });

      setIsSubmitting(false);

      if (functionRes.success) {
        const authDetails =
          functionRes.authoritative ||
          extractAuthoritativeReservation(functionRes.data) ||
          extractAuthoritativeReservation(functionRes.raw);

        // If any required authoritative reservation detail is missing or invalid:
        // Do NOT create a fictional or assumed confirmation. Display uncertain outcome and preserve key.
        if (!authDetails) {
          setIsUncertainOutcome(true);
          setErrorMessage(
            'Booking status could not be verified: The booking service returned an incomplete or invalid reservation response. ' +
            'Your booking attempt key has been preserved. If your reservation was already processed, complete bot verification and click retry to safely retrieve your confirmed booking without double-booking.'
          );
          resetCaptcha();
          return;
        }

        const liveReservation: Reservation = {
          id: authDetails.reservationId,
          referenceCode: authDetails.referenceCode,
          courtId: selectedCourt.id,
          courtName: authDetails.courtName || selectedCourt.name,
          date: authDetails.bookingDate || selectedDate,
          timeSlotId: selectedSlot.id,
          timeSlotLabel: authDetails.timeSlotLabel || selectedSlot.label,
          customerName: customerName.trim(),
          customerPhone: customerPhone.trim() || undefined,
          customerEmail: customerEmail.trim() || undefined,
          price: authDetails.price,
          status: authDetails.status,
          holdExpiresAt: authDetails.holdExpiresAt,
          isDemo: false,
          createdAt: authDetails.createdAt || new Date().toISOString(),
        };

        try {
          onAddReservation(liveReservation);
        } catch (addErr) {
          console.warn('Non-fatal error updating local state in onAddReservation:', addErr);
        }

        setConfirmedReservation(liveReservation);
        setErrorMessage(null);
        setIsUncertainOutcome(false);

        // Success confirmed: generate fresh key for subsequent bookings
        setBookingAttemptId(generateAttemptKey());
        resetCaptcha();

        // Refresh busy slots immediately to reflect new booking/hold
        // Crucial: Availability refresh error must NEVER change the confirmation screen into an error
        if (selectedCourtId && isValidUuid(selectedCourtId)) {
          getCourtBusySlots(selectedCourtId, selectedDate)
            .then(setBusySlots)
            .catch((refreshErr) => {
              console.warn('Post-booking availability refresh non-fatal warning:', refreshErr);
            });
        }
        return;
      }

      // STRICT SECURITY ENFORCEMENT & IDEMPOTENT RETRY:
      // When Supabase is configured and the Edge Function is unavailable or times out,
      // DO NOT rotate bookingAttemptId! The key is preserved for retries of the same request.
      resetCaptcha();

      if (functionRes.isIncompleteResponse) {
        // UNCERTAIN OUTCOME: Incomplete or invalid server response
        setIsUncertainOutcome(true);
        setErrorMessage(
          functionRes.error ||
            'Booking status could not be verified: The booking service returned an incomplete or invalid reservation response. ' +
            'Your booking attempt key has been preserved. If your reservation was already processed, complete bot verification and click retry to safely retrieve your confirmed booking without double-booking.'
        );
      } else if (functionRes.isConflict) {
        setIsUncertainOutcome(false);
        setErrorMessage(
          functionRes.error ||
            'This court slot has already been taken or held by another reservation. Please select another time slot.'
        );
        setSelectedSlotId(null);
      } else if (functionRes.isRateLimited) {
        setIsUncertainOutcome(false);
        setErrorMessage(
          functionRes.error ||
            `Rate limit exceeded: Too many booking attempts. Please wait ${functionRes.retryAfter || 60} seconds before retrying.`
        );
      } else if (functionRes.isCaptchaRequired) {
        setIsUncertainOutcome(false);
        setErrorMessage(
          functionRes.error ||
            'Bot verification required. Please complete the CAPTCHA verification challenge.'
        );
      } else if (
        functionRes.isTimeout ||
        functionRes.isNetworkError ||
        !functionRes.error ||
        functionRes.error.includes('Failed to fetch') ||
        functionRes.error.includes('timeout') ||
        functionRes.error.includes('network')
      ) {
        // UNCERTAIN OUTCOME / TIMEOUT HANDLING (Requirements 6 & 7):
        // Show "Booking status could not be verified" rather than claiming no reservation exists.
        // Idempotency key is preserved, enabling safe recovery without double-booking.
        setIsUncertainOutcome(true);
        setErrorMessage(
          'Booking status could not be verified: A network connection timeout occurred while waiting for the booking server. ' +
          'Your booking attempt key has been preserved. If your reservation was already processed, complete bot verification and click retry to safely retrieve your confirmed booking without double-booking.'
        );
      } else {
        setIsUncertainOutcome(false);
        setErrorMessage(functionRes.error || 'Booking request failed. Please check your details and retry.');
      }

      if (selectedCourtId && isValidUuid(selectedCourtId)) {
        getCourtBusySlots(selectedCourtId, selectedDate)
          .then(setBusySlots)
          .catch((err) => console.warn('Non-fatal slot refresh error:', err));
      }
      return;
    }

    // LOCAL DEMO MODE:
    // Permitted ONLY when the application is running unconfigured in explicit local demo mode (!isConfigured).
    const facilityConfirmationMode =
      courtStatus?.booking_confirmation_mode || settings.bookingConfirmationMode || 'instant';
    const holdMins = courtStatus?.hold_duration_minutes || settings.holdDurationMinutes || 30;

    const demoReservation: Reservation = {
      id: `demo-res-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      referenceCode: `DEMO-${generateBookingRef()}`,
      courtId: selectedCourt.id,
      courtName: selectedCourt.name,
      date: selectedDate,
      timeSlotId: selectedSlot.id,
      timeSlotLabel: selectedSlot.label,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim() || undefined,
      customerEmail: customerEmail.trim() || undefined,
      price: selectedCourt.hourlyRate,
      status: facilityConfirmationMode === 'manual_approval' ? 'pending' : 'confirmed',
      holdExpiresAt:
        facilityConfirmationMode === 'manual_approval'
          ? new Date(Date.now() + holdMins * 60 * 1000).toISOString()
          : null,
      isDemo: true,
      createdAt: new Date().toISOString(),
    };

    onAddReservation(demoReservation);
    setConfirmedReservation(demoReservation);
    setBookingAttemptId(generateAttemptKey());
    resetCaptcha();
  };

  const handleBookAnother = () => {
    setConfirmedReservation(null);
    setSelectedSlotId(null);
    setCustomerName('');
    setCustomerPhone('');
    setCustomerEmail('');
    setErrorMessage(null);
    setIsUncertainOutcome(false);
    setBookingAttemptId(generateAttemptKey());
    resetCaptcha();
  };

  // If reservation confirmed, display the Confirmation Screen with UNMISTAKABLE DEMO LABELING if demo,
  // or GENUINE DATABASE CONFIRMATION if live database booking.
  if (confirmedReservation) {
    const isDemo = Boolean(confirmedReservation.isDemo);

    return (
      <div className="bg-slate-50 min-h-[calc(100vh-64px)] py-10 px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl mx-auto">
          {/* Unmistakable Demo Warning or Genuine Database Status Banner */}
          {isDemo ? (
            <div className="mb-6 p-4 rounded-2xl bg-amber-500/10 border-2 border-amber-500 text-amber-950 shadow-sm">
              <div className="flex items-start gap-3">
                <ShieldAlert className="w-6 h-6 text-amber-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold text-sm uppercase tracking-wide text-amber-900">
                      DEMO MODE SIMULATION — NOT A REAL BOOKING
                    </span>
                    <span className="font-mono font-bold bg-amber-500 text-white px-2 py-0.5 rounded text-[10px]">
                      SIMULATION ONLY
                    </span>
                  </div>
                  <p className="text-xs text-amber-900/90 leading-relaxed">
                    This reservation was generated locally in preview demonstration mode because live Supabase credentials are not active.
                    No court slot was reserved in the database.
                  </p>
                </div>
              </div>
            </div>
          ) : confirmedReservation.status === 'pending' ? (
            <div className="mb-6 p-4 rounded-2xl bg-amber-50 border-2 border-amber-400 text-amber-950 shadow-sm">
              <div className="flex items-start gap-3">
                <Clock className="w-6 h-6 text-amber-600 shrink-0 mt-0.5 animate-pulse" />
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold text-sm uppercase tracking-wide text-amber-900">
                      Booking Request Submitted — Pending Approval
                    </span>
                    <span className="font-mono font-bold bg-amber-200 text-amber-900 px-2 py-0.5 rounded text-[10px]">
                      LIVE HOLD ACTIVE
                    </span>
                  </div>
                  <p className="text-xs text-amber-900/90 leading-relaxed">
                    The venue requires staff approval. Your selected court slot is currently held in the database
                    {confirmedReservation.holdExpiresAt && (
                      <> until <strong>{new Date(confirmedReservation.holdExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong></>
                    )}. Once approved by venue staff, your booking will be confirmed.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="mb-6 p-4 rounded-2xl bg-emerald-50 border-2 border-emerald-300 text-emerald-950 shadow-sm">
              <div className="flex items-start gap-3">
                <CheckCircle className="w-6 h-6 text-emerald-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold text-sm uppercase tracking-wide text-emerald-900">
                      Official Booking Confirmed
                    </span>
                    <span className="font-mono font-bold bg-emerald-200 text-emerald-900 px-2 py-0.5 rounded text-[10px]">
                      DATABASE CONFIRMED
                    </span>
                  </div>
                  <p className="text-xs text-emerald-900/90 leading-relaxed">
                    Your court reservation has been recorded in the CourtBook system. Your reference code is ready for check-in.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Receipt Card */}
          <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden">
            {/* Header */}
            <div
              className={`p-8 text-center relative text-white ${
                isDemo
                  ? 'bg-slate-700'
                  : confirmedReservation.status === 'pending'
                  ? 'bg-amber-600'
                  : 'bg-blue-600'
              }`}
            >
              <div className="w-16 h-16 bg-white/20 backdrop-blur-md rounded-2xl mx-auto flex items-center justify-center mb-4 text-white shadow-inner">
                {isDemo ? (
                  <FileCheck2 className="w-10 h-10 text-white" />
                ) : confirmedReservation.status === 'pending' ? (
                  <Clock className="w-10 h-10 text-white" />
                ) : (
                  <CheckCircle className="w-10 h-10 text-white" />
                )}
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
                {isDemo
                  ? 'Demo Reservation Simulated'
                  : confirmedReservation.status === 'pending'
                  ? 'Booking Request Received'
                  : 'Court Reservation Confirmed'}
              </h1>
              <p className="text-white/80 text-sm mt-1">
                {isDemo
                  ? 'Local demonstration simulation — not stored in live database.'
                  : confirmedReservation.status === 'pending'
                  ? 'Hold placed in database awaiting staff review.'
                  : 'Official booking recorded in CourtBook.'}
              </p>
              <div
                className={`mt-4 inline-block px-4 py-1.5 rounded-full font-mono font-bold text-sm shadow-xs ${
                  isDemo
                    ? 'bg-amber-400 text-slate-900'
                    : 'bg-white text-slate-900'
                }`}
              >
                Ref #{confirmedReservation.referenceCode} {isDemo && '(DEMO)'}
              </div>
            </div>

            {/* Details Table */}
            <div className="p-6 sm:p-8 space-y-6">
              <div className="bg-slate-50 rounded-2xl p-5 border border-slate-200/80 space-y-3">
                <div className="flex justify-between items-center text-sm pb-3 border-b border-slate-200">
                  <span className="text-slate-600 font-medium">Facility</span>
                  <span className="font-bold text-slate-900">{settings.name}</span>
                </div>
                <div className="flex justify-between items-center text-sm pb-3 border-b border-slate-200">
                  <span className="text-slate-600 font-medium">Court</span>
                  <span className="font-bold text-blue-700 bg-blue-50 px-2.5 py-0.5 rounded-md border border-blue-200">
                    {confirmedReservation.courtName}
                  </span>
                </div>
                <div className="flex justify-between items-center text-sm pb-3 border-b border-slate-200">
                  <span className="text-slate-600 font-medium">Date</span>
                  <span className="font-bold text-slate-900">
                    {formatDatePretty(confirmedReservation.date)}
                  </span>
                </div>
                <div className="flex justify-between items-center text-sm pb-3 border-b border-slate-200">
                  <span className="text-slate-600 font-medium">Time Slot</span>
                  <span className="font-bold text-slate-900">
                    {confirmedReservation.timeSlotLabel} (1 Hour)
                  </span>
                </div>
                <div className="flex justify-between items-center text-sm pb-3 border-b border-slate-200">
                  <span className="text-slate-600 font-medium">Player / Customer</span>
                  <span className="font-bold text-slate-900">
                    {confirmedReservation.customerName}
                  </span>
                </div>
                {confirmedReservation.customerPhone && (
                  <div className="flex justify-between items-center text-sm pb-3 border-b border-slate-200">
                    <span className="text-slate-600 font-medium">Phone</span>
                    <span className="font-mono text-slate-700">
                      {confirmedReservation.customerPhone}
                    </span>
                  </div>
                )}
                {confirmedReservation.customerEmail && (
                  <div className="flex justify-between items-center text-sm pb-3 border-b border-slate-200">
                    <span className="text-slate-600 font-medium">Email</span>
                    <span className="font-mono text-slate-700">
                      {confirmedReservation.customerEmail}
                    </span>
                  </div>
                )}
                <div className="flex justify-between items-center text-sm pt-1">
                  <div>
                    <span className="text-slate-900 font-bold block">Rate Calculation</span>
                    <span className="text-[11px] text-slate-600">
                      Court Rate ({settings.currency}{confirmedReservation.price}/hour)
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-2xl font-black text-emerald-600">
                      {settings.currency}{confirmedReservation.price}
                    </span>
                    <span
                      className={`block text-[10px] font-bold ${
                        isDemo ? 'text-amber-700 font-black' : 'text-emerald-700'
                      }`}
                    >
                      {isDemo ? 'DEMO SIMULATION ONLY' : 'OFFICIAL BOOKING'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Instructions Box */}
              <div
                className={`text-xs p-4 rounded-xl border space-y-1.5 ${
                  isDemo
                    ? 'bg-amber-50/60 border-amber-200 text-amber-900'
                    : 'bg-blue-50/60 border-blue-100 text-slate-600'
                }`}
              >
                <div
                  className={`font-bold flex items-center gap-1.5 text-sm ${
                    isDemo ? 'text-amber-900' : 'text-blue-900'
                  }`}
                >
                  <FileCheck2 className={`w-4 h-4 ${isDemo ? 'text-amber-600' : 'text-blue-600'}`} />
                  {isDemo ? 'Demonstration Notice:' : 'Official Reservation Details:'}
                </div>
                {isDemo ? (
                  <>
                    <p>• This reference ({confirmedReservation.referenceCode}) was simulated in local storage.</p>
                    <p>• No real court time has been booked and no staff notification was sent.</p>
                  </>
                ) : (
                  <>
                    <p>• Reference #{confirmedReservation.referenceCode} is recorded in the CourtBook database.</p>
                    <p>• Present this reference code upon arrival at the venue for court check-in.</p>
                  </>
                )}
              </div>

              {/* Action Buttons */}
              <div className="space-y-3 pt-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    onClick={handleBookAnother}
                    className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer shadow-xs"
                  >
                    <RefreshCw className="w-4 h-4" />
                    <span>Book Another Court</span>
                  </button>

                  <button
                    onClick={onNavigateToAdmin}
                    className="w-full py-3 px-4 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer shadow-xs"
                  >
                    <span>View in Admin Portal</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-slate-50 min-h-[calc(100vh-64px)] py-8 sm:py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Page Header */}
        <div className="mb-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-blue-100 text-blue-800 text-xs font-bold uppercase tracking-wider mb-2">
                <Database className="w-3.5 h-3.5" />
                <span>Supabase Calendar Sync &bull; Public RPC Active</span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
                Reserve a Sports Court
              </h1>
              <p className="text-slate-600 text-sm mt-1">
                <strong>{settings.name}</strong> &bull; Operating {formatHour12(openHour)} &ndash; {closeHour === 24 ? 'Midnight' : formatHour12(closeHour)} &bull; Timezone: {effectiveTimezone}
              </p>
            </div>

            {/* Public Facility Switcher & Mode Badge */}
            <div className="flex flex-wrap items-center gap-2.5 self-start sm:self-auto">
              {publicFacilities.length > 1 && (
                <div className="flex items-center gap-1.5 bg-white border border-slate-200 px-3 py-1.5 rounded-xl shadow-xs text-xs">
                  <Building className="w-3.5 h-3.5 text-blue-600" />
                  <span className="font-semibold text-slate-600">Facility:</span>
                  <select
                    value={activePublicFacility?.id || ''}
                    onChange={(e) => setActivePublicFacilityId(e.target.value)}
                    className="bg-transparent font-bold text-slate-900 focus:outline-none cursor-pointer"
                  >
                    {publicFacilities.map((fac) => (
                      <option key={fac.id} value={fac.id}>
                        {fac.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Facility Booking Confirmation Mode Badge */}
              {courtStatus?.booking_confirmation_mode === 'manual_approval' ||
              settings.bookingConfirmationMode === 'manual_approval' ? (
                <div className="bg-amber-50 border border-amber-300 px-3.5 py-1.5 rounded-xl text-xs text-amber-900 flex items-center gap-1.5 shadow-xs">
                  <Clock className="w-3.5 h-3.5 text-amber-600" />
                  <div>
                    <span className="font-extrabold">Owner Approval:</span> Holds slot for {courtStatus?.hold_duration_minutes || settings.holdDurationMinutes || 30}m
                  </div>
                </div>
              ) : (
                <div className="bg-emerald-50 border border-emerald-300 px-3.5 py-1.5 rounded-xl text-xs text-emerald-900 flex items-center gap-1.5 shadow-xs">
                  <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
                  <div>
                    <span className="font-extrabold">Instant Confirmation</span>
                  </div>
                </div>
              )}

              <div className="bg-amber-50 border border-amber-200 px-3.5 py-2 rounded-xl text-xs text-amber-900 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
                <div>
                  <span className="font-bold">Demo Mode:</span> Local confirmations
                </div>
              </div>

              <button
                onClick={onNavigateToSettings}
                title="Configure facility settings"
                className="px-3 py-2 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-xl text-xs font-semibold transition-colors flex items-center gap-1.5 shadow-xs cursor-pointer"
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
                <span className="hidden sm:inline">Settings</span>
              </button>
            </div>
          </div>
        </div>

        {/* Live RPC Status Banner for Selected Court */}
        {courtStatus && !courtStatus.is_bookable && (
          <div className="mb-6 p-4 rounded-2xl bg-red-50 border border-red-200 text-red-900 flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
            <div className="text-xs">
              <span className="font-bold">Court Unavailable:</span>{' '}
              {courtStatus.reason || 'This court is currently disabled by facility management.'}
            </div>
          </div>
        )}

        {/* Check if any courts are enabled */}
        {enabledCourts.length === 0 ? (
          <div className="bg-white rounded-3xl p-12 text-center border border-slate-200 max-w-xl mx-auto shadow-sm">
            <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 mx-auto flex items-center justify-center mb-4">
              <AlertCircle className="w-8 h-8" />
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">
              No Courts Currently Open for Booking
            </h2>
            <p className="text-sm text-slate-600 mb-6">
              All courts at {settings.name} have been disabled or set to inactive by the facility administrator.
            </p>
            <button
              onClick={onNavigateToSettings}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition-all shadow-sm"
            >
              Open Facility Settings to Enable Courts
            </button>
          </div>
        ) : (
          /* Main 2-Column Grid */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left Column: Booking Options (8 cols) */}
            <div className="lg:col-span-8 space-y-6">
              {/* Step 1: Date Selection */}
              <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-blue-100 text-blue-700 font-bold text-xs flex items-center justify-center">
                      1
                    </div>
                    <h2 className="text-lg font-bold text-slate-900">
                      Select Date
                    </h2>
                  </div>
                  <span className="text-xs font-semibold text-slate-600">
                    {formatDatePretty(selectedDate)}
                  </span>
                </div>

                {/* Quick Date Chips */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 mb-4">
                  {quickDates.map((item) => {
                    const isSelected = selectedDate === item.dateStr;
                    return (
                      <button
                        key={item.dateStr}
                        type="button"
                        onClick={() => handleDateChange(item.dateStr)}
                        className={`p-3 rounded-xl border text-center transition-all cursor-pointer ${
                          isSelected
                            ? 'border-blue-600 bg-blue-50 text-blue-900 ring-2 ring-blue-600/20'
                            : 'border-slate-200 hover:border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <span className="block text-[11px] font-bold uppercase tracking-wider text-slate-600">
                          {item.dayName}
                        </span>
                        <span className="block text-xl font-extrabold my-0.5">
                          {item.dayNum}
                        </span>
                        <span className="block text-[10px] text-slate-600">
                          {item.label}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Or Pick Exact Date */}
                <div className="flex items-center gap-3 pt-2 text-xs text-slate-600 border-t border-slate-100">
                  <span className="font-medium">Or choose any future date:</span>
                  <div className="relative inline-block">
                    <input
                      type="date"
                      min={todayInTimezone}
                      value={selectedDate}
                      onChange={(e) => handleDateChange(e.target.value)}
                      className="px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                    />
                  </div>
                </div>
              </div>

              {/* Step 2: Court Selection */}
              <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-blue-100 text-blue-700 font-bold text-xs flex items-center justify-center">
                      2
                    </div>
                    <h2 className="text-lg font-bold text-slate-900">
                      Select Court
                    </h2>
                  </div>
                  <span className="text-xs text-slate-600">
                    {enabledCourts.length} court{enabledCourts.length !== 1 ? 's' : ''} available
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {enabledCourts.map((court) => {
                    const isSelected = selectedCourtId === court.id;
                    const availableCount = courtAvailabilityCounts[court.id] ?? timeSlots.length;

                    return (
                      <button
                        key={court.id}
                        type="button"
                        onClick={() => handleCourtChange(court.id)}
                        className={`p-4 rounded-xl border text-left transition-all cursor-pointer relative flex flex-col justify-between ${
                          isSelected
                            ? 'border-blue-600 bg-blue-50/70 text-slate-900 ring-2 ring-blue-600/20 shadow-xs'
                            : 'border-slate-200 hover:border-slate-300 bg-white text-slate-700 hover:bg-slate-50/50'
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-base font-extrabold text-slate-900">
                              {court.name}
                            </span>
                            {isSelected && (
                              <span className="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs">
                                <Check className="w-3 h-3" />
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 mb-2">
                            <span className="inline-block text-[10px] font-bold uppercase tracking-wider text-blue-700 bg-blue-100/60 px-2 py-0.5 rounded">
                              {court.sportType}
                            </span>
                            {court.tag && (
                              <span className="inline-block text-[10px] text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                                {court.tag}
                              </span>
                            )}
                            {isValidUuid(court.id) && (
                              <span className="inline-block text-[9px] font-mono text-purple-700 bg-purple-50 border border-purple-200 px-1.5 py-0.2 rounded">
                                RPC Synced
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-600 line-clamp-2 mb-3">
                            {court.description}
                          </p>
                        </div>

                        <div className="pt-2 border-t border-slate-200/60 flex items-center justify-between text-xs">
                          <span className="font-bold text-emerald-600">
                            {availableCount} slots open
                          </span>
                          <span className="font-bold text-slate-900">
                            {settings.currency}{court.hourlyRate}/hr
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Step 3: Time Slot Selection with Supabase RPC Busy Slots */}
              <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-blue-100 text-blue-700 font-bold text-xs flex items-center justify-center">
                      3
                    </div>
                    <h2 className="text-lg font-bold text-slate-900">
                      Select 1-Hour Time Slot
                    </h2>
                  </div>
                  <div className="flex items-center gap-2">
                    {isLoadingSlots && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-blue-600">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Checking RPC...
                      </span>
                    )}
                    <span className="text-xs text-slate-600 font-medium">
                      {formatHour12(openHour)} &ndash; {closeHour === 24 ? 'Midnight' : formatHour12(closeHour)}
                    </span>
                  </div>
                </div>

                <p className="text-xs text-slate-600 mb-4">
                  Showing real-time availability for <strong>{selectedCourt?.name}</strong> on <strong>{formatDatePretty(selectedDate)}</strong> ({effectiveTimezone}).
                </p>

                {/* Slot Legend */}
                <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 mb-4 pb-3 border-b border-slate-100">
                  <div className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded bg-white border border-slate-300"></span>
                    <span>Available ({settings.currency}{selectedCourt?.hourlyRate || 350})</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded bg-blue-600"></span>
                    <span>Selected</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded bg-purple-100 border border-purple-300"></span>
                    <span>Reserved in Supabase</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded bg-amber-100 border border-amber-300"></span>
                    <span>Maintenance Block</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded bg-slate-100 border border-slate-200"></span>
                    <span className="text-slate-500">Past / Started</span>
                  </div>
                </div>

                {/* Grid of 1-Hour Slots */}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
                  {timeSlots.map((slot) => {
                    const avail = getSlotAvailability(slot);
                    const isSelected = selectedSlotId === slot.id;

                    if (!avail.isAvailable) {
                      return (
                        <div
                          key={slot.id}
                          title={avail.reason}
                          className={`p-3 rounded-xl border text-xs cursor-not-allowed select-none relative transition-all ${
                            avail.type === 'blocked'
                              ? 'bg-amber-50 border-amber-200 text-amber-800'
                              : avail.type === 'reserved'
                              ? 'bg-purple-50 border-purple-200 text-purple-800'
                              : avail.type === 'past'
                              ? 'bg-slate-100/75 border-slate-200/80 text-slate-400 opacity-65'
                              : 'bg-slate-100 border-slate-200 text-slate-500'
                          }`}
                        >
                          <div className="flex items-center justify-between text-xs font-semibold mb-1">
                            <span className={avail.type === 'past' ? 'line-through text-slate-400' : ''}>
                              {slot.label.split('–')[0]}
                            </span>
                            {avail.type === 'blocked' ? (
                              <Wrench className="w-3 h-3 text-amber-600" />
                            ) : (
                              <span
                                className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${
                                  avail.type === 'reserved'
                                    ? 'bg-purple-200 text-purple-900'
                                    : avail.type === 'past'
                                    ? 'bg-slate-200 text-slate-500'
                                    : 'bg-slate-200 text-slate-700'
                                }`}
                              >
                                {avail.badge}
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] block opacity-85 line-clamp-1">
                            {avail.type === 'blocked'
                              ? 'Maintenance Block'
                              : avail.type === 'past'
                              ? 'Passed / Unavailable'
                              : avail.reason}
                          </span>
                        </div>
                      );
                    }

                    return (
                      <button
                        key={slot.id}
                        type="button"
                        onClick={() => handleSelectSlot(slot)}
                        className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                          isSelected
                            ? 'border-blue-600 bg-blue-600 text-white shadow-md ring-2 ring-blue-600/30'
                            : 'border-slate-200 hover:border-blue-400 bg-white text-slate-800 hover:bg-blue-50/30'
                        }`}
                      >
                        <div className="flex items-center justify-between text-xs font-bold">
                          <span>{slot.label.split('–')[0]}</span>
                          {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
                        </div>
                        <span
                          className={`text-[11px] block mt-0.5 ${
                            isSelected ? 'text-blue-100' : 'text-slate-600'
                          }`}
                        >
                          to {slot.label.split('–')[1]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Right Column: Checkout & Confirmation Card (4 cols) */}
            <div className="lg:col-span-4">
              <div className="sticky top-24 bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
                <h3 className="text-lg font-bold text-slate-900 mb-4 pb-3 border-b border-slate-100 flex items-center gap-2">
                  <FileCheck2 className="w-5 h-5 text-blue-600" />
                  Reservation Summary
                </h3>

                {/* Booking Highlights */}
                <div className="space-y-3 text-xs mb-6">
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-600">Facility</span>
                    <span className="font-bold text-slate-900">{settings.name}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-600">Court</span>
                    <span className="font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded">
                      {selectedCourt ? selectedCourt.name : 'None selected'}
                    </span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-600">Sport Type</span>
                    <span className="font-semibold text-slate-800">
                      {selectedCourt ? selectedCourt.sportType : '-'}
                    </span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-600">Date</span>
                    <span className="font-bold text-slate-900">
                      {formatDatePretty(selectedDate)}
                    </span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-600">Time Slot</span>
                    {selectedSlot ? (
                      <span className="font-bold text-slate-900">
                        {selectedSlot.label}
                      </span>
                    ) : (
                      <span className="text-amber-600 italic">None selected</span>
                    )}
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-600">Duration</span>
                    <span className="font-semibold text-slate-800">1 Hour</span>
                  </div>
                  <div className="flex justify-between py-1.5 text-sm pt-2">
                    <span className="font-bold text-slate-900">
                      {isConfigured ? 'Total Amount' : 'Total Demo Cost'}
                    </span>
                    <span className="font-extrabold text-blue-600 text-lg">
                      {settings.currency}{selectedCourt ? selectedCourt.hourlyRate : 350}
                    </span>
                  </div>
                </div>

                {/* Form: Customer Details */}
                <form onSubmit={handleConfirmReservation} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      Customer Name <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <User className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                      <input
                        type="text"
                        required
                        placeholder="e.g. Alex Santos"
                        value={customerName}
                        onChange={(e) => handleNameChange(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none placeholder:text-slate-400"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      Phone Number <span className="text-slate-500 font-normal">(or Email required)</span>
                    </label>
                    <div className="relative">
                      <Phone className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                      <input
                        type="tel"
                        placeholder="e.g. 0917-123-4567"
                        value={customerPhone}
                        onChange={(e) => handlePhoneChange(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none placeholder:text-slate-400"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      Email Address <span className="text-slate-500 font-normal">(for confirmation)</span>
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                      <input
                        type="email"
                        placeholder="e.g. player@example.com"
                        value={customerEmail}
                        onChange={(e) => handleEmailChange(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none placeholder:text-slate-400"
                      />
                    </div>
                  </div>

                  {/* Error / Uncertain Status Banner */}
                  {errorMessage && (
                    <div
                      className={`p-3.5 rounded-xl border text-xs flex items-start gap-2.5 ${
                        isUncertainOutcome
                          ? 'bg-amber-50 border-amber-300 text-amber-950'
                          : 'bg-red-50 border-red-200 text-red-700'
                      }`}
                    >
                      {isUncertainOutcome ? (
                        <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                      )}
                      <div className="space-y-1">
                        <span className="font-semibold block">{errorMessage}</span>
                        {isUncertainOutcome && (
                          <p className="text-[11px] text-amber-900/90 leading-relaxed">
                            Clicking retry will resubmit with your preserved request key so the system can safely recover your existing reservation without double-booking.
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Mode-Aware Notice Banner */}
                  <div className={`p-3.5 rounded-xl border text-[11px] flex items-start gap-2.5 ${
                    courtStatus?.booking_confirmation_mode === 'manual_approval' ||
                    settings.bookingConfirmationMode === 'manual_approval'
                      ? 'bg-amber-50/90 border-amber-300 text-amber-950'
                      : 'bg-blue-50/90 border-blue-200 text-blue-950'
                  }`}>
                    <Info className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
                    <div>
                      <strong className="block font-bold mb-0.5">
                        {courtStatus?.booking_confirmation_mode === 'manual_approval' ||
                        settings.bookingConfirmationMode === 'manual_approval'
                          ? 'OWNER APPROVAL WORKFLOW:'
                          : 'INSTANT CONFIRMATION WORKFLOW:'}
                      </strong>
                      {courtStatus?.booking_confirmation_mode === 'manual_approval' ||
                      settings.bookingConfirmationMode === 'manual_approval'
                        ? `Submitting will place an active ${courtStatus?.hold_duration_minutes || settings.holdDurationMinutes || 30}-minute hold on this court slot while venue staff reviews your request.`
                        : 'Your reservation will be validated atomically and confirmed immediately upon submission.'}
                    </div>
                  </div>

                  {/* Cloudflare Turnstile Bot Verification Challenge */}
                  {turnstileSiteKey ? (
                    <div className="space-y-1.5 pt-1">
                      <div className="flex items-center justify-between">
                        <label className="block text-xs font-bold text-slate-700">
                          Bot Verification <span className="text-red-500">*</span>
                        </label>
                        {captchaToken && (
                          <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-1">
                            <ShieldCheck className="w-3 h-3 text-emerald-600" />
                            Verified
                          </span>
                        )}
                      </div>
                      <div
                        ref={turnstileContainerRef}
                        className="min-h-[65px] bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-center p-1.5"
                      />
                      {captchaError && (
                        <p className="text-[11px] text-red-600 font-medium">{captchaError}</p>
                      )}
                    </div>
                  ) : isConfigured ? (
                    <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs flex items-start gap-2.5">
                      <ShieldAlert className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                      <div className="space-y-0.5">
                        <span className="font-bold block">Bot verification is unavailable</span>
                        <p className="text-[11px] text-red-700 leading-relaxed">
                          Live bookings require CAPTCHA protection, but <code className="font-mono bg-red-100 px-1 py-0.5 rounded">VITE_TURNSTILE_SITE_KEY</code> is not configured.
                          Bookings cannot be submitted until bot verification is configured by the venue administrator.
                        </p>
                      </div>
                    </div>
                  ) : null}

                  {/* Submit Button */}
                  <button
                    type="submit"
                    disabled={
                      !selectedSlotId ||
                      !selectedCourt ||
                      isSubmitting ||
                      !isFacilityAndCourtValid ||
                      Boolean(isConfigured && !turnstileSiteKey) ||
                      Boolean(isConfigured && turnstileSiteKey && !captchaToken)
                    }
                    className={`w-full py-3.5 px-4 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 cursor-pointer ${
                      selectedSlotId &&
                      selectedCourt &&
                      !isSubmitting &&
                      isFacilityAndCourtValid &&
                      (!isConfigured || (turnstileSiteKey && captchaToken))
                        ? courtStatus?.booking_confirmation_mode === 'manual_approval' ||
                          settings.bookingConfirmationMode === 'manual_approval'
                          ? 'bg-amber-600 hover:bg-amber-700 active:bg-amber-800 text-white shadow-md shadow-amber-500/20'
                          : 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-md shadow-blue-500/20'
                        : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    }`}
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Securing Reservation...</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle className="w-4 h-4" />
                        <span>
                          {!isFacilityAndCourtValid
                            ? 'Resolving Facility & Court...'
                            : isConfigured && !turnstileSiteKey
                            ? 'Bot Verification Unavailable'
                            : isConfigured && turnstileSiteKey && !captchaToken
                            ? 'Complete Bot Verification to Proceed'
                            : isUncertainOutcome
                            ? 'Retry Booking (Safely Recover Status)'
                            : selectedSlotId && selectedCourt
                            ? courtStatus?.booking_confirmation_mode === 'manual_approval' ||
                              settings.bookingConfirmationMode === 'manual_approval'
                              ? `Request Booking (${settings.currency}${selectedCourt.hourlyRate})`
                              : `Confirm Reservation (${settings.currency}${selectedCourt.hourlyRate})`
                            : 'Select an Available Slot to Proceed'}
                        </span>
                      </>
                    )}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
