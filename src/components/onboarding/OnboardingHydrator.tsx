"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useOnboardingStore } from "@/store/onboardingStore";

// When the wizard is opened as /dealer-onboarding?applicationId=<id> (internal
// staff continuing a converted lead — BRD §0.13), fetch that application and
// pre-fill the store. No-op for normal dealer self-service (no applicationId).
export default function OnboardingHydrator() {
  const searchParams = useSearchParams();
  const applicationId = searchParams.get("applicationId");
  const hydrateFromApplication = useOnboardingStore(
    (s) => s.hydrateFromApplication
  );
  const [loading, setLoading] = useState(false);
  const loadedId = useRef<string | null>(null);

  useEffect(() => {
    if (!applicationId || loadedId.current === applicationId) return;
    loadedId.current = applicationId;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/dealer-onboarding/${encodeURIComponent(applicationId)}`,
          { cache: "no-store" }
        );
        const json = await res.json();
        if (json?.success && json.application) {
          hydrateFromApplication(json.application, json.documents ?? []);
        }
      } catch (err) {
        console.error("[onboarding] hydrate from application failed:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [applicationId, hydrateFromApplication]);

  if (!loading) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/70 backdrop-blur-sm">
      <div className="flex items-center gap-3 text-slate-600">
        <svg
          className="h-5 w-5 animate-spin text-[#1F5C8F]"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M8 2a6 6 0 1 0 6 6" strokeLinecap="round" />
        </svg>
        Loading onboarding from the converted lead…
      </div>
    </div>
  );
}
