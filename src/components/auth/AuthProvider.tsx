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

// Session-scoped profile snapshot. Every hard navigation remounts this
// provider and would otherwise block the whole tree on a fresh
// /api/user/profile round-trip; the snapshot renders immediately while the
// fetch below revalidates in the background. Cleared on sign-out/logout.
// v2: /api/user/profile used to return the whole users row including
// `password_hash`, so every browser that loaded the app cached a bcrypt hash
// here. The server side is fixed (auth-utils.ts USER_COLUMNS), but bumping the
// key is what actually evicts the already-poisoned snapshots — a stale v1 entry
// would otherwise survive for the life of the tab.
const PROFILE_SNAPSHOT_KEY = "itarang:profile:v2";

function readProfileSnapshot(): AppUser | null {
  try {
    const raw = sessionStorage.getItem(PROFILE_SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as AppUser) : null;
  } catch {
    return null;
  }
}

function writeProfileSnapshot(user: AppUser | null) {
  try {
    if (user) sessionStorage.setItem(PROFILE_SNAPSHOT_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(PROFILE_SNAPSHOT_KEY);
  } catch {
    // Storage full/unavailable — snapshot is an optimisation only.
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Don't call supabase.auth.getUser() / getSession() here. The GoTrue v2
  // auth lock can deadlock across hard navigations on the same tab,
  // freezing every subsequent auth call (verified via fiber-tree probe on
  // sandbox: getUser/getSession both timed out at 5s). Authentication is
  // already validated server-side in /api/user/profile via requireAuth(),
  // which reads Supabase SSR cookies and looks up the RDS user, so we just
  // hit that endpoint and trust its answer.
  const fetchUser = async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      if (!silent) setLoading(true);

      const response = await fetch("/api/user/profile", {
        method: "GET",
        cache: "no-store",
        credentials: "include",
      });

      if (response.ok) {
        const json = await response.json();
        const fetched = (json?.data ?? null) as AppUser | null;
        setUser(fetched);
        writeProfileSnapshot(fetched);
        return;
      }

      setUser(null);
      writeProfileSnapshot(null);
    } catch (error) {
      console.error("[AuthProvider] Failed to fetch user profile:", error);
      setUser(null);
      writeProfileSnapshot(null);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    // Hydrate instantly from the session snapshot (if any), then revalidate
    // against the server in the background. A role changed server-side is
    // stale for at most one render — the silent refetch corrects it, and
    // every API route still authorises requests server-side regardless.
    const snapshot = readProfileSnapshot();
    if (snapshot) {
      setUser(snapshot);
      setLoading(false);
      fetchUser({ silent: true });
    } else {
      fetchUser();
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event) => {
      if (event === "SIGNED_OUT") {
        setUser(null);
        writeProfileSnapshot(null);
        return;
      }
      // Only refetch the profile on real identity changes. INITIAL_SESSION
      // is already covered by the initial fetchUser above; TOKEN_REFRESHED
      // doesn't change identity, so refetching wastes a round-trip.
      if (event === "SIGNED_IN" || event === "USER_UPDATED") {
        await fetchUser({ silent: true });
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [supabase]);

  const logout = async () => {
    try {
      setLoading(true);
      setUser(null);
      writeProfileSnapshot(null);
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