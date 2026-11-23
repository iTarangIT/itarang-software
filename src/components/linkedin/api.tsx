"use client";

// Client fetch helper for /api/linkedin/* — unwraps { success, data } and
// throws the server's own message on failure.
export async function liFetch<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
  const res = await fetch(url, {
    ...init,
    headers: isForm ? init.headers : { "Content-Type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  });
  let body: { success?: boolean; data?: T; error?: { message?: string } | string } = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok || body.success === false) {
    const msg = typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(msg || `Request failed (${res.status})`);
  }
  return body.data as T;
}

export const json = (v: unknown): RequestInit => ({ body: JSON.stringify(v) });

export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

export const STATE_LABEL: Record<string, string> = {
  selected: "Selected",
  approved: "Approved",
  queued: "Queued",
  invite_sent: "Invite sent",
  accepted: "Accepted",
  message_sent: "Sent",
  seen: "Seen",
  replied: "Replied",
  invite_expired: "Invite expired",
  failed: "Failed",
  stopped: "Stopped",
};

export const STATE_TONE: Record<string, string> = {
  selected: "bg-gray-100 text-gray-700",
  approved: "bg-blue-50 text-blue-700",
  queued: "bg-blue-50 text-blue-700",
  invite_sent: "bg-amber-50 text-amber-700",
  accepted: "bg-indigo-50 text-indigo-700",
  message_sent: "bg-teal-50 text-teal-700",
  seen: "bg-teal-50 text-teal-700",
  replied: "bg-green-50 text-green-700",
  invite_expired: "bg-gray-100 text-gray-500",
  failed: "bg-red-50 text-red-700",
  stopped: "bg-gray-100 text-gray-500",
};

export function StateBadge({ state }: { state: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATE_TONE[state] ?? "bg-gray-100 text-gray-700"}`}>
      {STATE_LABEL[state] ?? state}
    </span>
  );
}
