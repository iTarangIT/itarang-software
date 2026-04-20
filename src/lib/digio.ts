import { Buffer } from "node:buffer";

const DIGIO_BASE_URL = process.env.DIGIO_BASE_URL!;
const DIGIO_CLIENT_ID = process.env.DIGIO_CLIENT_ID!;
const DIGIO_CLIENT_SECRET = process.env.DIGIO_CLIENT_SECRET!;

function getDigioAuthHeader() {
  const token = Buffer.from(
    `${DIGIO_CLIENT_ID}:${DIGIO_CLIENT_SECRET}`
  ).toString("base64");

  return `Basic ${token}`;
}

function isPdfBuffer(buf: ArrayBuffer) {
  if (buf.byteLength < 500) return false;
  const head = new Uint8Array(buf, 0, 5);
  return (
    head[0] === 0x25 &&
    head[1] === 0x50 &&
    head[2] === 0x44 &&
    head[3] === 0x46 &&
    head[4] === 0x2d
  );
}

type AuditTrailAttempt = { url: string; status: number; statusText: string; body: string };

function pickFirstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

async function fetchDigioDocumentMetadata(base: string, id: string) {
  const urls = [
    `${base}/v2/client/document/${encodeURIComponent(id)}`,
    `${base}/v2/client/document/${encodeURIComponent(id)}/status`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: getDigioAuthHeader(),
          Accept: "application/json",
        },
        cache: "no-store",
      });

      if (!res.ok) {
        console.warn(`[DIGIO AUDIT TRAIL META] ${res.status} @ ${url}`);
        continue;
      }

      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("json")) continue;

      const data = await res.json().catch(() => null);
      if (!data) continue;

      return data as Record<string, unknown>;
    } catch (err: any) {
      console.warn(`[DIGIO AUDIT TRAIL META] error @ ${url}:`, err?.message);
    }
  }

  return null;
}

/**
 * Public helper — fetches the full Digio document record with signing_parties.
 * Used by the local audit-trail generator to populate per-signer IP/browser/ESP/etc.
 */
export async function fetchDigioDocumentStatus(documentId: string) {
  if (!documentId) return null;
  const base = DIGIO_BASE_URL.replace(/\/$/, "");
  return await fetchDigioDocumentMetadata(base, documentId.trim());
}

/**
 * Fetches Digio's per-document audit log (JSON).
 * Endpoint confirmed by Digio support on 2026-04-17:
 *   GET /v2/client/document/{documentId}/audit_log
 *   Headers: Authorization: Basic ..., Content-Type: application/json, cache-control: no-cache
 * Returns parsed JSON or null on any failure.
 */
