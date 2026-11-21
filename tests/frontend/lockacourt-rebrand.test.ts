// ==============================================================================
// LockaCourt (AratReserve) — Stage 3 Rebranding & Domain Integration Tests
// File: tests/frontend/lockacourt-rebrand.test.ts
// ==============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import { SupabaseAuthProvider } from '../../src/context/SupabaseAuthContext';
import { CustomerBookingProvider } from '../../src/context/CustomerBookingContext';
import { Navbar } from '../../src/components/Navbar';
import { Footer } from '../../src/components/Footer';
import { HomePage } from '../../src/components/HomePage';
import { VenueDirectory } from '../../src/components/VenueDirectory';
import { AuthModal } from '../../src/components/AuthModal';
import { SupabaseStatusBanner } from '../../src/components/SupabaseStatusBanner';
import { DEFAULT_FACILITY_SETTINGS } from '../../src/types/booking';
import {
  BRAND_NAME,
  PARENT_BUSINESS_NAME,
  PARENT_BUSINESS_URL,
  CANONICAL_APP_BASE_URL,
  normalizeAppOrigin,
  getAppBaseUrl,
  getAuthEmailRedirectUrl,
} from '../../src/lib/appUrl';

console.log('Running LockaCourt Stage 3 Rebranding & Domain Integration Tests...');

let passed = 0;

function renderWithProviders(element: React.ReactElement, initialPath = '/'): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      React.createElement(
        SupabaseAuthProvider,
        null,
        React.createElement(CustomerBookingProvider, null, element)
      )
    )
  );
}

// Test 1: index.html and metadata.json branding & meta tags
{
  const indexHtml = fs.readFileSync(path.resolve('index.html'), 'utf8');
  const metadataRaw = fs.readFileSync(path.resolve('metadata.json'), 'utf8');
  const metadata = JSON.parse(metadataRaw);

  assert.ok(indexHtml.includes('<title>LockaCourt - Sports Court Reservation Platform</title>'));
  assert.ok(indexHtml.includes('AratReserve'));
  assert.ok(indexHtml.includes('https://lockacourt.com'));
  assert.ok(indexHtml.includes('og:site_name" content="LockaCourt"'));
  assert.ok(!/courtbook|booksuite/i.test(indexHtml), 'index.html must not contain CourtBook or BookSuite');

  assert.equal(metadata.name, 'LockaCourt - Sports Court Reservation Platform');
  assert.ok(metadata.description.includes('LockaCourt') && metadata.description.includes('AratReserve'));
  assert.ok(!/courtbook|booksuite/i.test(metadataRaw), 'metadata.json must not contain CourtBook or BookSuite');
  assert.ok(
    Array.isArray(metadata.majorCapabilities) &&
      metadata.majorCapabilities.includes('MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API'),
    'metadata.json must preserve majorCapabilities'
  );

  passed++;
  console.log('✓ Test 1: index.html and metadata.json LockaCourt / AratReserve metadata verified');
}

// Test 2: Navbar & Footer SSR branding and AratReserve attribution
{
  const navbarHtml = renderWithProviders(
    React.createElement(Navbar, {
      activeReservationsCount: 2,
    })
  );

  assert.ok(navbarHtml.includes('LockaCourt'), 'Navbar must render LockaCourt');
  assert.ok(navbarHtml.includes('AratReserve'), 'Navbar must credit AratReserve');
  assert.ok(navbarHtml.includes('https://aratreserve.com'), 'Navbar must link to aratreserve.com');
  assert.ok(!/courtbook|booksuite|phase 1/i.test(navbarHtml), 'Navbar must not expose CourtBook, BookSuite, or Phase 1');

  const footerHtml = renderWithProviders(React.createElement(Footer));
  assert.ok(footerHtml.includes('LockaCourt'), 'Footer must render LockaCourt');
  assert.ok(footerHtml.includes('Operated by'), 'Footer must render Operated by AratReserve');
  assert.ok(footerHtml.includes('https://aratreserve.com'), 'Footer must link to aratreserve.com');
  assert.ok(footerHtml.includes('lockacourt.com'), 'Footer must display lockacourt.com');
  assert.ok(!/courtbook|booksuite|phase 1/i.test(footerHtml), 'Footer must not expose CourtBook, BookSuite, or Phase 1');

  passed++;
  console.log('✓ Test 2: Navbar & Footer LockaCourt / AratReserve rendering verified');
}

// Test 3: HomePage, VenueDirectory, AuthModal & SupabaseStatusBanner SSR branding
{
  const homeHtml = renderWithProviders(
    React.createElement(HomePage, {
      settings: DEFAULT_FACILITY_SETTINGS,
      onStartBooking: () => {},
      onOpenAdmin: () => {},
      activeReservationsCount: 1,
    })
  );
  assert.ok(homeHtml.includes('LockaCourt'), 'HomePage must display LockaCourt');
  assert.ok(homeHtml.includes('AratReserve'), 'HomePage must credit AratReserve');
  assert.ok(!/courtbook|booksuite/i.test(homeHtml), 'HomePage must not expose CourtBook or BookSuite');

  const dirHtml = renderWithProviders(
    React.createElement(VenueDirectory, {
      facilities: [],
      directoryCourts: [],
      isLoading: true,
      error: null,
      onSelectFacility: () => {},
      onRetry: () => {},
    })
  );
  assert.ok(dirHtml.includes('Fetching venues from LockaCourt directory...'));
  assert.ok(!/courtbook|booksuite/i.test(dirHtml), 'VenueDirectory loading copy must not expose CourtBook/BookSuite');

  const authHtml = renderWithProviders(
    React.createElement(AuthModal, {
      isOpen: true,
      onClose: () => {},
    })
  );
  assert.ok(authHtml.includes('staff@lockacourt.com'), 'AuthModal must use LockaCourt email placeholder');
  assert.ok(!/courtbook|booksuite/i.test(authHtml), 'AuthModal must not expose CourtBook or BookSuite');

  const bannerHtml = renderWithProviders(React.createElement(SupabaseStatusBanner));
  assert.ok(!/courtbook|booksuite/i.test(bannerHtml), 'SupabaseStatusBanner must not expose CourtBook or BookSuite');

  passed++;
  console.log('✓ Test 3: HomePage, VenueDirectory, AuthModal & StatusBanner branding verified');
}

