// ==============================================================================
// CourtBook / BookSuite — Booking Page Layout Component
// File: src/components/booking/BookingPageLayout.tsx
// Description:
//   Common responsive page layout for all /book/* dedicated customer routes.
//   Provides progress bar, step breadcrumbs, back navigation, and clean typography.
// ==============================================================================

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, RotateCcw, Check, Sparkles } from 'lucide-react';
import { useCustomerBooking } from '../../context/CustomerBookingContext';

export interface BookingPageLayoutProps {
  currentStep: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  title: string;
  subtitle: string;
  backUrl?: string;
  onBack?: () => void;
  children?: React.ReactNode;
}

const STEP_DEFINITIONS = [
  { step: 1, label: 'Sport', path: '/book/sport' },
  { step: 2, label: 'Location', path: '/book/location' },
  { step: 3, label: 'Venues', path: '/book/venues' },
  { step: 4, label: 'Schedule', path: '/book/schedule' },
  { step: 5, label: 'Details', path: '/book/details' },
  { step: 6, label: 'Payment', path: '/book/payment' },
  { step: 7, label: 'Confirmation', path: '/book/confirmation' },
];

export const BookingPageLayout: React.FC<BookingPageLayoutProps> = ({
  currentStep,
  title,
  subtitle,
  backUrl,
  onBack,
  children,
}) => {
  const navigate = useNavigate();
  const { resetBooking } = useCustomerBooking();

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else if (backUrl) {
      navigate(backUrl);
    } else {
      navigate(-1);
    }
  };

  const handleStartOver = () => {
    if (window.confirm('Are you sure you want to start over and reset your booking selections?')) {
      resetBooking();
      navigate('/book/sport');
    }
  };

  const progressPercent = Math.round((currentStep / 7) * 100);

  return (
    <div className="min-h-[calc(100vh-64px)] bg-slate-50 py-6 sm:py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Navigation & Progress Shell */}
        <div className="bg-white rounded-3xl border border-slate-200/90 p-4 sm:p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {currentStep > 1 && currentStep < 7 && (
                <button
                  type="button"
                  onClick={handleBack}
                  className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors cursor-pointer"
                  title="Go back to previous step"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-extrabold uppercase tracking-widest text-blue-600">
                    Step {currentStep} of 7
                  </span>
                  <span className="text-slate-300">•</span>
                  <span className="text-[11px] font-semibold text-slate-500">
                    {progressPercent}% Complete
                  </span>
                </div>
                <h1 className="text-lg sm:text-2xl font-extrabold text-slate-900 tracking-tight">
                  {title}
                </h1>
                <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
                  {subtitle}
                </p>
              </div>
            </div>

            {/* Start Over Button */}
            {currentStep > 1 && currentStep < 7 && (
              <button
                type="button"
                onClick={handleStartOver}
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold text-slate-600 hover:text-red-600 hover:border-red-200 transition-colors cursor-pointer"
                title="Reset booking selections"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Start Over</span>
              </button>
            )}
          </div>

          {/* Animated Progress Bar */}
          <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
            <div
              className="bg-blue-600 h-full rounded-full transition-all duration-300 ease-out"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          {/* Horizontal Step Navigation Chips (Desktop / Tablet) */}
          <div className="hidden md:flex items-center justify-between gap-1 pt-1 border-t border-slate-100 overflow-x-auto">
            {STEP_DEFINITIONS.map((def) => {
              const isPassed = def.step < currentStep;
              const isCurrent = def.step === currentStep;
              return (
                <div
                  key={def.step}
                  className={`flex items-center gap-1.5 text-xs font-bold py-1 px-2.5 rounded-lg whitespace-nowrap transition-colors ${
                    isCurrent
                      ? 'bg-blue-50 text-blue-700 border border-blue-200'
                      : isPassed
                      ? 'text-slate-500 hover:text-slate-800'
                      : 'text-slate-300'
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${
                      isPassed
                        ? 'bg-emerald-500 text-white'
                        : isCurrent
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-200 text-slate-400'
                    }`}
                  >
                    {isPassed ? <Check className="w-2.5 h-2.5" /> : def.step}
                  </span>
                  <span>{def.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Page Content Body */}
        <div className="space-y-6">
          {children}
        </div>
      </div>
    </div>
  );
};
