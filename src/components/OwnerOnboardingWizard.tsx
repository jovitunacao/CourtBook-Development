import React, { useState, useEffect } from 'react';
import {
  Building2,
  MapPin,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Plus,
  Trash2,
  ArrowRight,
  Shield,
  Layers,
  Sparkles,
  Info,
  ChevronRight,
  LogOut,
  RotateCcw,
} from 'lucide-react';
import { useSupabaseAuth } from '../context/SupabaseAuthContext';
import {
  createOrganizationWithOwnerViaRpc,
  createFacilityForOwner,
  createCourtsForFacility,
  getOwnerOnboardingRecoveryState,
  slugify,
  validateSlug,
  validateOrganizationInput,
  validateFacilityInput,
  validateCourtsInput,
  CreateCourtItemInput,
} from '../lib/supabaseClient';

const SPORT_TYPES = [
  'Pickleball',
  'Padel',
  'Badminton',
  'Tennis',
  'Basketball',
  'Squash',
  'Volleyball',
  'Table Tennis',
];

const HOLD_DURATION_OPTIONS = [
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes (Standard)' },
  { value: 45, label: '45 minutes' },
  { value: 60, label: '60 minutes (1 hour)' },
  { value: 120, label: '120 minutes (2 hours)' },
];

interface OwnerOnboardingWizardProps {
  onComplete: () => void;
  onNavigateToBooking?: () => void;
}

