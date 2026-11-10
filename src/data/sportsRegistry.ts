// ==============================================================================
// CourtBook / BookSuite — Sports Category Registry & Taxonomy
// File: src/data/sportsRegistry.ts
// ==============================================================================

export interface SportDefinition {
  id: string;
  name: string;
  tagline: string;
  iconName: string;
  standardDurationMinutes: number;
  popularSurfaces: string[];
  bannerUrl: string;
}

export const SPORTS_REGISTRY: SportDefinition[] = [
  {
    id: 'pickleball',
    name: 'Pickleball',
    tagline: 'Fast-paced, dynamic racket sport for doubles and singles play',
    iconName: 'Activity',
    standardDurationMinutes: 60,
    popularSurfaces: ['Cushioned Acrylic', 'Pro Modular Tiles', 'Indoor Hardwood'],
    bannerUrl: 'https://images.unsplash.com/photo-1599474924187-334a4ae5bd3c?auto=format&fit=crop&w=800&q=80',
  },
  {
    id: 'badminton',
    name: 'Badminton',
    tagline: 'High-speed Olympic shuttlecock sport with professional vinyl matting',
    iconName: 'Zap',
    standardDurationMinutes: 60,
    popularSurfaces: ['BWF Standard Green Mat', 'Indoor Hardwood', 'PVC Cushion'],
    bannerUrl: 'https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?auto=format&fit=crop&w=800&q=80',
  },
  {
    id: 'tennis',
    name: 'Tennis',
    tagline: 'Classic full-court lawn, clay, and hardcourt competition',
    iconName: 'Trophy',
    standardDurationMinutes: 60,
    popularSurfaces: ['DecoTurf Hard Court', 'Red Clay', 'Synthetic Grass'],
    bannerUrl: 'https://images.unsplash.com/photo-1595435934249-5df7ed86e1c0?auto=format&fit=crop&w=800&q=80',
  },
  {
    id: 'padel',
    name: 'Padel',
    tagline: 'Enclosed glass court racket sport combining tennis and squash tactics',
    iconName: 'Layers',
    standardDurationMinutes: 60,
    popularSurfaces: ['Monofilament Synthetic Turf', 'Sand-Dressed Turf'],
    bannerUrl: 'https://images.unsplash.com/photo-1554068865-24cecd4e34b8?auto=format&fit=crop&w=800&q=80',
  },
  {
    id: 'basketball',
    name: 'Basketball',
    tagline: 'FIBA full-court and 3x3 half-court with regulation breakaway rims',
    iconName: 'CircleDot',
    standardDurationMinutes: 60,
    popularSurfaces: ['Maple Hardwood', 'High-Impact Polypropylene', 'Asphalt Hardcourt'],
    bannerUrl: 'https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&w=800&q=80',
  },
  {
    id: 'volleyball',
    name: 'Volleyball',
    tagline: 'Indoor hardwood and beach sand volleyball courts',
    iconName: 'Flame',
    standardDurationMinutes: 60,
    popularSurfaces: ['Teraflex Sport Floor', 'Indoor Hardwood', 'Sand'],
    bannerUrl: 'https://images.unsplash.com/photo-1612872087720-bb876e2e67d1?auto=format&fit=crop&w=800&q=80',
  },
  {
    id: 'squash',
    name: 'Squash',
    tagline: 'High-intensity enclosed four-walled racket sport',
    iconName: 'Box',
    standardDurationMinutes: 45,
    popularSurfaces: ['Parquet Hardwood Floor', 'Plaster Backwall'],
    bannerUrl: 'https://images.unsplash.com/photo-1587280501635-68a0e82cd5ff?auto=format&fit=crop&w=800&q=80',
  },
];

export function normalizeSportName(sport: string): string {
  const clean = sport.trim().toLowerCase();
  const found = SPORTS_REGISTRY.find((s) => s.id === clean || s.name.toLowerCase() === clean);
  return found ? found.name : sport;
}
