'use client';

import { useState, useEffect } from 'react';
import { Button, Input } from '@headlessui/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getAuthClient } from '@/lib/client/auth-client';
import { useAuthConfig, useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { showPrivacyModal } from '@/components/PrivacyModal';
import { LoadingSpinner } from '@/components/Spinner';
import toast from 'react-hot-toast';

export default function SignUpPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { authEnabled, baseUrl } = useAuthConfig();
  const { refresh: refreshRateLimit } = useAuthRateLimit();

  // Check if auth is enabled, redirect home if not
  useEffect(() => {
    if (!authEnabled) {
      router.push('/app');
    }
  }, [router, authEnabled]);

  const validateEmail = (email: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const validatePassword = (password: string) => {
    const checks = {
      length: password.length >= 8,
      uppercase: /[A-Z]/.test(password),
      lowercase: /[a-z]/.test(password),
      number: /\d/.test(password),
      special: /[!@#$%^&*(),.?":{}|<>]/.test(password)
    };
    const strength = Object.values(checks).filter(Boolean).length;
    return { checks, strength };
  };

  const handleSignUp = async () => {
    setError(null);

    if (!email.trim() || !validateEmail(email)) {
      setError('Please enter a valid email address');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    const { strength } = validatePassword(password);
    if (strength < 3) {
      setError('Password is too weak');
      return;
    }
    if (password !== passwordConfirmation) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);

    try {
      const client = getAuthClient(baseUrl);
      const result = await client.signUp.email({
        email: email.trim(),
        password,
        name: email.trim().split('@')[0], // Use part of email as name
      });

      if (result.error) {
        const errorMessage = result.error.message || 'An unknown error occurred';
        if (errorMessage.toLowerCase().includes('already exists')) {
          setError('An account with this email already exists');
        } else {
          setError(errorMessage);
        }
      } else {
        // Auto sign in
        const signInResult = await client.signIn.email({ email: email.trim(), password });
        if (signInResult.error) {
          toast.success('Account created! Please sign in.');
          router.push('/signin');
        } else {
          await refreshRateLimit();
          toast.success('Account created successfully!');
          router.push('/app');
        }
      }
    } catch (err) {
      console.error('Signup error:', err);
      setError('Unable to connect. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (!authEnabled) {
    return null;
  }

  const { checks, strength } = validatePassword(password);
  const strengthLabels = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong'];
  const strengthColors = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-blue-500', 'bg-green-500'];

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md bg-base rounded-2xl shadow-xl p-6">
        <h1 className="text-xl font-semibold text-foreground">Sign Up</h1>
        <p className="text-sm text-muted mt-1">Create your account to get started</p>

        {error && (
          <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="mt-6 space-y-4">
          {/* Email */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Email</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="me@example.com"
              className="w-full rounded-lg bg-background py-2 px-3 text-foreground shadow-sm 
                       focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          {/* Password */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Password</label>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full rounded-lg bg-background py-2 px-3 pr-10 text-foreground shadow-sm 
                         focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
              >
                {showPassword ? '👁️' : '👁️‍🗨️'}
              </button>
            </div>

            {/* Password Strength */}
            {password && (
              <div className="mt-2 space-y-1">
                <div className="flex gap-1">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      className={`h-1 flex-1 rounded ${i < strength ? strengthColors[strength - 1] : 'bg-offbase'
                        }`}
                    />
                  ))}
                </div>
                <p className={`text-xs ${strength >= 3 ? 'text-green-600' : 'text-red-600'}`}>
                  {strengthLabels[strength - 1] || 'Very Weak'}
                </p>
                <div className="text-xs space-y-0.5 text-muted">
                  {Object.entries(checks).map(([key, passed]) => (
                    <div key={key} className={`flex items-center gap-1 ${passed ? 'text-green-600' : ''}`}>
                      <span>{passed ? '✓' : '○'}</span>
                      <span>
                        {key === 'length' && 'At least 8 characters'}
                        {key === 'uppercase' && 'Uppercase letter'}
                        {key === 'lowercase' && 'Lowercase letter'}
                        {key === 'number' && 'Number'}
                        {key === 'special' && 'Special character'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Confirm Password */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Confirm Password</label>
            <Input
              type={showPassword ? 'text' : 'password'}
              value={passwordConfirmation}
              onChange={(e) => setPasswordConfirmation(e.target.value)}
              placeholder="Confirm Password"
              className="w-full rounded-lg bg-background py-2 px-3 text-foreground shadow-sm 
                       focus:outline-none focus:ring-2 focus:ring-accent"
            />
            {passwordConfirmation && password && (
              <p className={`text-xs mt-1 ${password === passwordConfirmation ? 'text-green-600' : 'text-red-600'}`}>
                {password === passwordConfirmation ? '✓ Passwords match' : '✗ Passwords do not match'}
              </p>
            )}
          </div>

          {/* Sign Up Button */}
          <Button
            type="submit"
            disabled={loading}
            onClick={handleSignUp}
            className="w-full rounded-lg bg-accent py-2 text-sm font-medium text-background 
                     hover:bg-secondary-accent focus:outline-none focus:ring-2 focus:ring-accent 
                     focus:ring-offset-2 disabled:opacity-50 transform transition-transform 
                     duration-200 hover:scale-[1.02]"
          >
            {loading ? <LoadingSpinner className="w-4 h-4 mx-auto" /> : 'Create Account'}
          </Button>
        </div>

        {/* Footer */}
        <div className="mt-6 pt-4 border-t border-offbase text-center space-y-2">
          <p className="text-xs text-muted">
            Already have an account?{' '}
            <Link href="/signin" className="underline hover:text-foreground">
              Sign in
            </Link>
          </p>
          <p className="text-xs text-muted">
            By creating an account, you agree to our{' '}
            <button
              onClick={() => showPrivacyModal({ authEnabled })}
              className="underline hover:text-foreground"
            >
              Privacy Policy
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
