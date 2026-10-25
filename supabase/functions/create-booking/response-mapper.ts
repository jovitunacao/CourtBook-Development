// ==============================================================================
// CourtBook / BookSuite — Create-Booking Response Mapper & Validator
//
// Maps the flat JSONB record returned by create_public_reservation_idempotent()
// into the authoritative HTTP response envelope expected by the frontend.
//
// Database RPC Contract (public.create_public_reservation):
//   - success: boolean
//   - reservation_id: UUID
//   - reference_code: TEXT (e.g. 'CB-88980')
//   - status: TEXT ('confirmed' | 'pending')
//   - booking_confirmation_mode: TEXT ('instant' | 'manual_approval')
//   - hold_expires_at: TIMESTAMPTZ | null
//   - court_name: TEXT
//   - facility_name: TEXT
//   - booking_date: DATE (YYYY-MM-DD)
//   - time_slot_label: TEXT
//   - total_price: NUMERIC
//   - currency: TEXT
//   - is_demo: BOOLEAN
//   - idempotent_replayed: BOOLEAN (present when replayed from cache)
// ==============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthoritativeReservationPayload {
  id: string;
  reservation_id: string;
  reference_code: string;
  booking_reference: string;
  status: 'confirmed' | 'pending';
  price: number;
  total_price: number;
  currency: string;
  booking_date: string;
  time_slot_label: string;
  court_name: string;
  facility_name: string;
  hold_expires_at: string | null;
  expires_at: string | null;
  booking_confirmation_mode: string;
  confirmation_mode: string;
  idempotent_replayed: boolean;
  is_demo: boolean;
}

export interface EdgeSuccessResponse {
  httpStatus: 200 | 201;
  body: {
    success: true;
    reservation: AuthoritativeReservationPayload;
    data: AuthoritativeReservationPayload;
    reservation_id: string;
    id: string;
    reference_code: string;
    booking_reference: string;
    status: 'confirmed' | 'pending';
    price: number;
    total_price: number;
    currency: string;
    hold_expires_at: string | null;
    expires_at: string | null;
    booking_confirmation_mode: string;
    confirmation_mode: string;
    court_name: string;
    facility_name: string;
    booking_date: string;
    time_slot_label: string;
    idempotent_replayed: boolean;
    payment_required: boolean;
    is_demo: boolean;
  };
}

export interface EdgeErrorResponse {
  httpStatus: 400 | 502;
  body: {
    success: false;
    error: string;
    code: string;
    details?: Record<string, boolean>;
  };
}

export type EdgeBookingResponseResult = EdgeSuccessResponse | EdgeErrorResponse;

/**
 * Validates the database RPC return and maps it into an authoritative Edge Function response.
 *
 * @param dbData The raw JSON returned by create_public_reservation_idempotent() RPC
 * @param fallbackBookingDate Optional fallback booking date from request
 */
