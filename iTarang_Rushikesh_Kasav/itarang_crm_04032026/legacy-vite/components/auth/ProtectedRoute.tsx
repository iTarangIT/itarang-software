import React from 'react';
import { useAuth } from './AuthProvider';
import type { UserRole } from '../../types';

interface ProtectedRouteProps {
    children: React.ReactNode;
    allowedRoles?: UserRole[];
    fallback?: React.ReactNode;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
    children,
    allowedRoles,
    fallback,
}) => {
    const { user, loading } = useAuth();

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="text-center">
                    <div className="w-16 h-16 border-4 border-primary-200 border-t-primary-600 rounded-full animate-spin mx-auto mb-4"></div>
                    <p className="text-gray-500">Loading...</p>
                </div>
            </div>
        );
    }

    if (!user) {
        return null; // Will be handled by App.tsx to show login
    }

    // Check if user has required role
    if (allowedRoles && allowedRoles.length > 0) {
        const hasRequiredRole = allowedRoles.some(role => user.roles.includes(role));

        if (!hasRequiredRole) {
            return fallback || (
                <div className="flex items-center justify-center min-h-screen bg-gray-50">
                    <div className="text-center p-8 bg-white rounded-2xl shadow-lg max-w-md">
                        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                            <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                        </div>
                        <h2 className="text-2xl font-bold text-gray-900 mb-2">Access Denied</h2>
                        <p className="text-gray-600">
                            You don't have permission to access this page.
                        </p>
                        <p className="text-sm text-gray-500 mt-4">
                            Required role: {allowedRoles.join(' or ')}
                        </p>
                    </div>
                </div>
            );
        }
    }

    return <>{children}</>;
};
