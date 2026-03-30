import { Queue } from "bullmq";
import { connection } from "./connection";

export const callQueue = new Queue("call-queue", {
  connection,
});
