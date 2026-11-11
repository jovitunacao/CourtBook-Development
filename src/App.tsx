import React, { useState, useEffect } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
} from 'react-router-dom';
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
import { VenueDirectory } from './components/VenueDirectory';
import { AdminPage } from './components/AdminPage';
import { FacilitySettingsPage } from './components/FacilitySettingsPage';
import { AuthModal } from './components/AuthModal';
import { OwnerOnboardingWizard } from './components/OwnerOnboardingWizard';
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
import { CustomerBookingProvider, useCustomerBooking } from './context/CustomerBookingContext';

// Dedicated Customer Booking Pages
import { SportSelectionPage } from './pages/book/SportSelectionPage';
import { LocationSelectionPage } from './pages/book/LocationSelectionPage';
import { VenueDirectoryPage } from './pages/book/VenueDirectoryPage';
import { ScheduleSelectionPage } from './pages/book/ScheduleSelectionPage';
import { GuestDetailsPage } from './pages/book/GuestDetailsPage';
import { PaymentReviewPage } from './pages/book/PaymentReviewPage';
import { ConfirmationPage } from './pages/book/ConfirmationPage';

function CourtBookMainContent() {
  const navigate = useNavigate();
  const location = useLocation();

  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [facilitySettings, setFacilitySettings] = useState<FacilitySettings>(DEFAULT_FACILITY_SETTINGS);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);

  const {
    isConfigured,
    user,
    onboardingState,
    membershipLookupError,
    refreshStaffData,
    signOut,
    mappedFacilitySettings,
    publicFacilitySettings,
    publicFacilities,
    publicFacilitiesLoading,
    publicFacilitiesError,
    refreshPublicFacilities,
    directoryCourts,
    activePublicFacility,
    setActivePublicFacilityId,
  } = useSupabaseAuth();

  const { setSelectedFacilityId, setSelectedCourtId } = useCustomerBooking();

  // Active facility settings for administrative/demo views
  const activeSettings = mappedFacilitySettings || facilitySettings;
  // Active facility settings for public customer views
  const publicActiveSettings = isConfigured ? publicFacilitySettings : facilitySettings;

  // Header display name
  const displayFacilityName =
    user && onboardingState === 'needs_onboarding'
      ? 'CourtBook Owner Portal'
      : location.pathname.startsWith('/admin') || location.pathname.startsWith('/settings')
      ? activeSettings.name
      : publicActiveSettings?.name || 'CourtBook Directory';

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
      setSelectedCourtId(courtId);
      navigate('/book/schedule');
    } else {
      navigate('/book/sport');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleOpenAdmin = () => {
    navigate('/admin');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleOpenSettings = () => {
    navigate('/settings');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const activeReservationsCount = reservations.filter(
    (r) => r.status === 'confirmed'
  ).length;

  // Render helper for administrative views when user is authenticated
  const renderAdministrativeScreen = (tab: 'admin' | 'settings') => {
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
                  navigate('/book/venues');
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

    if (onboardingState === 'needs_onboarding') {
      return (
        <OwnerOnboardingWizard
          onComplete={async () => {
            await refreshStaffData();
            navigate('/admin');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          onNavigateToBooking={() => {
            navigate('/book/sport');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      );
    }

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
            navigate('/book/sport');
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
          navigate('/book/sport');
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
        activeReservationsCount={activeReservationsCount}
        facilityName={displayFacilityName}
        onOpenAuthModal={() => setIsAuthModalOpen(true)}
      />

      {/* Main Routed Content */}
      <main className="flex-1">
        <Routes>
          {/* Home Route */}
          <Route
            path="/"
            element={
              isConfigured && !activePublicFacility ? (
                <VenueDirectory
                  facilities={publicFacilities}
                  directoryCourts={directoryCourts}
                  isLoading={publicFacilitiesLoading}
                  error={publicFacilitiesError}
                  onSelectFacility={async (facilityId) => {
                    await setActivePublicFacilityId(facilityId);
                    setSelectedFacilityId(facilityId);
                    navigate('/book/schedule');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  onRetry={refreshPublicFacilities}
                />
              ) : (
                <HomePage
                  settings={publicActiveSettings || facilitySettings}
                  onStartBooking={handleStartBooking}
                  onOpenAdmin={handleOpenAdmin}
                  activeReservationsCount={activeReservationsCount}
                />
              )
            }
          />

          {/* Customer Booking Dedicated Multi-Page Journey */}
          <Route path="/book/sport" element={<SportSelectionPage />} />
          <Route path="/book/location" element={<LocationSelectionPage />} />
          <Route path="/book/venues" element={<VenueDirectoryPage />} />
          <Route path="/book/schedule" element={<ScheduleSelectionPage />} />
          <Route path="/book/details" element={<GuestDetailsPage />} />
          <Route path="/book/payment" element={<PaymentReviewPage />} />
          <Route path="/book/confirmation" element={<ConfirmationPage />} />

          {/* Aliases & Redirects */}
          <Route path="/book" element={<Navigate to="/book/sport" replace />} />
          <Route path="/venues" element={<Navigate to="/book/venues" replace />} />

          {/* Administrative Views */}
          <Route
            path="/admin"
            element={
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
                    navigate('/book/sport');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  onNavigateToSettings={handleOpenSettings}
                  onOpenAuthModal={() => setIsAuthModalOpen(true)}
                />
              )
            }
          />

          <Route
            path="/settings"
            element={
              user ? (
                renderAdministrativeScreen('settings')
              ) : (
                <FacilitySettingsPage
                  settings={activeSettings}
                  onSaveSettings={handleSaveFacilitySettings}
                  onResetSettings={handleResetFacilitySettings}
                  onNavigateToBooking={() => {
                    navigate('/book/sport');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  onNavigateToReservations={handleOpenAdmin}
                />
              )
            }
          />

          {/* Catch-all redirect to Home */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {/* Footer */}
      <Footer />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SupabaseAuthProvider>
        <CustomerBookingProvider>
          <CourtBookMainContent />
        </CustomerBookingProvider>
      </SupabaseAuthProvider>
    </BrowserRouter>
  );
}
