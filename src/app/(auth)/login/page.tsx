'use client';

import { useState } from 'react';
import { Mail, Lock, Loader2, Eye, EyeOff } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';

export default function LoginPage() {
    const router = useRouter();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

    const validate = (): boolean => {
        const e: { email?: string; password?: string } = {};
        const trimmedEmail = email.trim().toLowerCase();

        if (!trimmedEmail) {
            e.email = 'Email is required';
        } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
            e.email = 'Enter a valid email address';
        }

        if (!password) {
            e.password = 'Password is required';
        } else if (password.length < 6) {
            e.password = 'Password must be at least 6 characters';
        }

        setErrors(e);
        return Object.keys(e).length === 0;
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!validate()) return;

        setLoading(true);
        setErrors({});

        try {
            const supabase = createClient();
            const { error } = await supabase.auth.signInWithPassword({
                email: email.trim().toLowerCase(),
                password,
            });

            if (error) {
                console.error('[LOGIN] Supabase login failed:', error.message);
                if (error.message.includes('Invalid login')) {
                    toast.error('Invalid email or password. Please try again.');
                } else if (error.message.includes('Email not confirmed')) {
                    toast.error('Please verify your email before signing in.');
                } else {
                    toast.error(error.message || 'Authentication failed. Please try again.');
                }
                setLoading(false);
                return;
            }

            // Check app-level user record
            const profileRes = await fetch('/api/user/profile', {
                method: 'GET',
                cache: 'no-store',
                credentials: 'include',
            });

            if (!profileRes.ok) {
                toast.error('User profile not found. Contact support.');
                await supabase.auth.signOut();
                setLoading(false);
                return;
            }

            const profileData = await profileRes.json();
            const appUser = profileData?.data;

            if (!appUser) {
                toast.error('User record not found. Contact support.');
                await supabase.auth.signOut();
                setLoading(false);
                return;
            }

            if (!appUser.is_active) {
                toast.error('Your account is inactive. Contact your administrator.');
                await supabase.auth.signOut();
                setLoading(false);
                return;
            }

            toast.success(`Welcome back, ${appUser.name || appUser.email}!`);

            if (appUser.must_change_password) {
                router.push('/change-password');
                return;
            }

            if (appUser.role === 'dealer') {
                router.push('/dealer-portal');
            } else if (appUser.role === 'admin') {
                router.push('/admin');
            } else if (appUser.role === 'ceo') {
                router.push('/ceo');
            } else if (appUser.role === 'sales_head') {
                router.push('/sales-head');
            } else if (appUser.role === 'business_head') {
                router.push('/business-head');
            } else if (appUser.role === 'finance_controller') {
                router.push('/finance-controller');
            } else if (appUser.role === 'sales_order_manager') {
                router.push('/sales-order-manager');
            } else if (appUser.role === 'inventory_manager') {
                router.push('/inventory-manager');
            } else if (appUser.role === 'service_engineer') {
                router.push('/service-engineer');
            } else if (appUser.role === 'sales_manager') {
                router.push('/sales-manager');
            } else if (appUser.role === 'sales_executive') {
                router.push('/sales-executive');
            } else {
                router.push('/');
            }
        } catch (err) {
            console.error('[LOGIN] Unexpected error:', err);
            toast.error('Something went wrong. Please check your connection and try again.');
            setLoading(false);
        }
    };

    return (
        <div className="flex min-h-screen bg-white">
            {/* Left Side - Image & Slogan */}
            <div className="hidden lg:flex lg:w-1/2 relative bg-[#F0F8FF] items-center justify-center overflow-hidden">
                <div className="absolute top-12 left-0 right-0 z-10 text-center px-8">
                    <h2 className="text-2xl font-bold text-[#002B49] leading-tight">
                        "Unleash Your Potential with the<br />
                        <span className="text-[#002B49]">Next-Gen E-Rickshaw Battery"</span>
                    </h2>
                </div>
                <div className="relative w-full h-full flex items-end justify-center pb-0">
                    <div className="relative w-[90%] h-[80%]">
                        <Image
                            src="/rickshaw-login.png"
                            alt="Rickshaw Driver and Battery"
                            fill
                            className="object-contain object-bottom"
                            priority
                        />
                    </div>
                </div>
            </div>

            {/* Right Side - Login Form */}
            <div className="w-full lg:w-1/2 flex flex-col justify-center px-8 sm:px-12 lg:px-24 xl:px-32 bg-white">
                <div className="w-full max-w-sm mx-auto">
                    {/* Brand Logo */}
                    <div className="mb-10">
                        <div className="flex items-center gap-3 mb-6">
                            <Image
                                src="/logo-full.png"
                                alt="iTarang Logo"
                                width={180}
                                height={60}
                                className="h-12 w-auto object-contain"
                            />
                        </div>
                        <h1 className="text-3xl font-bold text-gray-900 mb-2">Welcome to iTarang</h1>
                        <p className="text-sm font-medium text-gray-500 uppercase tracking-wide">EVERY THING EV!</p>
                    </div>

                    <form onSubmit={handleLogin} className="space-y-6">
                        <div>
                            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
                                Email address
                            </label>
                            <div className="relative">
                                <input
                                    id="email"
                                    name="email"
                                    type="email"
                                    required
                                    value={email}
                                    onChange={e => { setEmail(e.target.value); if (errors.email) setErrors(prev => ({ ...prev, email: undefined })); }}
                                    disabled={loading}
                                    className={`w-full px-4 py-3 bg-white border rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                                        errors.email ? 'border-red-400' : 'border-gray-200'
                                    }`}
                                    placeholder="name@company.com"
                                />
                                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                                    <Mail className="h-5 w-5 text-gray-400" />
                                </div>
                            </div>
                            {errors.email && <p className="mt-1 text-xs text-red-500 font-medium">{errors.email}</p>}
                        </div>

                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                                    Password
                                </label>
                                <a href="#" className="text-sm font-medium text-blue-600 hover:text-blue-500">
                                    Forgot password?
                                </a>
                            </div>
                            <div className="relative">
                                <input
                                    id="password"
                                    name="password"
                                    type={showPassword ? 'text' : 'password'}
                                    required
                                    value={password}
                                    onChange={e => { setPassword(e.target.value); if (errors.password) setErrors(prev => ({ ...prev, password: undefined })); }}
                                    disabled={loading}
                                    className={`w-full px-4 py-3 pr-20 bg-white border rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                                        errors.password ? 'border-red-400' : 'border-gray-200'
                                    }`}
                                    placeholder="••••••••"
                                />
                                <div className="absolute inset-y-0 right-0 pr-3 flex items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                                        tabIndex={-1}
                                    >
                                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </button>
                                    <Lock className="h-5 w-5 text-gray-400" />
                                </div>
                            </div>
                            {errors.password && <p className="mt-1 text-xs text-red-500 font-medium">{errors.password}</p>}
                        </div>

                        <div className="pt-2">
                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full flex justify-center items-center gap-2 py-3 px-4 border border-transparent rounded-lg shadow-sm text-sm font-semibold text-white bg-[#005596] hover:bg-[#00447a] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                {loading ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        <span>Signing in...</span>
                                    </>
                                ) : (
                                    <span>Sign In</span>
                                )}
                            </button>
                        </div>

                        <div className="relative py-4">
                            <div className="absolute inset-0 flex items-center">
                                <div className="w-full border-t border-gray-200" />
                            </div>
                            <div className="relative flex justify-center text-sm">
                                 <span className="px-2 bg-white text-gray-500">
                                    Don&apos;t have an account?{" "}
                                    <Link
                                        href="/dealer-onboarding"
                                        className="font-medium text-blue-600 hover:text-blue-500"
                                    >
                                    Create one
                                    </Link>
                                </span>
                            </div>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}
