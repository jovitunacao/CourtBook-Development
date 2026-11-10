# Phase 5.1: Customer Booking Experience & Application Integration Architecture Plan

## Executive Summary
Phase 5 integrates CourtBook's audited, multi-tenant financial backend (Phases 1–4.2.5) into a modern, mobile-first, conversion-focused customer booking experience. Customers can seamlessly discover sports venues across the Philippines, view live court availability in the `Asia/Manila` timezone, reserve slots with temporary anti-collision holds, and checkout as guests using PayMongo (GCash, Maya, cards, bank transfer) without mandatory registration.

---

## 1. Architectural Alignment & Safety Principles
1. **Strict Immutability of Financial Core**: Migrations `001` through `005d` remain 100% untouched. All ledger entries, 5% platform commission calculation, settlement journals, and audit views are preserved without modification.
2. **Server-Authoritative Pricing & Hold Expiration**: Client code never calculates or submits final booking prices, commission amounts, or hold durations. All monetary amounts and collision-prevention holds are calculated and enforced by `create_booking_checkout_session` (PostgreSQL procedure) and the `create-checkout-session` Edge Function.
3. **Pure Guest Checkout**: No login or user account creation is required for customers. Authentication is strictly reserved for facility owners and staff accessing the portal.
4. **Philippine Geographic & Timezone Standards**: All calendar dates, opening hours, and slot collision bounds are pegged strictly to `Asia/Manila` (PHT, UTC+8). The location search hierarchy follows standard Philippine Administrative Regions, Provinces, Cities/Municipalities, and Barangays.
5. **Multi-Tenant Isolation**: Public customer queries are strictly partitioned by `facility_id` and `organization_id`. Cross-tenant slot queries or bookings are physically blocked by existing composite foreign keys and database constraints.

---

## 2. Component & System Audit: Reuse vs. New Deliverables

### A. Existing Components to Reuse
| Component / Module | Path | Reuse Strategy |
| :--- | :--- | :--- |
| **Idempotent Checkout Procedure** | `supabase/migrations/005c_booking_payment_integration.sql` | Direct reuse via `create_booking_checkout_session`. Computes exact 5% commission, locks slot with GiST exclusion hold, creates pending payment record. |
| **Checkout Edge Function** | `supabase/functions/create-checkout-session/index.ts` | Direct endpoint for client checkout invocation; handles PayMongo session creation and idempotency replay. |
| **Payment Webhook Function** | `supabase/functions/payment-webhook/index.ts` | Authoritative webhook receiver; confirms reservations upon payment capture, posts double-entry settlement journal. |
| **Live Court Status RPC** | `supabase/migrations/002_secure_reservation_operations.sql` | `check_court_booking_status` and `get_court_busy_slots` for real-time slot availability. |
| **PayMongo Adapter & Types** | `src/lib/payments/*` | Client/server typed contracts for checkout sessions and webhook payloads. |
| **Supabase Auth & Context** | `src/context/SupabaseAuthContext.tsx` | Provides `publicFacilities`, `publicCourts`, and `activePublicFacility` with caching and multi-tenant isolation. |
| **Design System Tokens** | `src/index.css` | Tailwind v4 styling with clean typography, slate borders, and responsive mobile utilities. |

