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
              <span className="text-white font-extrabold text-lg tracking-tight">LockaCourt</span>
            </div>
            <p className="text-slate-400 text-sm max-w-md">
              Specialized court reservation platform for sports facilities, clubs, and athletic centers.
              Experience instant court availability, verified bookings, and streamlined facility oversight.
            </p>
            <div className="flex items-center gap-2 text-xs text-slate-300 pt-1">
              <Layers className="w-4 h-4 text-blue-400" />
              <span>
                Operated by{' '}
                <a
                  href="https://aratreserve.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-bold text-white hover:text-blue-300 underline underline-offset-2 transition-colors"
                >
                  AratReserve
                </a>
                .
              </span>
            </div>
          </div>

          {/* Navigation */}
          <div>
            <h4 className="text-white font-bold text-xs uppercase tracking-wider mb-3">
              Platform Navigation
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
                  Book a Court
                </button>
              </li>
              <li>
                <button
                  onClick={() => handleNav('admin')}
                  className="hover:text-white transition-colors cursor-pointer"
                >
                  Owner Reservations Portal
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

          {/* Booking Assurance Notice */}
          <div>
            <h4 className="text-white font-bold text-xs uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <ShieldAlert className="w-4 h-4 text-blue-400" />
              Booking Security
            </h4>
            <p className="text-xs text-slate-400 leading-relaxed">
              Live bookings at{' '}
              <span className="text-slate-200 font-semibold">lockacourt.com</span>{' '}
              are verified server-side with isolated facility schedules. Offline mode runs fictional local demos only.
            </p>
          </div>
        </div>

        <div className="mt-10 pt-6 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-300 gap-4">
          <p>© {new Date().getFullYear()} LockaCourt &bull; Operated by AratReserve.</p>
          <div className="flex items-center gap-4">
            <span className="text-slate-400">lockacourt.com</span>
          </div>
        </div>
      </div>
    </footer>
  );
};
