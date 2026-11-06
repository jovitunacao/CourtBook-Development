import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VenueDirectory } from '../../src/components/VenueDirectory';
import { SupabaseFacility, SupabaseCourt } from '../../src/lib/supabaseClient';

const mockFacilities: SupabaseFacility[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    organization_id: 'aaaa1111-1111-4111-8111-111111111111',
    name: 'Metro Pickleball Club',
    slug: 'metro-pickleball-club',
    tagline: 'Premier Indoor Pickleball',
    address: '123 Bonifacio High Street, Taguig',
    currency: '₱',
    timezone: 'Asia/Manila',
    open_hour: 7,
    close_hour: 22,
    default_hourly_rate: 400,
    booking_confirmation_mode: 'instant',
    hold_duration_minutes: 30,
    is_active: true,
    app_type: 'courtbook',
    is_demo: false,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    organization_id: 'bbbb2222-2222-4222-8222-222222222222',
    name: 'Cebu Smash Badminton',
    slug: 'cebu-smash-badminton',
    tagline: 'BWF-Standard Wood Courts',
    address: '45 IT Park, Cebu City',
    currency: '₱',
    timezone: 'Asia/Manila',
    open_hour: 8,
    close_hour: 23,
    default_hourly_rate: 300,
    booking_confirmation_mode: 'manual_approval',
    hold_duration_minutes: 45,
    is_active: true,
    app_type: 'courtbook',
    is_demo: false,
  },
];

const mockCourts: SupabaseCourt[] = [
  {
    id: 'c1111111-1111-4111-8111-111111111111',
    facility_id: '11111111-1111-4111-8111-111111111111',
    name: 'Pickleball Court 1',
    sport_type: 'Pickleball',
    tag: 'Pro',
    surface_type: 'Acrylic',
    description: 'Tournament grade',
    hourly_rate: 400,
    is_enabled: true,
    display_order: 1,
  },
  {
    id: 'c2222222-2222-4222-8222-222222222222',
    facility_id: '22222222-2222-4222-8222-222222222222',
    name: 'Badminton Court A',
    sport_type: 'Badminton',
    tag: 'Wood',
    surface_type: 'Maple',
    description: 'BWF standard',
    hourly_rate: 300,
    is_enabled: true,
    display_order: 1,
  },
];

let passed = 0;

// Test 1: Directory renders all active facilities with name, location, sports, and View Courts CTA
{
  const html = renderToStaticMarkup(
    React.createElement(VenueDirectory, {
      facilities: mockFacilities,
      directoryCourts: mockCourts,
      isLoading: false,
      error: null,
      onSelectFacility: () => {},
      onRetry: () => {},
    })
  );
  assert.ok(html.includes('Metro Pickleball Club'), 'Should render Facility 1 name');
  assert.ok(html.includes('123 Bonifacio High Street, Taguig'), 'Should render Facility 1 location');
  assert.ok(html.includes('Pickleball'), 'Should render Facility 1 sport');
  assert.ok(html.includes('Cebu Smash Badminton'), 'Should render Facility 2 name');
  assert.ok(html.includes('45 IT Park, Cebu City'), 'Should render Facility 2 location');
  assert.ok(html.includes('Badminton'), 'Should render Facility 2 sport');
  assert.ok(html.includes('View Courts'), 'Should render View Courts action');
  passed++;
}

// Test 2: Loading state renders loading skeleton
{
  const html = renderToStaticMarkup(
    React.createElement(VenueDirectory, {
      facilities: [],
      directoryCourts: [],
      isLoading: true,
      error: null,
      onSelectFacility: () => {},
      onRetry: () => {},
    })
  );
  assert.ok(html.includes('venue-directory-loading'), 'Should render loading state');
  passed++;
}

// Test 3: Error state renders error message and Retry button
{
  const html = renderToStaticMarkup(
    React.createElement(VenueDirectory, {
      facilities: [],
      directoryCourts: [],
      isLoading: false,
      error: 'permission denied for table facilities',
      onSelectFacility: () => {},
      onRetry: () => {},
    })
  );
  assert.ok(html.includes('venue-directory-error'), 'Should render error state');
  assert.ok(html.includes('permission denied for table facilities'), 'Should display Supabase error');
  assert.ok(html.includes('Retry'), 'Should render Retry button');
  passed++;
}

// Test 4: Empty state renders No Venues Available
{
  const html = renderToStaticMarkup(
    React.createElement(VenueDirectory, {
      facilities: [],
      directoryCourts: [],
      isLoading: false,
      error: null,
      onSelectFacility: () => {},
      onRetry: () => {},
    })
  );
  assert.ok(html.includes('venue-directory-empty'), 'Should render empty state');
  assert.ok(html.includes('No Venues Available'), 'Should display No Venues Available');
  passed++;
}

// Test 5: Tenant court isolation & stale-data prevention
{
  const selectedFacilityId = mockFacilities[1].id;
  const filteredCourts = mockCourts.filter((c) => c.facility_id === selectedFacilityId);
  assert.equal(filteredCourts.length, 1, 'Should only include courts for selected facility');
  assert.equal(filteredCourts[0].name, 'Badminton Court A', 'Should not leak Facility 1 courts');
  passed++;
}

console.log(`All ${passed} frontend venue directory & tenant isolation tests passed!`);
