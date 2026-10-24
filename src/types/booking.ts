export interface Court {
  id: string;
  facilityId?: string;
  name: string;
  sportType: string;
  tag: string;
  type?: string;
  description: string;
  hourlyRate: number;
  isEnabled: boolean;
}

export interface FacilitySettings {
  id?: string;
  slug?: string;
  name: string;
  tagline: string;
  address: string;
  currency: string;
  timezone?: string;
  bookingConfirmationMode?: 'instant' | 'manual_approval';
  holdDurationMinutes?: number;
  openHour: number; // 24-hour format e.g. 8 for 8 AM
  closeHour: number; // 24-hour format e.g. 22 for 10 PM
  defaultHourlyRate: number;
  courts: Court[];
}

export interface TimeSlot {
  id: string;
  label: string;
  hour: number;
}

export interface Reservation {
  id: string;
  referenceCode: string;
  courtId: string;
  courtName: string;
  date: string; // YYYY-MM-DD
  timeSlotId: string;
  timeSlotLabel: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  price: number;
  status: 'confirmed' | 'cancelled' | 'pending' | 'declined' | 'expired' | 'completed' | 'no_show';
  holdExpiresAt?: string | null;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  reviewNotes?: string | null;
  isDemo?: boolean;
  createdAt: string;
}

export const DEFAULT_FACILITY_SETTINGS: FacilitySettings = {
  name: 'Apex Pickleball Arena',
  tagline: 'Premier Indoor Courts & Community Hub',
  address: '128 Sports Boulevard, Metro District',
  currency: '₱',
  timezone: 'Asia/Manila',
  openHour: 8,
  closeHour: 22,
  defaultHourlyRate: 350,
  courts: [
    {
      id: 'court-1',
      name: 'Court 1',
      sportType: 'Pickleball',
      tag: 'Championship Court',
      type: 'Indoor Cushioned Pro Surface',
      description: 'Tournament-grade court with professional LED broadcast lighting and spectator seating.',
      hourlyRate: 350,
      isEnabled: true,
    },
    {
      id: 'court-2',
      name: 'Court 2',
      sportType: 'Pickleball',
      tag: 'Tournament Court',
      type: 'Indoor Non-Slip Acrylic',
      description: 'High-traction competition court with premium regulation net and perimeter safety margins.',
      hourlyRate: 350,
      isEnabled: true,
    },
    {
      id: 'court-3',
      name: 'Court 3',
      sportType: 'Pickleball',
      tag: 'Club Standard Court',
      type: 'Multi-Sport Cushioned Surface',
      description: 'Ideal for social games, open doubles play, drills, and high-energy recreational matches.',
      hourlyRate: 350,
      isEnabled: true,
    },
  ],
};

// Formats a 24-hour integer into a 12-hour formatted string e.g. 8 -> "08:00 AM", 13 -> "01:00 PM"
export function formatHour12(hour24: number): string {
  const period = hour24 >= 12 && hour24 < 24 ? 'PM' : 'AM';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return `${String(hour12).padStart(2, '0')}:00 ${period}`;
}

// Generate time slots dynamically based on facility open and close hours
export function generateTimeSlots(openHour: number, closeHour: number): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const start = Math.max(0, Math.min(openHour, 23));
  const end = Math.max(start + 1, Math.min(closeHour, 24));

  for (let h = start; h < end; h++) {
    const slotId = `${String(h).padStart(2, '0')}:00-${String(h + 1).padStart(2, '0')}:00`;
    const label = `${formatHour12(h)} – ${formatHour12(h + 1)}`;
    slots.push({
      id: slotId,
      label,
      hour: h,
    });
  }
  return slots;
}

// Pre-generated default slots for fallback
export const TIME_SLOTS: TimeSlot[] = generateTimeSlots(
  DEFAULT_FACILITY_SETTINGS.openHour,
  DEFAULT_FACILITY_SETTINGS.closeHour
);

export const AVAILABLE_SPORT_TYPES = [
  'Pickleball',
  'Tennis',
  'Badminton',
  'Padel',
  'Basketball',
  'Volleyball',
  'Squash',
  'Multi-Sport',
];
