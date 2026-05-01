/**
 * E-036 — Recovery pipeline page.
 *
 * Renders the RecoveryPipelineBoard which fetches /api/nbfc/recovery on the
 * client and supports stage transitions via /api/nbfc/recovery/[id]/stage.
 */
import { RecoveryPipelineBoard } from "@/components/nbfc-portal/RecoveryPipelineBoard";

export default function RecoveryPage() {
  return <RecoveryPipelineBoard />;
}
