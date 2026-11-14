"use client";

// Opens the browser's print dialog once the transcript has rendered ("Print / Save as PDF").

import { useEffect } from "react";

export function PrintNow() {
  useEffect(() => {
    const timer = setTimeout(() => window.print(), 400);
    return () => clearTimeout(timer);
  }, []);
  return null;
}
