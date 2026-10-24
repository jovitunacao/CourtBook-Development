import React, { useState, useEffect } from 'react';
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

  const { mappedFacilitySettings } = useSupabaseAuth();

  // Active facility settings: prioritize live Supabase facility settings if authenticated or available
  const activeSettings = mappedFacilitySettings || facilitySettings;

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
        facilityName={activeSettings.name}
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

        {currentTab === 'admin' && (
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
        )}

        {currentTab === 'settings' && (
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
