"use client";

import type { ActionName, Seat, Status } from "@/lib/feature-requests/workflow";

export type ListItem = {
  id: string;
  code: string;
  title: string;
  priority: string;
  module: string;
  status: Status;
  current_owner_name: string | null;
  assigned_developer_name: string | null;
  created_by_name: string | null;
  revision: number;
  updated_at: string;
};

export type Attachment = {
  id: string;
  comment_id: string | null;
  file_name: string;
  mime_type: string | null;
  size_bytes: number;
  uploaded_by_name: string | null;
  created_at: string;
};

export type Comment = {
  id: string;
  parent_id: string | null;
  author_id: string;
  author_name: string | null;
  author_role: string;
  body: string;
  kind: string;
  edited_at: string | null;
  created_at: string;
  edits: { previous_body: string; edited_at: string; edited_by_name: string | null }[];
};

export type Detail = {
  me: { id: string; seat: Seat; name: string };
  request: {
    id: string;
    code: string;
    title: string;
    description: string;
    priority: string;
    module: string;
    status: Status;
    revision: number;
    resubmit_to_status: Status | null;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    created_by_name: string | null;
    current_owner_name: string | null;
    assigned_developer_name: string | null;
  };
  comments: Comment[];
  attachments: Attachment[];
  events: {
    id: string;
    action: string;
    actor_id: string;
    from_status: Status | null;
    to_status: Status | null;
    actor_name: string | null;
    target_name: string | null;
    note: string | null;
    created_at: string;
  }[];
  members: { id: string; name: string; seat: Seat }[];
  actions: ActionName[];
  canEdit: boolean;
  nextStatuses: Status[];
};

/** fetch + the house { success, data, error } envelope → data or a thrown Error. */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init });
  let j: { success?: boolean; data?: T; error?: { message?: string } } | null = null;
  try {
    j = await r.json();
  } catch {
    // non-JSON (e.g. an nginx error page)
  }
  if (!r.ok || !j?.success) throw new Error(j?.error?.message || `Request failed (${r.status})`);
  return j.data as T;
}

export function postJson<T>(url: string, body: unknown, method = "POST"): Promise<T> {
  return api<T>(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export type UploadedFile = { id: string; file_name: string; size_bytes: number; mime_type: string | null };

export function uploadFile(file: File): Promise<UploadedFile> {
  const form = new FormData();
  form.append("file", file);
  return api<UploadedFile>("/api/feature-requests/uploads", { method: "POST", body: form });
}

export const MODULE_SUGGESTIONS = [
  "Leads",
  "Dealer Onboarding",
  "KYC",
  "AI Dialer",
  "Scraper",
  "Buyback",
  "Inventory",
  "Finance / Expenses",
  "CEO Dashboard",
  "IoT / Intellicar",
  "WhatsApp Assistant",
  "Other",
];

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDateTime(s: string): string {
  return new Date(s).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function attachmentUrl(id: string, inline = false): string {
  return `/api/feature-requests/attachments/${id}${inline ? "?inline=1" : ""}`;
}
