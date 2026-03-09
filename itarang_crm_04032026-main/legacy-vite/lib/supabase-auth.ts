import { supabase } from './supabase';
import type { User, UserRole } from '../types';

/**
 * Sign in with email and password
 */
export async function signIn(email: string, password: string): Promise<User> {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
    });

    if (authError) throw authError;
    if (!authData.user) throw new Error('No user returned from authentication');

    // Fetch user profile and roles
    const user = await getCurrentUser();
    if (!user) throw new Error('Failed to fetch user profile');

    return user;
}

/**
 * Sign out current user
 */
export async function signOut(): Promise<void> {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
}

/**
 * Get current authenticated user with roles
 */
export async function getCurrentUser(): Promise<User | null> {
    const { data: { user: authUser } } = await supabase.auth.getUser();

    if (!authUser) return null;

    // Fetch user profile
    const { data: profile, error: profileError } = await supabase
        .from('users')
        .select('*')
        .eq('id', authUser.id)
        .single();

    if (profileError) {
        console.error('Error fetching user profile:', profileError);
        return null;
    }

    // Fetch user roles
    const { data: userRoles, error: rolesError } = await supabase
        .from('user_roles')
        .select(`
      roles (
        name
      )
    `)
        .eq('user_id', authUser.id);

    if (rolesError) {
        console.error('Error fetching user roles:', rolesError);
        return null;
    }

    const roles = userRoles?.map((ur: any) => ur.roles.name as UserRole) || [];

    return {
        id: profile.id,
        email: profile.email,
        full_name: profile.full_name,
        phone: profile.phone,
        roles,
        created_at: profile.created_at,
    };
}

/**
 * Get user roles for a specific user ID
 */
export async function getUserRoles(userId: string): Promise<UserRole[]> {
    const { data, error } = await supabase
        .from('user_roles')
        .select(`
      roles (
        name
      )
    `)
        .eq('user_id', userId);

    if (error) {
        console.error('Error fetching user roles:', error);
        return [];
    }

    return data?.map((ur: any) => ur.roles.name as UserRole) || [];
}

/**
 * Check if user has a specific role
 */
export function hasRole(user: User | null, roleName: UserRole): boolean {
    if (!user) return false;
    return user.roles.includes(roleName);
}

/**
 * Check if user has any of the specified roles
 */
export function hasAnyRole(user: User | null, roleNames: UserRole[]): boolean {
    if (!user) return false;
    return roleNames.some(role => user.roles.includes(role));
}

/**
 * Get user permissions based on roles
 */
export async function getUserPermissions(userId: string): Promise<string[]> {
    const { data, error } = await supabase
        .from('user_roles')
        .select(`
      roles (
        role_permissions (
          permissions (
            name
          )
        )
      )
    `)
        .eq('user_id', userId);

    if (error) {
        console.error('Error fetching user permissions:', error);
        return [];
    }

    const permissions = new Set<string>();
    data?.forEach((ur: any) => {
        ur.roles.role_permissions?.forEach((rp: any) => {
            permissions.add(rp.permissions.name);
        });
    });

    return Array.from(permissions);
}

/**
 * Check if user has a specific permission
 */
export async function hasPermission(userId: string, permissionName: string): Promise<boolean> {
    const permissions = await getUserPermissions(userId);
    return permissions.includes(permissionName);
}

/**
 * Log authentication event
 */
export async function logAuthEvent(
    userId: string | null,
    eventType: string,
    metadata?: Record<string, any>
): Promise<void> {
    try {
        await supabase.from('auth_audit_log').insert({
            user_id: userId,
            event_type: eventType,
            metadata: metadata || {},
        });
    } catch (error) {
        console.error('Error logging auth event:', error);
    }
}
