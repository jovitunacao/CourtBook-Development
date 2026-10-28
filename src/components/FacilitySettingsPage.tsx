import React, { useState, useEffect } from 'react';
import {
  Building2,
  Clock,
  Dumbbell,
  Plus,
  Trash2,
  CheckCircle,
  RotateCcw,
  Save,
  AlertTriangle,
  ArrowRight,
  Eye,
  ToggleLeft,
  ToggleRight,
  Shield,
  Layers,
  Sparkles,
  Database,
  Lock,
} from 'lucide-react';
import {
  Court,
  FacilitySettings,
  AVAILABLE_SPORT_TYPES,
  formatHour12,
} from '../types/booking';
import { useSupabaseAuth } from '../context/SupabaseAuthContext';

interface FacilitySettingsPageProps {
  settings: FacilitySettings;
  onSaveSettings: (newSettings: FacilitySettings) => void;
  onResetSettings: () => void;
  onNavigateToBooking: () => void;
  onNavigateToReservations: () => void;
}

export const FacilitySettingsPage: React.FC<FacilitySettingsPageProps> = ({
  settings,
  onSaveSettings,
  onResetSettings,
  onNavigateToBooking,
  onNavigateToReservations,
}) => {
  const {
    isConfigured,
    user,
    onboardingState,
    staffData,
    demoProfile,
    isUsingSupabaseData,
    isDemoSession,
    updateConfirmationSettings,
  } = useSupabaseAuth();

  const isLiveSupabaseFacility = Boolean(staffData?.activeFacility) && !isDemoSession;

  // Local form state
  const [name, setName] = useState(settings.name);
  const [tagline, setTagline] = useState(settings.tagline);
  const [address, setAddress] = useState(settings.address);
  const [currency, setCurrency] = useState(settings.currency);
  const [openHour, setOpenHour] = useState<number>(settings.openHour);
  const [closeHour, setCloseHour] = useState<number>(settings.closeHour);
  const [courts, setCourts] = useState<Court[]>(settings.courts);
  const [bookingConfirmationMode, setBookingConfirmationMode] = useState<'instant' | 'manual_approval'>(
    settings.bookingConfirmationMode || 'instant'
  );
  const [holdDurationMinutes, setHoldDurationMinutes] = useState<number>(
    settings.holdDurationMinutes || 30
  );
  const [isUpdatingMode, setIsUpdatingMode] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);

  // Sync state if settings prop changes
  useEffect(() => {
    setName(settings.name);
    setTagline(settings.tagline);
    setAddress(settings.address);
    setCurrency(settings.currency);
    setOpenHour(settings.openHour);
    setCloseHour(settings.closeHour);
    setCourts(settings.courts);
    if (settings.bookingConfirmationMode) {
      setBookingConfirmationMode(settings.bookingConfirmationMode);
    }
    if (settings.holdDurationMinutes) {
      setHoldDurationMinutes(settings.holdDurationMinutes);
    }
  }, [settings]);

  const handleUpdateConfirmationMode = async (
    newMode: 'instant' | 'manual_approval',
    newHoldMinutes: number = holdDurationMinutes
  ) => {
    setBookingConfirmationMode(newMode);
    setHoldDurationMinutes(newHoldMinutes);

    if (isLiveSupabaseFacility) {
      setIsUpdatingMode(true);
      setErrorMsg(null);
      const res = await updateConfirmationSettings(newMode, newHoldMinutes);
      setIsUpdatingMode(false);
      if (res.success) {
        setSavedSuccess(true);
        setTimeout(() => setSavedSuccess(false), 3000);
      } else {
        setErrorMsg(res.error || 'Failed to update booking confirmation mode on Supabase.');
      }
    } else {
      // In local demo mode, update settings in parent
      onSaveSettings({
        ...settings,
        bookingConfirmationMode: newMode,
        holdDurationMinutes: newHoldMinutes,
      });
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3000);
    }
  };

  // Hour options for dropdowns (5 AM to 11 PM)
  const hourOptions = Array.from({ length: 20 }, (_, i) => i + 5);

  const handleAddCourt = () => {
    if (isLiveSupabaseFacility) {
      setErrorMsg('Adding courts to live Supabase facilities from the browser is disabled.');
      return;
    }
    const nextNumber = courts.length + 1;
    const newCourt: Court = {
      id: `court-${Date.now()}`,
      name: `Court ${nextNumber}`,
      sportType: 'Pickleball',
      tag: 'Standard Court',
      type: 'Indoor Cushioned Surface',
      description: 'Regulation sports court available for recreational and competitive bookings.',
      hourlyRate: 350,
      isEnabled: true,
    };
    setCourts([...courts, newCourt]);
    setSavedSuccess(false);
  };

  const handleUpdateCourt = (id: string, updates: Partial<Court>) => {
    if (isLiveSupabaseFacility) return;
    setCourts(
      courts.map((court) => (court.id === id ? { ...court, ...updates } : court))
    );
    setSavedSuccess(false);
  };

  const handleToggleCourtEnabled = (id: string) => {
    if (isLiveSupabaseFacility) {
      setErrorMsg('Modifying court availability in live Supabase facilities requires backend administrative privileges.');
      return;
    }
    setCourts(
      courts.map((court) =>
        court.id === id ? { ...court, isEnabled: !court.isEnabled } : court
      )
    );
    setSavedSuccess(false);
  };

  const handleDeleteCourt = (id: string) => {
    if (isLiveSupabaseFacility) {
      setErrorMsg('Deleting courts from live Supabase facilities is disabled.');
      return;
    }
    if (courts.length <= 1) {
      setErrorMsg('At least one court must remain configured for the facility.');
      return;
    }
    setCourts(courts.filter((c) => c.id !== id));
    setSavedSuccess(false);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    // Requirement 5: Disable unsupported administrative actions including settings changes on live facilities
    if (isLiveSupabaseFacility) {
      setErrorMsg(
        'Modifications to live Supabase facilities from browser clients are disabled in Phase 1 to preserve database schema integrity.'
      );
      return;
    }

    if (!name.trim()) {
      setErrorMsg('Facility name cannot be empty.');
      return;
    }

    if (closeHour <= openHour) {
      setErrorMsg('Closing hour must be at least 1 hour later than opening hour.');
      return;
    }

    if (courts.length === 0) {
      setErrorMsg('Please add at least one court.');
      return;
    }

    // Validate court rates and names
    for (const court of courts) {
      if (!court.name.trim()) {
        setErrorMsg('All courts must have a valid name.');
        return;
      }
      if (typeof court.hourlyRate !== 'number' || court.hourlyRate <= 0) {
        setErrorMsg(`Hourly rate for "${court.name}" must be greater than 0.`);
        return;
      }
    }

    const updatedSettings: FacilitySettings = {
      name: name.trim(),
      tagline: tagline.trim(),
      address: address.trim(),
      currency: currency.trim() || '₱',
      timezone: settings.timezone || 'Asia/Manila',
      openHour,
      closeHour,
      defaultHourlyRate: courts[0]?.hourlyRate || 350,
      courts,
    };

    onSaveSettings(updatedSettings);
    setSavedSuccess(true);
    setTimeout(() => {
      setSavedSuccess(false);
    }, 4000);
  };

  const handleReset = () => {
    if (isLiveSupabaseFacility) {
      setErrorMsg('Resetting live Supabase facility settings is disabled.');
      return;
    }
    if (window.confirm('Reset local facility settings to default sample data?')) {
      onResetSettings();
      setName(settings.name);
      setTagline(settings.tagline);
      setAddress(settings.address);
      setCurrency(settings.currency);
      setOpenHour(settings.openHour);
      setCloseHour(settings.closeHour);
      setCourts(settings.courts);
      setSavedSuccess(false);
      setErrorMsg(null);
    }
  };

  const enabledCourtsCount = courts.filter((c) => c.isEnabled).length;
  const totalSlotsCount = Math.max(0, closeHour - openHour);

  return (
    <div className="bg-slate-50 min-h-[calc(100vh-64px)] py-8 sm:py-12">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
        {user && onboardingState === 'needs_onboarding' ? (
          <div className="bg-white rounded-2xl border border-slate-200/90 p-6 sm:p-10 shadow-xs space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 pb-6 border-b border-slate-100">
              <div className="w-14 h-14 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-600 flex items-center justify-center shrink-0">
                <Building2 className="w-7 h-7" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase font-extrabold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                    Owner Onboarding Required
                  </span>
                  <span className="text-xs text-slate-400 font-mono">
                    {user.email}
                  </span>
                </div>
                <h2 className="text-xl font-extrabold text-slate-900 tracking-tight">
                  Facility Configuration Pending Organization Setup
                </h2>
                <p className="text-xs text-slate-600">
                  Your court owner account is registered, but no sports facility has been provisioned yet.
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 space-y-2">
              <p className="text-xs text-slate-600 leading-relaxed">
                Self-service organization and facility onboarding will be provided in <strong>Stage 3.3</strong>. Once completed, your facility settings and courts can be viewed and customized here.
              </p>
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <button
                type="button"
                onClick={() => onNavigateToBooking()}
                className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold transition-colors cursor-pointer"
              >
                View Public Booking Directory
              </button>
              <button
                type="button"
                onClick={() => onNavigateToReservations()}
                className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition-colors cursor-pointer"
              >
                Go to Status Console
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Navigation Breadcrumb / Sub-Tabs */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900 text-white text-xs font-bold uppercase tracking-wider mb-2">
              <Shield className="w-3.5 h-3.5 text-blue-400" />
              <span>Facility Configuration Console</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
              Facility Settings & Court Catalog
            </h1>
            <p className="text-slate-600 text-sm mt-1">
              Configure venue branding, operating hours, court capacity, sport types, and hourly rates.
            </p>
            {isUsingSupabaseData && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-50 border border-blue-200 text-xs font-semibold text-blue-900">
                  <Database className="w-3.5 h-3.5 text-blue-600" />
                  <span>
                    Linked Organization:{' '}
                    <strong>{staffData?.activeOrganization?.name || demoProfile?.orgName}</strong>
                    {' '}(slug: {staffData?.activeOrganization?.slug || demoProfile?.orgSlug})
                  </span>
                </span>
                {staffData?.activeFacility && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-purple-50 border border-purple-200 text-xs font-semibold text-purple-900">
                    Facility: {staffData.activeFacility.name} ({staffData.activeFacility.slug})
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Sub-navigation tabs */}
          <div className="flex items-center gap-2">
            <button
              onClick={onNavigateToReservations}
              className="px-4 py-2 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-xl text-xs font-bold transition-colors cursor-pointer shadow-xs"
            >
              Reservations Table
            </button>
            <button
              onClick={onNavigateToBooking}
              className="px-4 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>View Booking Page</span>
            </button>
          </div>
        </div>

        {/* Live Facility Restriction Notice (Requirement 5) */}
        {isLiveSupabaseFacility && (
          <div className="p-4 rounded-2xl bg-purple-50 border border-purple-200 text-purple-950 flex items-start gap-3 shadow-xs">
            <Lock className="w-5 h-5 text-purple-600 shrink-0 mt-0.5" />
            <div className="text-xs space-y-1">
              <span className="font-extrabold text-purple-900 block text-sm">
                Live Supabase Facility Settings (Read-Only)
              </span>
              <p className="text-purple-900/90 leading-relaxed">
                You are currently managing <strong>{staffData?.activeFacility?.name}</strong> on BookSuite-Dev.
                In accordance with database security architecture, live facility settings, operating hours,
                and court schemas are governed through database migrations. Browser-side administrative updates
                to live facilities are restricted.
              </p>
            </div>
          </div>
        )}

        {/* Feedback Alerts */}
        {savedSuccess && (
          <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-semibold flex items-center justify-between shadow-xs">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-emerald-600" />
              <span>Facility settings successfully saved to local browser storage!</span>
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="p-4 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm font-semibold flex items-center justify-between shadow-xs">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-600" />
              <span>{errorMsg}</span>
            </div>
            <button
              onClick={() => setErrorMsg(null)}
              className="text-xs text-red-500 hover:text-red-700 font-bold"
            >
              Dismiss
            </button>
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-8">
          {/* Phase 2: Booking Confirmation Mode & Hold Preferences */}
          <div className="bg-white rounded-2xl border-2 border-blue-100 p-6 shadow-sm space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    <span>Booking Confirmation Method</span>
                    <span className="font-mono text-[10px] bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full uppercase font-extrabold">
                      Facility Preference
                    </span>
                  </h2>
                  <p className="text-xs text-slate-500">
                    Choose how customer reservations are processed: instant confirmation or staff manual approval with a temporary slot hold.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Option 1: Instant Confirmation */}
              <div
                onClick={() => handleUpdateConfirmationMode('instant')}
                className={`p-4 rounded-xl border-2 transition-all cursor-pointer ${
                  bookingConfirmationMode === 'instant'
                    ? 'border-blue-600 bg-blue-50/50 shadow-xs'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-slate-900">Instant Confirmation</span>
                      {bookingConfirmationMode === 'instant' && (
                        <span className="text-[10px] bg-blue-600 text-white font-bold px-2 py-0.5 rounded">Active</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Customer selects an available court slot and receives an immediate confirmed booking reference code. No manual approval required.
                    </p>
                  </div>
                  <input
                    type="radio"
                    name="bookingConfirmationMode"
                    checked={bookingConfirmationMode === 'instant'}
                    onChange={() => handleUpdateConfirmationMode('instant')}
                    className="mt-1 h-4 w-4 text-blue-600 cursor-pointer"
                  />
                </div>
              </div>

              {/* Option 2: Owner / Staff Approval */}
              <div
                onClick={() => handleUpdateConfirmationMode('manual_approval')}
                className={`p-4 rounded-xl border-2 transition-all cursor-pointer ${
                  bookingConfirmationMode === 'manual_approval'
                    ? 'border-blue-600 bg-blue-50/50 shadow-xs'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-slate-900">Owner Approval</span>
                      {bookingConfirmationMode === 'manual_approval' && (
                        <span className="text-[10px] bg-blue-600 text-white font-bold px-2 py-0.5 rounded">Active</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Customer submits a request. The slot is held pending review. Authorized staff can approve or decline the request from the admin dashboard.
                    </p>
                  </div>
                  <input
                    type="radio"
                    name="bookingConfirmationMode"
                    checked={bookingConfirmationMode === 'manual_approval'}
                    onChange={() => handleUpdateConfirmationMode('manual_approval')}
                    className="mt-1 h-4 w-4 text-blue-600 cursor-pointer"
                  />
                </div>
              </div>
            </div>

            {/* Hold Duration Configuration */}
            {bookingConfirmationMode === 'manual_approval' && (
              <div className="p-4 rounded-xl bg-amber-50/60 border border-amber-200 text-xs space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <label className="font-bold text-slate-800 block text-xs">
                      Approval Hold Window (Minutes)
                    </label>
                    <span className="text-slate-500 text-[11px]">
                      Pending slots are temporarily reserved for this duration before auto-expiring to reopen availability.
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={holdDurationMinutes}
                      onChange={(e) =>
                        handleUpdateConfirmationMode('manual_approval', Number(e.target.value))
                      }
                      className="px-3 py-1.5 font-bold text-xs bg-white border border-amber-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500 cursor-pointer"
                    >
                      <option value={15}>15 minutes</option>
                      <option value={30}>30 minutes (Default)</option>
                      <option value={45}>45 minutes</option>
                      <option value={60}>60 minutes</option>
                      <option value={120}>2 hours</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Section 1: Venue Branding & Address */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-6">
            <div className="flex items-center gap-2.5 pb-4 border-b border-slate-100">
              <div className="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
                <Building2 className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  Venue Branding & Location
                </h2>
                <p className="text-xs text-slate-500">
                  Business name, promotional tagline, and physical address shown to customers.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Facility Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  disabled={isLiveSupabaseFacility}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Apex Pickleball Arena"
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Promotional Tagline
                </label>
                <input
                  type="text"
                  disabled={isLiveSupabaseFacility}
                  value={tagline}
                  onChange={(e) => setTagline(e.target.value)}
                  placeholder="e.g. Premier Indoor Courts & Community Hub"
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Venue Address / Physical Grounds
                </label>
                <input
                  type="text"
                  disabled={isLiveSupabaseFacility}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="e.g. 128 Sports Boulevard, Metro District"
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
                />
              </div>
            </div>
          </div>

          {/* Section 2: Operating Hours & Currency */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-6">
            <div className="flex items-center gap-2.5 pb-4 border-b border-slate-100">
              <div className="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
                <Clock className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  Operating Hours & Currency
                </h2>
                <p className="text-xs text-slate-500">
                  Controls the start and end of daily bookable slot intervals.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Opening Time
                </label>
                <select
                  disabled={isLiveSupabaseFacility}
                  value={openHour}
                  onChange={(e) => setOpenHour(Number(e.target.value))}
                  className="w-full px-3.5 py-2.5 text-sm font-semibold border border-slate-200 rounded-xl bg-white focus:ring-2 focus:ring-blue-500 focus:outline-none cursor-pointer disabled:bg-slate-50 disabled:text-slate-500"
                >
                  {hourOptions.map((hour) => (
                    <option key={hour} value={hour}>
                      {formatHour12(hour)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Closing Time
                </label>
                <select
                  disabled={isLiveSupabaseFacility}
                  value={closeHour}
                  onChange={(e) => setCloseHour(Number(e.target.value))}
                  className="w-full px-3.5 py-2.5 text-sm font-semibold border border-slate-200 rounded-xl bg-white focus:ring-2 focus:ring-blue-500 focus:outline-none cursor-pointer disabled:bg-slate-50 disabled:text-slate-500"
                >
                  {Array.from({ length: 19 }, (_, i) => i + 6).map((hour) => (
                    <option key={hour} value={hour}>
                      {hour === 24 ? 'Midnight' : formatHour12(hour)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Currency Symbol
                </label>
                <input
                  type="text"
                  disabled={isLiveSupabaseFacility}
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  placeholder="₱"
                  className="w-full px-3.5 py-2.5 text-sm font-bold border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
                />
              </div>
            </div>
          </div>

          {/* Section 3: Court Catalog */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
                  <Dumbbell className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Courts Catalog ({courts.length})
                  </h2>
                  <p className="text-xs text-slate-500">
                    Configure individual courts, sport types, and hourly rental rates.
                  </p>
                </div>
              </div>

              {!isLiveSupabaseFacility && (
                <button
                  type="button"
                  onClick={handleAddCourt}
                  className="px-3.5 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add New Court</span>
                </button>
              )}
            </div>

            <div className="space-y-4">
              {courts.map((court, index) => {
                return (
                  <div
                    key={court.id}
                    className={`p-5 rounded-2xl border transition-all ${
                      court.isEnabled
                        ? 'border-slate-200 bg-white'
                        : 'border-slate-200/80 bg-slate-50/80 opacity-75'
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
                      <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-lg bg-slate-100 text-slate-700 font-bold text-xs flex items-center justify-center">
                          {index + 1}
                        </span>
                        <input
                          type="text"
                          required
                          disabled={isLiveSupabaseFacility}
                          value={court.name}
                          onChange={(e) =>
                            handleUpdateCourt(court.id, { name: e.target.value })
                          }
                          className="font-bold text-slate-900 text-sm border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-none px-1 py-0.5 rounded"
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        {/* Toggle active switch */}
                        {!isLiveSupabaseFacility ? (
                          <button
                            type="button"
                            onClick={() => handleToggleCourtEnabled(court.id)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors cursor-pointer ${
                              court.isEnabled
                                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                            }`}
                          >
                            {court.isEnabled ? (
                              <>
                                <ToggleRight className="w-4 h-4 text-emerald-600" />
                                <span>Active</span>
                              </>
                            ) : (
                              <>
                                <ToggleLeft className="w-4 h-4 text-slate-500" />
                                <span>Disabled</span>
                              </>
                            )}
                          </button>
                        ) : (
                          <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-emerald-50 text-emerald-700">
                            Active
                          </span>
                        )}

                        {!isLiveSupabaseFacility && courts.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleDeleteCourt(court.id)}
                            title="Remove court"
                            className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4">
                      {/* Sport Type */}
                      <div>
                        <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                          Sport Type
                        </label>
                        <select
                          disabled={isLiveSupabaseFacility}
                          value={court.sportType}
                          onChange={(e) =>
                            handleUpdateCourt(court.id, { sportType: e.target.value })
                          }
                          className="w-full px-3 py-2 text-xs font-bold border border-slate-200 rounded-xl bg-white focus:ring-2 focus:ring-blue-500 focus:outline-none cursor-pointer disabled:bg-slate-50 disabled:text-slate-500"
                        >
                          {AVAILABLE_SPORT_TYPES.map((st) => (
                            <option key={st} value={st}>
                              {st}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Rental Rate */}
                      <div>
                        <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                          Rental Rate ({currency}/hour)
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-2.5 text-xs font-bold text-slate-500">
                            {currency}
                          </span>
                          <input
                            type="number"
                            min="50"
                            step="25"
                            required
                            disabled={isLiveSupabaseFacility}
                            value={court.hourlyRate}
                            onChange={(e) =>
                              handleUpdateCourt(court.id, {
                                hourlyRate: Number(e.target.value),
                              })
                            }
                            className="w-full pl-8 pr-3 py-2 text-xs font-bold border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
                          />
                        </div>
                      </div>

                      {/* Court Tag / Badge */}
                      <div>
                        <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                          Court Tag
                        </label>
                        <input
                          type="text"
                          disabled={isLiveSupabaseFacility}
                          value={court.tag}
                          onChange={(e) =>
                            handleUpdateCourt(court.id, { tag: e.target.value })
                          }
                          placeholder="e.g. Tournament Court"
                          className="w-full px-3 py-2 text-xs border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Sticky Bottom Actions Bar */}
          <div className="sticky bottom-6 z-30 bg-white/95 backdrop-blur-md p-4 sm:p-5 rounded-2xl border border-slate-200 shadow-xl flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-xs text-slate-600 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500"></span>
              <span>
                {isLiveSupabaseFacility ? (
                  <>
                    Live Supabase facility mode: Changes are managed by database schema. Browser edits locked.
                  </>
                ) : (
                  <>
                    Demo mode: Changes stored locally in your browser&apos;s <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">localStorage</code>.
                  </>
                )}
              </span>
            </div>

            <div className="flex items-center gap-3 w-full sm:w-auto">
              {!isLiveSupabaseFacility && (
                <button
                  type="button"
                  onClick={handleReset}
                  className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-semibold transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset to Defaults</span>
                </button>
              )}

              <button
                type="submit"
                disabled={isLiveSupabaseFacility}
                className={`flex-1 sm:flex-initial px-6 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer ${
                  isLiveSupabaseFacility
                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-md hover:shadow-blue-500/20'
                }`}
              >
                {isLiveSupabaseFacility ? (
                  <>
                    <Lock className="w-4 h-4" />
                    <span>Live Facility (Read-Only)</span>
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    <span>Save Demo Settings</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </>
    )}
  </div>
</div>
);
};