export async function fetchDigioAuditLogJson(documentId: string): Promise<Record<string, unknown> | null> {
  if (!documentId) return null;
  const base = DIGIO_BASE_URL.replace(/\/$/, "");
  const url = `${base}/v2/client/document/${encodeURIComponent(documentId.trim())}/audit_log`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: getDigioAuthHeader(),
        "Content-Type": "application/json",
        "cache-control": "no-cache",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[DIGIO AUDIT LOG JSON] ${res.status} ${res.statusText} @ ${url}`,
        body.slice(0, 300)
      );
      return null;
    }

    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) {
      const body = await res.text().catch(() => "");
      console.warn(`[DIGIO AUDIT LOG JSON] Non-JSON response (${ct}) @ ${url}`, body.slice(0, 300));
      return null;
    }

    const data = await res.json().catch(() => null);
    if (data) {
      console.log(
        `[DIGIO AUDIT LOG JSON] Success @ ${url}, keys:`,
        Object.keys(data)
      );
      return data as Record<string, unknown>;
    }
  } catch (err: any) {
    console.warn(`[DIGIO AUDIT LOG JSON] error @ ${url}:`, err?.message);
  }
  return null;
}

async function tryDownloadPdfFromUrl(
  url: string,
  attempts: AuditTrailAttempt[]
): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: getDigioAuthHeader(),
      Accept: "*/*",
    },
    cache: "no-store",
  });

  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.warn(`[DIGIO AUDIT TRAIL] ${response.status} ${response.statusText} @ ${url}`, body.slice(0, 300));
    attempts.push({ url, status: response.status, statusText: response.statusText, body: body.slice(0, 300) });
    return null;
  }

  if (contentType.includes("json")) {
    const body = await response.text().catch(() => "");
    console.warn(`[DIGIO AUDIT TRAIL] JSON response @ ${url}`, body.slice(0, 300));
    attempts.push({ url, status: response.status, statusText: "JSON instead of PDF", body: body.slice(0, 300) });
    return null;
  }

  const arrayBuffer = await response.arrayBuffer();

  if (!isPdfBuffer(arrayBuffer)) {
    console.warn(`[DIGIO AUDIT TRAIL] Not a valid PDF @ ${url}, size=`, arrayBuffer.byteLength);
    attempts.push({ url, status: response.status, statusText: `Invalid PDF (size=${arrayBuffer.byteLength})`, body: "" });
    return null;
  }

  console.log(`[DIGIO AUDIT TRAIL] Success @ ${url} (size=${arrayBuffer.byteLength})`);
  return { buffer: arrayBuffer, contentType: contentType || "application/pdf" };
}

export async function downloadDigioAuditTrail(
  documentId: string,
  options?: { alternateIds?: (string | null | undefined)[] }
) {
  if (!documentId) {
    throw new Error("Digio documentId is required");
  }

  const base = DIGIO_BASE_URL.replace(/\/$/, "");
  const ids = Array.from(
    new Set(
      [documentId, ...(options?.alternateIds || [])]
        .map((v) => (v ? String(v).trim() : ""))
        .filter(Boolean)
    )
  );

  const attempts: AuditTrailAttempt[] = [];

  // Step 1: Query Digio document metadata to discover audit-trail URL/ID
  for (const id of ids) {
    const meta = await fetchDigioDocumentMetadata(base, id);
    if (!meta) continue;

    console.log(`[DIGIO AUDIT TRAIL META] Fetched metadata for ${id}, keys:`, Object.keys(meta));

    const auditUrl = pickFirstString(
      meta["audit_trail_url"],
      meta["audit_trail_file_url"],
      meta["auditTrailUrl"],
      meta["audit_file_url"],
      meta["audit_url"],
      (meta["audit_trail"] as any)?.url,
      (meta["audit_trail"] as any)?.file_url
    );

    if (auditUrl) {
      console.log(`[DIGIO AUDIT TRAIL] Discovered audit URL in metadata: ${auditUrl}`);
      const result = await tryDownloadPdfFromUrl(auditUrl, attempts);
      if (result) {
        return {
          buffer: Buffer.from(result.buffer),
          contentType: result.contentType,
        };
      }
    }

    const auditDocId = pickFirstString(
      meta["audit_trail_document_id"],
      meta["audit_trail_doc_id"],
      meta["auditDocumentId"],
      (meta["audit_trail"] as any)?.document_id,
      (meta["audit_trail"] as any)?.id
    );

    if (auditDocId && auditDocId !== id) {
      ids.push(auditDocId);
      console.log(`[DIGIO AUDIT TRAIL] Discovered audit doc id: ${auditDocId}`);
    }
  }

  // Step 2: Fall back to direct audit-trail endpoint variants.
  // Digio's /audit_log endpoint returns JSON (not a PDF) — tryDownloadPdfFromUrl will
  // correctly reject those, so we keep only the variants that can plausibly return a PDF.
  const buildUrls = (id: string) => {
    const enc = encodeURIComponent(id);
    return [
      `${base}/v2/client/document/${enc}/download_audit_trail`,
      `${base}/v2/client/document/download_audit_trail?document_id=${enc}`,
    ];
  };

  for (const id of ids) {
    for (const url of buildUrls(id)) {
      const result = await tryDownloadPdfFromUrl(url, attempts);
      if (result) {
        return {
          buffer: Buffer.from(result.buffer),
          contentType: result.contentType,
        };
      }
    }
  }

  const lastStatus = attempts[attempts.length - 1]?.status || 404;
  const summary = attempts
    .map((a) => `${a.status} ${a.statusText} @ ${a.url}`)
    .join(" | ");

  const allEntityNotFound = attempts.every(
    (a) =>
      a.status === 404 &&
      (a.body.includes("ENTITY_NOT_FOUND") || a.body.includes("Entity not found"))
  );

  const friendly = allEntityNotFound
    ? "Audit trail is not available for this agreement on Digio. This typically happens when signers used the 'electronic signature' method or when the Digio account does not generate audit trails for this document type. Check the Digio dashboard to confirm."
    : `Digio audit trail download failed after ${attempts.length} attempts.`;

  const err = new Error(`${friendly} ${summary}`) as Error & {
    attempts: AuditTrailAttempt[];
    lastStatus: number;
    entityNotFound: boolean;
  };
  err.attempts = attempts;
  err.lastStatus = lastStatus;
  err.entityNotFound = allEntityNotFound;
  throw err;
}
