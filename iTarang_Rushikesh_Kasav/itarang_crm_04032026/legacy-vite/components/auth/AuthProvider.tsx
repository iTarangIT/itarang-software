import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { signIn as authSignIn, signOut as authSignOut, getCurrentUser, getUserPermissions } from '../../lib/supabase-auth';
import type { AuthContextType, User } from '../../types';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [permissions, setPermissions] = useState<string[]>([]);

    useEffect(() => {
        // Initial check
        checkUser();

        // Listen for auth changes
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            if (session) {
                checkUser();
            } else {
                setUser(null);
                setPermissions([]);
                setLoading(false);
            }
        });

        return () => {
            subscription.unsubscribe();
        };
    }, []);

    async function checkUser() {
        setLoading(true);
        try {
            const currentUser = await getCurrentUser();
            setUser(currentUser);

            if (currentUser) {
                const userPermissions = await getUserPermissions(currentUser.id);
                setPermissions(userPermissions);
            }
        } catch (error) {
            console.error('Error checking user:', error);
            setUser(null);
            setPermissions([]);
        } finally {
            setLoading(false);
        }
    }

    async function signIn(email: string, password: string) {
        setLoading(true);
        try {
            // signIn will trigger onAuthStateChange, which calls checkUser()
            // We return the user from checkUser to be consistent with the Promise
            const { data, error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) throw error;

            // Wait for user profile and permissions to be set by checkUser (via event)
            // Or manually fetch and set if event is slow. 
            // Better to unify:
            const currentUser = await getCurrentUser();
            if (!currentUser) throw new Error('Failed to fetch user profile');

            setUser(currentUser);
            const userPermissions = await getUserPermissions(currentUser.id);
            setPermissions(userPermissions);
        } catch (error) {
            console.error('Sign in error:', error);
            throw error;
        } finally {
            setLoading(false);
        }
    }

    async function signOut() {
        try {
            await authSignOut();
            setUser(null);
            setPermissions([]);
        } catch (error) {
            console.error('Sign out error:', error);
            throw error;
        }
    }

    function hasRole(role: string) {
        return user?.roles.includes(role as any) || false;
    }

    function hasPermission(permission: string) {
        return permissions.includes(permission);
    }

    const value: AuthContextType = {
        user,
        loading,
        signIn,
        signOut,
        hasRole,
        hasPermission,
    };

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}
