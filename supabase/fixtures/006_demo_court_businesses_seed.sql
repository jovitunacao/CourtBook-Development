-- ==============================================================================
-- CourtBook / BookSuite — Demo Court Businesses Seed Fixture
-- File: supabase/fixtures/006_demo_court_businesses_seed.sql
-- Description:
--   Idempotent seed fixture providing 12 fictional court businesses across
--   Luzon, Visayas, and Mindanao (3 courts each = 36 demo courts total).
--
-- Safety Guarantees:
--   - STRICTLY FOR TESTING & DEMONSTRATION PURPOSES ONLY.
--   - All organizations and facilities have is_demo = true.
--   - Strict tenant isolation: Each business is in its own organization.
--   - Deterministic UUIDs and unique slugs ensure safe repeated execution without duplicates.
--   - No fake bookings, payments, or ledger records are inserted.
--   - Addresses match Philippine location hierarchy in philippineLocations.ts.
--   - Includes read-only verification queries and a clean demo-only teardown routine.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. Fictional Organizations (12 Distinct Tenants)
-- ------------------------------------------------------------------------------

INSERT INTO public.organizations (id, name, slug, billing_email, is_demo)
VALUES
  -- Luzon
  ('d0000001-0000-4000-8000-000000000001', 'Apex Sports Club QC [DEMO]', 'demo-apex-sports-qc', 'billing@demo-apex-qc.courtbook.ph', true),
  ('d0000001-0000-4000-8000-000000000002', 'Salcedo Athletic Group [DEMO]', 'demo-salcedo-athletic-makati', 'billing@demo-salcedo-makati.courtbook.ph', true),
  ('d0000001-0000-4000-8000-000000000003', 'Pine Valley Athletics [DEMO]', 'demo-pine-valley-baguio', 'billing@demo-pine-baguio.courtbook.ph', true),
  ('d0000001-0000-4000-8000-000000000004', 'Nuvali Sports Ventures [DEMO]', 'demo-nuvali-sports-laguna', 'billing@demo-nuvali-laguna.courtbook.ph', true),
  -- Visayas
  ('d0000001-0000-4000-8000-000000000005', 'Sugbo Smash Sports [DEMO]', 'demo-sugbo-smash-cebu', 'billing@demo-sugbo-cebu.courtbook.ph', true),
  ('d0000001-0000-4000-8000-000000000006', 'Metro Mandaue Racquet Facilities [DEMO]', 'demo-metro-mandaue-racquet', 'billing@demo-mandaue.courtbook.ph', true),
  ('d0000001-0000-4000-8000-000000000007', 'Iloilo Riverview Sports Club [DEMO]', 'demo-iloilo-riverview-sports', 'billing@demo-iloilo.courtbook.ph', true),
  ('d0000001-0000-4000-8000-000000000008', 'Negros Champion Arena [DEMO]', 'demo-negros-champion-arena', 'billing@demo-bacolod.courtbook.ph', true),
  -- Mindanao
  ('d0000001-0000-4000-8000-000000000009', 'Hermosa Sports Club [DEMO]', 'demo-hermosa-sports-zamboanga', 'billing@demo-zamboanga.courtbook.ph', true),
  ('d0000001-0000-4000-8000-000000000010', 'Mount Apo Sports Club [DEMO]', 'demo-mount-apo-sports-davao', 'billing@demo-davao.courtbook.ph', true),
  ('d0000001-0000-4000-8000-000000000011', 'Golden Friendship Athletic Club [DEMO]', 'demo-golden-friendship-cdo', 'billing@demo-cdo.courtbook.ph', true),
  ('d0000001-0000-4000-8000-000000000012', 'Maria Cristina Racquet Club [DEMO]', 'demo-maria-cristina-iligan', 'billing@demo-iligan.courtbook.ph', true)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    billing_email = EXCLUDED.billing_email,
    is_demo = true,
    updated_at = now();

-- ------------------------------------------------------------------------------
-- 2. Fictional Facilities (12 Venues with Complete Philippine Addresses)
-- ------------------------------------------------------------------------------