// Test 4: Canonical domain, www normalization, and auth redirect URL resolution
{
  assert.equal(BRAND_NAME, 'LockaCourt');
  assert.equal(PARENT_BUSINESS_NAME, 'AratReserve');
  assert.equal(PARENT_BUSINESS_URL, 'https://aratreserve.com');
  assert.equal(CANONICAL_APP_BASE_URL, 'https://lockacourt.com');

  assert.equal(normalizeAppOrigin('https://www.lockacourt.com/'), 'https://lockacourt.com');
  assert.equal(normalizeAppOrigin('https://lockacourt.com///'), 'https://lockacourt.com');

  const prevEnv = process.env.VITE_APP_BASE_URL;
  try {
    delete process.env.VITE_APP_BASE_URL;
    assert.equal(getAppBaseUrl(), 'https://lockacourt.com');
    assert.equal(getAuthEmailRedirectUrl('/admin'), 'https://lockacourt.com/admin');

    process.env.VITE_APP_BASE_URL = 'https://www.lockacourt.com/';
    assert.equal(getAppBaseUrl(), 'https://lockacourt.com');
    assert.equal(getAuthEmailRedirectUrl('admin'), 'https://lockacourt.com/admin');
  } finally {
    if (prevEnv === undefined) delete process.env.VITE_APP_BASE_URL;
    else process.env.VITE_APP_BASE_URL = prevEnv;
  }

  passed++;
  console.log('✓ Test 4: Canonical domain & auth redirect resolution verified');
}

// Test 5: Customer calendar export, Onboarding Wizard, and BookingPage branding check
{
  const cardSource = fs.readFileSync(
    path.resolve('src/components/booking/BookingConfirmationCard.tsx'),
    'utf8'
  );
  assert.ok(cardSource.includes('PRODID:-//LockaCourt//Customer Booking//EN'));
  assert.ok(cardSource.includes('@lockacourt.com'));
  assert.ok(cardSource.includes('LockaCourt-${details.referenceCode}.ics'));
  assert.ok(!/courtbook|booksuite/i.test(cardSource), 'BookingConfirmationCard must not contain CourtBook/BookSuite');

  const wizardSource = fs.readFileSync(
    path.resolve('src/components/OwnerOnboardingWizard.tsx'),
    'utf8'
  );
  assert.ok(wizardSource.includes('Launch Your LockaCourt Business'));
  assert.ok(wizardSource.includes('lockacourt.com/org/'));
  assert.ok(wizardSource.includes('lockacourt.com/'));
  assert.ok(!/courtbook|booksuite/i.test(wizardSource), 'OwnerOnboardingWizard must not contain CourtBook/BookSuite');

  const bookingPageSource = fs.readFileSync(
    path.resolve('src/components/BookingPage.tsx'),
    'utf8'
  );
  assert.ok(bookingPageSource.includes('recorded in the LockaCourt system'));
  assert.ok(bookingPageSource.includes('Official booking recorded in LockaCourt.'));
  assert.ok(bookingPageSource.includes('recorded in the LockaCourt database.'));

  passed++;
  console.log('✓ Test 5: Calendar export, Onboarding Wizard, and BookingPage copy verified');
}

// Test 6: Internal compatibility & financial/payment invariants preserved
{
  const clientSource = fs.readFileSync(path.resolve('src/lib/supabaseClient.ts'), 'utf8');
  assert.ok(
    clientSource.includes("storageKey: 'courtbook_supabase_auth_token'"),
    'Must preserve existing Supabase auth storageKey to keep live sessions intact'
  );
  assert.ok(
    !clientSource.includes("supabase.rpc('create_booking_checkout_session'"),
    'Must keep insecure direct checkout RPC fallback removed'
  );

  const onboardingSource = fs.readFileSync(path.resolve('src/lib/ownerOnboarding.ts'), 'utf8');
  assert.ok(
    onboardingSource.includes("app_type: 'courtbook'"),
    'Must preserve database schema app_type = courtbook compatibility identifier'
  );

  const tokenSource = fs.readFileSync(
    path.resolve('supabase/functions/_shared/guestLookupToken.ts'),
    'utf8'
  );
  assert.ok(
    tokenSource.includes("const TOKEN_DOMAIN = 'courtbook-guest-lookup-v1'"),
    'Must preserve guest lookup HMAC domain to keep in-flight tokens valid'
  );

  const authCtxSource = fs.readFileSync(
    path.resolve('src/context/SupabaseAuthContext.tsx'),
    'utf8'
  );
  assert.ok(
    authCtxSource.includes('emailRedirectTo: getAuthEmailRedirectUrl'),
    'Supabase Auth signup must specify canonical emailRedirectTo URL'
  );

  passed++;
  console.log('✓ Test 6: Internal DB/auth/token compatibility & checkout security preserved');
}

console.log(`\n======================================================`);
console.log(`ALL ${passed} LOCKACOURT REBRAND & DOMAIN TESTS PASSED!`);
console.log(`======================================================`);
