import { redirect } from "next/navigation";

// Campaigns were removed from the asm sidebar (Oct 2026): a rep
// sees a lead's AI calls — recording, transcript, intent — on the lead's
// AI Call History tab instead. Old links land on the queue.
export default function RemovedCampaignsPage() {
    redirect("/asm");
}
