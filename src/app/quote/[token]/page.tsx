"use client";

// E-243 — the dealer's response page for a LEAD quotation. The page itself is
// ../QuoteResponseView (shared with the account link, /quote/a/[token]).
import { useParams } from "next/navigation";
import { QuoteResponseView } from "../QuoteResponseView";

export default function QuoteResponsePage() {
  const params = useParams<{ token: string }>();
  return <QuoteResponseView token={params?.token ?? ""} apiBase="/api/public/quotations" />;
}
