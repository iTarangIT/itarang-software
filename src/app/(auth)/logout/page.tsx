
'use client';

import { useEffect } from 'react';
import { signOut } from './actions';

export default function LogoutPage() {
    useEffect(() => {
        const performLogout = async () => {
            await signOut();
        };
        performLogout();
    }, []);

    return (
        <div className="flex items-center justify-center min-h-screen bg-gray-50">
            <div className="text-center">
                <p className="text-gray-500 mb-2">Signing out...</p>
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600 mx-auto"></div>
            </div>
        </div>
    );
}
