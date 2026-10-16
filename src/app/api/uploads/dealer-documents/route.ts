import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { isS3Backend, putObject, filesProxyPath } from "@/lib/storage/s3";
import { FRESH_LINK_TTL_SECONDS, publicUploadFolder, safeUploadFileName, signedFilePath } from "@/lib/storage/fileAccess";
import { classifyFile } from "@/lib/storage/fileRules";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUCKET_NAME = "dealer-documents";
// A draft can be resumed days later in the same browser. ID 119: when this
// runs out, the file route offers "Continue my application" (a code to the
// registered mobile gives fresh links) instead of a dead end.
const VIEW_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const file = formData.get("file") as File | null;
    // ID 128: this route needs no login, so it must not write wherever it is
    // told. One lowercase slug (what the wizard sends), never a private folder
    // such as agreements/ — and no "../" to climb with.
    const folder = publicUploadFolder(formData.get("folder") as string | null);

    if (!file) {
      return NextResponse.json(
        { success: false, message: "File is required" },
        { status: 400 }
      );
    }
    if (!folder) {
      return NextResponse.json(
        { success: false, message: "Invalid upload folder" },
        { status: 400 }
      );
    }

    const allowedTypes = [
      "application/pdf",
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
    ];

    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        {
          success: false,
          message: "Only PDF, JPG, JPEG, PNG, WEBP files are allowed",
        },
        { status: 400 }
      );
    }

    // 25 MB — keep in step with proxyClientMaxBodySize in next.config.ts,
    // which must sit above this or the body is truncated before we get here
    // and formData() throws "Failed to parse body as FormData."
    const maxSize = 25 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json(
        {
          success: false,
          message: "You cannot upload a file larger than 25 MB",
        },
        { status: 400 }
      );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const safeFileName = safeUploadFileName(file.name);
    const filePath = `${folder}/${Date.now()}-${randomUUID()}-${safeFileName}`;

    let publicUrl: string;

    if (isS3Backend) {
      await putObject(BUCKET_NAME, filePath, buffer, file.type);
      publicUrl = filesProxyPath(BUCKET_NAME, filePath);
    } else {
      const { error: uploadError } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(filePath, buffer, {
          contentType: file.type,
          upsert: false,
        });

      if (uploadError) {
        console.error("SUPABASE UPLOAD ERROR:", uploadError);

        return NextResponse.json(
          {
            success: false,
            message: uploadError.message || "Failed to upload file",
          },
          { status: 500 }
        );
      }

      const { data: publicUrlData } = supabase.storage
        .from(BUCKET_NAME)
        .getPublicUrl(filePath);
      publicUrl = publicUrlData.publicUrl;
    }

    return NextResponse.json({
      success: true,
      file: {
        name: file.name,
        path: filePath,
        url: publicUrl,
        // ID 119: /api/files needs a login or a signature, and this form has no
        // login. `viewUrl` is a signed link for the uploader to preview the
        // file; store `url`, never `viewUrl`.
        // ID 166: only the pre-login onboarding papers get the 7-day link. Staff
        // uploads through this form (commercials, visit photos) preview with a
        // 15-minute one; afterwards they open under the file rule.
        viewUrl: signedFilePath(
          publicUrl,
          classifyFile(BUCKET_NAME, filePath).kind === "dealer_onboarding" ? VIEW_LINK_TTL_SECONDS : FRESH_LINK_TTL_SECONDS,
        ),
        type: file.type,
        size: file.size,
        bucketName: BUCKET_NAME,
      },
    });
  } catch (error: any) {
    console.error("DEALER DOCUMENT UPLOAD ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Upload failed",
      },
      { status: 500 }
    );
  }
}