import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Dumbbell, ShieldAlert, Layers } from 'lucide-react';

interface FooterProps {
  onNavigate?: (tab: 'home' | 'booking' | 'admin' | 'settings') => void;
}

export const Footer: React.FC<FooterProps> = ({ onNavigate }) => {
  const navigate = useNavigate();

  const handleNav = (tab: 'home' | 'booking' | 'admin' | 'settings') => {
    if (onNavigate) {
      onNavigate(tab);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (tab === 'home') navigate('/');
    else if (tab === 'booking') navigate('/book/sport');
    else if (tab === 'admin') navigate('/admin');
    else if (tab === 'settings') navigate('/settings');
  };
  return (
    <footer className="bg-slate-900 text-slate-400 border-t border-slate-800 text-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Brand info */}
          <div className="md:col-span-2 space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white">
                <Dumbbell className="w-4 h-4 -rotate-45" />
              </div>
              <span className="text-white font-extrabold text-lg tracking-tight">CourtBook</span>
              <span className="text-xs bg-blue-500/20 text-blue-300 border border-blue-500/30 px-2 py-0.5 rounded font-mono">
                Phase 1 Prototype
              </span>
            </div>
            <p className="text-slate-400 text-sm max-w-md">
              Specialized court reservation software for sports facilities, clubs, and athletic centers.
              Experience seamless booking, instant court availability, and simplified facility oversight.
            </p>
            <div className="flex items-center gap-2 text-xs text-slate-300 pt-1">
              <Layers className="w-4 h-4 text-blue-400" />
              <span>A product of the <strong>BookSuite</strong> specialized reservation software company.</span>
            </div>
          </div>

          {/* Navigation */}
          <div>
            <h4 className="text-white font-bold text-xs uppercase tracking-wider mb-3">
              Application Screens
            </h4>
            <ul className="space-y-2">
              <li>
                <button
                  onClick={() => handleNav('home')}
                  className="hover:text-white transition-colors cursor-pointer"
                >
                  Homepage
                </button>
              </li>
              <li>
                <button
                  onClick={() => handleNav('booking')}
                  className="hover:text-white transition-colors text-blue-400 font-medium cursor-pointer"
                >
                  Customer Booking
                </button>
              </li>
              <li>
                <button
                  onClick={() => handleNav('admin')}
                  className="hover:text-white transition-colors cursor-pointer"
                >
                  Admin Reservations Table
                </button>
              </li>
              <li>
                <button
                  onClick={() => handleNav('settings')}
                  className="hover:text-white transition-colors text-slate-300 cursor-pointer"
                >
                  Facility Settings &amp; Courts
                </button>
              </li>
            </ul>
          </div>

          {/* Prototype Notice */}
          <div>
            <h4 className="text-white font-bold text-xs uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <ShieldAlert className="w-4 h-4 text-amber-400" />
              Prototype Scope
            </h4>
            <p className="text-xs text-slate-400 leading-relaxed">
              Phase 1 operates purely client-side using browser <code className="bg-slate-800 text-slate-200 px-1 py-0.5 rounded font-mono text-[11px]">localStorage</code>.
              No backend database or payment gateway is connected.
            </p>
          </div>
        </div>

        <div className="mt-10 pt-6 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-300 gap-4">
          <p>© {new Date().getFullYear()} CourtBook &bull; BookSuite Suite of Booking Apps.</p>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1 text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              Client-side Demo Active
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
};
