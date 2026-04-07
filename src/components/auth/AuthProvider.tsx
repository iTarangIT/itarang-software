"use client";

import React, {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createClient } from "@/lib/supabase/client";
import { normalizeRole } from "@/lib/roles";

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

  // Dealer onboarding/account fields
  onboarding_status?: string | null;
  review_status?: string | null;
  dealer_account_status?: string | null;
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

  const fetchUser = useCallback(async () => {
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

      const metadataName =
        (typeof authUser.user_metadata?.name === "string" && authUser.user_metadata.name) ||
        authUser.email?.split("@")[0] ||
        "User";
      const metadataRole =
        (typeof authUser.user_metadata?.role === "string" && authUser.user_metadata.role) ||
        (typeof authUser.app_metadata?.role === "string" && authUser.app_metadata.role) ||
        "user";

      setUser({
        id: authUser.id,
        email: authUser.email || "",
        name: metadataName,
        role: normalizeRole(metadataRole),
      });
    } catch (error) {
      console.error("[AuthProvider] Failed to fetch user profile:", error);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

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
  }, [fetchUser, supabase]);

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