INSERT INTO public.facilities (
  id, organization_id, app_type, name, slug, tagline, address,
  timezone, currency, open_hour, close_hour, default_hourly_rate,
  booking_confirmation_mode, hold_duration_minutes, is_active, is_demo
)
VALUES
  -- 1. Quezon City, Metro Manila
  (
    'd0000002-0000-4000-8000-000000000001', 'd0000001-0000-4000-8000-000000000001', 'courtbook',
    'Apex Pickleball & Racquet Hub', 'demo-apex-pickleball-qc',
    'Covered pickleball, badminton and squash courts in Diliman',
    '45 Commonwealth Ave, Diliman, Quezon City, Metro Manila',
    'Asia/Manila', '₱', 7, 23, 400.00, 'instant', 15, true, true
  ),
  -- 2. Makati City, Metro Manila
  (
    'd0000002-0000-4000-8000-000000000002', 'd0000001-0000-4000-8000-000000000002', 'courtbook',
    'Salcedo Padel & Racquet Club', 'demo-salcedo-padel-makati',
    'Boutique padel and tennis club in central Makati CBD',
    '120 Tordesillas St, Salcedo Village, Makati City, Metro Manila',
    'Asia/Manila', '₱', 6, 23, 550.00, 'instant', 15, true, true
  ),
  -- 3. Baguio City, Benguet
  (
    'd0000002-0000-4000-8000-000000000003', 'd0000001-0000-4000-8000-000000000003', 'courtbook',
    'Pine Valley Tennis & Sports Pavilion', 'demo-pine-valley-tennis-baguio',
    'High-altitude mountain tennis and pickleball play in Baguio',
    '88 Kennon Road, Camp 7, Baguio City, Benguet',
    'Asia/Manila', '₱', 7, 21, 450.00, 'instant', 15, true, true
  ),
  -- 4. Santa Rosa City, Laguna
  (
    'd0000002-0000-4000-8000-000000000004', 'd0000001-0000-4000-8000-000000000004', 'courtbook',
    'Nuvali Multi-Sport Arena', 'demo-nuvali-multisport-arena',
    'Modern sports facility with hardwood basketball and volleyball courts',
    'Evo City Blvd, Nuvali, Santa Rosa City, Laguna',
    'Asia/Manila', '₱', 6, 22, 500.00, 'instant', 15, true, true
  ),
  -- 5. Cebu City, Cebu
  (
    'd0000002-0000-4000-8000-000000000005', 'd0000001-0000-4000-8000-000000000005', 'courtbook',
    'Sugbo Smash Pickleball & Badminton Dome', 'demo-sugbo-smash-dome-cebu',
    'Cebu premier indoor racquet hub near Cebu IT Park',
    'Salinas Drive, Lahug (IT Park), Cebu City, Cebu',
    'Asia/Manila', '₱', 7, 24, 420.00, 'instant', 15, true, true
  ),
  -- 6. Mandaue City, Cebu
  (
    'd0000002-0000-4000-8000-000000000006', 'd0000001-0000-4000-8000-000000000006', 'courtbook',
    'Metro Mandaue Racquet Center', 'demo-metro-mandaue-center',
    'Dedicated indoor badminton, tennis and squash courts',
    'A.C. Cortes Ave, Subangdaku, Mandaue City, Cebu',
    'Asia/Manila', '₱', 8, 22, 380.00, 'instant', 15, true, true
  ),
  -- 7. Iloilo City, Iloilo
  (
    'd0000002-0000-4000-8000-000000000007', 'd0000001-0000-4000-8000-000000000007', 'courtbook',
    'Iloilo Riverview Sports Complex', 'demo-iloilo-riverview-complex',
    'Spacious sports venue at Megaworld Iloilo Business Park',
    'Megaworld Blvd, Mandurriao (Megaworld), Iloilo City, Iloilo',
    'Asia/Manila', '₱', 6, 22, 420.00, 'instant', 15, true, true
  ),
  -- 8. Bacolod City, Negros Occidental
  (
    'd0000002-0000-4000-8000-000000000008', 'd0000001-0000-4000-8000-000000000008', 'courtbook',
    'Negros Champion Sports Arena', 'demo-negros-champion-sports',
    'City of Smiles hub for badminton, volleyball, and pickleball',
    'Lacson St, Mandalagan, Bacolod City, Negros Occidental',
    'Asia/Manila', '₱', 7, 23, 350.00, 'instant', 15, true, true
  ),
  -- 9. Zamboanga City, Zamboanga del Sur
  (
    'd0000002-0000-4000-8000-000000000009', 'd0000001-0000-4000-8000-000000000009', 'courtbook',
    'Hermosa Racquet Club', 'demo-hermosa-racquet-zamboanga',
    'Zamboanga premier tennis, badminton and pickleball destination',
    'Gov. Ramos Ave, Tetuan, Zamboanga City, Zamboanga del Sur',
    'Asia/Manila', '₱', 7, 22, 350.00, 'instant', 15, true, true
  ),
  -- 10. Davao City, Davao del Sur
  (
    'd0000002-0000-4000-8000-000000000010', 'd0000001-0000-4000-8000-000000000010', 'courtbook',
    'Mount Apo Sports & Fitness Dome', 'demo-mount-apo-dome-davao',
    'World-class indoor padel, pickleball and basketball courts in Matina',
    'Quimpo Blvd, Matina, Davao City, Davao del Sur',
    'Asia/Manila', '₱', 6, 23, 480.00, 'instant', 15, true, true
  ),
  -- 11. Cagayan de Oro City, Misamis Oriental
  (
    'd0000002-0000-4000-8000-000000000011', 'd0000001-0000-4000-8000-000000000011', 'courtbook',
    'Golden Friendship Athletic Club', 'demo-golden-friendship-facility-cdo',
    'Modern athletic courts in the heart of Cagayan de Oro',
    'Tibasak St, Macasandig, Cagayan de Oro City, Misamis Oriental',
    'Asia/Manila', '₱', 7, 22, 380.00, 'instant', 15, true, true
  ),
  -- 12. Iligan City, Lanao del Norte
  (
    'd0000002-0000-4000-8000-000000000012', 'd0000001-0000-4000-8000-000000000012', 'courtbook',
    'Maria Cristina Racquet & Court Park', 'demo-maria-cristina-court-iligan',
    'Scenic athletic park with pickleball, badminton and squash courts',
    'National Highway, Tubod, Iligan City, Lanao del Norte',
    'Asia/Manila', '₱', 7, 21, 340.00, 'instant', 15, true, true
  )
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    tagline = EXCLUDED.tagline,
    address = EXCLUDED.address,
    timezone = EXCLUDED.timezone,
    currency = EXCLUDED.currency,
    open_hour = EXCLUDED.open_hour,
    close_hour = EXCLUDED.close_hour,
    default_hourly_rate = EXCLUDED.default_hourly_rate,
    booking_confirmation_mode = EXCLUDED.booking_confirmation_mode,
    hold_duration_minutes = EXCLUDED.hold_duration_minutes,
    is_active = true,
    is_demo = true,
    updated_at = now();

