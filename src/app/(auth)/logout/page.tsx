'use client';

import { useEffect } from 'react';

export default function LogoutPage() {
    useEffect(() => {
        // Hand off to the fast cookie-clearing route.
        window.location.href = '/api/auth/logout';
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
