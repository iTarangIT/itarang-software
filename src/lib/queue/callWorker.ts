import "dotenv/config";
import { Worker } from "bullmq";
import { connection } from "./connection";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";

new Worker(
  "call-queue",
  async (job) => {
    const { phone, leadId } = job.data;
    console.log("PROCESSING JOB:", job.data);

    await triggerBolnaCall({
      phone,
      leadId,
    });
  },
  {
    connection,
  },
);
