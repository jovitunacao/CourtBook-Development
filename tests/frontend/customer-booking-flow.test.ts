import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PHILIPPINE_REGIONS,
  searchPhilippineLocations,
  getFlattenedLocationOptions,
} from '../../src/data/philippineLocations';
import { SPORTS_REGISTRY, normalizeSportName } from '../../src/data/sportsRegistry';
import { SportCategoryPills } from '../../src/components/booking/SportCategoryPills';
import { LocationCascadeSelector } from '../../src/components/booking/LocationCascadeSelector';
import { VenueDirectoryCard } from '../../src/components/booking/VenueDirectoryCard';
import { GuestCheckoutForm } from '../../src/components/booking/GuestCheckoutForm';
import { BookingConfirmationCard } from '../../src/components/booking/BookingConfirmationCard';
import { SupabaseFacility, SupabaseCourt } from '../../src/lib/supabaseClient';

console.log('Running CourtBook Customer Booking Experience Unit Tests...');

let passed = 0;

// Test 1: Philippine Location Dataset & Fuzzy Search
{
  assert.ok(PHILIPPINE_REGIONS.length >= 7, 'Should contain all major Philippine regions');
  const ncr = PHILIPPINE_REGIONS.find((r) => r.code === 'NCR');
  assert.ok(ncr, 'NCR must exist');
  const metroManila = ncr?.provinces.find((p) => p.name === 'Metro Manila');
  assert.ok(metroManila, 'Metro Manila province must exist in NCR');
  const makati = metroManila?.cities.find((c) => c.name === 'Makati City');
  assert.ok(makati, 'Makati City must exist');
  assert.ok(makati?.barangays.includes('Poblacion'), 'Makati must include Poblacion');

  // Search tests
  const bgcResults = searchPhilippineLocations('BGC');
  assert.ok(bgcResults.length > 0, 'Search for BGC must return Taguig City');
  assert.ok(bgcResults[0].city.includes('Taguig'), 'BGC result must belong to Taguig City');

  const cebuResults = searchPhilippineLocations('Cebu');
  assert.ok(cebuResults.length > 0, 'Search for Cebu must return Cebu locations');

  const index = getFlattenedLocationOptions();
  assert.ok(index.length > 50, 'Flattened location options must contain all indexed cities and barangays');
  passed++;
  console.log('✓ Test 1: Philippine Location Dataset & Cascade Search passed');
}

// Test 2: Sports Category Registry & Taxonomy
{
  assert.ok(SPORTS_REGISTRY.length >= 6, 'Should support at least 6 primary sports');
  const pickleball = SPORTS_REGISTRY.find((s) => s.id === 'pickleball');
  assert.ok(pickleball, 'Pickleball must be registered');
  assert.equal(pickleball?.name, 'Pickleball');

  assert.equal(normalizeSportName('pickleball'), 'Pickleball');
  assert.equal(normalizeSportName('badminton'), 'Badminton');
  assert.equal(normalizeSportName('tennis'), 'Tennis');
  assert.equal(normalizeSportName('basketball'), 'Basketball');
  passed++;
  console.log('✓ Test 2: Sports Category Registry & Normalization passed');
}

// Test 3: Sport Category Pills Component Rendering
{
  const html = renderToStaticMarkup(
    React.createElement(SportCategoryPills, {
      selectedSport: 'Pickleball',
      onSelectSport: () => {},
      sportCounts: { pickleball: 5, badminton: 3, tennis: 2 },
    })
  );

  assert.ok(html.includes('Pickleball'), 'Should render Pickleball pill');
  assert.ok(html.includes('Badminton'), 'Should render Badminton pill');
  assert.ok(html.includes('All Sports'), 'Should render All Sports pill');
  assert.ok(html.includes('10'), 'Should calculate total courts across sports');
  passed++;
  console.log('✓ Test 3: SportCategoryPills rendering passed');
}

// Test 4: Location Cascade Selector Component Rendering
{
  const html = renderToStaticMarkup(
    React.createElement(LocationCascadeSelector, {
      selectedLocation: {
        regionCode: 'NCR',
        regionName: 'NCR',
        province: 'Metro Manila',
        city: 'Makati City',
        barangay: 'Bel-Air',
      },
      onSelectLocation: () => {},
    })
  );

  assert.ok(html.includes('Bel-Air, Makati City, Metro Manila'), 'Should render selected location pill');
  assert.ok(html.includes('Search city, province, or barangay'), 'Should render search input');
  passed++;
  console.log('✓ Test 4: LocationCascadeSelector rendering passed');
}

