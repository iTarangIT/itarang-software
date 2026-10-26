"use client";

// E-356 — the account's response page for an ACCOUNT quotation (signed link
// from the quotation email / WhatsApp). Same page as a lead quotation's.
import { useParams } from "next/navigation";
import { QuoteResponseView } from "../../QuoteResponseView";

export default function AccountQuoteResponsePage() {
  const params = useParams<{ token: string }>();
  return <QuoteResponseView token={params?.token ?? ""} apiBase="/api/public/account-quotations" />;
}
