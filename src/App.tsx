import React, { useState, useEffect } from 'react';
import {
  Building,
  Shield,
  AlertCircle,
  RefreshCw,
  LogOut,
  ArrowRight,
  Loader2,
} from 'lucide-react';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { HomePage } from './components/HomePage';
import { BookingPage } from './components/BookingPage';
import { AdminPage } from './components/AdminPage';
import { FacilitySettingsPage } from './components/FacilitySettingsPage';
import { AuthModal } from './components/AuthModal';
import { Reservation, FacilitySettings, DEFAULT_FACILITY_SETTINGS } from './types/booking';
import {
  getStoredReservations,
  saveStoredReservations,
  resetToSampleReservations,
  clearAllReservations,
  getStoredFacilitySettings,
  saveStoredFacilitySettings,
  resetStoredFacilitySettings,
} from './utils/storage';
import { SupabaseAuthProvider, useSupabaseAuth } from './context/SupabaseAuthContext';

function CourtBookApp() {
  const [currentTab, setCurrentTab] = useState<'home' | 'booking' | 'admin' | 'settings'>('home');
  const [selectedCourtForBooking, setSelectedCourtForBooking] = useState<string>('');
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [facilitySettings, setFacilitySettings] = useState<FacilitySettings>(DEFAULT_FACILITY_SETTINGS);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);

  const {
    user,
    onboardingState,
    membershipLookupError,
    refreshStaffData,
    signOut,
    mappedFacilitySettings,
  } = useSupabaseAuth();

  // Active facility settings for public views: prioritize live Supabase facility settings if available, else localStorage
  const activeSettings = mappedFacilitySettings || facilitySettings;

  // Header display name
  const displayFacilityName =
    user && onboardingState === 'needs_onboarding'
      ? 'CourtBook Owner Portal'
      : activeSettings.name;

  // Keep selectedCourtForBooking synchronized with available courts in activeSettings
  useEffect(() => {
    if (activeSettings.courts.length > 0) {
      const exists = activeSettings.courts.some((c) => c.id === selectedCourtForBooking && c.isEnabled);
      if (!exists) {
        const firstEnabled = activeSettings.courts.find((c) => c.isEnabled) || activeSettings.courts[0];
        if (firstEnabled) {
          setSelectedCourtForBooking(firstEnabled.id);
        }
      }
    }
  }, [activeSettings.courts, selectedCourtForBooking]);

  // Initialize from localStorage
  useEffect(() => {
    const loadedReservations = getStoredReservations();
    const loadedSettings = getStoredFacilitySettings();
    setReservations(loadedReservations);
    setFacilitySettings(loadedSettings);
  }, []);

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => {
      setToastMessage((prev) => (prev === message ? null : prev));
    }, 3500);
  };

  const handleAddReservation = (newReservation: Reservation) => {
    const updated = [newReservation, ...reservations];
    setReservations(updated);
    saveStoredReservations(updated);
    showToast(`Reservation ${newReservation.referenceCode} confirmed!`);
  };

  const handleCancelReservation = (id: string) => {
    const updated = reservations.map((res) =>
      res.id === id ? { ...res, status: 'cancelled' as const } : res
    );
    setReservations(updated);
    saveStoredReservations(updated);
    showToast('Reservation was successfully cancelled. Slot reopened.');
  };

  const handleRestoreReservation = (id: string) => {
    const updated = reservations.map((res) =>
      res.id === id ? { ...res, status: 'confirmed' as const } : res
    );
    setReservations(updated);
    saveStoredReservations(updated);
    showToast('Reservation restored to confirmed.');
  };

  const handleDeleteReservation = (id: string) => {
    const updated = reservations.filter((res) => res.id !== id);
    setReservations(updated);
    saveStoredReservations(updated);
    showToast('Reservation removed from local demo storage.');
  };

  const handleResetDemoData = () => {
    const samples = resetToSampleReservations();
    setReservations(samples);
    showToast('Demonstration reservations reset to default sample data.');
  };

  const handleClearAllData = () => {
    const cleared = clearAllReservations();
    setReservations(cleared);
    showToast('All local demonstration reservations cleared.');
  };

  const handleSaveFacilitySettings = (newSettings: FacilitySettings) => {
    setFacilitySettings(newSettings);
    saveStoredFacilitySettings(newSettings);
    showToast('Facility settings and court configurations saved to localStorage!');
  };

  const handleResetFacilitySettings = () => {
    const reset = resetStoredFacilitySettings();
    setFacilitySettings(reset);
    showToast('Facility settings reverted to original defaults.');
  };

  const handleStartBooking = (courtId?: string) => {
    if (courtId) {
      setSelectedCourtForBooking(courtId);
    }
    setCurrentTab('booking');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleOpenAdmin = () => {
    setCurrentTab('admin');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleOpenSettings = () => {
    setCurrentTab('settings');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const activeReservationsCount = reservations.filter(
    (r) => r.status === 'confirmed'
  ).length;

  // Render helper for administrative views when user is authenticated
  const renderAdministrativeScreen = (tab: 'admin' | 'settings') => {
    // 1. Separate Loading State
    if (onboardingState === 'loading') {
      return (
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-20 flex items-center justify-center">
          <div className="bg-white rounded-2xl border border-slate-200/90 p-8 shadow-sm text-center max-w-md w-full space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-bold text-slate-900">Verifying Organization Access...</h3>
              <p className="text-xs text-slate-500">Checking organization memberships and facility permissions in Supabase...</p>
            </div>
          </div>
        </div>
      );
    }

    // 2. Separate Error State (strictly distinct from 0 organizations)
    if (onboardingState === 'error') {
      return (
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="bg-white rounded-2xl border border-red-200/90 p-6 sm:p-8 shadow-sm space-y-5">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-50 border border-red-200 text-red-600 flex items-center justify-center shrink-0 mt-0.5">
                <AlertCircle className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-bold text-slate-900">Unable to Verify Organization Workspace</h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  A database error or incomplete configuration prevented loading your organization's facilities. This query failure is not an empty organization.
                </p>
              </div>
            </div>

            {membershipLookupError && (
              <div className="p-3.5 rounded-xl bg-red-50/70 border border-red-200 text-xs font-mono text-red-800 break-words">
                {membershipLookupError}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setCurrentTab('booking');
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition-colors cursor-pointer"
              >
                View Public Directory
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => refreshStaffData()}
                  className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Retry Verification</span>
                </button>
                <button
                  type="button"
                  onClick={() => signOut()}
                  className="px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign Out</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // 3. Organization Setup Required Screen (needs_onboarding)
    // Strictly does not fall back to localStorage facility settings or sample reservations
    if (onboardingState === 'needs_onboarding') {
      return (
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="bg-white rounded-2xl border border-slate-200/90 p-6 sm:p-10 shadow-sm space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 pb-6 border-b border-slate-100">
              <div className="w-14 h-14 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-600 flex items-center justify-center shrink-0">
                <Building className="w-7 h-7" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase font-extrabold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                    Authenticated Court Owner
                  </span>
                  <span className="text-xs text-slate-400 font-mono">
                    {user?.email}
                  </span>
                </div>
                <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">
                  Organization Setup Required
                </h2>
                <p className="text-xs text-slate-500">
                  Account verified in Supabase Auth &bull; No sports organization or facility detected
                </p>
              </div>
            </div>

            <div className="p-5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-3">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-800">
                <Shield className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>Welcome to CourtBook / BookSuite!</span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                Your owner account registration has succeeded and your credentials are verified. However, you do not have an active sports organization or facility associated with your profile yet.
              </p>
              <div className="p-3.5 rounded-lg bg-emerald-50/70 border border-emerald-200/70 text-xs text-emerald-900">
                <p className="font-semibold mb-1">Stage 3.2 Detection Active:</p>
                <p className="text-emerald-800 leading-relaxed text-[11px]">
                  Self-service organization creation and facility onboarding wizard will be configured in <strong>Stage 3.3</strong>.
                  Administrative settings and reservations will become available once your initial organization and venue are created.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  setCurrentTab('booking');
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold flex items-center gap-2 transition-colors cursor-pointer"
              >
                <span>Browse Public Booking Directory</span>
                <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => refreshStaffData()}
                  className="px-4 py-2.5 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Check Status</span>
                </button>
                <button
                  type="button"
                  onClick={() => signOut()}
                  className="px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign Out</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // 4. Ready State: mappedFacilitySettings must be valid (no fallback to localStorage)
    if (!mappedFacilitySettings) {
      return (
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="bg-white rounded-2xl border border-amber-200/90 p-6 sm:p-8 shadow-sm space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-200 text-amber-600 flex items-center justify-center shrink-0">
                <AlertCircle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">Incomplete Facility Configuration</h3>
                <p className="text-xs text-slate-600">
                  Your organization was found, but active facility settings could not be retrieved from the database.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => refreshStaffData()}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => signOut()}
                className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      );
    }

    // Authenticated user with ready organization and facility: render page with mapped settings
    if (tab === 'admin') {
      return (
        <AdminPage
          settings={mappedFacilitySettings}
          reservations={reservations}
          onCancelReservation={handleCancelReservation}
          onRestoreReservation={handleRestoreReservation}
          onDeleteReservation={handleDeleteReservation}
          onResetDemoData={handleResetDemoData}
          onClearAllData={handleClearAllData}
          onNavigateToBooking={() => {
            setCurrentTab('booking');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          onNavigateToSettings={handleOpenSettings}
          onOpenAuthModal={() => setIsAuthModalOpen(true)}
        />
      );
    }

    return (
      <FacilitySettingsPage
        settings={mappedFacilitySettings}
        onSaveSettings={handleSaveFacilitySettings}
        onResetSettings={handleResetFacilitySettings}
        onNavigateToBooking={() => {
          setCurrentTab('booking');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        onNavigateToReservations={handleOpenAdmin}
      />
    );
  };

  return (
    <div className="min-h-screen flex flex-col bg-white text-slate-900 selection:bg-blue-100 selection:text-blue-900">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 animate-bounce duration-300">
          <div className="bg-slate-900 text-white text-xs font-semibold px-4 py-3 rounded-xl shadow-xl border border-slate-700 flex items-center gap-2.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            <span>{toastMessage}</span>
          </div>
        </div>
      )}

      {/* Staff Sign-In Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
      />

      {/* Primary Navigation */}
      <Navbar
        currentTab={currentTab}
        setCurrentTab={setCurrentTab}
        activeReservationsCount={activeReservationsCount}
        facilityName={displayFacilityName}
        onOpenAuthModal={() => setIsAuthModalOpen(true)}
      />

      {/* Screen Render */}
      <main className="flex-1">
        {currentTab === 'home' && (
          <HomePage
            settings={activeSettings}
            onStartBooking={handleStartBooking}
            onOpenAdmin={handleOpenAdmin}
            activeReservationsCount={activeReservationsCount}
          />
        )}

        {currentTab === 'booking' && (
          <BookingPage
            initialCourtId={selectedCourtForBooking}
            settings={activeSettings}
            reservations={reservations}
            onAddReservation={handleAddReservation}
            onNavigateToAdmin={handleOpenAdmin}
            onNavigateToSettings={handleOpenSettings}
            onResetToNewBooking={() => {
              const firstCourt = activeSettings.courts.find((c) => c.isEnabled) || activeSettings.courts[0];
              setSelectedCourtForBooking(firstCourt ? firstCourt.id : '');
            }}
          />
        )}

        {/* Administrative Views: Gated by user authentication and onboardingState */}
        {currentTab === 'admin' && (
          user ? (
            renderAdministrativeScreen('admin')
          ) : (
            <AdminPage
              settings={activeSettings}
              reservations={reservations}
              onCancelReservation={handleCancelReservation}
              onRestoreReservation={handleRestoreReservation}
              onDeleteReservation={handleDeleteReservation}
              onResetDemoData={handleResetDemoData}
              onClearAllData={handleClearAllData}
              onNavigateToBooking={() => {
                setCurrentTab('booking');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              onNavigateToSettings={handleOpenSettings}
              onOpenAuthModal={() => setIsAuthModalOpen(true)}
            />
          )
        )}

        {currentTab === 'settings' && (
          user ? (
            renderAdministrativeScreen('settings')
          ) : (
            <FacilitySettingsPage
              settings={activeSettings}
              onSaveSettings={handleSaveFacilitySettings}
              onResetSettings={handleResetFacilitySettings}
              onNavigateToBooking={() => {
                setCurrentTab('booking');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              onNavigateToReservations={handleOpenAdmin}
            />
          )
        )}
      </main>

      {/* Footer */}
      <Footer
        onNavigate={(tab) => {
          setCurrentTab(tab);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />
    </div>
  );
}

export default function App() {
  return (
    <SupabaseAuthProvider>
      <CourtBookApp />
    </SupabaseAuthProvider>
  );
}
