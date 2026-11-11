import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Calendar, Shield, Dumbbell, Menu, X, CheckCircle2, SlidersHorizontal, LogIn, LogOut, User } from 'lucide-react';
import { useSupabaseAuth } from '../context/SupabaseAuthContext';

interface NavbarProps {
  currentTab?: 'home' | 'booking' | 'admin' | 'settings';
  setCurrentTab?: (tab: 'home' | 'booking' | 'admin' | 'settings') => void;
  activeReservationsCount: number;
  facilityName?: string;
  onOpenAuthModal?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab: propCurrentTab,
  setCurrentTab,
  activeReservationsCount,
  facilityName = 'CourtBook',
  onOpenAuthModal,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const { isConfigured, user, isDemoSession, demoProfile, staffData, onboardingState, signOut } = useSupabaseAuth();

  // Derive active tab from URL path
  const currentTab = propCurrentTab || (
    location.pathname.startsWith('/book')
      ? 'booking'
      : location.pathname.startsWith('/admin')
      ? 'admin'
      : location.pathname.startsWith('/settings')
      ? 'settings'
      : 'home'
  );

  const isAuthenticated = Boolean(user || isDemoSession);
  const isNeedsOnboarding = Boolean(user && onboardingState === 'needs_onboarding');
  const activeOrgName = isNeedsOnboarding
    ? 'Setup Needed'
    : staffData?.activeOrganization?.name || demoProfile?.orgName;
  const staffRole = isNeedsOnboarding
    ? 'Owner (Setup Needed)'
    : staffData?.activeRole || demoProfile?.role;
  const staffEmail = user?.email || demoProfile?.email;

