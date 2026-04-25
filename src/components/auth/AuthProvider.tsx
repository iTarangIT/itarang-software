"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type AppUser = {
  id: string;
  email: string;
  role: string;
  name?: string | null;
  dealer_id?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
  must_change_password?: boolean;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
};

interface AuthContextType {
  user: AppUser | null;
  loading: boolean;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  refreshUser: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUser = async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      if (!silent) setLoading(true);

      const {
        data: { user: authUser },
      } = await supabase.auth.getUser();

      if (!authUser) {
        setUser(null);
        return;
      }

      const response = await fetch("/api/user/profile", {
        method: "GET",
        cache: "no-store",
        credentials: "include",
      });

      if (response.ok) {
        const json = await response.json();
        setUser(json?.data ?? null);
        return;
      }

      setUser({
        id: authUser.id,
        email: authUser.email || "",
        role: "user",
      });
    } catch (error) {
      console.error("[AuthProvider] Failed to fetch user profile:", error);
      setUser(null);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event) => {
      if (event === "SIGNED_OUT") {
        setUser(null);
        return;
      }
      // INITIAL_SESSION fires immediately on subscribe and races the
      // initial fetchUser() above — both call supabase.auth.getUser(),
      // which serializes through the GoTrue auth lock and can deadlock,
      // leaving the dashboard stuck on its loading state. TOKEN_REFRESHED
      // doesn't change identity, so re-fetching the profile on it is
      // wasted work. Only refetch on real identity changes.
      if (event === "SIGNED_IN" || event === "USER_UPDATED") {
        await fetchUser({ silent: true });
      }
    });

    return () => {
      subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  const logout = async () => {
    try {
      setLoading(true);
      setUser(null);
      // Route through /api/auth/logout — relative, hits the current public
      // host. Server clears sb-* cookies and redirects to /login using
      // X-Forwarded-Host so browsers never land on the internal upstream.
      window.location.href = "/api/auth/logout";
    } catch (error) {
      console.error("[AuthProvider] Logout failed:", error);
      setLoading(false);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        refreshUser: () => fetchUser({ silent: true }),
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);