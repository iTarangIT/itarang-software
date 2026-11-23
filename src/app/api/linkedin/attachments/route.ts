// LinkedIn Outreach — upload a campaign / reply attachment to the CRM's
// private file store. Its sha256 becomes part of the approval hash.
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { saveAttachment } from "@/lib/linkedin/services/attachments";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole([...LINKEDIN_ROLES]);
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return errorResponse("Choose a file", 400);
  const row = await saveAttachment(file, user.id);
  return successResponse({ id: row.id, file_name: row.file_name, size_bytes: row.size_bytes }, 201);
});
