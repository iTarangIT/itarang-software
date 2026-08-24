/**
 * E-262 — POST /api/nbfc/recovery/agents/reference-photo
 *
 * A photograph of the recovery agent, so the reviewer looking at the selfie
 * that came back from the doorstep has something to compare it against. Returns
 * a `fileUrl` the caller stores on the agent via POST/PATCH of the agent row —
 * this route does not touch the directory itself.
 *
 * Same shape as the FI equivalent: same 8 MB ceiling, same extension
 * allow-list, same `nbfc-documents` bucket behind `putNbfcObject`, served by
 * the /nbfc-uploads catch-all so it is standalone-safe.
 *
 * These images stay in `nbfc-documents` and are NEVER promoted to a battery's
 * `image_urls` — that column is `/api/files/...` paths a dealer's lot photo is
 * read from, and a picture of an employee has no business there.
 */
import { NextRequest, NextResponse } from "next/server";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { putNbfcObject } from "@/lib/nbfc/nbfc-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const SAFE_EXT_RE = /^[a-z0-9]{1,8}$/i;

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (!actor.can("recovery.manage_agents")) {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: role '${actor.role}' cannot manage recovery agents`,
        },
        { status: 403 },
      );
    }

    // Reject on the declared length before parsing. `formData()` buffers the
    // whole body into heap, and sandbox and production share one box.
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BYTES + 4096) {
      return NextResponse.json(
        { ok: false, error: `Upload exceeds ${MAX_BYTES} bytes` },
        { status: 413 },
      );
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Expected multipart/form-data body" },
        { status: 400 },
      );
    }

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json(
        { ok: false, error: "file field is required" },
        { status: 422 },
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { ok: false, error: `File exceeds ${MAX_BYTES} bytes` },
        { status: 413 },
      );
    }

    const rawName = file.name || "ref";
    const lastDot = rawName.lastIndexOf(".");
    const extCandidate = lastDot >= 0 ? rawName.slice(lastDot + 1).toLowerCase() : "";
    const ext = SAFE_EXT_RE.test(extCandidate) ? extCandidate : "jpg";

    const slug = actor.tenant_id.replace(/[^a-z0-9]/gi, "");
    const key = `recovery-agents/${slug}/${Date.now()}.${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    const { url } = await putNbfcObject(
      key,
      buf,
      file.type || `image/${ext === "jpg" ? "jpeg" : ext}`,
    );

    return NextResponse.json({ ok: true, fileUrl: url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.startsWith("UNAUTHORIZED")
      ? 401
      : msg.startsWith("FORBIDDEN")
        ? 403
        : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: code });
  }
}