export function buildEdgeBookingResponse(
  dbData: any,
  fallbackBookingDate?: string
): EdgeBookingResponseResult {
  if (!dbData || typeof dbData !== 'object' || dbData.success === false) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        error: dbData?.error || 'Failed to create reservation.',
        code: dbData?.error_code || 'CREATION_FAILED',
      },
    };
  }

  // The database RPC returns fields flat on the root object.
  // Handle both flat RPC output and any legacy nested data.reservation structure.
  const source =
    dbData.reservation && typeof dbData.reservation === 'object'
      ? dbData.reservation
      : dbData;

  // 1. Authoritative Reservation ID
  const rawId = source.reservation_id ?? source.id ?? dbData.reservation_id ?? dbData.id;
  const reservationId = typeof rawId === 'string' ? rawId.trim() : '';

  // 2. Authoritative Reference Code
  const rawRef =
    source.reference_code ??
    source.booking_reference ??
    dbData.reference_code ??
    dbData.booking_reference;
  const referenceCode = typeof rawRef === 'string' ? rawRef.trim() : '';

  // 3. Authoritative Status ('confirmed' | 'pending')
  const rawStatus = typeof (source.status ?? dbData.status) === 'string'
    ? String(source.status ?? dbData.status).toLowerCase().trim()
    : '';

  // 4. Authoritative Total Price
  const rawPrice = source.total_price ?? source.price ?? dbData.total_price ?? dbData.price;
  let totalPrice: number | null = null;
  if (typeof rawPrice === 'number' && !isNaN(rawPrice)) {
    totalPrice = rawPrice;
  } else if (typeof rawPrice === 'string' && rawPrice.trim().length > 0) {
    const cleaned = rawPrice.replace(/[^0-9.-]/g, '').trim();
    const parsed = Number(cleaned);
    if (!isNaN(parsed) && cleaned.length > 0) {
      totalPrice = parsed;
    }
  }

  const isValidId = UUID_REGEX.test(reservationId);
  const isValidRef = referenceCode.length > 0;
  const isValidStatus = rawStatus === 'confirmed' || rawStatus === 'pending';
  const isValidPrice = totalPrice !== null && totalPrice >= 0;

  // Validation: Fail closed if the database returned an incomplete record
  if (!isValidId || !isValidRef || !isValidStatus || !isValidPrice || totalPrice === null) {
    return {
      httpStatus: 502,
      body: {
        success: false,
        error: 'The booking service returned an incomplete or invalid reservation record.',
        code: 'INCOMPLETE_DATABASE_RESPONSE',
        details: {
          has_valid_id: isValidId,
          has_valid_ref: isValidRef,
          has_valid_status: isValidStatus,
          has_valid_price: isValidPrice,
        },
      },
    };
  }

  const authoritativePrice: number = totalPrice;
  const authoritativeStatus: 'confirmed' | 'pending' = rawStatus as 'confirmed' | 'pending';
  const isIdempotentReplay = Boolean(dbData.idempotent_replayed || source.idempotent_replayed);
  const httpStatus: 200 | 201 = isIdempotentReplay ? 200 : 201;

  // Hold Expiration: Only preserved for pending reservations; never invented for confirmed reservations
  const rawHold =
    source.hold_expires_at ??
    source.expires_at ??
    dbData.hold_expires_at ??
    dbData.expires_at;
  const holdExpiresAt =
    authoritativeStatus === 'pending' && typeof rawHold === 'string' && rawHold.trim().length > 0
      ? rawHold.trim()
      : null;

  const confirmationMode = String(
    source.booking_confirmation_mode ??
    source.confirmation_mode ??
    dbData.booking_confirmation_mode ??
    dbData.confirmation_mode ??
    (authoritativeStatus === 'pending' ? 'manual_approval' : 'instant')
  ).trim();

  const courtName = String(source.court_name ?? dbData.court_name ?? '').trim();
  const facilityName = String(source.facility_name ?? dbData.facility_name ?? '').trim();
  const bookingDate = String(
    source.booking_date ?? dbData.booking_date ?? fallbackBookingDate ?? ''
  ).trim();
  const timeSlotLabel = String(source.time_slot_label ?? dbData.time_slot_label ?? '').trim();
  const currency = String(source.currency ?? dbData.currency ?? 'PHP').trim();

  const reservation: AuthoritativeReservationPayload = {
    id: reservationId,
    reservation_id: reservationId,
    reference_code: referenceCode,
    booking_reference: referenceCode,
    status: authoritativeStatus,
    price: authoritativePrice,
    total_price: authoritativePrice,
    currency,
    booking_date: bookingDate,
    time_slot_label: timeSlotLabel,
    court_name: courtName,
    facility_name: facilityName,
    hold_expires_at: holdExpiresAt,
    expires_at: holdExpiresAt,
    booking_confirmation_mode: confirmationMode,
    confirmation_mode: confirmationMode,
    idempotent_replayed: isIdempotentReplay,
    is_demo: false,
  };

  return {
    httpStatus,
    body: {
      success: true,
      reservation,
      data: reservation,
      reservation_id: reservationId,
      id: reservationId,
      reference_code: referenceCode,
      booking_reference: referenceCode,
      status: authoritativeStatus,
      price: authoritativePrice,
      total_price: authoritativePrice,
      currency,
      hold_expires_at: holdExpiresAt,
      expires_at: holdExpiresAt,
      booking_confirmation_mode: confirmationMode,
      confirmation_mode: confirmationMode,
      court_name: courtName,
      facility_name: facilityName,
      booking_date: bookingDate,
      time_slot_label: timeSlotLabel,
      idempotent_replayed: isIdempotentReplay,
      payment_required: false,
      is_demo: false,
    },
  };
}
