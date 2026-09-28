// /sales-head/analyst — the AI Analyst (Data Analyst agent): ask questions about the business in plain English.
// Shared with /ceo/analyst; see src/components/analyst/AnalystPage.tsx.

import { AnalystPage } from "@/components/analyst/AnalystPage";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI Analyst" };

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <AnalystPage basePath="/sales-head/analyst" searchParams={searchParams} />;
}
