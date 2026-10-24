import React from 'react';
import {
  Shield,
  User,
  LogOut,
  LogIn,
  Building,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Database,
  Sparkles,
} from 'lucide-react';
import { useSupabaseAuth } from '../context/SupabaseAuthContext';

interface SupabaseStatusBannerProps {
  onOpenAuthModal?: () => void;
  compact?: boolean;
}

export const SupabaseStatusBanner: React.FC<SupabaseStatusBannerProps> = ({
  onOpenAuthModal,
  compact = false,
}) => {
  const {
    isConfigured,
    user,
    session,
    staffData,
    isDemoSession,
    demoProfile,
    signOut,
    refreshStaffData,
    isLoading,
  } = useSupabaseAuth();

  const isAuthenticated = Boolean(user || isDemoSession);
  const email = user?.email || demoProfile?.email;
  const role = staffData?.activeRole || demoProfile?.role || 'staff';
  const orgName = staffData?.activeOrganization?.name || demoProfile?.orgName;
  const orgSlug = staffData?.activeOrganization?.slug || demoProfile?.orgSlug;
  const facilityName = staffData?.activeFacility?.name || demoProfile?.facilityName;

  if (compact) {
    if (isAuthenticated) {
      return (
        <div className="flex items-center gap-2 text-xs">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="font-bold truncate max-w-[140px] sm:max-w-[200px]">
              {orgName || email}
            </span>
            <span className="text-[10px] uppercase font-extrabold px-1 py-0.2 rounded bg-emerald-200/70 text-emerald-900">
              {role}
            </span>
          </div>
          <button
            onClick={() => signOut()}
            title="Sign out of staff portal"
            className="p-1 rounded-lg text-slate-500 hover:text-red-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => onOpenAuthModal?.()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-900 hover:bg-slate-800 text-white transition-all shadow-xs cursor-pointer"
        >
          <LogIn className="w-3.5 h-3.5 text-blue-400" />
          <span>Staff Login</span>
        </button>
      </div>
    );
  }

  // Full detailed banner for Admin Page
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-xs">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        {/* Left: Account & Org Details */}
        <div className="flex items-start sm:items-center gap-3.5">
          <div
            className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
              isAuthenticated
                ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/20'
                : 'bg-slate-100 text-slate-600 border border-slate-200'
            }`}
          >
            {isAuthenticated ? (
              <Shield className="w-5 h-5 text-white" />
            ) : (
              <Database className="w-5 h-5 text-slate-500" />
            )}
          </div>

          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
                Supabase Auth & Tenant Isolation
              </span>
              <span
                className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full border ${
                  isConfigured
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-amber-50 text-amber-700 border-amber-200'
                }`}
              >
                {isConfigured ? 'BookSuite-Dev (Live)' : 'Local / Demo Mode'}
              </span>
              {isAuthenticated && (
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                  Role: {role}
                </span>
              )}
            </div>

            <div className="mt-1 flex flex-wrap items-baseline gap-2">
              {isAuthenticated ? (
                <>
                  <h3 className="text-base sm:text-lg font-extrabold text-slate-900">
                    {orgName || 'Authorized Facility'}
                  </h3>
                  {orgSlug && (
                    <span className="text-xs font-mono text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                      slug: {orgSlug}
                    </span>
                  )}
                  {email && (
                    <span className="text-xs text-slate-600 flex items-center gap-1">
                      &bull; <User className="w-3 h-3 text-slate-400" /> {email}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <h3 className="text-base sm:text-lg font-extrabold text-slate-900">
                    Not Signed In as Staff
                  </h3>
                  <p className="text-xs text-slate-600">
                    Sign in with your organization account to manage real facility reservations.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2 self-start md:self-auto">
          {isAuthenticated ? (
            <>
              {user && (
                <button
                  onClick={() => refreshStaffData()}
                  disabled={isLoading}
                  title="Refresh staff data"
                  className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                  <span className="hidden sm:inline">Sync</span>
                </button>
              )}
              <button
                onClick={() => signOut()}
                className="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-red-50 hover:text-red-700 text-slate-700 text-xs font-bold flex items-center gap-1.5 transition-colors border border-slate-200 cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </>
          ) : (
            <button
              onClick={() => onOpenAuthModal?.()}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1.5 transition-all shadow-sm hover:shadow-blue-500/25 cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Staff Sign In</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