### B. New Components & Enhancements Required for Phase 5
| New Module | Planned Location | Responsibility |
| :--- | :--- | :--- |
| **Philippine Location Selector** | `src/components/booking/LocationCascadeSelector.tsx` | Region -> Province -> City/Municipality -> Barangay cascading filter with instant search. |
| **Philippine Geo Data Store** | `src/data/philippineLocations.ts` | Lightweight, static, curated Philippine geography dataset (Metro Manila, Cebu, Davao, Central Luzon, Calabarzon, etc.). |
| **Sport Category Selector** | `src/components/booking/SportCategoryPills.tsx` | Visual sport selector (Pickleball, Badminton, Tennis, Basketball, Padel, Volleyball) with icon badges and court counts. |
| **Enhanced Venue Discovery** | `src/components/booking/VenueDirectoryCard.tsx` | Rich facility card with photos, pricing range ("From ₱350/hr"), address, distance, operating hours, and amenities badges. |
| **Interactive Stepper Controller** | `src/components/booking/CustomerBookingFlow.tsx` | 8-step guided booking wizard with progress bar, state persistence, back navigation, and mobile bottom bar. |
| **Court & Slot Schedule Matrix** | `src/components/booking/SlotMatrixPicker.tsx` | Visual date picker + time grid with real-time busy indicators, duration selector (30m to 480m), and live hold countdown. |
| **Guest Checkout Form** | `src/components/booking/GuestCheckoutForm.tsx` | Minimal contact capture (Name, +63 Phone, Email) + transparent itemized fee breakdown (100% transparent pricing). |
| **PayMongo Checkout Bridge** | `src/components/booking/PaymentCheckoutBridge.tsx` | Submits checkout session, renders loading overlay, handles redirect to GCash/Maya/Card, or simulates in test mode. |
| **Booking Confirmation Pass** | `src/components/booking/BookingConfirmationCard.tsx` | High-fidelity confirmation ticket with Reference Code, venue directions, calendar export (.ics), and booking summary. |

---

## 3. Approved 8-Step Customer Flow Specification

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                        COURTBOOK CUSTOMER BOOKING FLOW                            │
└───────────────────────────────────────────────────────────────────────────────────┘
   Step 1: Click "Book a Court"
     │  (CTA on Navbar, Hero, or Direct Venue Link)
     ▼
   Step 2: Choose Sport
     │  [ Pickleball ]  [ Badminton ]  [ Tennis ]  [ Padel ]  [ Basketball ]
     ▼
   Step 3: Choose Location (Philippine Geographic Hierarchy)
     │  Region ──► Province ──► City / Municipality ──► Barangay (Search filter)
     ▼
   Step 4: Browse Available Court Businesses
     │  Photo Gallery • Amenities • Pricing "From ₱X/hr" • Distance • Open Hours
     ▼
   Step 5: Select Court, Booking Date & Available Time Slot
     │  Date Picker (Asia/Manila) ──► Court Selection ──► Time Slot Grid (Busy/Open)
     │  [Hold Slot: 15-Minute GiST Exclusion Lock via create_booking_checkout_session]
     ▼
   Step 6: Enter Minimal Personal Details (Guest Checkout)
     │  Full Name • Philippine Mobile (+63 9XX...) • Email (for receipt/pass)
     │  No Account Creation Required • Transparent Price Summary
     ▼
   Step 7: Complete Payment
     │  Redirect to PayMongo Hosted Checkout (GCash / Maya / Card / Online Bank)
     │  Webhook verifies payment ──► DB captures payment & creates confirmed booking
     ▼
   Step 8: Receive Booking Confirmation
        Digital Booking Pass • Ref Code • Add to Calendar (.ics) • Venue Location Map