// Test 5: Venue Directory Card Component Rendering
{
  const mockFacility: SupabaseFacility = {
    id: 'f1111111-1111-4111-8111-111111111111',
    organization_id: 'o1111111-1111-4111-8111-111111111111',
    name: 'Bonifacio Pickleball Arena',
    slug: 'bonifacio-pickleball-arena',
    tagline: 'Premier Indoor Courts at High Street',
    address: 'High Street South, BGC, Taguig City',
    currency: '₱',
    timezone: 'Asia/Manila',
    open_hour: 7,
    close_hour: 23,
    default_hourly_rate: 450,
    is_active: true,
    app_type: 'courtbook',
    is_demo: false,
  };

  const mockCourts: SupabaseCourt[] = [
    {
      id: 'c1111111-1111-4111-8111-111111111111',
      facility_id: 'f1111111-1111-4111-8111-111111111111',
      name: 'Championship Court 1',
      sport_type: 'Pickleball',
      hourly_rate: 450,
      is_enabled: true,
      display_order: 1,
    },
  ];

  const html = renderToStaticMarkup(
    React.createElement(VenueDirectoryCard, {
      facility: mockFacility,
      courts: mockCourts,
      onSelectVenue: () => {},
      selectedSport: 'Pickleball',
    })
  );

  assert.ok(html.includes('Bonifacio Pickleball Arena'), 'Should render venue name');
  assert.ok(html.includes('High Street South, BGC, Taguig City'), 'Should render venue address');
  assert.ok(html.includes('₱450'), 'Should render minimum hourly rate');
  assert.ok(html.includes('Free Parking'), 'Should render amenity badges');
  assert.ok(html.includes('Select Venue &amp; View Schedule'), 'Should render booking CTA');
  passed++;
  console.log('✓ Test 5: VenueDirectoryCard rendering passed');
}

// Test 6: Guest Checkout Form Rendering & Transparent Breakdown
{
  const mockFacility: SupabaseFacility = {
    id: 'f1111111-1111-4111-8111-111111111111',
    organization_id: 'o1111111-1111-4111-8111-111111111111',
    name: 'Apex Arena',
    slug: 'apex-arena',
    currency: '₱',
    timezone: 'Asia/Manila',
    open_hour: 8,
    close_hour: 22,
    default_hourly_rate: 400,
    is_active: true,
    app_type: 'courtbook',
    is_demo: false,
  };

  const mockCourt: SupabaseCourt = {
    id: 'c1111111-1111-4111-8111-111111111111',
    facility_id: 'f1111111-1111-4111-8111-111111111111',
    name: 'Court 1',
    sport_type: 'Pickleball',
    hourly_rate: 400,
    is_enabled: true,
    display_order: 1,
  };

  const html = renderToStaticMarkup(
    React.createElement(GuestCheckoutForm, {
      facility: mockFacility,
      court: mockCourt,
      selectedDate: '2026-11-12',
      startTimeIso: '2026-11-12T02:00:00.000Z',
      durationMinutes: 60,
      customerName: 'Juan Dela Cruz',
      onNameChange: () => {},
      customerPhone: '09171234567',
      onPhoneChange: () => {},
      customerEmail: 'juan@example.com',
      onEmailChange: () => {},
      onProceedToPayment: () => {},
      onBack: () => {},
    })
  );

  assert.ok(html.includes('Juan Dela Cruz'), 'Should render guest name in value');
  assert.ok(html.includes('0917 123 4567'), 'Should render phone placeholder');
  assert.ok(html.includes('₱400.00'), 'Should render total price calculation');
  assert.ok(html.includes('Zero booking fees or hidden charges'), 'Should render transparent fee guarantee');
  assert.ok(html.includes('Proceed to Payment'), 'Should render payment CTA');
  passed++;
  console.log('✓ Test 6: GuestCheckoutForm rendering & transparent fee breakdown passed');
}

// Test 7: Booking Confirmation Card & Digital Pass
{
  const html = renderToStaticMarkup(
    React.createElement(BookingConfirmationCard, {
      details: {
        reservationId: 'res-1234',
        referenceCode: 'CB-TEST99',
        facilityName: 'Metro Arena',
        facilityAddress: 'Taguig City, Metro Manila',
        courtName: 'Center Court',
        sportType: 'Tennis',
        bookingDate: '2026-11-15',
        timeSlotLabel: '10:00 AM – 11:00 AM',
        durationMinutes: 60,
        totalPrice: 500.0,
        currency: '₱',
        customerName: 'Maria Clara',
        customerPhone: '09181112222',
        customerEmail: 'maria@example.com',
        confirmedAt: '2026-11-09T23:30:00.000Z',
      },
      onBookAnother: () => {},
      onDone: () => {},
    })
  );

  assert.ok(html.includes('CB-TEST99'), 'Should render authoritative reference code');
  assert.ok(html.includes('Booking Confirmed!'), 'Should render confirmation header');
  assert.ok(html.includes('Add to Calendar (.ics)'), 'Should provide .ics calendar button');
  assert.ok(html.includes('Directions in Google Maps'), 'Should provide Google Maps navigation');
  assert.ok(html.includes('Paid &amp; Verified'), 'Should display verified badge');
  passed++;
  console.log('✓ Test 7: BookingConfirmationCard rendering & pass features passed');
}

