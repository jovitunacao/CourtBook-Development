// ==============================================================================
// CourtBook / BookSuite — Philippine Geographic Hierarchy Dataset
// File: src/data/philippineLocations.ts
// ==============================================================================

export interface RegionData {
  code: string;
  name: string;
  provinces: ProvinceData[];
}

export interface ProvinceData {
  name: string;
  cities: CityData[];
}

export interface CityData {
  name: string;
  isCity: boolean;
  barangays: string[];
}

export const PHILIPPINE_REGIONS: RegionData[] = [
  {
    code: 'NCR',
    name: 'National Capital Region (NCR)',
    provinces: [
      {
        name: 'Metro Manila',
        cities: [
          {
            name: 'Makati City',
            isCity: true,
            barangays: ['Bel-Air', 'Poblacion', 'San Lorenzo', 'Urdaneta', 'Legazpi Village', 'Salcedo Village', 'San Antonio', 'Guadalupe Nuevo'],
          },
          {
            name: 'Taguig City',
            isCity: true,
            barangays: ['Fort Bonifacio (BGC)', 'Ususan', 'Tuktukan', 'Western Bicutan', 'Signal Village', 'Bagumbayan'],
          },
          {
            name: 'Quezon City',
            isCity: true,
            barangays: ['Diliman', 'New Manila', 'Loyola Heights', 'Ugong Norte', 'South Triangle', 'Cubao', 'Batasan Hills', 'Tandang Sora'],
          },
          {
            name: 'Pasig City',
            isCity: true,
            barangays: ['Ortigas Center', 'Kapitolyo', 'San Antonio', 'Ugong', 'Rosario', 'Caniogan', 'Maybunga'],
          },
          {
            name: 'Mandaluyong City',
            isCity: true,
            barangays: ['Wack-Wack Greenhills', 'Highway Hills', 'Plainview', 'Barangka Ilaya', 'Addition Hills'],
          },
          {
            name: 'City of Manila',
            isCity: true,
            barangays: ['Malate', 'Ermita', 'Paco', 'Santa Ana', 'Sampaloc', 'Binondo', 'Intramuros'],
          },
          {
            name: 'San Juan City',
            isCity: true,
            barangays: ['Greenhills', 'Addition Hills', 'Little Baguio', 'West Crame', 'Kabayanan'],
          },
          {
            name: 'Parañaque City',
            isCity: true,
            barangays: ['BF Homes', 'Don Bosco', 'Moonwalk', 'San Antonio', 'Sun Valley', 'Baclaran', 'Tambo'],
          },
          {
            name: 'Muntinlupa City',
            isCity: true,
            barangays: ['Alabang', 'Ayala Alabang', 'Cupang', 'Putatan', 'Tunasan', 'Poblacion'],
          },
          {
            name: 'Pasay City',
            isCity: true,
            barangays: ['San Isidro', 'San Jose', 'San Rafael', 'Mall of Asia Complex', 'Villamor'],
          },
          {
            name: 'Las Piñas City',
            isCity: true,
            barangays: ['Pamplona Uno', 'Talon Dos', 'Pilar', 'Almanza Uno', 'Pulang Lupa'],
          },
          {
            name: 'Marikina City',
            isCity: true,
            barangays: ['Concepcion Uno', 'Marikina Heights', 'Barangka', 'Sto. Niño', 'San Roque'],
          },
        ],
      },
    ],
  },
  {
    code: 'REGION-IV-A',
    name: 'Region IV-A (CALABARZON)',
    provinces: [
      {
        name: 'Laguna',
        cities: [
          {
            name: 'Santa Rosa City',
            isCity: true,
            barangays: ['Nuvali', 'Balibago', 'Don Jose', 'Tagapo', 'Dita', 'Macabling'],
          },
          {
            name: 'Calamba City',
            isCity: true,
            barangays: ['Pansol', 'Canlubang', 'Real', 'Bucal', 'Parian', 'Halang'],
          },
          {
            name: 'Biñan City',
            isCity: true,
            barangays: ['San Francisco', 'Platero', 'Santo Tomas', 'San Antonio', 'Malaban'],
          },
          {
            name: 'Cabuyao City',
            isCity: true,
            barangays: ['Mamatid', 'Pulo', 'Sala', 'Bigaa', 'Banlic'],
          },
          {
            name: 'San Pedro City',
            isCity: true,
            barangays: ['San Vicente', 'San Antonio', 'Landayan', 'Pacita Complex'],
          },
        ],
      },
      {
        name: 'Cavite',
        cities: [
          {
            name: 'Tagaytay City',
            isCity: true,
            barangays: ['Kaybagal South', 'Mendez Crossing', 'Silang Junction', 'Maharlika West', 'Iruhin'],
          },
          {
            name: 'Imus City',
            isCity: true,
            barangays: ['Bucandala', 'Malagasang', 'Anabu', 'Palico', 'Tanzang Luma'],
          },
          {
            name: 'Bacoor City',
            isCity: true,
            barangays: ['Molino', 'Habay', 'Panapaan', 'Talaba', 'Niog'],
          },
          {
            name: 'Dasmariñas City',
            isCity: true,
            barangays: ['Salitran', 'Paliparan', 'Burol', 'Sampaloc', 'San Agustin'],
          },
          {
            name: 'Silang',
            isCity: false,
            barangays: ['Biga', 'Tubuan', 'Bulihan', 'Lalaan', 'Poblacion'],
          },
        ],
      },
      {
        name: 'Rizal',
        cities: [
          {
            name: 'Antipolo City',
            isCity: true,
            barangays: ['San Roque', 'Dela Paz', 'Beverly Hills', 'Cupang', 'Mambugan', 'Santa Cruz'],
          },
          {
            name: 'Cainta',
            isCity: false,
            barangays: ['San Andres', 'San Isidro', 'San Juan', 'Santo Domingo'],
          },
          {
            name: 'Taytay',
            isCity: false,
            barangays: ['Dolores', 'San Isidro', 'San Juan', 'Santa Ana'],
          },
        ],
      },
      {
        name: 'Batangas',
        cities: [
          {
            name: 'Lipa City',
            isCity: true,
            barangays: ['Sabang', 'Mataas Na Lupa', 'Tambo', 'Marauoy', 'Inosloban'],
          },
          {
            name: 'Batangas City',
            isCity: true,
            barangays: ['Kumintang Ibaba', 'Kumintang Ilaya', 'Alangilan', 'Poblacion'],
          },
        ],
      },
    ],
  },
  {
    code: 'REGION-VII',
    name: 'Region VII (Central Visayas)',
    provinces: [
      {
        name: 'Cebu',
        cities: [
          {
            name: 'Cebu City',
            isCity: true,
            barangays: ['Lahug (IT Park)', 'Banilad', 'Kasambagan', 'Mabolo', 'Guadalupe', 'Zapatera', 'Kamputhaw'],
          },
          {
            name: 'Mandaue City',
            isCity: true,
            barangays: ['Subangdaku', 'Banilad', 'Bakilid', 'Tipolo', 'Centro'],
          },
          {
            name: 'Lapu-Lapu City',
            isCity: true,
            barangays: ['Mactan', 'Maribago', 'Punta Engaño', 'Basak', 'Poblacion'],
          },
        ],
      },
    ],
  },
  {
    code: 'REGION-III',
    name: 'Region III (Central Luzon)',
    provinces: [
      {
        name: 'Pampanga',
        cities: [
          {
            name: 'Angeles City',
            isCity: true,
            barangays: ['Balibago', 'Malabañas', 'Anunas', 'Sto. Rosario', 'Cutcut'],
          },
          {
            name: 'City of San Fernando',
            isCity: true,
            barangays: ['Dolores', 'Sindalan', 'San Agustin', 'Telabastagan', 'Del Rosario'],
          },
          {
            name: 'Clark Freeport Zone',
            isCity: false,
            barangays: ['Clark Global City', 'Parade Grounds', 'Midori Complex'],
          },
        ],
      },
      {
        name: 'Bulacan',
        cities: [
          {
            name: 'Malolos City',
            isCity: true,
            barangays: ['Dakila', 'Guinhawa', 'Catmon', 'San Vicente'],
          },
          {
            name: 'San Jose del Monte City',
            isCity: true,
            barangays: ['Tungkong Mangga', 'Muzon', 'Graceville', 'Gaya-Gaya'],
          },
        ],
      },
    ],
  },
  {
    code: 'REGION-XI',
    name: 'Region XI (Davao Region)',
    provinces: [
      {
        name: 'Davao del Sur',
        cities: [
          {
            name: 'Davao City',
            isCity: true,
            barangays: ['Poblacion', 'Matina', 'Buhangin', 'Lanang', 'Bajada', 'Toril', 'Maa'],
          },
        ],
      },
    ],
  },
  {
    code: 'REGION-VI',
    name: 'Region VI (Western Visayas)',
    provinces: [
      {
        name: 'Iloilo',
        cities: [
          {
            name: 'Iloilo City',
            isCity: true,
            barangays: ['Mandurriao (Megaworld)', 'Molo', 'Jaro', 'City Proper', 'La Paz'],
          },
        ],
      },
      {
        name: 'Negros Occidental',
        cities: [
          {
            name: 'Bacolod City',
            isCity: true,
            barangays: ['Villamonte', 'Mandalagan', 'Bata', 'Mansilingan', 'Taculing'],
          },
        ],
      },
    ],
  },
  {
    code: 'CAR',
    name: 'Cordillera Administrative Region (CAR)',
    provinces: [
      {
        name: 'Benguet',
        cities: [
          {
            name: 'Baguio City',
            isCity: true,
            barangays: ['Camp 7', 'Legarda-Burnham', 'Loakan', 'Pacdal', 'Mines View', 'Bakakeng'],
          },
        ],
      },
    ],
  },
  {
    code: 'REGION-IX',
    name: 'Region IX (Zamboanga Peninsula)',
    provinces: [
      {
        name: 'Zamboanga del Sur',
        cities: [
          {
            name: 'Zamboanga City',
            isCity: true,
            barangays: ['Tetuan', 'Pasonanca', 'Santa Maria', 'Canelar', 'Tumaga', 'Guiwan', 'San Jose Gusu'],
          },
        ],
      },
    ],
  },
  {
    code: 'REGION-X',
    name: 'Region X (Northern Mindanao)',
    provinces: [
      {
        name: 'Misamis Oriental',
        cities: [
          {
            name: 'Cagayan de Oro City',
            isCity: true,
            barangays: ['Carmen', 'Macasandig', 'Nazareth', 'Kauswagan', 'Lapasan', 'Bulua', 'Patag'],
          },
        ],
      },
      {
        name: 'Lanao del Norte',
        cities: [
          {
            name: 'Iligan City',
            isCity: true,
            barangays: ['Tubod', 'Pala-o', 'San Miguel', 'Suarez', 'Hinaplanon', 'Buru-un'],
          },
        ],
      },
    ],
  },
];

