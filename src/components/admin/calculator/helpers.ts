// Client-safe helpers for the calculator admin console (no server imports).

export const paiseToRupees = (p: number | string | null | undefined) =>
  p == null ? 0 : Number(p) / 100;
export const rupeesToPaise = (r: number) => Math.round(r * 100);
export const inr = (paise: number | string | null | undefined) =>
  "₹" + Math.round(paiseToRupees(paise)).toLocaleString("en-IN");

export async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || "Request failed");
  return data.data as T;
}

export const inputCls =
  "w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-gray-400 focus:bg-white";
