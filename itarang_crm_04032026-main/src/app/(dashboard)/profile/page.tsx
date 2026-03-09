'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/components/auth/AuthProvider';
import {
    Loader2, User, Mail, Phone, Shield, Building2,
    Key, Eye, EyeOff, CheckCircle2, CreditCard, Calendar
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

type DealerProfile = {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    role: string;
    dealer_id: string | null;
    is_active: boolean;
    created_at: string;
};

type Subscription = {
    id: string;
    plan_name: string;
    status: string;
    started_at: string;
    expires_at: string | null;
};

export default function ProfilePage() {
    const { user } = useAuth();
    const supabase = createClient();
    const [profile, setProfile] = useState<DealerProfile | null>(null);
    const [subscription, setSubscription] = useState<Subscription | null>(null);
    const [loading, setLoading] = useState(true);

    // Change password state
    const [showChangePassword, setShowChangePassword] = useState(false);
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [changingPassword, setChangingPassword] = useState(false);
    const [passwordMessage, setPasswordMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    useEffect(() => {
        const fetchProfile = async () => {
            try {
                const res = await fetch('/api/user/profile');
                const data = await res.json();
                if (data.success) setProfile(data.data);

                const subRes = await fetch('/api/user/subscription');
                const subData = await subRes.json();
                if (subData.success) setSubscription(subData.data);
            } catch { /* silent */ }
            finally { setLoading(false); }
        };
        fetchProfile();
    }, []);

    const handleChangePassword = async () => {
        setPasswordMessage(null);
        if (newPassword.length < 8) {
            setPasswordMessage({ type: 'error', text: 'Password must be at least 8 characters' });
            return;
        }
        if (newPassword !== confirmPassword) {
            setPasswordMessage({ type: 'error', text: 'Passwords do not match' });
            return;
        }
        setChangingPassword(true);
        try {
            const { error } = await supabase.auth.updateUser({ password: newPassword });
            if (error) {
                setPasswordMessage({ type: 'error', text: error.message });
            } else {
                setPasswordMessage({ type: 'success', text: 'Password changed successfully' });
                setCurrentPassword('');
                setNewPassword('');
                setConfirmPassword('');
                setShowChangePassword(false);
            }
        } catch {
            setPasswordMessage({ type: 'error', text: 'Failed to change password' });
        } finally {
            setChangingPassword(false);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-[#1D4ED8]" />
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <div className="max-w-[900px] mx-auto px-6 py-8">
                <header className="mb-8">
                    <h1 className="text-[28px] font-black text-gray-900 tracking-tight">My Profile</h1>
                    <p className="text-sm text-gray-500 mt-1">View and manage your account settings</p>
                </header>

                {/* Profile Card */}
                <div className="bg-white rounded-[20px] border border-gray-100 shadow-sm overflow-hidden mb-6">
                    <div className="bg-gradient-to-r from-[#0047AB] to-[#1D4ED8] px-8 py-8">
                        <div className="flex items-center gap-5">
                            <div className="w-20 h-20 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center text-white text-2xl font-black border-2 border-white/30">
                                {(profile?.name || 'U').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                            </div>
                            <div>
                                <h2 className="text-2xl font-bold text-white">{profile?.name}</h2>
                                <p className="text-blue-100 text-sm mt-1 capitalize">{profile?.role} Account</p>
                                <div className="flex items-center gap-2 mt-2">
                                    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${profile?.is_active ? 'bg-green-400/20 text-green-100' : 'bg-red-400/20 text-red-100'}`}>
                                        {profile?.is_active ? 'Active' : 'Inactive'}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="p-8 grid grid-cols-1 md:grid-cols-2 gap-6">
                        <InfoRow icon={<User className="w-4 h-4" />} label="Full Name" value={profile?.name || '-'} />
                        <InfoRow icon={<Mail className="w-4 h-4" />} label="Email" value={profile?.email || '-'} />
                        <InfoRow icon={<Phone className="w-4 h-4" />} label="Phone" value={profile?.phone || 'Not set'} />
                        <InfoRow icon={<Shield className="w-4 h-4" />} label="Role" value={profile?.role || '-'} />
                        <InfoRow icon={<Building2 className="w-4 h-4" />} label="Dealer ID" value={profile?.dealer_id || 'N/A'} />
                        <InfoRow icon={<Calendar className="w-4 h-4" />} label="Member Since" value={profile?.created_at ? new Date(profile.created_at).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' }) : '-'} />
                    </div>
                </div>

                {/* Subscription Card */}
                <div className="bg-white rounded-[20px] border border-gray-100 shadow-sm p-8 mb-6">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center">
                            <CreditCard className="w-5 h-5 text-purple-600" />
                        </div>
                        <div>
                            <h3 className="font-bold text-gray-900">Subscription</h3>
                            <p className="text-xs text-gray-500">Your current plan and billing status</p>
                        </div>
                    </div>
                    {subscription ? (
                        <div className="flex items-center gap-6">
                            <div className="flex-1">
                                <div className="flex items-center gap-3">
                                    <span className="text-lg font-black text-gray-900 capitalize">{subscription.plan_name} Plan</span>
                                    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${subscription.status === 'active' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                                        {subscription.status}
                                    </span>
                                </div>
                                <p className="text-sm text-gray-500 mt-1">
                                    Started: {new Date(subscription.started_at).toLocaleDateString('en-IN')}
                                    {subscription.expires_at && ` · Expires: ${new Date(subscription.expires_at).toLocaleDateString('en-IN')}`}
                                </p>
                            </div>
                        </div>
                    ) : (
                        <div className="text-sm text-gray-400">No active subscription found</div>
                    )}
                </div>

                {/* Change Password */}
                <div className="bg-white rounded-[20px] border border-gray-100 shadow-sm p-8">
                    <div className="flex items-center justify-between mb-6">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
                                <Key className="w-5 h-5 text-amber-600" />
                            </div>
                            <div>
                                <h3 className="font-bold text-gray-900">Change Password</h3>
                                <p className="text-xs text-gray-500">Update your account password</p>
                            </div>
                        </div>
                        {!showChangePassword && (
                            <button onClick={() => setShowChangePassword(true)} className="px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-100">
                                Change Password
                            </button>
                        )}
                    </div>

                    {passwordMessage && (
                        <div className={`mb-4 p-3 rounded-xl text-sm font-medium ${passwordMessage.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                            {passwordMessage.text}
                        </div>
                    )}

                    {showChangePassword && (
                        <div className="space-y-4">
                            <div className="relative">
                                <input
                                    type={showPassword ? 'text' : 'password'}
                                    value={newPassword}
                                    onChange={e => setNewPassword(e.target.value)}
                                    placeholder="New Password (min 8 characters)"
                                    className="w-full h-11 px-4 pr-12 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]"
                                />
                                <button onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                            <input
                                type={showPassword ? 'text' : 'password'}
                                value={confirmPassword}
                                onChange={e => setConfirmPassword(e.target.value)}
                                placeholder="Confirm New Password"
                                className="w-full h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]"
                            />
                            <div className="flex gap-3">
                                <button onClick={() => { setShowChangePassword(false); setNewPassword(''); setConfirmPassword(''); }} className="px-5 py-2.5 border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-600">
                                    Cancel
                                </button>
                                <button onClick={handleChangePassword} disabled={changingPassword || !newPassword || !confirmPassword} className="px-5 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold disabled:opacity-40 flex items-center gap-2">
                                    {changingPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                                    Update Password
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
    return (
        <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center text-gray-400 mt-0.5">{icon}</div>
            <div>
                <p className="text-xs text-gray-400 font-medium">{label}</p>
                <p className="text-sm font-semibold text-gray-900 capitalize">{value}</p>
            </div>
        </div>
    );
}
