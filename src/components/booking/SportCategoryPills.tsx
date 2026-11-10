import React from 'react';
import {
  Activity,
  Zap,
  Trophy,
  Layers,
  CircleDot,
  Flame,
  Box,
  Check,
} from 'lucide-react';
import { SPORTS_REGISTRY } from '../../data/sportsRegistry';

interface SportCategoryPillsProps {
  selectedSport: string | null;
  onSelectSport: (sport: string | null) => void;
  sportCounts?: Record<string, number>;
  compact?: boolean;
}

export const SportCategoryPills: React.FC<SportCategoryPillsProps> = ({
  selectedSport,
  onSelectSport,
  sportCounts = {},
  compact = false,
}) => {
  const getSportIcon = (iconName: string) => {
    switch (iconName) {
      case 'Activity':
        return <Activity className="w-4 h-4" />;
      case 'Zap':
        return <Zap className="w-4 h-4" />;
      case 'Trophy':
        return <Trophy className="w-4 h-4" />;
      case 'Layers':
        return <Layers className="w-4 h-4" />;
      case 'CircleDot':
        return <CircleDot className="w-4 h-4" />;
      case 'Flame':
        return <Flame className="w-4 h-4" />;
      case 'Box':
        return <Box className="w-4 h-4" />;
      default:
        return <Trophy className="w-4 h-4" />;
    }
  };

  const totalCourts = Object.values(sportCounts).reduce((a, b) => a + b, 0);

  return (
    <div className="w-full">
      <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none no-scrollbar">
        {/* All Sports Pill */}
        <button
          type="button"
          onClick={() => onSelectSport(null)}
          className={`shrink-0 inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            selectedSport === null
              ? 'bg-slate-900 text-white shadow-xs'
              : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300'
          }`}
        >
          <span>All Sports</span>
          {totalCourts > 0 && (
            <span
              className={`px-1.5 py-0.5 rounded-full text-[10px] font-extrabold ${
                selectedSport === null
                  ? 'bg-slate-800 text-slate-200'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {totalCourts}
            </span>
          )}
        </button>

        {/* Individual Sports */}
        {SPORTS_REGISTRY.map((sport) => {
          const isSelected =
            selectedSport?.toLowerCase() === sport.name.toLowerCase() ||
            selectedSport?.toLowerCase() === sport.id.toLowerCase();
          const count = sportCounts[sport.name.toLowerCase()] ?? sportCounts[sport.id.toLowerCase()] ?? 0;

          return (
            <button
              key={sport.id}
              type="button"
              onClick={() => onSelectSport(isSelected ? null : sport.name)}
              className={`shrink-0 inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                isSelected
                  ? 'bg-blue-600 text-white shadow-sm ring-2 ring-blue-500/20'
                  : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-blue-300'
              }`}
            >
              <span className={isSelected ? 'text-white' : 'text-blue-600'}>
                {getSportIcon(sport.iconName)}
              </span>
              <span>{sport.name}</span>
              {count > 0 && (
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-extrabold ${
                    isSelected
                      ? 'bg-blue-700 text-blue-100'
                      : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