export interface FlattenedLocationOption {
  key: string;
  regionCode: string;
  regionName: string;
  province: string;
  city: string;
  barangay?: string;
  displayLabel: string;
  searchText: string;
}

// Generate flattened search index for fast instant fuzzy search
export function getFlattenedLocationOptions(): FlattenedLocationOption[] {
  const options: FlattenedLocationOption[] = [];

  for (const reg of PHILIPPINE_REGIONS) {
    for (const prov of reg.provinces) {
      for (const city of prov.cities) {
        // City level
        options.push({
          key: `${reg.code}|${prov.name}|${city.name}`,
          regionCode: reg.code,
          regionName: reg.name,
          province: prov.name,
          city: city.name,
          displayLabel: `${city.name}, ${prov.name}`,
          searchText: `${city.name} ${prov.name} ${reg.name} ${reg.code}`.toLowerCase(),
        });

        // Prominent barangay level
        for (const bgy of city.barangays) {
          options.push({
            key: `${reg.code}|${prov.name}|${city.name}|${bgy}`,
            regionCode: reg.code,
            regionName: reg.name,
            province: prov.name,
            city: city.name,
            barangay: bgy,
            displayLabel: `${bgy}, ${city.name}, ${prov.name}`,
            searchText: `${bgy} ${city.name} ${prov.name} ${reg.name} ${reg.code}`.toLowerCase(),
          });
        }
      }
    }
  }

  return options;
}

export function searchPhilippineLocations(query: string, limit = 8): FlattenedLocationOption[] {
  const clean = query.trim().toLowerCase();
  if (!clean) return [];

  const index = getFlattenedLocationOptions();
  const results: FlattenedLocationOption[] = [];

  for (const item of index) {
    if (item.searchText.includes(clean)) {
      results.push(item);
      if (results.length >= limit) break;
    }
  }

  return results;
}
