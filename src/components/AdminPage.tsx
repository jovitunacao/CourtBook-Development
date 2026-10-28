import React, { useState, useMemo } from 'react';
import {
  Calendar,
  Clock,
  User,
  Shield,
  RotateCcw,
  Plus,
  Trash2,
  Search,
  CheckCircle2,
  XCircle,
  FileSpreadsheet,
  SlidersHorizontal,
  Database,
  Building,
  AlertCircle,
  Sparkles,
  Layers,
  ChevronDown,
  Info,
  Loader2,
  RefreshCw,
  LogOut,
  ArrowRight,
} from 'lucide-react';
import { FacilitySettings, Reservation, formatHour12 } from '../types/booking';
import { formatDatePretty, getTodayString } from '../utils/storage';
import { useSupabaseAuth } from '../context/SupabaseAuthContext';
import { SupabaseStatusBanner } from './SupabaseStatusBanner';

interface AdminPageProps {
  settings: FacilitySettings;
  reservations: Reservation[];
  onCancelReservation: (id: string) => void;
  onRestoreReservation: (id: string) => void;
  onDeleteReservation: (id: string) => void;
  onResetDemoData: () => void;
  onClearAllData: () => void;
  onNavigateToBooking: () => void;
  onNavigateToSettings: () => void;
  onOpenAuthModal?: () => void;
}

