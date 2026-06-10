/**
 * POST /api/nbfc/fi/agents/reference-photo — upload an FI agent reference
 * photo (§10.5/§10.7) for Coordinator selfie comparison. Returns a fileUrl the
 * caller stores on the agent via PATCH /api/nbfc/fi/agents/[agentId].
 *
 * Role: fi_coordinator / nbfc_admin. Local-disk pattern (public/nbfc-uploads),
 * served via the /nbfc-uploads catch-all — standalone-safe.
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
    if (actor.role !== "fi_coordinator" && actor.role !== "nbfc_admin") {
      return NextResponse.json({ ok: false, error: `FORBIDDEN: role '${actor.role}' cannot manage FI agents` }, { status: 403 });
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ ok: false, error: "Expected multipart/form-data body" }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ ok: false, error: "file field is required" }, { status: 422 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: `File exceeds ${MAX_BYTES} bytes` }, { status: 413 });
    }

    const rawName = file.name || "ref";
    const lastDot = rawName.lastIndexOf(".");
    const extCandidate = lastDot >= 0 ? rawName.slice(lastDot + 1).toLowerCase() : "";
    const ext = SAFE_EXT_RE.test(extCandidate) ? extCandidate : "jpg";

    const slug = actor.tenant_id.replace(/[^a-z0-9]/gi, "");
    const filename = `${Date.now()}.${ext}`;
    const key = `fi-agents/${slug}/${filename}`;
    const buf = Buffer.from(await file.arrayBuffer());
    const { url } = await putNbfcObject(key, buf, file.type || `image/${ext === "jpg" ? "jpeg" : ext}`);

    return NextResponse.json({ ok: true, fileUrl: url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.startsWith("UNAUTHORIZED") ? 401 : msg.startsWith("FORBIDDEN") ? 403 : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: code });
  }
}