```

---

## 4. Phase 5 Implementation Roadmap & Stage Gates

### Stage 5.1: Architecture, Data Models & Philippine Location Engine
- **Deliverables**:
  1. Curated Philippine Administrative Geography dataset (`philippineLocations.ts`).
  2. Location cascade hook and search filter (`usePhilippineLocation.ts`).
  3. Extended facility metadata types (`amenities`, `photos`, `operating_rules`).
- **Dependencies**: Static frontend data, zero schema modifications.
- **Verification Gate**: Location search and cascade unit tests pass with 100% deterministic coverage.

### Stage 5.2: Enhanced Venue Directory & Sport Categorization UI
- **Deliverables**:
  1. Sport selection pill carousel with live court count per sport.
  2. Modernized Venue Directory with rich venue cards, photo carousels, amenity tags (Indoor/Outdoor, Aircon, Parking, Pro Shop, Showers), and transparent pricing.
  3. Location + Sport combined filtering engine with clean URL sync.
- **Dependencies**: Stage 5.1 location engine.
- **Verification Gate**: Directory filtering correctly filters multi-tenant facilities by sport and location; zero cross-tenant leakage.

### Stage 5.3: Interactive Court, Date & Slot Matrix with Hold Countdown
- **Deliverables**:
  1. Timezone-locked calendar selector (`Asia/Manila`).
  2. Visual time slot matrix with color-coded availability (`Open`, `Held`, `Reserved`, `Maintenance`).
  3. Flexible duration selection (30m, 60m, 90m, 120m) matching `create_booking_checkout_session` bounds.
  4. Real-time slot status polling with automatic hold expiry timers.
- **Dependencies**: Stage 5.2 venue selection, `get_court_busy_slots` RPC.
- **Verification Gate**: Concurrent slot reservation attempts strictly respect GiST exclusion holds without false double-bookings.

### Stage 5.4: Guest Checkout Form & Server-Authoritative Fee Breakdown
- **Deliverables**:
  1. Minimal guest checkout form with Philippine phone input formatting (`+63 9XX XXX XXXX`) and email validation.
  2. Server-authoritative fee preview: Court Rate × Duration = Total (displaying 100% transparent pricing without hidden checkout surcharges).
  3. Client-side idempotency key generator (UUIDv4 / crypto-random 32-char hex).
  4. Anti-abuse rate-limit guard handling (detecting burst limits gracefully with friendly messages).
- **Dependencies**: Stage 5.3 slot selection.
- **Verification Gate**: Client validation blocks invalid phone/email; price preview strictly matches server-side rate calculations.

### Stage 5.5: PayMongo Checkout Integration & Webhook Lifecycle
- **Deliverables**:
  1. Frontend checkout session caller (`createCheckoutSession` in `supabaseClient.ts`).
  2. Hosted checkout redirection to PayMongo (GCash, Maya, cards, bank transfer).
  3. Polling and return URL listener for payment confirmation.
  4. Webhook reconciliation safety (handles simulated test mode and live webhook processing).
- **Dependencies**: Stage 5.4 guest form, `supabase/functions/create-checkout-session`.
- **Verification Gate**: End-to-end checkout initiates PayMongo session, reserves slot in database, captures payment upon webhook, and posts balanced journal entries.

### Stage 5.6: Digital Booking Confirmation Pass & Post-Booking Actions
- **Deliverables**:
  1. Mobile-optimized digital booking pass with Reference Code (`CB-XXXXXX`), court details, and verification badge.
  2. Calendar export (`.ics` generation for Apple Calendar, Google Calendar, Outlook).
  3. Direct venue navigation link (Google Maps / Waze deep link using venue coordinates/address).
  4. Instant booking lookup by Reference Code + Phone for returning guests.
- **Dependencies**: Stage 5.5 successful booking completion.
- **Verification Gate**: Pass renders all authoritative reservation fields; calendar export downloads valid `.ics` format.

---

## 5. Security, Concurrency & Tenant Isolation Checklist
- [x] **No Secret Key Exposure**: PayMongo secret keys and Supabase `service_role` keys remain strictly inside Edge Functions. The browser client uses only `anon`/publishable keys.
- [x] **Zero Financial Core Alteration**: No modifications to migrations `001` through `005d`.
- [x] **Tenant Separation**: Facilities belonging to different organizations are rendered in separate venue cards. Public queries never allow cross-tenant booking or balance aggregation.
- [x] **Double-Booking Prevention**: Database exclusion constraint `prevent_court_overlapping_active_reservations` physically prevents double-booking across both `pending` (held) and `confirmed` bookings.
- [x] **Zero Mock Assumptions**: All payment flows invoke genuine Edge Functions and official PayMongo schemas.

---

## 6. Review & Approval Decision Points
1. **Approval of the 8-Step Customer Flow**: Confirm the sequence matches CourtBook's business and product goals.
2. **Review of Philippine Location Hierarchy Strategy**: Static curated dataset vs. external PSGC API.
3. **Approval of Stage Gates 5.1 through 5.6**: Formal sign-off before any frontend or integration coding commences.