-- ------------------------------------------------------------------------------
-- 3. Fictional Courts (36 Courts: 3 per Facility)
-- ------------------------------------------------------------------------------

INSERT INTO public.courts (
  id, facility_id, name, sport_type, tag, surface_type, description, hourly_rate, is_enabled, display_order
)
VALUES
  -- Venue 1: Apex Pickleball & Racquet Hub (QC)
  ('d0000003-0000-4000-8000-000000000001', 'd0000002-0000-4000-8000-000000000001', 'Championship Pickleball Court', 'Pickleball', 'Indoor AC', 'Cushioned Acrylic Hardcourt', 'Tournament regulation pickleball court with climate control and premium LED lighting.', 400.00, true, 1),
  ('d0000003-0000-4000-8000-000000000002', 'd0000002-0000-4000-8000-000000000001', 'Badminton Court A', 'Badminton', 'Taraflex', 'BWF Grade Vinyl Mat', 'Shock-absorbing green vinyl mat with official BWF net height and anti-glare luminaires.', 350.00, true, 2),
  ('d0000003-0000-4000-8000-000000000003', 'd0000002-0000-4000-8000-000000000001', 'Squash Court 1', 'Squash', 'Glass Back', 'Standard Maple Hardwood', 'International singles squash court with glass rear wall and acoustic sound dampening.', 450.00, true, 3),

  -- Venue 2: Salcedo Padel & Racquet Club (Makati)
  ('d0000003-0000-4000-8000-000000000004', 'd0000002-0000-4000-8000-000000000002', 'Panoramic Padel Court 1', 'Padel', 'Panoramic Glass', 'Textured Monofilament Turf', 'Full panoramic 12mm tempered glass padel court with official silica infill turf.', 600.00, true, 1),
  ('d0000003-0000-4000-8000-000000000005', 'd0000002-0000-4000-8000-000000000002', 'Center Tennis Court', 'Tennis', 'Covered Pro', 'DecoTurf Tournament Surface', 'Medium-fast tournament tennis court sheltered from sudden tropical downpours.', 550.00, true, 2),
  ('d0000003-0000-4000-8000-000000000006', 'd0000002-0000-4000-8000-000000000002', 'Pickleball Court Alpha', 'Pickleball', 'LED Lit', 'Sport Court Modular Tile', 'All-weather modular surface with low-joint impact for recreational and competitive games.', 450.00, true, 3),

  -- Venue 3: Pine Valley Tennis & Sports Pavilion (Baguio)
  ('d0000003-0000-4000-8000-000000000007', 'd0000002-0000-4000-8000-000000000003', 'Pine View Tennis Court', 'Tennis', 'Red Clay', 'Engineered Italian Red Clay', 'Authentic slow-playing red clay court surrounded by mountain pine trees and fresh air.', 500.00, true, 1),
  ('d0000003-0000-4000-8000-000000000008', 'd0000002-0000-4000-8000-000000000003', 'Pavilion Badminton Court', 'Badminton', 'Indoor Timber', 'Spring Hardwood Flooring', 'High-resilience hardwood court ideal for fast rallies and joint comfort.', 380.00, true, 2),
  ('d0000003-0000-4000-8000-000000000009', 'd0000002-0000-4000-8000-000000000003', 'Baguio Pickleball Court', 'Pickleball', 'All-Weather', 'All-Weather Acrylic Surface', 'Scenic outdoor court designed for high-altitude pickleball enthusiast matches.', 420.00, true, 3),

  -- Venue 4: Nuvali Multi-Sport Arena (Santa Rosa, Laguna)
  ('d0000003-0000-4000-8000-000000000010', 'd0000002-0000-4000-8000-000000000004', 'Arena Basketball Court', 'Basketball', 'FIBA Grade', 'Select North American Maple', 'Professional standard full-court basketball with spring-loaded breakaway rims.', 750.00, true, 1),
  ('d0000003-0000-4000-8000-000000000011', 'd0000002-0000-4000-8000-000000000004', 'Volleyball Court 1', 'Volleyball', 'Indoor Pro', 'Shock-Absorbing Polyurethane', 'Seamless sports polyurethane flooring equipped with Senoh tournament net system.', 500.00, true, 2),
  ('d0000003-0000-4000-8000-000000000012', 'd0000002-0000-4000-8000-000000000004', 'Laguna Badminton Court', 'Badminton', 'Air Conditioned', 'Enviro-cushion Taraflex', 'Full indoor air-conditioned court with dedicated spectator seating and lockers.', 380.00, true, 3),

  -- Venue 5: Sugbo Smash Pickleball & Badminton Dome (Cebu City)
  ('d0000003-0000-4000-8000-000000000013', 'd0000002-0000-4000-8000-000000000005', 'Sinulog Pickleball Court', 'Pickleball', 'Championship', 'Plexicushion Tournament Mat', 'Official tournament pickleball court with high contrast borders for crisp tracking.', 450.00, true, 1),
  ('d0000003-0000-4000-8000-000000000014', 'd0000002-0000-4000-8000-000000000005', 'IT Park Badminton Court', 'Badminton', 'Anti-Glare LED', 'Pro BWF Vinyl Floor', 'Conveniently located 2 minutes from IT Park for after-work and weekend badminton games.', 380.00, true, 2),
  ('d0000003-0000-4000-8000-000000000015', 'd0000002-0000-4000-8000-000000000005', 'Queen City Padel Court', 'Padel', 'Panoramic Glass', 'Mondo Supercourt Padel Turf', 'Cebu first panoramic indoor padel court with world-class turf consistency.', 580.00, true, 3),

  -- Venue 6: Metro Mandaue Racquet Center (Mandaue City)
  ('d0000003-0000-4000-8000-000000000016', 'd0000002-0000-4000-8000-000000000006', 'Mandaue Badminton Court 1', 'Badminton', 'Tournament Mat', 'Green BWF Certified Vinyl', 'Dedicated singles and doubles court with ample side clearance and tournament nets.', 350.00, true, 1),
  ('d0000003-0000-4000-8000-000000000017', 'd0000002-0000-4000-8000-000000000006', 'Subangdaku Tennis Court', 'Tennis', 'Covered', 'Hardcourt Acrylic Surface', 'Covered tennis facility designed to prevent sun glare and high midday heat.', 480.00, true, 2),
  ('d0000003-0000-4000-8000-000000000018', 'd0000002-0000-4000-8000-000000000006', 'Squash Box A', 'Squash', 'ASRA Approved', 'Solid Beech Strip Flooring', 'Solid plaster court walls with precision tin line sensors and viewing gallery.', 400.00, true, 3),

  -- Venue 7: Iloilo Riverview Sports Complex (Iloilo City)
  ('d0000003-0000-4000-8000-000000000019', 'd0000002-0000-4000-8000-000000000007', 'Riverview Tennis Court', 'Tennis', 'Outdoor Floodlit', 'Laykold Master Surface', 'Floodlit hard court overlooking the Iloilo river esplanade.', 450.00, true, 1),
  ('d0000003-0000-4000-8000-000000000020', 'd0000002-0000-4000-8000-000000000007', 'Ilonggo Pickleball Court', 'Pickleball', 'Covered Pro', 'Cushioned Polyurethane', 'Modern covered court with responsive bounce characteristics.', 380.00, true, 2),
  ('d0000003-0000-4000-8000-000000000021', 'd0000002-0000-4000-8000-000000000007', 'Dinagyang Basketball Court', 'Basketball', 'Indoor Court', 'Standard Maple Hardwood', 'High ceiling indoor basketball arena with scoreboards and clean shower rooms.', 650.00, true, 3),

  -- Venue 8: Negros Champion Sports Arena (Bacolod City)
  ('d0000003-0000-4000-8000-000000000022', 'd0000002-0000-4000-8000-000000000008', 'MassKara Badminton Court', 'Badminton', 'Indoor AC', 'Taraflex Olympic Mat', 'Air-conditioned badminton court with comfortable seating and cold hydration station.', 360.00, true, 1),
  ('d0000003-0000-4000-8000-000000000023', 'd0000002-0000-4000-8000-000000000008', 'Spikers Volleyball Court', 'Volleyball', 'High Ceiling', 'Shock Absorption Timber', 'Wide volleyball court suitable for club leagues and weekend pick-up tournaments.', 480.00, true, 2),
  ('d0000003-0000-4000-8000-000000000024', 'd0000002-0000-4000-8000-000000000008', 'Sugarland Pickleball Court', 'Pickleball', 'All-Weather', 'Fast-Dry Coated Acrylic', 'Fast-drying outdoor pickleball court engineered for quick recovery after rain showers.', 380.00, true, 3),

  -- Venue 9: Hermosa Racquet Club (Zamboanga City)
  ('d0000003-0000-4000-8000-000000000025', 'd0000002-0000-4000-8000-000000000009', 'Hermosa Tennis Court', 'Tennis', 'Covered Pro', 'Hardcourt Acrylic', 'Covered tennis court sheltered from strong coastal sun in Tetuan.', 420.00, true, 1),
  ('d0000003-0000-4000-8000-000000000026', 'd0000002-0000-4000-8000-000000000009', 'Chavacano Pickleball Court', 'Pickleball', 'LED Lights', 'Multi-layer Cushion Turf', 'Family-friendly pickleball court with dedicated equipment rental counter.', 350.00, true, 2),
  ('d0000003-0000-4000-8000-000000000027', 'd0000002-0000-4000-8000-000000000009', 'Tetuan Badminton Court', 'Badminton', 'Vinyl Mat', 'BWF Certified Non-Slip Mat', 'Reliable indoor court with excellent foot traction and high-density foam backing.', 320.00, true, 3),

  -- Venue 10: Mount Apo Sports & Fitness Dome (Davao City)
  ('d0000003-0000-4000-8000-000000000028', 'd0000002-0000-4000-8000-000000000010', 'Durian City Pickleball Court', 'Pickleball', 'Championship AC', 'Plexipave Cushion Hardcourt', 'Modern air-conditioned pickleball facility located along Quimpo Boulevard.', 450.00, true, 1),
  ('d0000003-0000-4000-8000-000000000029', 'd0000002-0000-4000-8000-000000000010', 'Davao Padel Court 1', 'Padel', 'Panoramic Glass', 'Mondo Texturized Turf', 'Premier padel installation with high-transparency glass panels and pro-level nets.', 600.00, true, 2),
  ('d0000003-0000-4000-8000-000000000030', 'd0000002-0000-4000-8000-000000000010', 'King of Courts Basketball', 'Basketball', 'Hardwood Floor', 'FIBA Approved Timber', 'Full-sized hardwood court with electronic shot clock and digital scoreboard.', 700.00, true, 3),

  -- Venue 11: Golden Friendship Athletic Club (Cagayan de Oro City)
  ('d0000003-0000-4000-8000-000000000031', 'd0000002-0000-4000-8000-000000000011', 'Highland Badminton Court', 'Badminton', 'Taraflex Pro', 'Green Sports Vinyl Mat', 'Spacious green badminton mat with excellent anti-slip surface and ceiling ventilation.', 350.00, true, 1),
  ('d0000003-0000-4000-8000-000000000032', 'd0000002-0000-4000-8000-000000000011', 'CDO Tennis Center Court', 'Tennis', 'Covered Lit', 'All-Weather Acrylic', 'Well-maintained tennis court with true ball bounce and low glare night lights.', 460.00, true, 2),
  ('d0000003-0000-4000-8000-000000000033', 'd0000002-0000-4000-8000-000000000011', 'Golden Volleyball Court', 'Volleyball', 'Indoor Pro', 'Elastic Polyurethane Floor', 'Multi-purpose indoor volleyball court with official antenna and boundary markers.', 450.00, true, 3),

  -- Venue 12: Maria Cristina Racquet & Court Park (Iligan City)
  ('d0000003-0000-4000-8000-000000000034', 'd0000002-0000-4000-8000-000000000012', 'Waterfalls Pickleball Court', 'Pickleball', 'Covered Court', 'Cushioned Hardcourt', 'Sheltered court surrounded by tropical greenery in Tubod, Iligan.', 350.00, true, 1),
  ('d0000003-0000-4000-8000-000000000035', 'd0000002-0000-4000-8000-000000000012', 'Iligan Badminton Court 1', 'Badminton', 'Anti-Slip', 'Commercial Vinyl Mat', 'Clean, well-lit badminton court with welcoming staff and fresh beverage corner.', 320.00, true, 2),
  ('d0000003-0000-4000-8000-000000000036', 'd0000002-0000-4000-8000-000000000012', 'Tubod Squash Court', 'Squash', 'Standard Court', 'Parquet Maple Hardwood', 'Classic maple floor squash box equipped with glass spectator rear wall.', 380.00, true, 3)