  const handleNav = (tab: 'home' | 'booking' | 'admin' | 'settings') => {
    if (setCurrentTab) {
      setCurrentTab(tab);
    }
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (tab === 'home') navigate('/');
    else if (tab === 'booking') navigate('/book/sport');
    else if (tab === 'admin') navigate('/admin');
    else if (tab === 'settings') navigate('/settings');
  };

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200 shadow-xs">
      {/* BookSuite Sub-banner */}
      <div className="bg-slate-900 text-slate-300 text-xs py-1.5 px-4 text-center font-medium flex items-center justify-center gap-2">
        <span className="inline-block w-2 h-2 rounded-full bg-blue-400"></span>
        <span>
          <strong className="text-white">BookSuite</strong> Product Ecosystem &bull; Phase 1 Prototype Demo
        </span>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <button
            onClick={() => handleNav('home')}
            className="flex items-center gap-3 text-left group focus:outline-none cursor-pointer"
          >
            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-sm shadow-blue-500/20 group-hover:bg-blue-700 transition-colors">
              <Dumbbell className="w-5 h-5 -rotate-45" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-xl tracking-tight text-slate-900 group-hover:text-blue-600 transition-colors">
                  CourtBook
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wider bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full border border-blue-200">
                  Phase 1
                </span>
              </div>
              <p className="text-[11px] text-slate-600 hidden sm:block -mt-0.5 truncate max-w-[180px]">
                {facilityName}
              </p>
            </div>
          </button>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-1 sm:gap-2">
            <button
              onClick={() => handleNav('home')}
              className={`px-3.5 py-2 rounded-lg text-sm font-semibold transition-all cursor-pointer ${
                currentTab === 'home'
                  ? 'bg-slate-100 text-slate-900'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              Home
            </button>
            <button
              onClick={() => handleNav('booking')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold transition-all cursor-pointer ${
                currentTab === 'booking'
                  ? 'bg-blue-50 text-blue-700 border border-blue-200'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <Calendar className="w-4 h-4 text-blue-600" />
              <span>Book a Court</span>
            </button>
            <button
              onClick={() => handleNav('admin')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold transition-all cursor-pointer ${
                currentTab === 'admin'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <Shield className="w-4 h-4 text-blue-400" />
              <span>Admin Demo</span>
              {activeReservationsCount > 0 && (
                <span className="ml-1 px-1.5 py-0.5 text-xs font-bold rounded-full bg-blue-500 text-white">
                  {activeReservationsCount}
                </span>
              )}
            </button>
            <button
              onClick={() => handleNav('settings')}
              title="Facility Settings & Court Management"
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-all cursor-pointer ${
                currentTab === 'settings'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <SlidersHorizontal className="w-4 h-4 text-slate-500 group-hover:text-slate-700" />
              <span>Facility Settings</span>
            </button>
          </nav>

          {/* CTA & Staff Auth Right */}
          <div className="hidden md:flex items-center gap-2.5">
            {isAuthenticated ? (
              <div className="flex items-center gap-2 bg-slate-50 border border-slate-200/80 rounded-xl px-2.5 py-1.5 text-xs shadow-xs">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  <div className="flex flex-col text-left">
                    <span className="font-bold text-slate-900 leading-tight truncate max-w-[140px]">
                      {activeOrgName || staffEmail}
                    </span>
                    <span className="text-[10px] text-blue-700 font-semibold uppercase leading-none">
                      {staffRole} &bull; {isConfigured ? 'Supabase' : 'Demo'}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => signOut()}
                  title="Sign out of staff account"
                  className="ml-1 p-1 rounded-lg text-slate-400 hover:text-red-600 hover:bg-slate-200/60 transition-colors cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => onOpenAuthModal && onOpenAuthModal()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200/80 border border-slate-200 transition-all cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5 text-blue-600" />
                <span>Staff Login</span>
              </button>
            )}

            <button
              onClick={() => handleNav('booking')}
              className="bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-bold px-4 py-2 rounded-xl transition-all shadow-sm hover:shadow-blue-500/25 flex items-center gap-1.5 cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Instant Reserve</span>
            </button>
          </div>

          {/* Mobile Menu Button */}
          <div className="md:hidden flex items-center gap-2">
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Toggle navigation menu"
              className="p-2 rounded-lg text-slate-700 hover:bg-slate-100 transition-colors"
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu Drawer */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-slate-200 bg-white px-4 pt-3 pb-5 space-y-2 shadow-lg">
          {/* Mobile Staff Status */}
          <div className="pb-2 border-b border-slate-100">
            {isAuthenticated ? (
              <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-200">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                  <div>
                    <div className="text-xs font-bold text-slate-900">{activeOrgName || staffEmail}</div>
                    <div className="text-[10px] text-blue-600 font-semibold uppercase">{staffRole} &bull; {isConfigured ? 'Supabase Live' : 'Demo Mode'}</div>
                  </div>
                </div>
                <button
                  onClick={() => signOut()}
                  className="px-2 py-1 text-xs text-red-600 font-semibold hover:bg-red-50 rounded"
                >
                  Sign Out
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setMobileMenuOpen(false);
                  if (onOpenAuthModal) onOpenAuthModal();
                }}
                className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-bold bg-slate-100 text-slate-800 border border-slate-200"
              >
                <LogIn className="w-3.5 h-3.5 text-blue-600" />
                <span>Staff Sign-In (Supabase Auth)</span>
              </button>
            )}
          </div>
          <button
            onClick={() => handleNav('home')}
            className={`w-full text-left px-4 py-2.5 rounded-xl font-semibold text-sm ${
              currentTab === 'home'
                ? 'bg-slate-100 text-slate-900'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            Home
          </button>
          <button
            onClick={() => handleNav('booking')}
            className={`w-full text-left px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-between ${
              currentTab === 'booking'
                ? 'bg-blue-50 text-blue-700 border border-blue-200'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <span className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-blue-600" />
              Book a Court
            </span>
          </button>
          <button
            onClick={() => handleNav('admin')}
            className={`w-full text-left px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-between ${
              currentTab === 'admin'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <span className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-blue-400" />
              Admin Demo (Reservations)
            </span>
            {activeReservationsCount > 0 && (
              <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-blue-500 text-white">
                {activeReservationsCount} active
              </span>
            )}
          </button>
          <button
            onClick={() => handleNav('settings')}
            className={`w-full text-left px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-2 ${
              currentTab === 'settings'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <SlidersHorizontal className="w-4 h-4 text-blue-400" />
            <span>Facility Settings (Courts & Rates)</span>
          </button>

          <div className="pt-2">
            <button
              onClick={() => handleNav('booking')}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white text-center py-2.5 rounded-xl font-bold text-sm shadow-sm"
            >
              Book a Court Now
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
