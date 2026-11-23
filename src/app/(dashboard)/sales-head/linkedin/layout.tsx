import type { ReactNode } from "react";

import { LinkedInTabs } from "@/components/linkedin/LinkedInTabs";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";

export const dynamic = "force-dynamic";

// E-393 — LinkedIn Outreach (tasks/linkedin-outreach-dev-plan.md). Sales Head
// and CEO only (doc D8); middleware already limits /sales-head/* to them and
// every page and API route checks again.
export default async function LinkedInLayout({ children }: { children: ReactNode }) {
  await requireRole([...LINKEDIN_ROLES]);
  return (
    <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1600px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">LinkedIn Scraper</h1>
        <p className="mt-1 text-sm text-gray-600">
          Find prospects by keyword, send an approved message at a safe pace, and handle replies in one inbox.
          Nothing is sent without your approval.
        </p>
      </header>
      <LinkedInTabs />
      {children}
    </div>
  );
}
