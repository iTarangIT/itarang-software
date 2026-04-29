// @ts-nocheck
// Stub: @aws-sdk/client-s3 is not installed. This module is unused (no imports
// of @/lib/s3 anywhere in src/). Install the package and remove this banner if
// S3 storage is ever wired in.
import { S3Client } from "@aws-sdk/client-s3";

export const s3 = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});