"use client";

import { create } from "zustand";

// Tiny shared open/close switch for the mobile nav drawer. The hamburger in the
// header opens it; the drawer (and tapping any nav link) closes it. Deliberately
// NOT persisted — a fresh page load should always start with the drawer closed.
type UIState = {
  sidebarOpen: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;
};

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: false,
  openSidebar: () => set({ sidebarOpen: true }),
  closeSidebar: () => set({ sidebarOpen: false }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));
