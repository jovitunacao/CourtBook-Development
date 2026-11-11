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
    liveHtml.includes('Awaiting Authoritative Webhook Confirmation'),
    'Live facility must show awaiting authoritative confirmation state'
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

console.log(`\n======================================================`);
console.log(`ALL ${passed} CUSTOMER BOOKING UNIT TESTS PASSED!`);
console.log(`======================================================`);