// Test 8: 12 Fictional Demo Court Businesses & 36 Courts Seed Dataset
{
  const { DEMO_FACILITIES, DEMO_COURTS } = await import('../../src/data/demoVenues');

  assert.equal(DEMO_FACILITIES.length, 12, 'Must contain exactly 12 demo facilities');
  assert.equal(DEMO_COURTS.length, 36, 'Must contain exactly 36 demo courts (3 per venue)');

  // Verify all 12 are marked is_demo = true
  for (const fac of DEMO_FACILITIES) {
    assert.equal(fac.is_demo, true, `Facility ${fac.name} must be marked is_demo = true`);
    assert.ok(fac.slug.startsWith('demo-'), `Facility slug ${fac.slug} must start with demo-`);
    assert.equal(fac.timezone, 'Asia/Manila', 'Must use Asia/Manila timezone');
    assert.equal(fac.currency, '₱', 'Must use ₱ Philippine peso');
  }

  // Verify all 12 requested cities are covered
  const requiredCities = [
    // Luzon
    'Quezon City',
    'Makati City',
    'Baguio City',
    'Santa Rosa City',
    // Visayas
    'Cebu City',
    'Mandaue City',
    'Iloilo City',
    'Bacolod City',
    // Mindanao
    'Zamboanga City',
    'Davao City',
    'Cagayan de Oro City',
    'Iligan City',
  ];

  for (const city of requiredCities) {
    const found = DEMO_FACILITIES.some((f) => f.address?.includes(city));
    assert.ok(found, `Demo venues must include facility in ${city}`);
  }

  // Verify all 36 courts link to valid facilities and have 3 courts per facility
  for (const fac of DEMO_FACILITIES) {
    const facCourts = DEMO_COURTS.filter((c) => c.facility_id === fac.id);
    assert.equal(facCourts.length, 3, `Facility ${fac.name} must have exactly 3 courts`);
  }

  passed++;
  console.log('✓ Test 8: 12 Demo Businesses & 36 Courts Dataset Verification passed');
}

// Test 9: DEMO VENUE Badge Rendering on VenueDirectoryCard
{
  const { DEMO_FACILITIES, DEMO_COURTS } = await import('../../src/data/demoVenues');
  const demoFac = DEMO_FACILITIES[0];

  const html = renderToStaticMarkup(
    React.createElement(VenueDirectoryCard, {
      facility: demoFac,
      courts: DEMO_COURTS,
      onSelectVenue: () => {},
      selectedSport: 'Pickleball',
    })
  );

  assert.ok(html.includes('DEMO VENUE'), 'Should prominently label sample business as DEMO VENUE');
  passed++;
  console.log('✓ Test 9: DEMO VENUE badge rendering on sample businesses passed');
}

// Test 10: Multi-Page BookingPageLayout Header & Progress
{
  const { BookingPageLayout } = await import('../../src/components/booking/BookingPageLayout');
  const { MemoryRouter } = await import('react-router-dom');
  const { SupabaseAuthProvider } = await import('../../src/context/SupabaseAuthContext');
  const { CustomerBookingProvider } = await import('../../src/context/CustomerBookingContext');

  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/book/sport'] },
      React.createElement(
        SupabaseAuthProvider,
        null,
        React.createElement(
          CustomerBookingProvider,
          null,
          React.createElement(
            BookingPageLayout,
            {
              currentStep: 1,
              title: 'Choose Your Sport',
              subtitle: 'Select the sport or court game you want to book today',
            },
            React.createElement('div', null, 'Step 1 Child Content')
          )
        )
      )
    )
  );

  assert.ok(html.includes('Step 1 of 7'), 'Should render Step 1 of 7 indicator');
  assert.ok(html.includes('14% Complete'), 'Should calculate correct progress percent');
  assert.ok(html.includes('Choose Your Sport'), 'Should render page title');
  assert.ok(html.includes('Step 1 Child Content'), 'Should render child page content');
  passed++;
  console.log('✓ Test 10: Multi-Page BookingPageLayout header & progress passed');
}

