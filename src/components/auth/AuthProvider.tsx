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

  const fetchUser = async () => {
    try {
      setLoading(true);

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
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async () => {
      await fetchUser();
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [supabase]);

  const logout = async () => {
    try {
      setLoading(true);
      await supabase.auth.signOut();
      setUser(null);
      window.location.href = "/login";
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
        refreshUser: fetchUser,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);