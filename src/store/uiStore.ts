"use client";

import { create } from "zustand";

// Tiny shared open/close switch for the mobile nav drawer. The hamburger in the
// header opens it; the drawer (and tapping any nav link) closes it. Deliberately
// NOT persisted — a fresh page load should always start with the drawer closed.
// Also carries the Change Password modal switch (E-213). That modal is mounted
// ONCE in the root layout and opened from four places — the shared header, the
// NBFC portal header, the Risk Head shell, and the profile page's Security
// card. Local useState in each trigger would mean four modal instances and
// four copies of the open/close wiring.
type UIState = {
  sidebarOpen: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;

  changePasswordOpen: boolean;
  openChangePassword: () => void;
  closeChangePassword: () => void;
};

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: false,
  openSidebar: () => set({ sidebarOpen: true }),
  closeSidebar: () => set({ sidebarOpen: false }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  changePasswordOpen: false,
  openChangePassword: () => set({ changePasswordOpen: true }),
  closeChangePassword: () => set({ changePasswordOpen: false }),
}));