export const AdminPage: React.FC<AdminPageProps> = ({
  settings,
  reservations: localReservations,
  onCancelReservation,
  onRestoreReservation,
  onDeleteReservation,
  onResetDemoData,
  onClearAllData,
  onNavigateToBooking,
  onNavigateToSettings,
  onOpenAuthModal,
}) => {
  const {
    user,
    staffData,
    onboardingState,
    membershipLookupError,
    signOut,
    refreshStaffData,
    isUsingSupabaseData,
    isDemoSession,
    demoProfile,
    supabaseReservations,
    cancelStaffReservation,
    approveStaffReservation,
    declineStaffReservation,
    switchOrganization,
    switchFacility,
    isLoading: isAuthLoading,
  } = useSupabaseAuth();

  // Mode: if authenticated with Supabase or in demo session, default to Supabase data source
  const [dataSource, setDataSource] = useState<'supabase' | 'local'>('supabase');
  const [cancelFeedback, setCancelFeedback] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState<boolean>(false);

  // Requirement 4: Empty Supabase reservation list MUST remain an empty live result (never fall back to local demo records)
  const isDisplayingSupabase = isUsingSupabaseData && dataSource === 'supabase';

  const activeReservations = useMemo(() => {
    if (isDisplayingSupabase) {
      // In live Supabase mode, return live records directly. Zero records remains zero!
      return supabaseReservations;
    }
    return localReservations;
  }, [isDisplayingSupabase, supabaseReservations, localReservations]);

  const reservations = activeReservations;

  const today = getTodayString();
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'custom'>('all');
  const [customDate, setCustomDate] = useState<string>(today);
  const [courtFilter, setCourtFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [confirmApproveId, setConfirmApproveId] = useState<string | null>(null);
  const [confirmDeclineId, setConfirmDeclineId] = useState<string | null>(null);
  const [actionNotes, setActionNotes] = useState<string>('');
  const [isProcessingAction, setIsProcessingAction] = useState<boolean>(false);

  const handleCancelClick = async (reservationId: string) => {
    if (isDisplayingSupabase) {
      setIsCancelling(true);
      setCancelFeedback(null);
      const res = await cancelStaffReservation(reservationId, 'Cancelled via Staff Admin Portal');
      setIsCancelling(false);
      setConfirmCancelId(null);
      if (res.success) {
        setCancelFeedback('Reservation cancelled successfully via secure Supabase RPC.');
        setTimeout(() => setCancelFeedback(null), 3500);
      } else {
        setCancelFeedback(`Cancellation failed: ${res.error || 'Permission denied'}`);
        setTimeout(() => setCancelFeedback(null), 4500);
      }
    } else {
      onCancelReservation(reservationId);
      setConfirmCancelId(null);
    }
  };

  const handleApproveClick = async (reservationId: string) => {
    setIsProcessingAction(true);
    setCancelFeedback(null);
    const res = await approveStaffReservation(reservationId, actionNotes.trim() || undefined);
    setIsProcessingAction(false);
    setConfirmApproveId(null);
    setActionNotes('');
    if (res.success) {
      setCancelFeedback('Booking request approved and confirmed successfully!');
      setTimeout(() => setCancelFeedback(null), 3500);
    } else {
      setCancelFeedback(`Approval failed: ${res.error || 'Permission denied'}`);
      setTimeout(() => setCancelFeedback(null), 4500);
    }
  };

  const handleDeclineClick = async (reservationId: string) => {
    setIsProcessingAction(true);
    setCancelFeedback(null);
    const res = await declineStaffReservation(reservationId, actionNotes.trim() || undefined);
    setIsProcessingAction(false);
    setConfirmDeclineId(null);
    setActionNotes('');
    if (res.success) {
      setCancelFeedback('Booking request declined. Court slot hold released.');
      setTimeout(() => setCancelFeedback(null), 3500);
    } else {
      setCancelFeedback(`Decline failed: ${res.error || 'Permission denied'}`);
      setTimeout(() => setCancelFeedback(null), 4500);
    }
  };

  // Statistics calculation
  const stats = useMemo(() => {
    const todayRes = reservations.filter((r) => r.date === today);
    const todayActive = todayRes.filter((r) => r.status === 'confirmed');
    const totalActive = reservations.filter((r) => r.status === 'confirmed');
    const totalPending = reservations.filter((r) => r.status === 'pending');
    const totalCancelled = reservations.filter((r) => r.status === 'cancelled');
    const todayRevenue = todayActive.reduce((sum, r) => sum + r.price, 0);

    return {
      todayCount: todayActive.length,
      todayTotalCount: todayRes.length,
      todayRevenue,
      totalActiveCount: totalActive.length,
      totalPendingCount: totalPending.length,
      totalCancelledCount: totalCancelled.length,
    };
  }, [reservations, today]);

  // Filtered reservations
  const filteredReservations = useMemo(() => {
    return reservations.filter((item) => {
      // Date filter
      if (dateFilter === 'today' && item.date !== today) return false;
      if (dateFilter === 'custom' && item.date !== customDate) return false;

      // Court filter
      if (courtFilter !== 'all' && item.courtId !== courtFilter) return false;

      // Status filter
      if (statusFilter !== 'all' && item.status !== statusFilter) return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = item.customerName.toLowerCase().includes(q);
        const matchesRef = item.referenceCode.toLowerCase().includes(q);
        const matchesCourt = item.courtName.toLowerCase().includes(q);
        const matchesPhone = item.customerPhone ? item.customerPhone.toLowerCase().includes(q) : false;
        if (!matchesName && !matchesRef && !matchesCourt && !matchesPhone) {
          return false;
        }
      }

      return true;
    });
  }, [reservations, dateFilter, today, customDate, courtFilter, statusFilter, searchQuery]);

  return (
    <div className="bg-slate-50 min-h-[calc(100vh-64px)] py-8 sm:py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
        {/* Supabase Status Banner */}
        <SupabaseStatusBanner onOpenAuthModal={onOpenAuthModal} />

        {/* Loading State during Membership Lookup */}
        {user && onboardingState === 'loading' && (
          <div className="bg-white rounded-2xl border border-slate-200 p-8 sm:p-12 text-center shadow-xs space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">Verifying Organization Membership</h3>
              <p className="text-xs text-slate-500 mt-1">
                Checking organization access and roles for <strong className="text-slate-800">{user.email}</strong>...
              </p>
            </div>
          </div>
        )}

        {/* Error State if Membership Lookup Failed */}
        {user && onboardingState === 'error' && (
          <div className="bg-white rounded-2xl border border-red-200 p-6 sm:p-8 shadow-xs space-y-4">
            <div className="flex items-start gap-3.5">
              <div className="w-10 h-10 rounded-xl bg-red-100 text-red-600 flex items-center justify-center shrink-0">
                <AlertCircle className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-red-900">Membership Lookup Failed</h3>
                <p className="text-xs text-red-700 leading-relaxed">
                  {membershipLookupError || 'An unexpected error occurred while communicating with the database.'}
                </p>
                <p className="text-[11px] text-slate-500">
                  Please verify your network connection or try refreshing your credentials.
                </p>
              </div>
            </div>
            <div className="pt-3 border-t border-red-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => signOut()}
                className="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition-colors cursor-pointer"
              >
                Sign Out
              </button>
              <button
                type="button"
                onClick={() => refreshStaffData()}
                className="px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry Verification</span>
              </button>
            </div>
          </div>
        )}

        {/* Organization Setup Required Placeholder (Phase 3 Stage 3.2) */}
        {user && onboardingState === 'needs_onboarding' && (
          <div className="bg-white rounded-2xl border border-slate-200/90 p-6 sm:p-10 shadow-xs space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 pb-6 border-b border-slate-100">
              <div className="w-14 h-14 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-600 flex items-center justify-center shrink-0">
                <Building className="w-7 h-7" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase font-extrabold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                    Authenticated Owner Account
                  </span>
                  <span className="text-xs text-slate-400 font-mono">
                    ID: {user.id.slice(0, 8)}...
                  </span>
                </div>
                <h2 className="text-xl font-extrabold text-slate-900 tracking-tight">
                  Organization Setup Required
                </h2>
                <p className="text-xs text-slate-600">
                  Signed in as <strong className="text-slate-900">{user.email}</strong>
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 space-y-2">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-800">
                <Info className="w-4 h-4 text-blue-600 shrink-0" />
                <span>Welcome to CourtBook / BookSuite!</span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                Your owner account has been registered and verified in Supabase Auth. However, you do not have an active sports organization or facility associated with your account yet.
              </p>
              <p className="text-xs text-slate-500 leading-relaxed">
                Self-service organization creation and court configuration will be enabled in <strong>Stage 3.3</strong>. Once completed, your organization's facilities and courts will appear here for management.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <button
                type="button"
                onClick={() => onNavigateToBooking()}
                className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold flex items-center gap-2 transition-colors cursor-pointer"
              >
                <span>View Public Booking Directory</span>
                <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => refreshStaffData()}
                  className="px-3.5 py-2.5 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Check Status</span>
                </button>
                <button
                  type="button"
                  onClick={() => signOut()}
                  className="px-3.5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign Out</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Regular Admin View: Only rendered if user is ready (or unauthenticated visitor in demo) */}
        {(!user || onboardingState === 'ready') && (
          <>
            {/* Multi-Tenant Organization & Facility Selection Header (Requirement 7) */}
            {staffData && (
          <div className="bg-white rounded-2xl border border-slate-200/90 p-4 sm:p-5 shadow-xs">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-4">
                {/* Organization Selector */}
                <div>
                  <span className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Organization
                  </span>
                  {staffData.userOrganizations.length > 1 ? (
                    <div className="relative inline-block">
                      <select
                        value={staffData.activeOrganization?.id || ''}
                        onChange={(e) => switchOrganization(e.target.value)}
                        className="appearance-none bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 pr-8 text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                      >
                        {staffData.userOrganizations.map((uo) => (
                          <option key={uo.organization.id} value={uo.organization.id}>
                            {uo.organization.name} ({uo.role})
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2.5 pointer-events-none" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-extrabold text-slate-900">
                        {staffData.activeOrganization?.name || 'Authorized Organization'}
                      </span>
                      <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                        {staffData.activeRole}
                      </span>
                    </div>
                  )}
                </div>

                <div className="hidden sm:block h-8 w-px bg-slate-200" />

                {/* Facility Selector */}
                <div>
                  <span className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Active Facility
                  </span>
                  {staffData.availableFacilities.length > 1 ? (
                    <div className="relative inline-block">
                      <select
                        value={staffData.activeFacility?.id || ''}
                        onChange={(e) => switchFacility(e.target.value)}
                        className="appearance-none bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 pr-8 text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                      >
                        {staffData.availableFacilities.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name} ({f.slug})
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2.5 pointer-events-none" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <Building className="w-4 h-4 text-slate-400" />
                      <span className="text-sm font-bold text-slate-800">
                        {staffData.activeFacility?.name || 'Facility'}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* RLS Policy Indicator */}
              <div className="text-xs text-slate-500 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200/80 flex items-center gap-2">
                <Shield className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>
                  RLS Isolation Active &bull; <strong className="text-slate-800">{staffData.activeRole.toUpperCase()}</strong> Scope
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Data Source Switcher (Live Supabase vs Local Demo) */}
        {isUsingSupabaseData && (
          <div className="bg-white rounded-xl border border-slate-200 p-2.5 flex flex-wrap items-center justify-between gap-3 shadow-xs">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-600 px-2">Table View Source:</span>
              <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-100 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setDataSource('supabase')}
                  className={`px-3 py-1 rounded-md transition-all cursor-pointer flex items-center gap-1.5 ${
                    isDisplayingSupabase
                      ? 'bg-purple-600 text-white font-bold shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Database className="w-3.5 h-3.5" />
                  <span>Live Supabase Database ({supabaseReservations.length})</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDataSource('local')}
                  className={`px-3 py-1 rounded-md transition-all cursor-pointer flex items-center gap-1.5 ${
                    !isDisplayingSupabase
                      ? 'bg-blue-600 text-white font-bold shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>Local Demo Storage ({localReservations.length})</span>
                </button>
              </div>
            </div>

            <div className="text-xs text-slate-500 pr-2">
              {isDisplayingSupabase ? (
                <span className="text-purple-700 font-semibold">
                  Viewing genuine Supabase reservations via RLS policy `staff_can_view_facility_reservations`.
                </span>
              ) : (
                <span className="text-blue-700 font-semibold">
                  Viewing isolated browser demo reservations.
                </span>
              )}
            </div>
          </div>
        )}

        {/* RPC Cancellation Feedback Notification */}
        {cancelFeedback && (
          <div className="p-3.5 rounded-xl bg-blue-50 border border-blue-200 text-blue-900 text-xs flex items-center gap-2.5 animate-in fade-in duration-200">
            <CheckCircle2 className="w-4 h-4 text-blue-600 shrink-0" />
            <span className="font-semibold">{cancelFeedback}</span>
          </div>
        )}

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-200 text-slate-800 text-xs font-bold uppercase tracking-wider mb-2">
              <Shield className="w-3.5 h-3.5 text-blue-600" />
              <span>Staff Administrative Console</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
              Reservations Management
            </h1>
            <p className="text-slate-600 text-sm mt-1">
              {settings.name} &bull; Manage live court bookings, cancellations, and daily schedules.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              onClick={onNavigateToBooking}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition-all shadow-xs flex items-center gap-2 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>New Reservation</span>
            </button>

            <button
              onClick={onNavigateToSettings}
              className="px-3.5 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-xl text-xs font-semibold transition-colors flex items-center gap-1.5 shadow-xs cursor-pointer"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
              <span>Facility Settings</span>
            </button>

            {/* Demo storage tools (disabled when viewing live Supabase records to prevent confusion) */}
            {!isDisplayingSupabase ? (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={onResetDemoData}
                  title="Reset sample demo bookings"
                  className="px-3 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-xl text-xs font-semibold transition-colors flex items-center gap-1.5 shadow-xs cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-slate-500" />
                  <span className="hidden sm:inline">Reset Demo</span>
                </button>
                <button
                  onClick={onClearAllData}
                  title="Clear all local demo bookings"
                  className="px-3 py-2 bg-white hover:bg-red-50 text-red-600 border border-slate-200 hover:border-red-200 rounded-xl text-xs font-semibold transition-colors flex items-center gap-1.5 shadow-xs cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5 text-red-500" />
                  <span className="hidden sm:inline">Clear Demo</span>
                </button>
              </div>
            ) : (
              <div className="text-[11px] font-semibold text-slate-400 bg-slate-100 border border-slate-200 px-2.5 py-1.5 rounded-xl">
                Demo resets disabled in Live Supabase mode
              </div>
            )}
          </div>
        </div>

        {/* Metrics Row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-1">
              Today's Confirmed
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-black text-slate-900">{stats.todayCount}</span>
              <span className="text-xs text-slate-500 font-medium">
                of {stats.todayTotalCount} booked today
              </span>
            </div>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-1">
              Today's Revenue
            </span>
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-black text-emerald-600">
                {settings.currency}{stats.todayRevenue.toLocaleString()}
              </span>
            </div>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-1">
              Total Active Bookings
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-black text-blue-600">{stats.totalActiveCount}</span>
              <span className="text-xs text-slate-500 font-medium">scheduled</span>
            </div>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-1">
              Cancelled Bookings
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-black text-slate-400">{stats.totalCancelledCount}</span>
              <span className="text-xs text-slate-500 font-medium">released slots</span>
            </div>
          </div>
        </div>

        {/* Filter Controls Card */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            {/* Search Input */}
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
              <input
                type="text"
                placeholder="Search by customer name, ref #, court..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>

            {/* Quick Filters */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Date Filter */}
              <div className="inline-flex rounded-xl border border-slate-200 p-0.5 bg-slate-50 text-xs font-semibold">
                <button
                  onClick={() => setDateFilter('all')}
                  className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                    dateFilter === 'all'
                      ? 'bg-white text-slate-900 shadow-xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  All Dates
                </button>
                <button
                  onClick={() => setDateFilter('today')}
                  className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                    dateFilter === 'today'
                      ? 'bg-white text-slate-900 shadow-xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Today
                </button>
                <button
                  onClick={() => setDateFilter('custom')}
                  className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                    dateFilter === 'custom'
                      ? 'bg-white text-slate-900 shadow-xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Pick Date
                </button>
              </div>

              {dateFilter === 'custom' && (
                <input
                  type="date"
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                  className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-semibold cursor-pointer"
                />
              )}

              {/* Court Dropdown */}
              <select
                value={courtFilter}
                onChange={(e) => setCourtFilter(e.target.value)}
                className="px-3 py-2 text-xs font-semibold border border-slate-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              >
                <option value="all">All Courts</option>
                {settings.courts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              {/* Status Dropdown */}
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-2 text-xs font-semibold border border-slate-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              >
                <option value="all">All Statuses</option>
                <option value="pending">Pending Approval ({stats.totalPendingCount})</option>
                <option value="confirmed">Confirmed</option>
                <option value="declined">Declined</option>
                <option value="expired">Expired Hold</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
          </div>
        </div>

        {/* Reservations Table Card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-slate-900">
                {isDisplayingSupabase ? 'Live Supabase Reservations' : 'Local Demo Reservations'}
              </h2>
              <span className="text-xs font-bold bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-full">
                {filteredReservations.length} records
              </span>
            </div>

            {isDisplayingSupabase && (
              <span className="text-[11px] font-mono text-purple-700 bg-purple-50 px-2 py-0.5 rounded border border-purple-200">
                RPC cancel_reservation_as_staff enabled
              </span>
            )}
          </div>

          {/* Requirement 4: If Supabase reservation list is empty, display an authentic empty result without substituting local demo records */}
          {filteredReservations.length === 0 ? (
            <div className="p-16 text-center">
              <div className="w-14 h-14 rounded-2xl bg-slate-100 text-slate-400 mx-auto flex items-center justify-center mb-4">
                <Calendar className="w-7 h-7" />
              </div>
              <h3 className="text-base font-bold text-slate-900 mb-1">
                {isDisplayingSupabase ? 'No Live Reservations Found' : 'No Demo Reservations Found'}
              </h3>
              <p className="text-xs text-slate-500 max-w-md mx-auto mb-6">
                {isDisplayingSupabase ? (
                  <>
                    There are currently 0 live reservations in the Supabase database for{' '}
                    <strong>{staffData?.activeFacility?.name || settings.name}</strong>.
                    Public customer bookings created in browser demo mode are not written to the live database.
                  </>
                ) : (
                  <>No local reservations match the selected filter criteria.</>
                )}
              </p>
              <button
                onClick={onNavigateToBooking}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition-all shadow-xs"
              >
                Create a Demonstration Reservation
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-600">
                <thead className="bg-slate-50/80 text-slate-500 uppercase tracking-wider font-bold border-b border-slate-200 text-[10px]">
                  <tr>
                    <th className="px-5 py-3">Reference</th>
                    <th className="px-5 py-3">Customer</th>
                    <th className="px-5 py-3">Court</th>
                    <th className="px-5 py-3">Date</th>
                    <th className="px-5 py-3">Time Slot</th>
                    <th className="px-5 py-3">Price</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredReservations.map((item) => {
                    const isCancelled = item.status === 'cancelled';
                    const isToday = item.date === today;

                    return (
                      <tr
                        key={item.id}
                        className={`hover:bg-slate-50/80 transition-colors ${
                          isCancelled ? 'bg-slate-50/50 text-slate-400' : ''
                        }`}
                      >
                        {/* Ref */}
                        <td className="px-5 py-4 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                              {item.referenceCode}
                            </span>
                            {isDisplayingSupabase && (
                              <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.2 rounded bg-purple-50 text-purple-700 border border-purple-200">
                                Supabase
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Customer */}
                        <td className="px-5 py-4 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-slate-200 text-slate-700 font-bold flex items-center justify-center text-[10px]">
                              {item.customerName.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="font-bold text-slate-900">
                                {item.customerName}
                              </div>
                              {item.customerPhone && (
                                <div className="text-[10px] text-slate-500 font-mono">
                                  {item.customerPhone}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* Court */}
                        <td className="px-5 py-4 whitespace-nowrap">
                          <span className="font-semibold text-slate-800">
                            {item.courtName}
                          </span>
                        </td>

                        {/* Date */}
                        <td className="px-5 py-4 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span>{formatDatePretty(item.date)}</span>
                            {isToday && (
                              <span className="text-[10px] font-bold bg-blue-100 text-blue-700 px-1.5 py-0.2 rounded">
                                Today
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Time Slot */}
                        <td className="px-5 py-4 whitespace-nowrap">
                          <div className="flex items-center gap-1.5 text-slate-800">
                            <Clock className="w-3.5 h-3.5 text-slate-400" />
                            <span>{item.timeSlotLabel}</span>
                          </div>
                        </td>

                        {/* Rate */}
                        <td className="px-5 py-4 whitespace-nowrap font-bold text-slate-900">
                          {settings.currency}{item.price}
                        </td>

                        {/* Status */}
                        <td className="px-5 py-4 whitespace-nowrap">
                          {item.status === 'confirmed' && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">
                              <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                              Confirmed
                            </span>
                          )}
                          {item.status === 'pending' && (
                            <div className="space-y-0.5">
                              <span className="inline-flex items-center gap-1 text-[11px] font-extrabold text-amber-800 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-300 animate-pulse">
                                <Clock className="w-3 h-3 text-amber-600" />
                                Pending Approval
                              </span>
                              {item.holdExpiresAt && (
                                <div className="text-[10px] text-amber-700 font-mono">
                                  Hold until {new Date(item.holdExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </div>
                              )}
                            </div>
                          )}
                          {item.status === 'declined' && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-red-700 bg-red-50 px-2.5 py-0.5 rounded-full border border-red-200">
                              <XCircle className="w-3 h-3 text-red-500" />
                              Declined
                            </span>
                          )}
                          {item.status === 'expired' && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full border border-slate-200">
                              <Clock className="w-3 h-3 text-slate-400" />
                              Hold Expired
                            </span>
                          )}
                          {item.status === 'cancelled' && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full border border-slate-200">
                              <XCircle className="w-3 h-3 text-slate-400" />
                              Cancelled
                            </span>
                          )}
                        </td>

                        {/* Actions */}
                        <td className="px-5 py-4 whitespace-nowrap text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* PENDING APPROVAL WORKFLOW */}
                            {item.status === 'pending' && (
                              <div className="inline-flex items-center gap-1.5">
                                {confirmApproveId === item.id ? (
                                  <div className="inline-flex items-center gap-1 bg-emerald-50 p-1 rounded-lg border border-emerald-300">
                                    <input
                                      type="text"
                                      placeholder="Notes (optional)..."
                                      value={actionNotes}
                                      onChange={(e) => setActionNotes(e.target.value)}
                                      className="px-2 py-0.5 text-[10px] bg-white border border-emerald-200 rounded w-28 focus:outline-none"
                                    />
                                    <button
                                      onClick={() => handleApproveClick(item.id)}
                                      disabled={isProcessingAction}
                                      className="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[10px] font-bold cursor-pointer disabled:opacity-50"
                                    >
                                      {isProcessingAction ? '...' : 'Confirm'}
                                    </button>
                                    <button
                                      onClick={() => {
                                        setConfirmApproveId(null);
                                        setActionNotes('');
                                      }}
                                      className="px-1.5 py-0.5 bg-slate-200 text-slate-700 rounded text-[10px] cursor-pointer"
                                    >
                                      X
                                    </button>
                                  </div>
                                ) : confirmDeclineId === item.id ? (
                                  <div className="inline-flex items-center gap-1 bg-red-50 p-1 rounded-lg border border-red-300">
                                    <input
                                      type="text"
                                      placeholder="Reason (optional)..."
                                      value={actionNotes}
                                      onChange={(e) => setActionNotes(e.target.value)}
                                      className="px-2 py-0.5 text-[10px] bg-white border border-red-200 rounded w-28 focus:outline-none"
                                    />
                                    <button
                                      onClick={() => handleDeclineClick(item.id)}
                                      disabled={isProcessingAction}
                                      className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded text-[10px] font-bold cursor-pointer disabled:opacity-50"
                                    >
                                      {isProcessingAction ? '...' : 'Decline'}
                                    </button>
                                    <button
                                      onClick={() => {
                                        setConfirmDeclineId(null);
                                        setActionNotes('');
                                      }}
                                      className="px-1.5 py-0.5 bg-slate-200 text-slate-700 rounded text-[10px] cursor-pointer"
                                    >
                                      X
                                    </button>
                                  </div>
                                ) : (
                                  <>
                                    <button
                                      onClick={() => {
                                        setConfirmApproveId(item.id);
                                        setConfirmDeclineId(null);
                                      }}
                                      className="px-2.5 py-1 text-[11px] font-bold text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors cursor-pointer border border-emerald-300"
                                    >
                                      Approve
                                    </button>
                                    <button
                                      onClick={() => {
                                        setConfirmDeclineId(item.id);
                                        setConfirmApproveId(null);
                                      }}
                                      className="px-2.5 py-1 text-[11px] font-bold text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors cursor-pointer border border-red-200"
                                    >
                                      Decline
                                    </button>
                                  </>
                                )}
                              </div>
                            )}

                            {/* CONFIRMED WORKFLOW */}
                            {item.status === 'confirmed' && (
                              confirmCancelId === item.id ? (
                                <div className="inline-flex items-center gap-1 bg-red-50 p-1 rounded-lg border border-red-200">
                                  <span className="text-[11px] text-red-700 font-semibold px-1">
                                    Cancel?
                                  </span>
                                  <button
                                    onClick={() => handleCancelClick(item.id)}
                                    disabled={isCancelling}
                                    className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded text-[10px] font-bold cursor-pointer disabled:opacity-50"
                                  >
                                    {isCancelling ? '...' : 'Yes'}
                                  </button>
                                  <button
                                    onClick={() => setConfirmCancelId(null)}
                                    className="px-2 py-0.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-[10px] font-semibold cursor-pointer"
                                  >
                                    No
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setConfirmCancelId(item.id)}
                                  title="Staff cancellation via validated procedure"
                                  className="px-2.5 py-1 text-[11px] font-bold text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors cursor-pointer border border-red-200/50"
                                >
                                  Cancel Reservation
                                </button>
                              )
                            )}

                            {/* DECLINED / EXPIRED / CANCELLED STATES */}
                            {(item.status === 'declined' || item.status === 'expired') && (
                              <span className="px-2 py-1 text-[10px] font-semibold text-slate-400 bg-slate-100 rounded-lg border border-slate-200/60">
                                Slot Released
                              </span>
                            )}

                            {item.status === 'cancelled' && (
                              isDisplayingSupabase ? (
                                <span
                                  title="Cancelled reservations in Supabase are immutable and cannot be reopened from client"
                                  className="px-2 py-1 text-[10px] font-semibold text-slate-400 bg-slate-100 rounded-lg cursor-not-allowed border border-slate-200/60"
                                >
                                  Cancelled (Permanent)
                                </span>
                              ) : (
                                <button
                                  onClick={() => onRestoreReservation(item.id)}
                                  title="Reactivate this demo reservation"
                                  className="px-2.5 py-1 text-[11px] font-semibold text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors cursor-pointer"
                                >
                                  Reopen Slot
                                </button>
                              )
                            )}

                            {/* Deleting reservations: Disabled in live Supabase mode */}
                            {isDisplayingSupabase ? (
                              <span
                                title="Live Supabase reservations cannot be deleted from database. Use staff cancellation."
                                className="p-1 text-slate-300 cursor-not-allowed"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </span>
                            ) : (
                              <button
                                onClick={() => onDeleteReservation(item.id)}
                                title="Delete from local demo storage"
                                className="p-1 text-slate-500 hover:text-red-600 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </>
    )}
  </div>
</div>
);
};