export const OwnerOnboardingWizard: React.FC<OwnerOnboardingWizardProps> = ({
  onComplete,
  onNavigateToBooking,
}) => {
  const { user, refreshStaffData, signOut } = useSupabaseAuth();

  // Wizard Navigation State
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);
  const [isCheckingRecovery, setIsCheckingRecovery] = useState<boolean>(true);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  // STEP 1 — Organization State
  const [orgName, setOrgName] = useState<string>('');
  const [orgSlug, setOrgSlug] = useState<string>('');
  const [isOrgSlugManual, setIsOrgSlugManual] = useState<boolean>(false);
  const [billingEmail, setBillingEmail] = useState<string>(user?.email || '');
  const [persistedOrgId, setPersistedOrgId] = useState<string | null>(null);
  const [persistedOrgName, setPersistedOrgName] = useState<string | null>(null);

  // STEP 2 — Facility State
  const [facilityName, setFacilityName] = useState<string>('');
  const [facilitySlug, setFacilitySlug] = useState<string>('');
  const [isFacilitySlugManual, setIsFacilitySlugManual] = useState<boolean>(false);
  const [facilityAddress, setFacilityAddress] = useState<string>('');
  const [facilityTagline, setFacilityTagline] = useState<string>('');
  const [openHour, setOpenHour] = useState<number>(8); // 8 AM
  const [closeHour, setCloseHour] = useState<number>(22); // 10 PM
  const [defaultHourlyRate, setDefaultHourlyRate] = useState<number>(350);
  const [confirmationMode, setConfirmationMode] = useState<'instant' | 'manual_approval'>('instant');
  const [holdDurationMinutes, setHoldDurationMinutes] = useState<number>(30);
  const [persistedFacilityId, setPersistedFacilityId] = useState<string | null>(null);
  const [persistedFacilityName, setPersistedFacilityName] = useState<string | null>(null);

  // STEP 3 — Courts State
  const [courtsList, setCourtsList] = useState<CreateCourtItemInput[]>([
    {
      name: 'Court 1',
      sport_type: 'Pickleball',
      hourly_rate: 350,
      surface_type: 'Pro Cushioned Acrylic',
      tag: 'Main Court',
      is_enabled: true,
      display_order: 0,
    },
  ]);

  // Inspect existing onboarding progress on mount to resume safely (Requirement 5 & 7)
  useEffect(() => {
    let isMounted = true;

    async function checkRecovery() {
      setIsCheckingRecovery(true);
      try {
        const recovery = await getOwnerOnboardingRecoveryState(user?.id);

        if (!isMounted) return;

        if (recovery.status === 'needs_facility' && recovery.organization) {
          setPersistedOrgId(recovery.organization.id);
          setPersistedOrgName(recovery.organization.name);
          setOrgName(recovery.organization.name);
          setOrgSlug(recovery.organization.slug);
          // Suggest facility name based on org
          if (!facilityName) {
            setFacilityName(`${recovery.organization.name} Arena`);
            setFacilitySlug(slugify(`${recovery.organization.name} arena`));
          }
          setCurrentStep(2);
          setRecoveryNotice(
            `Resumed setup: Organization "${recovery.organization.name}" is already registered. Please configure your primary facility.`
          );
        } else if (recovery.status === 'needs_courts' && recovery.facility) {
          if (recovery.organization) {
            setPersistedOrgId(recovery.organization.id);
            setPersistedOrgName(recovery.organization.name);
          }
          setPersistedFacilityId(recovery.facility.id);
          setPersistedFacilityName(recovery.facility.name);
          setFacilityName(recovery.facility.name);
          // Inherit default rate for courts
          const facRate = Number(recovery.facility.default_hourly_rate) || 350;
          setDefaultHourlyRate(facRate);
          setCourtsList([
            {
              name: 'Court 1',
              sport_type: 'Pickleball',
              hourly_rate: facRate,
              surface_type: 'Pro Cushioned Acrylic',
              tag: 'Main Court',
              is_enabled: true,
              display_order: 0,
            },
          ]);
          setCurrentStep(3);
          setRecoveryNotice(
            `Resumed setup: Facility "${recovery.facility.name}" is already registered. Please add your courts to finalize your workspace.`
          );
        } else if (recovery.status === 'complete') {
          // Already complete -> route directly
          onComplete();
        }
      } catch (err: any) {
        console.warn('Could not inspect recovery state:', err);
      } finally {
        if (isMounted) {
          setIsCheckingRecovery(false);
        }
      }
    }

    if (user?.id) {
      checkRecovery();
    } else {
      setIsCheckingRecovery(false);
    }

    return () => {
      isMounted = false;
    };
  }, [user?.id, onComplete]);

  // Handle Org Name Change -> Auto-slugify
  const handleOrgNameChange = (val: string) => {
    setOrgName(val);
    setGeneralError(null);
    if (!isOrgSlugManual) {
      setOrgSlug(slugify(val));
    }
  };

  // Handle Facility Name Change -> Auto-slugify
  const handleFacilityNameChange = (val: string) => {
    setFacilityName(val);
    setGeneralError(null);
    if (!isFacilitySlugManual) {
      setFacilitySlug(slugify(val));
    }
  };

  // STEP 1: Submit Organization
  const handleStep1Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneralError(null);

    // If already created in this session or recovered, advance to step 2 directly
    if (persistedOrgId) {
      setCurrentStep(2);
      return;
    }

    const cleanSlug = slugify(orgSlug || orgName);
    const validation = validateOrganizationInput(orgName, cleanSlug, billingEmail);
    if (!validation.isValid) {
      setGeneralError(validation.error || 'Please correct the organization details.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await createOrganizationWithOwnerViaRpc(orgName, cleanSlug, billingEmail);
      if (!result.success) {
        setGeneralError(result.error || 'Failed to create organization.');
        return;
      }

      setPersistedOrgId(result.organizationId!);
      setPersistedOrgName(orgName.trim());

      // Pre-fill facility name if empty
      if (!facilityName) {
        setFacilityName(`${orgName.trim()} Venue`);
        setFacilitySlug(slugify(`${orgName.trim()} venue`));
      }

      setRecoveryNotice(null);
      setCurrentStep(2);
    } catch (err: any) {
      setGeneralError(err.message || 'An unexpected error occurred.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // STEP 2: Submit Facility
  const handleStep2Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneralError(null);

    if (!persistedOrgId) {
      setGeneralError('Organization information is missing. Please return to Step 1.');
      setCurrentStep(1);
      return;
    }

    // If facility was already persisted, proceed to Step 3
    if (persistedFacilityId) {
      setCurrentStep(3);
      return;
    }

    const cleanSlug = slugify(facilitySlug || facilityName);
    const facilityPayload = {
      name: facilityName.trim(),
      slug: cleanSlug,
      address: facilityAddress.trim() || null,
      tagline: facilityTagline.trim() || null,
      timezone: 'Asia/Manila',
      currency: '₱',
      open_hour: openHour,
      close_hour: closeHour,
      default_hourly_rate: Number(defaultHourlyRate),
      booking_confirmation_mode: confirmationMode,
      hold_duration_minutes: confirmationMode === 'manual_approval' ? holdDurationMinutes : 30,
    };

    const validation = validateFacilityInput(persistedOrgId, facilityPayload);
    if (!validation.isValid) {
      setGeneralError(validation.error || 'Please correct the facility details.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await createFacilityForOwner(persistedOrgId, facilityPayload);
      if (!result.success || !result.facility) {
        setGeneralError(result.error || 'Failed to create facility.');
        return;
      }

      setPersistedFacilityId(result.facility.id);
      setPersistedFacilityName(result.facility.name);

      // Pre-populate court rate from facility default
      setCourtsList((prev) =>
        prev.map((c) => ({
          ...c,
          hourly_rate: c.hourly_rate || Number(defaultHourlyRate) || 350,
        }))
      );

      setRecoveryNotice(null);
      setCurrentStep(3);
    } catch (err: any) {
      setGeneralError(err.message || 'An unexpected error occurred.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Court Entry Management
  const handleAddCourt = () => {
    const nextIndex = courtsList.length + 1;
    setCourtsList([
      ...courtsList,
      {
        name: `Court ${nextIndex}`,
        sport_type: 'Pickleball',
        hourly_rate: defaultHourlyRate || 350,
        surface_type: 'Standard Surface',
        tag: 'Regulation Court',
        is_enabled: true,
        display_order: nextIndex - 1,
      },
    ]);
  };

  const handleRemoveCourt = (index: number) => {
    if (courtsList.length <= 1) return;
    setCourtsList(courtsList.filter((_, i) => i !== index));
  };

  const handleUpdateCourt = (index: number, field: keyof CreateCourtItemInput, value: any) => {
    setCourtsList((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  // STEP 3: Submit Courts & Finalize
  const handleStep3Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneralError(null);

    if (!persistedFacilityId) {
      setGeneralError('Facility information is missing. Please return to Step 2.');
      setCurrentStep(2);
      return;
    }

    const validation = validateCourtsInput(persistedFacilityId, courtsList);
    if (!validation.isValid) {
      setGeneralError(validation.error || 'Please correct the court details.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await createCourtsForFacility(persistedFacilityId, courtsList);
      if (!result.success) {
        setGeneralError(result.error || 'Failed to configure courts.');
        return;
      }

      // Refresh staff data to synchronize context state with the live workspace
      await refreshStaffData();

      // Launch admin view
      onComplete();
    } catch (err: any) {
      setGeneralError(err.message || 'An unexpected error occurred finalizing setup.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isCheckingRecovery) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-20 flex items-center justify-center">
        <div className="bg-white rounded-2xl border border-slate-200/90 p-8 shadow-sm text-center max-w-md w-full space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-bold text-slate-900">Checking Onboarding Status...</h3>
            <p className="text-xs text-slate-500">Checking for existing organizations and facilities...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Wizard Header */}
        <div className="px-6 sm:px-10 pt-8 pb-6 bg-gradient-to-b from-slate-50 to-white border-b border-slate-100">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-sm shrink-0">
                <Building2 className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 tracking-wider">
                    Owner Onboarding
                  </span>
                  <span className="text-xs text-slate-400 font-mono truncate max-w-[200px]">
                    {user?.email}
                  </span>
                </div>
                <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight mt-0.5">
                  Launch Your CourtBook Business
                </h1>
              </div>
            </div>

            <button
              type="button"
              onClick={() => signOut()}
              className="self-start sm:self-auto px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-600 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>

          {/* Stepper Bar */}
          <div className="grid grid-cols-3 gap-2 sm:gap-4 pt-2">
            {/* Step 1 Indicator */}
            <div
              className={`p-3 rounded-2xl border transition-all ${
                currentStep === 1
                  ? 'bg-white border-blue-600 shadow-sm'
                  : currentStep > 1
                  ? 'bg-emerald-50/70 border-emerald-200 text-emerald-800'
                  : 'bg-slate-50/70 border-slate-200 text-slate-400'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 ${
                    currentStep === 1
                      ? 'bg-blue-600 text-white'
                      : currentStep > 1
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  {currentStep > 1 ? <CheckCircle2 className="w-4 h-4" /> : '1'}
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-bold truncate">1. Organization</p>
                  <p className="text-[10px] text-slate-500 truncate hidden sm:block">Business Brand</p>
                </div>
              </div>
            </div>

            {/* Step 2 Indicator */}
            <div
              className={`p-3 rounded-2xl border transition-all ${
                currentStep === 2
                  ? 'bg-white border-blue-600 shadow-sm'
                  : currentStep > 2
                  ? 'bg-emerald-50/70 border-emerald-200 text-emerald-800'
                  : 'bg-slate-50/70 border-slate-200 text-slate-400'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 ${
                    currentStep === 2
                      ? 'bg-blue-600 text-white'
                      : currentStep > 2
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  {currentStep > 2 ? <CheckCircle2 className="w-4 h-4" /> : '2'}
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-bold truncate">2. Venue</p>
                  <p className="text-[10px] text-slate-500 truncate hidden sm:block">Primary Facility</p>
                </div>
              </div>
            </div>

            {/* Step 3 Indicator */}
            <div
              className={`p-3 rounded-2xl border transition-all ${
                currentStep === 3
                  ? 'bg-white border-blue-600 shadow-sm'
                  : 'bg-slate-50/70 border-slate-200 text-slate-400'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 ${
                    currentStep === 3
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  3
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-bold truncate">3. Courts</p>
                  <p className="text-[10px] text-slate-500 truncate hidden sm:block">Sports & Pricing</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Recovery Alert if resuming */}
        {recoveryNotice && (
          <div className="mx-6 sm:mx-10 mt-6 p-3.5 rounded-2xl bg-amber-50/80 border border-amber-200 text-xs text-amber-900 flex items-start gap-2.5">
            <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-bold">Safe Setup Resumption</p>
              <p className="text-amber-800 leading-relaxed text-[11px]">{recoveryNotice}</p>
            </div>
          </div>
        )}

        {/* Global Error Banner */}
        {generalError && (
          <div className="mx-6 sm:mx-10 mt-6 p-4 rounded-2xl bg-red-50 border border-red-200 text-xs text-red-900 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold">Action Required</p>
              <p className="text-red-700 leading-relaxed">{generalError}</p>
            </div>
          </div>
        )}

        {/* Step Content */}
        <div className="p-6 sm:p-10">
          {/* ========================================================================= */}
          {/* STEP 1: ORGANIZATION */}
          {/* ========================================================================= */}
          {currentStep === 1 && (
            <form onSubmit={handleStep1Submit} className="space-y-6">
              <div className="space-y-1">
                <h2 className="text-lg font-bold text-slate-900">Step 1 — Register Your Organization</h2>
                <p className="text-xs text-slate-500">
                  Every athletic venue on BookSuite belongs to an organization. You will be registered as the primary owner.
                </p>
              </div>

              <div className="space-y-4">
                {/* Org Name */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    Organization / Business Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={orgName}
                    onChange={(e) => handleOrgNameChange(e.target.value)}
                    placeholder="e.g. Metro Manila Padel & Pickleball Club"
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm font-medium text-slate-900 placeholder:text-slate-400"
                  />
                  <p className="text-[11px] text-slate-400 mt-1">2 to 120 characters</p>
                </div>

                {/* Org Slug */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-bold text-slate-700">
                      Organization Slug <span className="text-red-500">*</span>
                    </label>
                    <span className="text-[11px] text-slate-400 font-mono">Lowercase & hyphens</span>
                  </div>
                  <div className="flex items-center rounded-xl border border-slate-200 bg-slate-50 focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent overflow-hidden">
                    <span className="px-3 text-xs text-slate-400 font-mono select-none">
                      courtbook.app/org/
                    </span>
                    <input
                      type="text"
                      required
                      value={orgSlug}
                      onChange={(e) => {
                        setOrgSlug(e.target.value);
                        setIsOrgSlugManual(true);
                      }}
                      placeholder="metro-manila-padel"
                      className="w-full py-2.5 pr-4 bg-transparent text-sm font-mono text-slate-900 focus:outline-none"
                    />
                  </div>
                  {orgSlug && !validateSlug(orgSlug).isValid && (
                    <p className="text-[11px] text-red-600 mt-1">
                      {validateSlug(orgSlug).error}
                    </p>
                  )}
                </div>

                {/* Billing Email */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    Billing / Contact Email <span className="text-slate-400 font-normal">(Optional)</span>
                  </label>
                  <input
                    type="email"
                    value={billingEmail}
                    onChange={(e) => setBillingEmail(e.target.value)}
                    placeholder="billing@yourclub.ph"
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                  <p className="text-[11px] text-slate-400 mt-1">
                    Defaults to your account email: {user?.email}
                  </p>
                </div>
              </div>

              {/* Form Controls */}
              <div className="flex items-center justify-between pt-4 border-t border-slate-100">
                {onNavigateToBooking ? (
                  <button
                    type="button"
                    onClick={onNavigateToBooking}
                    className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
                  >
                    Cancel & Browse Directory
                  </button>
                ) : (
                  <div />
                )}

                <button
                  type="submit"
                  disabled={isSubmitting || !orgName.trim() || !validateSlug(orgSlug).isValid}
                  className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-bold flex items-center gap-2 shadow-sm transition-colors cursor-pointer"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Creating Organization...</span>
                    </>
                  ) : (
                    <>
                      <span>Continue to Facility Setup</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* ========================================================================= */}
          {/* STEP 2: FACILITY */}
          {/* ========================================================================= */}
          {currentStep === 2 && (
            <form onSubmit={handleStep2Submit} className="space-y-6">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-slate-900">Step 2 — Set Up Your Primary Facility</h2>
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700">
                    Org: {persistedOrgName || orgName}
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  Configure your primary athletic grounds, operating hours, and booking confirmation policy.
                </p>
              </div>

              <div className="space-y-4">
                {/* Facility Name */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    Facility Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={facilityName}
                    onChange={(e) => handleFacilityNameChange(e.target.value)}
                    placeholder="e.g. Apex Pickleball Arena Central"
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm font-medium text-slate-900 placeholder:text-slate-400"
                  />
                </div>

                {/* Facility Slug */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-bold text-slate-700">
                      Facility URL Slug <span className="text-red-500">*</span>
                    </label>
                    <span className="text-[11px] text-slate-400 font-mono">Public booking URL</span>
                  </div>
                  <div className="flex items-center rounded-xl border border-slate-200 bg-slate-50 focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent overflow-hidden">
                    <span className="px-3 text-xs text-slate-400 font-mono select-none">
                      courtbook.app/
                    </span>
                    <input
                      type="text"
                      required
                      value={facilitySlug}
                      onChange={(e) => {
                        setFacilitySlug(e.target.value);
                        setIsFacilitySlugManual(true);
                      }}
                      placeholder="apex-pickleball-central"
                      className="w-full py-2.5 pr-4 bg-transparent text-sm font-mono text-slate-900 focus:outline-none"
                    />
                  </div>
                  {facilitySlug && !validateSlug(facilitySlug).isValid && (
                    <p className="text-[11px] text-red-600 mt-1">
                      {validateSlug(facilitySlug).error}
                    </p>
                  )}
                </div>

                {/* Address & Tagline */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1.5">
                      Physical Address <span className="text-slate-400 font-normal">(Optional)</span>
                    </label>
                    <input
                      type="text"
                      value={facilityAddress}
                      onChange={(e) => setFacilityAddress(e.target.value)}
                      placeholder="e.g. 100 Athletics Way, Metro Manila"
                      className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1.5">
                      Tagline <span className="text-slate-400 font-normal">(Optional)</span>
                    </label>
                    <input
                      type="text"
                      value={facilityTagline}
                      onChange={(e) => setFacilityTagline(e.target.value)}
                      placeholder="e.g. Premier Indoor Courts & Academy"
                      className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                </div>

                {/* Operating Hours & Default Rate */}
                <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-4">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-800">
                    <Clock className="w-4 h-4 text-blue-600" />
                    <span>Operating Schedule & Default Pricing</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Opens At
                      </label>
                      <select
                        value={openHour}
                        onChange={(e) => setOpenHour(Number(e.target.value))}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-800 focus:ring-2 focus:ring-blue-500"
                      >
                        {Array.from({ length: 24 }).map((_, i) => (
                          <option key={i} value={i}>
                            {i === 0 ? '12:00 AM (Midnight)' : i < 12 ? `${i}:00 AM` : i === 12 ? '12:00 PM (Noon)' : `${i - 12}:00 PM`}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Closes At
                      </label>
                      <select
                        value={closeHour}
                        onChange={(e) => setCloseHour(Number(e.target.value))}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-800 focus:ring-2 focus:ring-blue-500"
                      >
                        {Array.from({ length: 24 }).map((_, i) => {
                          const hour = i + 1;
                          return (
                            <option key={hour} value={hour}>
                              {hour < 12 ? `${hour}:00 AM` : hour === 12 ? '12:00 PM (Noon)' : hour === 24 ? '12:00 AM (Midnight)' : `${hour - 12}:00 PM`}
                            </option>
                          );
                        })}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Default Rate (₱ / hour)
                      </label>
                      <input
                        type="number"
                        min="50"
                        step="50"
                        required
                        value={defaultHourlyRate}
                        onChange={(e) => setDefaultHourlyRate(Math.max(1, Number(e.target.value)))}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-900 focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>

                  {closeHour <= openHour && (
                    <p className="text-[11px] text-red-600 font-semibold">
                      Closing hour must be strictly later than opening hour.
                    </p>
                  )}
                </div>

                {/* Booking Confirmation Mode */}
                <div className="space-y-3">
                  <label className="block text-xs font-bold text-slate-700">
                    Booking Confirmation Workflow
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label
                      className={`p-4 rounded-2xl border cursor-pointer transition-all ${
                        confirmationMode === 'instant'
                          ? 'bg-blue-50/50 border-blue-600 ring-1 ring-blue-600'
                          : 'bg-white border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="confirmationMode"
                        value="instant"
                        checked={confirmationMode === 'instant'}
                        onChange={() => setConfirmationMode('instant')}
                        className="sr-only"
                      />
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-xs font-bold text-slate-900">Instant Confirmation</p>
                          <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                            Bookings are confirmed immediately upon submission without requiring staff approval.
                          </p>
                        </div>
                        <CheckCircle2
                          className={`w-4 h-4 shrink-0 ${
                            confirmationMode === 'instant' ? 'text-blue-600' : 'text-slate-300'
                          }`}
                        />
                      </div>
                    </label>

                    <label
                      className={`p-4 rounded-2xl border cursor-pointer transition-all ${
                        confirmationMode === 'manual_approval'
                          ? 'bg-blue-50/50 border-blue-600 ring-1 ring-blue-600'
                          : 'bg-white border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="confirmationMode"
                        value="manual_approval"
                        checked={confirmationMode === 'manual_approval'}
                        onChange={() => setConfirmationMode('manual_approval')}
                        className="sr-only"
                      />
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-xs font-bold text-slate-900">Manual Staff Approval</p>
                          <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                            Holds slot as pending until an authorized staff member approves or declines the request.
                          </p>
                        </div>
                        <CheckCircle2
                          className={`w-4 h-4 shrink-0 ${
                            confirmationMode === 'manual_approval' ? 'text-blue-600' : 'text-slate-300'
                          }`}
                        />
                      </div>
                    </label>
                  </div>

                  {confirmationMode === 'manual_approval' && (
                    <div className="p-3.5 rounded-xl bg-amber-50/70 border border-amber-200/80 space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] font-bold text-amber-900">
                          Pending Hold Expiration Duration:
                        </label>
                        <select
                          value={holdDurationMinutes}
                          onChange={(e) => setHoldDurationMinutes(Number(e.target.value))}
                          className="px-3 py-1.5 rounded-lg border border-amber-200 bg-white text-xs font-bold text-slate-800"
                        >
                          {HOLD_DURATION_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <p className="text-[10px] text-amber-800 leading-relaxed">
                        Unreviewed bookings automatically expire after this duration, safely releasing the slot for other customers.
                      </p>
                    </div>
                  )}
                </div>

                {/* System Constants Info */}
                <div className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-slate-50 text-[11px] text-slate-500 font-medium">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  <span>Timezone: <strong>Asia/Manila (GMT+8)</strong></span>
                  <span className="text-slate-300">&bull;</span>
                  <span>Currency: <strong>Philippine Peso (₱)</strong></span>
                </div>
              </div>

              {/* Form Controls */}
              <div className="flex items-center justify-between pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setCurrentStep(1)}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
                >
                  Back to Organization
                </button>

                <button
                  type="submit"
                  disabled={
                    isSubmitting ||
                    !facilityName.trim() ||
                    !validateSlug(facilitySlug).isValid ||
                    closeHour <= openHour
                  }
                  className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-bold flex items-center gap-2 shadow-sm transition-colors cursor-pointer"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Saving Facility...</span>
                    </>
                  ) : (
                    <>
                      <span>Continue to Courts</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* ========================================================================= */}
          {/* STEP 3: COURTS */}
          {/* ========================================================================= */}
          {currentStep === 3 && (
            <form onSubmit={handleStep3Submit} className="space-y-6">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-slate-900">Step 3 — Configure Initial Courts</h2>
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700">
                    Venue: {persistedFacilityName || facilityName}
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  Add one or more playing courts. You can add more courts or change pricing later from your dashboard.
                </p>
              </div>

              {/* Courts Cards List */}
              <div className="space-y-3">
                {courtsList.map((court, index) => (
                  <div
                    key={index}
                    className="p-4 rounded-2xl border border-slate-200 bg-white hover:border-slate-300 transition-all space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                        <Layers className="w-3.5 h-3.5 text-blue-600" />
                        <span>Court #{index + 1}</span>
                      </span>

                      {courtsList.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveCourt(index)}
                          className="p-1 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 transition-colors cursor-pointer"
                          title="Remove court"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Court Name <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          value={court.name}
                          onChange={(e) => handleUpdateCourt(index, 'name', e.target.value)}
                          placeholder="e.g. Court 1"
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-900 focus:ring-2 focus:ring-blue-500"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Sport Type
                        </label>
                        <select
                          value={court.sport_type}
                          onChange={(e) => handleUpdateCourt(index, 'sport_type', e.target.value)}
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-800 focus:ring-2 focus:ring-blue-500"
                        >
                          {SPORT_TYPES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Hourly Rate (₱)
                        </label>
                        <input
                          type="number"
                          min="50"
                          step="50"
                          required
                          value={court.hourly_rate}
                          onChange={(e) =>
                            handleUpdateCourt(index, 'hourly_rate', Math.max(1, Number(e.target.value)))
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-900 focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                          Surface / Type (Optional)
                        </label>
                        <input
                          type="text"
                          value={court.surface_type || ''}
                          onChange={(e) => handleUpdateCourt(index, 'surface_type', e.target.value)}
                          placeholder="e.g. Cushioned Hardcourt"
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-[11px] text-slate-700"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                          Tag / Description (Optional)
                        </label>
                        <input
                          type="text"
                          value={court.tag || ''}
                          onChange={(e) => handleUpdateCourt(index, 'tag', e.target.value)}
                          placeholder="e.g. Tournament Regulation"
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-[11px] text-slate-700"
                        />
                      </div>
                    </div>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={handleAddCourt}
                  className="w-full py-3 rounded-2xl border-2 border-dashed border-slate-200 hover:border-blue-400 hover:bg-blue-50/50 text-blue-600 text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add Another Court</span>
                </button>
              </div>

              {/* Form Controls */}
              <div className="flex items-center justify-between pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setCurrentStep(2)}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
                >
                  Back to Facility
                </button>

                <button
                  type="submit"
                  disabled={isSubmitting || courtsList.length === 0}
                  className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-bold flex items-center gap-2 shadow-sm transition-colors cursor-pointer"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Configuring Workspace...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Complete Onboarding & Launch Dashboard</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
