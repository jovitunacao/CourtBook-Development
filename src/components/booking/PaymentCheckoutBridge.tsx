import React, { useState, useEffect } from 'react';
import {
  CreditCard,
  ExternalLink,
  ShieldCheck,
  Clock,
  AlertCircle,
  Loader2,
  CheckCircle2,
  ArrowRight,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { CreateBookingCheckoutResult } from '../../lib/supabaseClient';

interface PaymentCheckoutBridgeProps {
  checkoutResult: CreateBookingCheckoutResult | null;
  isLoading: boolean;
  errorMessage: string | null;
  isDemoFacility?: boolean;
  isCheckingStatus?: boolean;
  statusMessage?: string | null;
  onSimulateSuccess: () => void;
  onCheckPaymentStatus?: () => void;
  onRetry: () => void;
  onCancel: () => void;
}

export const PaymentCheckoutBridge: React.FC<PaymentCheckoutBridgeProps> = ({
  checkoutResult,
  isLoading,
  errorMessage,
  isDemoFacility = false,
  isCheckingStatus = false,
  statusMessage = null,
  onSimulateSuccess,
  onCheckPaymentStatus,
  onRetry,
  onCancel,
}) => {
  // 15-minute countdown timer calculation
  const [secondsRemaining, setSecondsRemaining] = useState<number>(15 * 60);

  useEffect(() => {
    if (!checkoutResult?.hold_expires_at) return;

    const expiryMs = new Date(checkoutResult.hold_expires_at).getTime();
    const updateCountdown = () => {
      const diffSec = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000));
      setSecondsRemaining(diffSec);
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [checkoutResult?.hold_expires_at]);

  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = secondsRemaining % 60;
  const timeFormatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  const paymentChannels = [
    { name: 'GCash', tag: 'E-Wallet', color: 'bg-blue-50 text-blue-700 border-blue-200' },
    { name: 'Maya', tag: 'E-Wallet', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    { name: 'Credit / Debit Card', tag: 'Visa, Mastercard', color: 'bg-slate-50 text-slate-700 border-slate-200' },
    { name: 'GrabPay', tag: 'E-Wallet', color: 'bg-green-50 text-green-700 border-green-200' },
    { name: 'Online Banking', tag: 'BPI, UnionBank, RCBC', color: 'bg-purple-50 text-purple-700 border-purple-200' },
  ];

  if (isLoading) {
    return (
      <div className="py-16 text-center space-y-4 max-w-md mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto shadow-xs">
          <Loader2 className="w-7 h-7 animate-spin" />
        </div>
        <div className="space-y-1">
          <h3 className="text-base font-extrabold text-slate-900">
            Securing Your Court Slot...
          </h3>
          <p className="text-xs text-slate-500 leading-relaxed">
            Acquiring concurrency-safe hold and initializing PayMongo checkout session...
          </p>
        </div>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="bg-red-50/80 border border-red-200 rounded-3xl p-6 sm:p-8 space-y-4 max-w-lg mx-auto text-center">
        <div className="w-12 h-12 rounded-2xl bg-red-100 text-red-600 flex items-center justify-center mx-auto">
          <AlertCircle className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <h3 className="text-base font-bold text-slate-900">Unable to Reserve Slot</h3>
          <p className="text-xs text-slate-600 leading-relaxed">{errorMessage}</p>
        </div>

        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition-colors cursor-pointer"
          >
            Change Time Slot
          </button>
          <button
            type="button"
            onClick={onRetry}
            className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Try Again</span>
          </button>
        </div>
      </div>
    );
  }

  if (!checkoutResult) return null;

  return (
    <div className="space-y-6 max-w-xl mx-auto">
      {/* 15-Minute Slot Hold Notice */}
      <div className="bg-amber-50/80 border border-amber-200 rounded-2xl p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
            <Clock className="w-4 h-4" />
          </div>
          <div>
            <div className="text-xs font-extrabold text-amber-900">
              Temporary Slot Hold Active
            </div>
            <div className="text-[11px] text-amber-700">
              This court slot is exclusively reserved for you. Complete payment before the timer expires.
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-base font-extrabold text-amber-900 font-mono tracking-wider">
            {timeFormatted}
          </div>
          <div className="text-[10px] text-amber-600 font-bold uppercase">Remaining</div>
        </div>
      </div>

      {/* Payment Details Card */}
      <div className="bg-white border border-slate-200 rounded-3xl p-6 sm:p-8 space-y-6 shadow-sm">
        <div className="flex items-center justify-between pb-4 border-b border-slate-100">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600 bg-blue-50 px-2 py-0.5 rounded-md">
              Step 7: Complete Payment
            </span>
            <h3 className="text-lg font-extrabold text-slate-900 mt-1">
              PayMongo Official Checkout
            </h3>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase font-bold text-slate-400">Total Amount</div>
            <div className="text-2xl font-extrabold text-slate-900">
              {checkoutResult.currency || '₱'}{Number(checkoutResult.expected_amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })}
            </div>
          </div>
        </div>

        {/* Supported Payment Channels */}
        <div className="space-y-2">
          <label className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">
            Supported Philippine Payment Methods
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {paymentChannels.map((ch, idx) => (
              <div
                key={idx}
                className={`p-2.5 rounded-xl border text-xs font-bold flex flex-col justify-between ${ch.color}`}
              >
                <span>{ch.name}</span>
                <span className="text-[10px] opacity-75 font-normal mt-0.5">{ch.tag}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Security & Zero Fees Guarantee */}
        <div className="p-3 bg-slate-50 rounded-xl border border-slate-100 flex items-center gap-2.5 text-xs text-slate-600 font-medium">
          <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" />
          <span>
            256-bit SSL encrypted checkout. 100% transparent pricing with zero extra booking fees.
          </span>
        </div>

        {/* Checkout Execution Actions */}
        <div className="space-y-3 pt-2">
          {checkoutResult.checkout_url && (
            <a
              href={checkoutResult.checkout_url}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full py-4 px-6 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-extrabold flex items-center justify-center gap-2 transition-all shadow-md shadow-blue-500/20"
            >
              <span>Open PayMongo Hosted Checkout</span>
              <ExternalLink className="w-4 h-4" />
            </a>
          )}

          {/* Test / Simulated Payment Confirmation Button: STRICTLY RESTRICTED TO DEMO TEST VENUES */}
          {isDemoFacility ? (
            <div className="space-y-1.5 pt-1">
              <button
                type="button"
                onClick={onSimulateSuccess}
                className="w-full py-3.5 px-6 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs sm:text-sm font-extrabold flex items-center justify-center gap-2 transition-all cursor-pointer shadow-xs"
              >
                <Sparkles className="w-4 h-4" />
                <span>Simulate Demo Payment & View Pass</span>
                <ArrowRight className="w-4 h-4" />
              </button>
              <p className="text-[11px] text-center text-slate-400">
                Demo Facility sandbox test: creates an isolated demo reservation pass.
              </p>
            </div>
          ) : (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl text-center space-y-3">
              <div className="space-y-1">
                <div className="text-xs font-bold text-slate-800 flex items-center justify-center gap-1.5">
                  <Loader2 className={`w-3.5 h-3.5 ${isCheckingStatus ? 'animate-spin text-blue-600' : 'text-slate-400'}`} />
                  <span>{isCheckingStatus ? 'Verifying Authoritative Backend Status...' : 'Awaiting Authoritative Payment Capture'}</span>
                </div>
                <p className="text-[11px] text-slate-500 max-w-sm mx-auto">
                  Complete your payment on the PayMongo checkout window. Once confirmed by the webhook, click below to verify and receive your digital pass.
                </p>
                {statusMessage && (
                  <p className="text-[11px] text-amber-700 font-medium pt-1">
                    {statusMessage}
                  </p>
                )}
              </div>

              {onCheckPaymentStatus && (
                <button
                  type="button"
                  onClick={onCheckPaymentStatus}
                  disabled={isCheckingStatus}
                  className="w-full py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-xs"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isCheckingStatus ? 'animate-spin' : ''}`} />
                  <span>{isCheckingStatus ? 'Checking Status...' : 'I Have Paid — Check My Booking Status'}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
