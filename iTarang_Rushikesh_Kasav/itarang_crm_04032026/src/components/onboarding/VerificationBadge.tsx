import { VerificationState } from "./onboardingTypes";

export default function VerificationBadge({ status }: { status: VerificationState }) {
  const map = {
    idle: "bg-gray-100 text-gray-600",
    uploading: "bg-blue-100 text-blue-700",
    processing: "bg-amber-100 text-amber-700",
    verified: "bg-green-100 text-green-700",
    rejected: "bg-red-100 text-red-700",
    reupload: "bg-orange-100 text-orange-700",
  };

  const labelMap = {
    idle: "Not Uploaded",
    uploading: "Uploading",
    processing: "Processing",
    verified: "Verified",
    rejected: "Rejected",
    reupload: "Needs Re-upload",
  };

  return (
    <span className={`inline-flex px-3 py-1 rounded-full text-xs font-semibold ${map[status]}`}>
      {labelMap[status]}
    </span>
  );
}