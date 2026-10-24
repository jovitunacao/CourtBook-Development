import {
  Court,
  Reservation,
  FacilitySettings,
  DEFAULT_FACILITY_SETTINGS,
} from '../types/booking';

const RESERVATIONS_STORAGE_KEY = 'courtbook_phase1_reservations';
const FACILITY_SETTINGS_STORAGE_KEY = 'courtbook_phase1_facility_settings';

export function getTodayString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatDatePretty(dateString: string): string {
  try {
    const [y, m, d] = dateString.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return dateString;
  }
}

export function generateBookingRef(): string {
  const randomNum = Math.floor(10000 + Math.random() * 90000);
  return `CB-${randomNum}`;
}

const DEFAULT_SAMPLE_RESERVATIONS: Reservation[] = [
  {
    id: 'demo-res-1',
    referenceCode: 'CB-38412',
    courtId: 'court-1',
    courtName: 'Court 1',
    date: getTodayString(),
    timeSlotId: '09:00-10:00',
    timeSlotLabel: '09:00 AM – 10:00 AM',
    customerName: 'Marcus Reyes',
    customerPhone: '0917-555-0192',
    price: 350,
    status: 'confirmed',
    createdAt: new Date(Date.now() - 3600000 * 4).toISOString(),
  },
  {
    id: 'demo-res-2',
    referenceCode: 'CB-49103',
    courtId: 'court-2',
    courtName: 'Court 2',
    date: getTodayString(),
    timeSlotId: '14:00-15:00',
    timeSlotLabel: '02:00 PM – 03:00 PM',
    customerName: 'Sophia Chen',
    customerPhone: '0928-555-0481',
    price: 350,
    status: 'confirmed',
    createdAt: new Date(Date.now() - 3600000 * 2).toISOString(),
  },
  {
    id: 'demo-res-3',
    referenceCode: 'CB-88219',
    courtId: 'court-3',
    courtName: 'Court 3',
    date: getTodayString(),
    timeSlotId: '18:00-19:00',
    timeSlotLabel: '06:00 PM – 07:00 PM',
    customerName: 'Coach Leo Tan',
    customerPhone: '0919-555-0814',
    price: 350,
    status: 'confirmed',
    createdAt: new Date(Date.now() - 3600000 * 1).toISOString(),
  },
];

export function getStoredReservations(): Reservation[] {
  try {
    const raw = localStorage.getItem(RESERVATIONS_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(RESERVATIONS_STORAGE_KEY, JSON.stringify(DEFAULT_SAMPLE_RESERVATIONS));
      return DEFAULT_SAMPLE_RESERVATIONS;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return DEFAULT_SAMPLE_RESERVATIONS;
    }
    return parsed;
  } catch (e) {
    console.error('Failed to load reservations from localStorage', e);
    return DEFAULT_SAMPLE_RESERVATIONS;
  }
}

export function saveStoredReservations(reservations: Reservation[]): void {
  try {
    localStorage.setItem(RESERVATIONS_STORAGE_KEY, JSON.stringify(reservations));
  } catch (e) {
    console.error('Failed to save reservations to localStorage', e);
  }
}

export function isSlotBooked(
  reservations: Reservation[],
  courtId: string,
  date: string,
  timeSlotId: string
): boolean {
  return reservations.some(
    (res) =>
      res.courtId === courtId &&
      res.date === date &&
      res.timeSlotId === timeSlotId &&
      res.status === 'confirmed'
  );
}

export function resetToSampleReservations(): Reservation[] {
  localStorage.setItem(RESERVATIONS_STORAGE_KEY, JSON.stringify(DEFAULT_SAMPLE_RESERVATIONS));
  return DEFAULT_SAMPLE_RESERVATIONS;
}

export function clearAllReservations(): Reservation[] {
  localStorage.setItem(RESERVATIONS_STORAGE_KEY, JSON.stringify([]));
  return [];
}

// ================= FACILITY SETTINGS PERSISTENCE =================

export function getStoredFacilitySettings(): FacilitySettings {
  try {
    const raw = localStorage.getItem(FACILITY_SETTINGS_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(
        FACILITY_SETTINGS_STORAGE_KEY,
        JSON.stringify(DEFAULT_FACILITY_SETTINGS)
      );
      return DEFAULT_FACILITY_SETTINGS;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.courts)) {
      return DEFAULT_FACILITY_SETTINGS;
    }

    // Merge with defaults to ensure all required fields exist
    return {
      name: parsed.name || DEFAULT_FACILITY_SETTINGS.name,
      tagline: parsed.tagline || DEFAULT_FACILITY_SETTINGS.tagline,
      address: parsed.address || DEFAULT_FACILITY_SETTINGS.address,
      currency: parsed.currency || DEFAULT_FACILITY_SETTINGS.currency,
      openHour: typeof parsed.openHour === 'number' ? parsed.openHour : DEFAULT_FACILITY_SETTINGS.openHour,
      closeHour: typeof parsed.closeHour === 'number' ? parsed.closeHour : DEFAULT_FACILITY_SETTINGS.closeHour,
      defaultHourlyRate: typeof parsed.defaultHourlyRate === 'number' ? parsed.defaultHourlyRate : DEFAULT_FACILITY_SETTINGS.defaultHourlyRate,
      courts: parsed.courts.map((c: Partial<Court>, index: number) => ({
        id: c.id || `court-${index + 1}`,
        name: c.name || `Court ${index + 1}`,
        sportType: c.sportType || 'Pickleball',
        tag: c.tag || 'Standard Court',
        type: c.type || 'Standard Surface',
        description: c.description || 'Facility court available for booking.',
        hourlyRate: typeof c.hourlyRate === 'number' ? c.hourlyRate : 350,
        isEnabled: c.isEnabled !== false, // default true
      })),
    };
  } catch (e) {
    console.error('Failed to load facility settings from localStorage', e);
    return DEFAULT_FACILITY_SETTINGS;
  }
}

export function saveStoredFacilitySettings(settings: FacilitySettings): void {
  try {
    localStorage.setItem(FACILITY_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save facility settings to localStorage', e);
  }
}

export function resetStoredFacilitySettings(): FacilitySettings {
  localStorage.setItem(
    FACILITY_SETTINGS_STORAGE_KEY,
    JSON.stringify(DEFAULT_FACILITY_SETTINGS)
  );
  return DEFAULT_FACILITY_SETTINGS;
}
