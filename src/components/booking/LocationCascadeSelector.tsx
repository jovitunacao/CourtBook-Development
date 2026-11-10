import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  MapPin,
  Search,
  ChevronDown,
  X,
  Compass,
  Check,
  Building,
} from 'lucide-react';
import {
  PHILIPPINE_REGIONS,
  searchPhilippineLocations,
  FlattenedLocationOption,
} from '../../data/philippineLocations';
import { PhilippineLocation } from '../../types/customerBooking';

interface LocationCascadeSelectorProps {
  selectedLocation: PhilippineLocation | null;
  onSelectLocation: (loc: PhilippineLocation | null) => void;
  className?: string;
}

export const LocationCascadeSelector: React.FC<LocationCascadeSelectorProps> = ({
  selectedLocation,
  onSelectLocation,
  className = '',
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [isManualCascadeOpen, setIsManualCascadeOpen] = useState(false);

  // Manual cascade states
  const [activeRegionCode, setActiveRegionCode] = useState<string>('');
  const [activeProvinceName, setActiveProvinceName] = useState<string>('');
  const [activeCityName, setActiveCityName] = useState<string>('');
  const [activeBarangayName, setActiveBarangayName] = useState<string>('');

  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Search results
  const searchResults = useMemo(() => {
    return searchPhilippineLocations(searchQuery, 8);
  }, [searchQuery]);

  // Handle outside click to close dropdowns
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setIsSearchFocused(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Quick preset locations for convenient 1-tap selection
  const popularPresets = [
    { city: 'Makati City', province: 'Metro Manila', regionCode: 'NCR', regionName: 'NCR' },
    { city: 'Taguig City', province: 'Metro Manila', regionCode: 'NCR', regionName: 'NCR', label: 'BGC / Taguig' },
    { city: 'Quezon City', province: 'Metro Manila', regionCode: 'NCR', regionName: 'NCR' },
    { city: 'Pasig City', province: 'Metro Manila', regionCode: 'NCR', regionName: 'NCR', label: 'Ortigas / Pasig' },
    { city: 'Santa Rosa City', province: 'Laguna', regionCode: 'REGION-IV-A', regionName: 'CALABARZON', label: 'Santa Rosa (Nuvali)' },
    { city: 'Cebu City', province: 'Cebu', regionCode: 'REGION-VII', regionName: 'Central Visayas' },
    { city: 'Angeles City', province: 'Pampanga', regionCode: 'REGION-III', regionName: 'Central Luzon' },
  ];

  // Cascading dropdown helpers
  const currentRegion = PHILIPPINE_REGIONS.find((r) => r.code === activeRegionCode);
  const currentProvince = currentRegion?.provinces.find((p) => p.name === activeProvinceName);
  const currentCity = currentProvince?.cities.find((c) => c.name === activeCityName);

  const handleApplyCascade = () => {
    if (!currentRegion || !currentProvince || !currentCity) return;
    onSelectLocation({
      regionCode: currentRegion.code,
      regionName: currentRegion.name,
      province: currentProvince.name,
      city: currentCity.name,
      barangay: activeBarangayName || undefined,
    });
    setIsManualCascadeOpen(false);
    setSearchQuery('');
  };

  const handleSelectSearchResult = (opt: FlattenedLocationOption) => {
    onSelectLocation({
      regionCode: opt.regionCode,
      regionName: opt.regionName,
      province: opt.province,
      city: opt.city,
      barangay: opt.barangay,
    });
    setSearchQuery('');
    setIsSearchFocused(false);
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Search Input Bar */}
      <div ref={searchContainerRef} className="relative">
        <div className="relative flex items-center">
          <div className="absolute left-3.5 text-slate-400 pointer-events-none">
            <Search className="w-4 h-4" />
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setIsSearchFocused(true)}
            placeholder="Search city, province, or barangay (e.g. Makati, BGC, Nuvali, Cebu)..."
            className="w-full pl-10 pr-24 py-3 bg-white border border-slate-200/90 rounded-2xl text-xs sm:text-sm text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 shadow-xs transition-all"
          />

          <div className="absolute right-2 flex items-center gap-1">
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setIsManualCascadeOpen(!isManualCascadeOpen)}
              className="px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-bold flex items-center gap-1 transition-colors cursor-pointer"
              title="Browse by Region, Province, City"
            >
              <Compass className="w-3.5 h-3.5 text-blue-600" />
              <span className="hidden sm:inline">Regions</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${isManualCascadeOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>

        {/* Search Results Dropdown */}
        {isSearchFocused && searchQuery.trim().length > 0 && (
          <div className="absolute z-50 left-0 right-0 mt-1.5 bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="p-2 border-b border-slate-100 text-[11px] font-bold uppercase tracking-wider text-slate-400 px-3">
              Matching Philippine Locations
            </div>
            {searchResults.length > 0 ? (
              <div className="max-h-64 overflow-y-auto divide-y divide-slate-50">
                {searchResults.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => handleSelectSearchResult(item)}
                    className="w-full text-left px-3.5 py-2.5 hover:bg-blue-50/70 flex items-center justify-between text-xs transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 group-hover:bg-blue-100">
                        <MapPin className="w-3.5 h-3.5" />
                      </div>
                      <div className="truncate">
                        <div className="font-bold text-slate-900 group-hover:text-blue-700">
                          {item.displayLabel}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {item.regionName}
                        </div>
                      </div>
                    </div>
                    <span className="text-[10px] font-bold text-blue-600 shrink-0 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      Select
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-6 text-center text-xs text-slate-500">
                No location found matching "{searchQuery}". Try selecting via the Regions browser.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Selected Location Pill */}
      {selectedLocation && (
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-blue-50 border border-blue-200 text-blue-800 text-xs font-semibold">
          <MapPin className="w-3.5 h-3.5 text-blue-600 shrink-0" />
          <span>
            {selectedLocation.barangay ? `${selectedLocation.barangay}, ` : ''}
            {selectedLocation.city}, {selectedLocation.province}
          </span>
          <button
            type="button"
            onClick={() => onSelectLocation(null)}
            className="p-0.5 rounded-md hover:bg-blue-200 text-blue-600 cursor-pointer ml-1"
            title="Clear location filter"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Popular Presets Bar */}
      {!selectedLocation && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none no-scrollbar">
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider shrink-0 mr-1 flex items-center gap-1">
            <Building className="w-3 h-3" />
            <span>Popular:</span>
          </span>
          {popularPresets.map((p, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() =>
                onSelectLocation({
                  city: p.city,
                  province: p.province,
                  regionCode: p.regionCode,
                  regionName: p.regionName,
                })
              }
              className="shrink-0 px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-semibold transition-colors cursor-pointer"
            >
              {p.label || p.city}
            </button>
          ))}
        </div>
      )}

      {/* Manual Cascade Browser Drawer / Modal */}
      {isManualCascadeOpen && (
        <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-3 animate-in fade-in duration-200">
          <div className="flex items-center justify-between pb-2 border-b border-slate-200">
            <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
              <Compass className="w-4 h-4 text-blue-600" />
              <span>Browse Philippine Administrative Hierarchy</span>
            </div>
            <button
              type="button"
              onClick={() => setIsManualCascadeOpen(false)}
              className="text-slate-400 hover:text-slate-600 text-xs font-bold p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs">
            {/* 1. Region */}
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                1. Region
              </label>
              <select
                value={activeRegionCode}
                onChange={(e) => {
                  setActiveRegionCode(e.target.value);
                  setActiveProvinceName('');
                  setActiveCityName('');
                  setActiveBarangayName('');
                }}
                className="w-full p-2 bg-white border border-slate-200 rounded-xl text-slate-800 text-xs focus:ring-1 focus:ring-blue-500"
              >
                <option value="">Select Region...</option>
                {PHILIPPINE_REGIONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>

            {/* 2. Province */}
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                2. Province
              </label>
              <select
                disabled={!activeRegionCode}
                value={activeProvinceName}
                onChange={(e) => {
                  setActiveProvinceName(e.target.value);
                  setActiveCityName('');
                  setActiveBarangayName('');
                }}
                className="w-full p-2 bg-white border border-slate-200 rounded-xl text-slate-800 text-xs disabled:bg-slate-100 disabled:text-slate-400 focus:ring-1 focus:ring-blue-500"
              >
                <option value="">Select Province...</option>
                {currentRegion?.provinces.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {/* 3. City / Municipality */}
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                3. City / Municipality
              </label>
              <select
                disabled={!activeProvinceName}
                value={activeCityName}
                onChange={(e) => {
                  setActiveCityName(e.target.value);
                  setActiveBarangayName('');
                }}
                className="w-full p-2 bg-white border border-slate-200 rounded-xl text-slate-800 text-xs disabled:bg-slate-100 disabled:text-slate-400 focus:ring-1 focus:ring-blue-500"
              >
                <option value="">Select City / Municipality...</option>
                {currentProvince?.cities.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            {/* 4. Barangay (Optional) */}
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                4. Barangay (Optional)
              </label>
              <select
                disabled={!activeCityName || !currentCity?.barangays.length}
                value={activeBarangayName}
                onChange={(e) => setActiveBarangayName(e.target.value)}
                className="w-full p-2 bg-white border border-slate-200 rounded-xl text-slate-800 text-xs disabled:bg-slate-100 disabled:text-slate-400 focus:ring-1 focus:ring-blue-500"
              >
                <option value="">All Barangays</option>
                {currentCity?.barangays.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setIsManualCascadeOpen(false)}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!activeCityName}
              onClick={handleApplyCascade}
              className="px-4 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-50 transition-colors shadow-xs"
            >
              Apply Location
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