ON CONFLICT (facility_id, name) DO UPDATE
SET sport_type = EXCLUDED.sport_type,
    tag = EXCLUDED.tag,
    surface_type = EXCLUDED.surface_type,
    description = EXCLUDED.description,
    hourly_rate = EXCLUDED.hourly_rate,
    is_enabled = true,
    display_order = EXCLUDED.display_order,
    updated_at = now();

COMMIT;

-- ==============================================================================
-- 4. Read-Only Verification Queries
-- ==============================================================================

-- 4.1 Verify exactly 12 demo facilities exist and all are marked is_demo = true
SELECT
  f.id AS facility_id,
  f.name AS facility_name,
  f.address,
  f.default_hourly_rate,
  f.is_demo,
  o.slug AS org_slug,
  COUNT(c.id) AS court_count
FROM public.facilities f
JOIN public.organizations o ON o.id = f.organization_id
LEFT JOIN public.courts c ON c.facility_id = f.id
WHERE f.is_demo = true
GROUP BY f.id, f.name, f.address, f.default_hourly_rate, f.is_demo, o.slug
ORDER BY f.name;

-- 4.2 Verify exactly 36 demo courts across all 7 sports
SELECT
  sport_type,
  COUNT(*) AS court_count,
  MIN(hourly_rate) AS min_rate,
  MAX(hourly_rate) AS max_rate
FROM public.courts
WHERE facility_id IN (SELECT id FROM public.facilities WHERE is_demo = true)
GROUP BY sport_type
ORDER BY court_count DESC;

-- ==============================================================================
-- 5. Safe Demo-Only Cleanup Procedure
-- (Use this block to safely remove all demo data without touching real data)
-- ==============================================================================
/*
BEGIN;
DELETE FROM public.courts
WHERE facility_id IN (
  SELECT id FROM public.facilities
  WHERE is_demo = true AND slug LIKE 'demo-%'
);

DELETE FROM public.facilities
WHERE is_demo = true AND slug LIKE 'demo-%';

DELETE FROM public.organizations
WHERE is_demo = true AND slug LIKE 'demo-%';
COMMIT;
*/