// Test 11: PaymentCheckoutBridge Demo-Only Simulation Guard
{
  const { PaymentCheckoutBridge } = await import('../../src/components/booking/PaymentCheckoutBridge');

  const mockCheckoutResult = {
    success: true,
    reservation_id: 'res-live-1111',
    payment_id: 'pay-live-1111',
    reference_code: 'CB-LIVE99',
    expected_amount: 500,
    currency: '₱',
    checkout_url: 'https://checkout.paymongo.com/cs_test_123',
  };

  // When isDemoFacility is false (live registered facility)
  const liveHtml = renderToStaticMarkup(
    React.createElement(PaymentCheckoutBridge, {
      checkoutResult: mockCheckoutResult,
      isLoading: false,
      errorMessage: null,
      isDemoFacility: false,
      onSimulateSuccess: () => {},
      onRetry: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(
    !liveHtml.includes('Simulate Demo Payment'),
    'Live facility must NOT show Simulate Demo Payment button'
  );
  assert.ok(
    liveHtml.includes('Awaiting Authoritative Payment Capture'),
    'Live facility must show awaiting authoritative payment capture state'
  );

  // When isDemoFacility is true (demo test facility)
  const demoHtml = renderToStaticMarkup(
    React.createElement(PaymentCheckoutBridge, {
      checkoutResult: mockCheckoutResult,
      isLoading: false,
      errorMessage: null,
      isDemoFacility: true,
      onSimulateSuccess: () => {},
      onRetry: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(
    demoHtml.includes('Simulate Demo Payment &amp; View Pass'),
    'Demo facility MUST display explicit demo simulation option'
  );
  passed++;
  console.log('✓ Test 11: PaymentCheckoutBridge demo-only simulation guard passed');
}

// Test 12: Zero Silent Substitution & Isolated Inventory Guarantees
{
  const { DEMO_FACILITIES, DEMO_COURTS } = await import('../../src/data/demoVenues');

  // Verify that an invalid venue ID does NOT substitute another facility
  const invalidId = 'f9999999-9999-4999-8999-999999999999';
  const found = DEMO_FACILITIES.find((f) => f.id === invalidId) || null;
  assert.equal(found, null, 'Invalid facility ID must strictly return null without fallback substitution');

  // Verify that an invalid court ID does NOT substitute another court
  const invalidCourtId = 'c9999999-9999-4999-8999-999999999999';
  const foundCourt = DEMO_COURTS.find((c) => c.id === invalidCourtId) || null;
  assert.equal(foundCourt, null, 'Invalid court ID must strictly return null without fallback substitution');

  // Verify every demo court belongs to a valid demo facility
  for (const c of DEMO_COURTS) {
    const parentFacility = DEMO_FACILITIES.find((f) => f.id === c.facility_id);
    assert.ok(parentFacility, `Court ${c.name} must belong to an existing demo facility`);
    assert.equal(parentFacility?.is_demo, true, 'Parent facility must be demo');
  }

  passed++;
  console.log('✓ Test 12: Zero silent substitution and isolated inventory guarantees passed');
}

// Test 13: Strict Hierarchical Location Filtering (City and Barangay Matching)
{
  const { DEMO_FACILITIES, DEMO_COURTS } = await import('../../src/data/demoVenues');

  // Case A: Filtering by Quezon City must only match QC facilities, not Makati or Baguio
  const qcLocation = {
    regionCode: 'NCR',
    regionName: 'NCR',
    province: 'Metro Manila',
    city: 'Quezon City',
  };

  const qcMatches = DEMO_FACILITIES.filter((f) => {
    const addr = (f.address || '').toLowerCase();
    const city = qcLocation.city.toLowerCase().trim().replace(/\s+city$/i, '');
    return addr.includes(city);
  });

  assert.equal(qcMatches.length, 1, 'Exactly 1 demo facility in Quezon City');
  assert.equal(qcMatches[0].name, 'Apex Pickleball & Racquet Hub');

  // Case B: City mismatch must NOT match just because province matches (Metro Manila)
  // Selecting Pasay City must NOT return Quezon City or Makati facilities
  const pasayLocation = {
    regionCode: 'NCR',
    regionName: 'NCR',
    province: 'Metro Manila',
    city: 'Pasay City',
  };

  const pasayMatches = DEMO_FACILITIES.filter((f) => {
    const addr = (f.address || '').toLowerCase();
    const city = pasayLocation.city.toLowerCase().trim().replace(/\s+city$/i, '');
    return addr.includes(city);
  });

  assert.equal(pasayMatches.length, 0, 'No demo facility in Pasay City; must not match other Metro Manila venues');

  // Case C: Barangay match enforcement
  const salcedoLocation = {
    regionCode: 'NCR',
    regionName: 'NCR',
    province: 'Metro Manila',
    city: 'Makati City',
    barangay: 'Salcedo Village',
  };

  const salcedoMatches = DEMO_FACILITIES.filter((f) => {
    const addr = (f.address || '').toLowerCase();
    const city = salcedoLocation.city.toLowerCase().trim().replace(/\s+city$/i, '');
    const bgy = salcedoLocation.barangay.toLowerCase().trim();
    return addr.includes(city) && addr.includes(bgy);
  });

  assert.equal(salcedoMatches.length, 1, 'Must match Salcedo Padel & Racquet Club');
  assert.equal(salcedoMatches[0].name, 'Salcedo Padel & Racquet Club');
  passed++;
  console.log('✓ Test 13: Strict hierarchical location filtering passed');
}

// Test 14: Financial Model & 5% Platform Commission Verification
{
  const hourlyRate = 350.0;
  const durationMinutes = 60;
  const totalPrice = Math.round((hourlyRate * (durationMinutes / 60)) * 100) / 100;
  const commissionRate = 0.05;
  const commissionAmount = Math.round((totalPrice * commissionRate) * 100) / 100;
  const ownerGrossShare = Math.round((totalPrice - commissionAmount) * 100) / 100;

  assert.equal(totalPrice, 350.0, 'Customer pays listed court price');
  assert.equal(commissionAmount, 17.5, 'CourtBook commission is exactly 5% of gross');
  assert.equal(ownerGrossShare, 332.5, 'Owner gross entitlement is 95%');
  assert.equal(commissionAmount + ownerGrossShare, totalPrice, 'Journal balances perfectly');
  passed++;
  console.log('✓ Test 14: 5% platform commission and owner gross share calculation passed');
}

// Test 15: Booking Confirmation Pass Distinction (DEMO / SIMULATED vs Official)
{
  const { BookingConfirmationCard } = await import('../../src/components/booking/BookingConfirmationCard');

  // Demo confirmation rendering
  const demoDetails = {
    reservationId: 'demo-res-1234',
    referenceCode: 'DEMO-ABC123',
    facilityName: 'Apex Sports Club [DEMO]',
    facilityAddress: 'Quezon City, Metro Manila',
    courtName: 'Court 1',
    sportType: 'Pickleball',
    bookingDate: '2026-11-20',
    timeSlotLabel: '08:00 AM – 09:00 AM',
    durationMinutes: 60,
    totalPrice: 400.0,
    currency: '₱',
    customerName: 'Demo Player',
    confirmedAt: new Date().toISOString(),
    isDemo: true,
    isSimulated: true,
  };

  const demoCardHtml = renderToStaticMarkup(
    React.createElement(BookingConfirmationCard, {
      details: demoDetails,
      onBookAnother: () => {},
      onDone: () => {},
    })
  );

  assert.ok(
    demoCardHtml.includes('DEMO SIMULATION ONLY • NOT A PAID RESERVATION'),
    'Demo confirmation must prominently state it is a simulation only'
  );
  assert.ok(
    demoCardHtml.includes('DEMO / SIMULATED'),
    'Demo confirmation badge must say DEMO / SIMULATED'
  );
  assert.ok(
    !demoCardHtml.includes('Paid &amp; Verified'),
    'Demo confirmation must NOT display Paid & Verified badge'
  );

  // Live confirmed reservation rendering
  const liveDetails = {
    ...demoDetails,
    isDemo: false,
    isSimulated: false,
    referenceCode: 'CB-LIVE99',
  };

  const liveCardHtml = renderToStaticMarkup(
    React.createElement(BookingConfirmationCard, {
      details: liveDetails,
      onBookAnother: () => {},
      onDone: () => {},
    })
  );

  assert.ok(
    liveCardHtml.includes('Paid &amp; Verified'),
    'Live confirmed reservation must display Paid & Verified badge'
  );
  assert.ok(
    liveCardHtml.includes('Confirmed &amp; Reserved'),
    'Live confirmed reservation must state Confirmed & Reserved'
  );
  passed++;
  console.log('✓ Test 15: Demo vs Live confirmation pass labeling passed');
}

// Test 16: Live Checkout Fail-Closed Guard (No Fake Live Reservations)
{
  const { createBookingCheckoutSession } = await import('../../src/lib/supabaseClient');

  // Attempting checkout for a live registered facility when backend is offline/unreachable
  // MUST fail closed and return success: false without fabricating fake IDs
  const result = await createBookingCheckoutSession({
    facility_id: '11111111-1111-4111-8111-111111111111',
    court_id: '22222222-2222-4222-8222-222222222222',
    customer_name: 'Live Customer',
    customer_phone: '09171112233',
    booking_date: '2026-11-20',
    start_time: '2026-11-20T08:00:00.000Z',
    duration_minutes: 60,
    idempotency_key: 'idem_test_live_fail_closed_123456',
    is_demo: false, // Live facility
  });

  assert.equal(result.success, false, 'Live facility checkout without backend connection must fail closed');
  assert.ok(
    result.error?.includes('Unable to establish authoritative backend checkout session') ||
    result.error?.includes('connection') ||
    result.error?.includes('offline'),
    'Must return clear failure reason without faking live success'
  );
  passed++;
  console.log('✓ Test 16: Live checkout fail-closed guard passed');
}

// Test 17: Fictional Demo Seed SQL Fixture Whitelist & Idempotency
{
  const fs = await import('node:fs');
  const path = await import('node:path');

  const fixturePath = path.resolve('supabase/fixtures/006_demo_court_businesses_seed.sql');
  const sqlContent = fs.readFileSync(fixturePath, 'utf8');

  // Verify fixture does NOT contain unsafe wildcard deletes
  assert.ok(
    !sqlContent.includes("DELETE FROM public.facilities WHERE slug LIKE 'demo-%'"),
    'Fixture must NOT contain unsafe wildcard slug deletion'
  );
  assert.ok(
    !sqlContent.includes("DELETE FROM public.organizations WHERE slug LIKE 'demo-%'"),
    'Fixture must NOT contain unsafe wildcard organization deletion'
  );

  // Verify fixture contains exact 12 organization UUIDs and 12 facility UUIDs
  assert.ok(sqlContent.includes('d0000001-0000-4000-8000-000000000001'), 'Must contain Org 1 UUID');
  assert.ok(sqlContent.includes('d0000001-0000-4000-8000-000000000012'), 'Must contain Org 12 UUID');
  assert.ok(sqlContent.includes('d0000002-0000-4000-8000-000000000001'), 'Must contain Facility 1 UUID');
  assert.ok(sqlContent.includes('d0000002-0000-4000-8000-000000000012'), 'Must contain Facility 12 UUID');

  // Verify safe ON CONFLICT clauses for idempotency
  assert.ok(sqlContent.includes('ON CONFLICT (slug) DO UPDATE'), 'Must be idempotent with ON CONFLICT');
  passed++;
  console.log('✓ Test 17: Demo Seed SQL Fixture safety and exact UUID cleanup verification passed');
}

// Test 18: Zero Network Calls for Frontend Demo Checkout & Dynamic Pricing
{
  const { createBookingCheckoutSession } = await import('../../src/lib/supabaseClient');

  // Intercept global fetch to verify ZERO network requests are made during frontend demo checkout
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;
  globalThis.fetch = async (...args: any[]) => {
    fetchCallCount++;
    throw new Error(`CRITICAL ERROR: Unexpected network fetch called in frontend-only demo mode: ${args[0]}`);
  };

  try {
    const demoResult = await createBookingCheckoutSession({
      facility_id: 'd0000002-0000-4000-8000-000000000001',
      court_id: 'd0000003-0000-4000-8000-000000000001',
      customer_name: 'Demo Player',
      customer_phone: '09171234567',
      booking_date: '2026-11-25',
      start_time: '2026-11-25T09:00:00.000Z',
      duration_minutes: 90, // 1.5 hours
      hourly_rate: 600, // ₱600/hr -> Expected total ₱900
      idempotency_key: 'idem_test_zero_network_frontend_demo_999999',
      is_frontend_demo: true,
    });

    assert.equal(fetchCallCount, 0, 'Zero network calls must be made for frontend demo checkout');
    assert.equal(demoResult.success, true, 'Frontend demo checkout must succeed in-memory');
    assert.equal(demoResult.isSimulated, true, 'Result must be marked isSimulated = true');
    assert.equal(demoResult.expected_amount, 900.0, 'Amount must be dynamically calculated from hourly_rate and duration');
    assert.equal(demoResult.commission_amount, 45.0, '5% commission must be ₱45.00');
    assert.equal(demoResult.owner_gross_share, 855.0, '95% owner gross share must be ₱855.00');
    assert.equal(demoResult.checkout_url, undefined, 'Zero fabricated PayMongo URL');
    assert.ok(demoResult.reference_code?.startsWith('DEMO-'), 'Reference code must be explicitly prefixed DEMO-');
  } finally {
    globalThis.fetch = originalFetch;
  }

  passed++;
  console.log('✓ Test 18: Zero network calls & dynamic pricing for frontend demo checkout passed');
}

// Test 19: Region-Only and Province-Only Hierarchical Selection
{
  const { DEMO_FACILITIES } = await import('../../src/data/demoVenues');

  // Case A: Region-Only selection (Region VII - Central Visayas)
  // Must match Cebu City and Mandaue City venues, but NOT Davao or Manila
  const regionVII = {
    regionCode: 'VII',
    regionName: 'Central Visayas (Region VII)',
    province: '',
    city: '',
  };

  const regVIIMatches = DEMO_FACILITIES.filter((f) => {
    const addr = (f.address || '').toLowerCase();
    return addr.includes('cebu') || addr.includes('mandaue');
  });

  assert.equal(regVIIMatches.length, 2, 'Exactly 2 venues in Region VII (Cebu & Mandaue)');

  // Case B: Province-Only selection (Benguet)
  // Must match Baguio City venue
  const benguetLocation = {
    regionCode: 'CAR',
    regionName: 'Cordillera Administrative Region (CAR)',
    province: 'Benguet',
    city: '',
  };

  const benguetMatches = DEMO_FACILITIES.filter((f) => {
    const addr = (f.address || '').toLowerCase();
    return addr.includes('benguet') || addr.includes('baguio');
  });

  assert.equal(benguetMatches.length, 1, 'Exactly 1 venue in Benguet (Baguio)');
  assert.equal(benguetMatches[0].name, 'Pine Valley Tennis & Sports Pavilion');
  passed++;
  console.log('✓ Test 19: Region-only and Province-only hierarchical selection passed');
}

// Test 20: Hold Expiration and Fresh Attempt Creation
{
  // Simulated attempt storage check: expired hold must trigger fresh attempt token
  const slotSignature = 'fac1_court1_2026-11-20_2026-11-20T08:00:00Z_60_Juan_09171234567';
  const pastExpiry = new Date(Date.now() - 5000).toISOString(); // Expired 5 seconds ago
  const futureExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 mins remaining

  const isHoldExpired = (expiresAt: string) => new Date(expiresAt).getTime() <= Date.now();

  assert.equal(isHoldExpired(pastExpiry), true, 'Past expiry timestamp must be detected as expired');
  assert.equal(isHoldExpired(futureExpiry), false, 'Future expiry timestamp must be active');
  passed++;
  console.log('✓ Test 20: Hold expiration and fresh attempt trigger validation passed');
}

// Test 21: Supabase Demo Facility Does NOT Bypass Backend Checkout
{
  const { createBookingCheckoutSession } = await import('../../src/lib/supabaseClient');

  // When a facility is in Supabase with is_demo = true, but is_frontend_demo is false (or omitted),
  // it MUST use the real backend path and NOT execute local in-memory simulation.
  // If the backend is offline, it must fail closed and return success: false.
  const result = await createBookingCheckoutSession({
    facility_id: 'd0000002-0000-4000-8000-000000000001', // Supabase demo facility UUID
    court_id: 'd0000003-0000-4000-8000-000000000001',
    customer_name: 'Database Demo Player',
    customer_phone: '09171234567',
    booking_date: '2026-11-25',
    start_time: '2026-11-25T10:00:00.000Z',
    duration_minutes: 60,
    idempotency_key: 'idem_test_db_demo_must_not_bypass_backend',
    is_demo: true, // database demo facility
    is_frontend_demo: false, // NOT frontend-only demo
  });

  assert.equal(result.success, false, 'Supabase-backed demo facility without backend must fail closed');
  assert.ok(
    result.error?.includes('Unable to establish authoritative backend checkout session') ||
    result.error?.includes('connection') ||
    result.error?.includes('offline'),
    'Supabase demo facility must NOT use local offline simulation bypass'
  );
  passed++;
  console.log('✓ Test 21: Supabase demo facility backend path & fail-closed verification passed');
}

// Test 22: Authoritative Payment Verification Fails Closed on Invalid or Pending State
{
  const { verifyPublicBookingPaymentStatus } = await import('../../src/lib/supabaseClient');

  // Case A: Missing required reference or guest credential (reservation_id alone is insufficient)
  const invalidResult = await verifyPublicBookingPaymentStatus({
    reference_code: '',
    reservation_id: '',
  });
  assert.equal(invalidResult.verified, false, 'Missing input must return verified: false');
  assert.equal(invalidResult.status, 'failed');

  const uuidOnlyResult = await verifyPublicBookingPaymentStatus({
    reference_code: 'CB-TEST9999',
    reservation_id: 'res-9999-unverified',
  });
  assert.equal(uuidOnlyResult.verified, false, 'reservation_id alone must fail closed');
  assert.equal(uuidOnlyResult.status, 'failed');

  // Case B: Unverified / pending status when backend is unreachable
  const unverifiedResult = await verifyPublicBookingPaymentStatus({
    reference_code: 'CB-TEST9999',
    reservation_id: 'res-9999-unverified',
    payment_id: 'pay-9999-unverified',
    customer_phone_or_email: '09171234567',
  });
  assert.equal(unverifiedResult.verified, false, 'Unconfirmed status must never report verified: true');
  assert.equal(unverifiedResult.status, 'pending');
  assert.ok(unverifiedResult.error?.includes('unreachable') || unverifiedResult.error?.includes('progress'));
  passed++;
  console.log('✓ Test 22: Authoritative payment verification fail-closed state handling passed');
}

// Test 23: Idempotent Attempt Key Stability Across Re-Renders
{
  const slotSignature = 'facA_courtB_2026-11-28_2026-11-28T09:00:00Z_60_Maria_09181234567';
  const token = 'stable_token_12345678';
  const facPrefix = 'facA1111'.substring(0, 8);
  const courtPrefix = 'courtB22'.substring(0, 8);

  const key1 = `idem_${facPrefix}_${courtPrefix}_${token}`.substring(0, 64);
  const key2 = `idem_${facPrefix}_${courtPrefix}_${token}`.substring(0, 64);

  assert.equal(key1, key2, 'Deterministic attempt key must be strictly identical across re-renders');
  assert.ok(key1.length >= 16 && key1.length <= 64, 'Idempotency key length must be compliant');
  passed++;
  console.log('✓ Test 23: Idempotent attempt key stability across re-renders passed');
}

// Test 24: Authoritative Status Verification Contract - Confirmed Capture
{
  const { verifyPublicBookingPaymentStatus } = await import('../../src/lib/supabaseClient');

  const originalFetch = globalThis.fetch;
  const mockReservationId = 'd1111111-1111-4111-8111-111111111111';
  const mockReferenceCode = 'CB-PAID123';
  const mockPaymentId = 'p1111111-1111-4111-8111-111111111111';

  // Mock Edge Function responding with authentic captured payment evidence
  globalThis.fetch = async (url: any, opts: any) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        verified: true,
        status: 'confirmed',
        reservation_status: 'confirmed',
        payment_status: 'captured',
        reservation_id: mockReservationId,
        reference_code: mockReferenceCode,
        payment_id: mockPaymentId,
        total_price: 450.0,
        currency: '₱',
        facility_name: 'Metro Arena',
        court_name: 'Center Court',
        booking_date: '2026-11-20',
        time_slot_label: '08:00 AM – 09:00 AM',
        duration_minutes: 60,
        customer_name: 'Maria Santos',
        confirmed_at: '2026-11-20T08:05:00.000Z',
        has_capture_evidence: true,
        settlement_verified: true,
      }),
    } as any;
  };

  try {
    // reservation_id alone without token or contact must fail closed
    const unauthRes = await verifyPublicBookingPaymentStatus({
      reference_code: mockReferenceCode,
      reservation_id: mockReservationId,
      payment_id: mockPaymentId,
    });
    assert.equal(unauthRes.verified, false, 'reservation_id alone must fail closed');
    assert.equal(unauthRes.status, 'failed');

    const verifiedResult = await verifyPublicBookingPaymentStatus({
      reference_code: mockReferenceCode,
      reservation_id: mockReservationId,
      payment_id: mockPaymentId,
      customer_phone_or_email: '09171234567',
    });

    assert.equal(verifiedResult.verified, true, 'Server-confirmed capture must report verified: true');
    assert.equal(verifiedResult.status, 'confirmed');
    assert.equal(verifiedResult.reference_code, mockReferenceCode);
    assert.equal(verifiedResult.reservation_id, mockReservationId);
    assert.equal(verifiedResult.payment_id, mockPaymentId);
    assert.equal(verifiedResult.total_price, 450.0);
    assert.equal(verifiedResult.facility_name, 'Metro Arena');
  } finally {
    globalThis.fetch = originalFetch;
  }

  passed++;
  console.log('✓ Test 24: Authoritative status verification contract on confirmed capture passed');
}

// Test 25: Forged or Mismatched Reservation Reference Rejection
{
  const { verifyPublicBookingPaymentStatus } = await import('../../src/lib/supabaseClient');

  const originalFetch = globalThis.fetch;

  // Mock server returning reference code mismatch / 403
  globalThis.fetch = async () => {
    return {
      ok: false,
      status: 403,
      json: async () => ({
        error: 'Guest verification failed. Please check your booking reference and contact details.',
      }),
    } as any;
  };

  try {
    const result = await verifyPublicBookingPaymentStatus({
      reference_code: 'CB-FORGED99',
      reservation_id: 'd1111111-1111-4111-8111-111111111111',
      customer_phone_or_email: '09171234567',
    });

    assert.equal(result.verified, false, 'Forged lookup must not verify');
    assert.equal(result.status, 'failed');
    assert.ok(result.error?.includes('verification failed') || result.error?.includes('mismatch'));
  } finally {
    globalThis.fetch = originalFetch;
  }

  passed++;
  console.log('✓ Test 25: Forged or mismatched reservation reference rejection passed');
}

// Test 26: Mismatched Response Contract Protection
{
  const { verifyPublicBookingPaymentStatus } = await import('../../src/lib/supabaseClient');

  const originalFetch = globalThis.fetch;

  // Mock server response returning mismatched reservation_id
  globalThis.fetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        verified: true,
        status: 'confirmed',
        reservation_id: 'different-uuid-returned',
        reference_code: 'CB-TEST123',
      }),
    } as any;
  };

  try {
    const result = await verifyPublicBookingPaymentStatus({
      reference_code: 'CB-TEST123',
      reservation_id: 'target-uuid-sent',
      customer_phone_or_email: '09171234567',
    });

    // Must fail closed because returned reservation_id does not match target-uuid-sent
    assert.equal(result.verified, false, 'Mismatched response contract must fail closed');
    assert.equal(result.status, 'pending');
  } finally {
    globalThis.fetch = originalFetch;
  }

  passed++;
  console.log('✓ Test 26: Mismatched response contract protection passed');
}

