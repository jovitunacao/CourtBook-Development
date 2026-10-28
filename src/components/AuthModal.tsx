import React, { useState } from 'react';
import {
  Shield,
  X,
  Mail,
  Lock,
  Eye,
  EyeOff,
  AlertCircle,
  CheckCircle2,
  Database,
  Building,
  ArrowRight,
  Sparkles,
  Loader2,
  KeyRound,
  Info,
  UserPlus,
  LogIn,
} from 'lucide-react';
import { useSupabaseAuth } from '../context/SupabaseAuthContext';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultEmail?: string;
  initialMode?: 'signin' | 'register';
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  defaultEmail = '',
  initialMode = 'signin',
}) => {
  const {
    isConfigured,
    isLoading,
    signIn,
    signUp,
    simulateDemoSignIn,
    authError,
    clearAuthError,
  } = useSupabaseAuth();

  const [authMode, setAuthMode] = useState<'signin' | 'register'>(initialMode);
  const [email, setEmail] = useState<string>(defaultEmail || '');
  const [password, setPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [verificationNotice, setVerificationNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  if (!isOpen) return null;

  const handleTabSwitch = (mode: 'signin' | 'register') => {
    setAuthMode(mode);
    clearAuthError();
    setLocalError(null);
    setSuccessMsg(null);
    setVerificationNotice(null);
    setPassword('');
    setConfirmPassword('');
  };

  const handleSignInSubmit = async () => {
    if (!email.trim()) {
      setLocalError('Please enter your staff email address.');
      return;
    }
    if (!password) {
      setLocalError('Please enter your account password.');
      return;
    }

    if (!isConfigured) {
      // In offline demo mode, simulate based on entered email
      if (email.toLowerCase().includes('badminton') || email.toLowerCase().includes('user_b')) {
        simulateDemoSignIn('user_b');
        setSuccessMsg('Simulated sign-in as User B (Badminton Center)!');
      } else {
        simulateDemoSignIn('user_a');
        setSuccessMsg('Simulated sign-in as User A (Pickleball Center)!');
      }
      setTimeout(() => {
        onClose();
      }, 700);
      return;
    }

    // Call real Supabase Auth signIn with the explicitly entered credentials
    const result = await signIn(email, password);
    if (result.success) {
      setSuccessMsg('Successfully authenticated with Supabase!');
      setTimeout(() => {
        onClose();
      }, 700);
    }
  };

  const handleSignUpSubmit = async () => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) {
      setLocalError('Please enter an email address for your owner account.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setLocalError('Please enter a valid email address (e.g. owner@example.com).');
      return;
    }
    if (!password) {
      setLocalError('Please enter a password.');
      return;
    }
    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setLocalError('Passwords do not match. Please verify both password entries.');
      return;
    }

    if (!isConfigured) {
      setLocalError('Supabase is not configured in this environment. Owner registration requires a live Supabase connection.');
      return;
    }

    setIsSubmitting(true);
    const result = await signUp(cleanEmail, password);
    setIsSubmitting(false);

    if (!result.success) {
      setLocalError(result.error || 'Failed to complete registration.');
      return;
    }

    if (result.needsEmailVerification) {
      // Supabase email confirmation required
      setVerificationNotice(
        `Registration received for ${cleanEmail}! Please check your email inbox to verify your address before signing in.`
      );
      setPassword('');
      setConfirmPassword('');
      return;
    }

    if (result.sessionCreated) {
      setSuccessMsg('Owner account registered and authenticated successfully! Initializing workspace...');
      setTimeout(() => {
        onClose();
      }, 800);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading || isSubmitting) return;

    clearAuthError();
    setLocalError(null);
    setSuccessMsg(null);
    setVerificationNotice(null);

    if (authMode === 'register') {
      await handleSignUpSubmit();
    } else {
      await handleSignInSubmit();
    }
  };

  const handleSimulateDemo = (account: 'user_a' | 'user_b') => {
    clearAuthError();
    setLocalError(null);
    simulateDemoSignIn(account);
    setSuccessMsg(
      `Simulated demo session as ${account === 'user_a' ? 'User A (Pickleball Center)' : 'User B (Badminton Center)'}!`
    );
    setTimeout(() => {
      onClose();
    }, 600);
  };

  const busy = isLoading || isSubmitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden relative"
        role="dialog"
        aria-modal="true"
      >
        {/* Modal Header */}
        <div className="bg-slate-900 text-white p-6 relative">
          <button
            onClick={onClose}
            aria-label="Close modal"
            className="absolute top-5 right-5 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-blue-600/30 border border-blue-400/30 flex items-center justify-center text-blue-400">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight">
                {authMode === 'signin' ? 'Staff & Owner Sign-In' : 'Register Court Owner'}
              </h2>
              <p className="text-xs text-slate-400">
                Supabase Auth &bull; Multi-Tenant RLS Access
              </p>
            </div>
          </div>

          {/* Connection Pill */}
          <div className="mt-3 flex items-center gap-2 text-xs py-1.5 px-3 rounded-lg bg-slate-800/80 border border-slate-700">
            <span
              className={`w-2 h-2 rounded-full ${
                isConfigured ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
              }`}
            />
            <span className="font-medium text-slate-300">
              {isConfigured ? (
                <>
                  Supabase Status: <strong className="text-white">Live Connection</strong> (BookSuite-Dev)
                </>
              ) : (
                <>
                  Supabase Status: <strong className="text-amber-300">Offline / Demo Mode</strong>
                </>
              )}
            </span>
          </div>
        </div>

        {/* Tab Navigation (Sign In vs Register Owner) */}
        <div className="flex border-b border-slate-200 bg-slate-50/70 p-1.5 gap-1.5">
          <button
            type="button"
            onClick={() => handleTabSwitch('signin')}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              authMode === 'signin'
                ? 'bg-white text-slate-900 shadow-xs border border-slate-200/80'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/70'
            }`}
          >
            <LogIn className="w-3.5 h-3.5 text-blue-600" />
            <span>Staff & Owner Sign-In</span>
          </button>
          <button
            type="button"
            onClick={() => handleTabSwitch('register')}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              authMode === 'register'
                ? 'bg-white text-slate-900 shadow-xs border border-slate-200/80'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/70'
            }`}
          >
            <UserPlus className="w-3.5 h-3.5 text-emerald-600" />
            <span>Register Owner Account</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-5">
          {/* Email Verification Banner */}
          {verificationNotice && (
            <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs space-y-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <span className="font-bold block">Verification Email Sent</span>
                  <p className="text-amber-800 leading-relaxed">{verificationNotice}</p>
                </div>
              </div>
              <div className="pt-2 border-t border-amber-200/60 flex justify-end">
                <button
                  type="button"
                  onClick={() => handleTabSwitch('signin')}
                  className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold transition-colors cursor-pointer"
                >
                  Go to Sign In
                </button>
              </div>
            </div>
          )}

          {/* Success Banner */}
          {successMsg && (
            <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Error Banner */}
          {(localError || authError) && (
            <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-semibold flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
              <span>{localError || authError}</span>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                {authMode === 'register' ? 'Owner Email Address' : 'Staff / Owner Email Address'}{' '}
                <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                <input
                  type="email"
                  required
                  placeholder={authMode === 'register' ? 'e.g. owner@sportsclub.com' : 'e.g. staff@courtbook.facility'}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setLocalError(null);
                  }}
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none placeholder:text-slate-400"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Password {authMode === 'register' && <span className="text-slate-500 font-normal">(min. 8 characters)</span>}{' '}
                <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={authMode === 'register' ? 8 : 1}
                  placeholder={authMode === 'register' ? 'Create a secure password (min. 8 chars)' : 'Enter your account password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setLocalError(null);
                  }}
                  className="w-full pl-9 pr-10 py-2 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none placeholder:text-slate-400"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Confirm Password Field (Register Mode Only) */}
            {authMode === 'register' && (
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Confirm Password <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    placeholder="Re-enter your password"
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      setLocalError(null);
                    }}
                    className="w-full pl-9 pr-10 py-2 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none placeholder:text-slate-400"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className={`w-full py-2.5 px-4 text-white rounded-xl text-xs font-bold shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 ${
                authMode === 'register'
                  ? 'bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 shadow-emerald-500/20'
                  : 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 shadow-blue-500/20'
              }`}
            >
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>
                    {authMode === 'register'
                      ? 'Registering Owner Account...'
                      : 'Authenticating with Supabase...'}
                  </span>
                </>
              ) : (
                <>
                  {authMode === 'register' ? (
                    <>
                      <UserPlus className="w-4 h-4" />
                      <span>Register Court Owner Account</span>
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-4 h-4" />
                      <span>Sign In as Authorized Staff / Owner</span>
                    </>
                  )}
                </>
              )}
            </button>
          </form>

          {/* Mode Context Note */}
          {authMode === 'register' ? (
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 text-xs text-slate-600 space-y-1">
              <div className="flex items-center gap-1.5 font-bold text-slate-800">
                <Building className="w-3.5 h-3.5 text-emerald-600" />
                <span>Phase 3 Owner Registration:</span>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Registering creates your court owner account in Supabase Auth. Upon signing in, your account will be recognized as needing organization onboarding before managing facilities.
              </p>
            </div>
          ) : (
            /* Information & Offline Demo Simulator */
            <div className="pt-3 border-t border-slate-100 space-y-3">
              {isConfigured ? (
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 text-xs text-slate-600 space-y-1">
                  <div className="flex items-center gap-1.5 font-bold text-slate-800">
                    <Info className="w-3.5 h-3.5 text-blue-600" />
                    <span>BookSuite-Dev Staff Credentials:</span>
                  </div>
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    Enter your assigned Supabase Auth credentials. User accounts configured in your
                    environment have access to their respective organizations (Pickleball Center or Badminton Center)
                    governed strictly by database RLS policies.
                  </p>
                </div>
              ) : (
                <div className="p-3.5 rounded-xl bg-amber-50/70 border border-amber-200/80 space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-amber-900">
                    <Sparkles className="w-3.5 h-3.5 text-amber-600" />
                    <span>Test In Browser Demo Mode:</span>
                  </div>
                  <p className="text-[11px] text-amber-800/90 leading-relaxed">
                    Supabase keys are not currently configured in the browser environment. You can simulate
                    either fictional tenant locally without making external network requests:
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => handleSimulateDemo('user_a')}
                      className="p-2 text-left rounded-lg bg-white hover:bg-amber-100/50 border border-amber-200 text-xs font-semibold text-amber-900 transition-colors flex items-center justify-between cursor-pointer"
                    >
                      <span>User A: Pickleball Center</span>
                      <ArrowRight className="w-3 h-3 text-amber-700" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSimulateDemo('user_b')}
                      className="p-2 text-left rounded-lg bg-white hover:bg-amber-100/50 border border-amber-200 text-xs font-semibold text-amber-900 transition-colors flex items-center justify-between cursor-pointer"
                    >
                      <span>User B: Badminton Center</span>
                      <ArrowRight className="w-3 h-3 text-amber-700" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