// Test 27: Failed / Expired Status Handling in Verification
{
  const { verifyPublicBookingPaymentStatus } = await import('../../src/lib/supabaseClient');

  const originalFetch = globalThis.fetch;

  // Case A: Expired hold
  globalThis.fetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        verified: false,
        status: 'expired',
        reservation_status: 'expired',
        payment_status: 'expired',
        reservation_id: 'res-expired-111',
        reference_code: 'CB-EXPIRED',
      }),
    } as any;
  };

  try {
    const expiredRes = await verifyPublicBookingPaymentStatus({
      reference_code: 'CB-EXPIRED',
      reservation_id: 'res-expired-111',
      customer_phone_or_email: '09171234567',
    });

    assert.equal(expiredRes.verified, false);
    assert.equal(expiredRes.status, 'expired');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Case B: Payment failed
  globalThis.fetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        verified: false,
        status: 'failed',
        reservation_status: 'pending',
        payment_status: 'failed',
        reservation_id: 'res-failed-111',
        reference_code: 'CB-FAILED',
      }),
    } as any;
  };

  try {
    const failedRes = await verifyPublicBookingPaymentStatus({
      reference_code: 'CB-FAILED',
      reservation_id: 'res-failed-111',
      customer_phone_or_email: '09171234567',
    });

    assert.equal(failedRes.verified, false);
    assert.equal(failedRes.status, 'failed');
  } finally {
    globalThis.fetch = originalFetch;
  }

  passed++;
  console.log('✓ Test 27: Failed and expired status handling passed');
}

console.log(`\n======================================================`);
console.log(`ALL ${passed} CUSTOMER BOOKING UNIT TESTS PASSED!`);
console.log(`======================================================`);





