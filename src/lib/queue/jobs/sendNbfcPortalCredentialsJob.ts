/**
 * E-002 — Email job: send NBFC portal credentials to primary_contact_email.
 *
 * The activation route enqueues a job here when the NBFC flips from approved
 * to active. The actual SMTP send is intentionally out of scope of this loop;
 * the Bull queue + job descriptor exposes the contract that the email worker
 * (or downstream Resend/Postmark integration) will consume.
 *
 * Tests assert that `enqueueNbfcPortalCredentialsJob` is invoked with the
 * primary_contact_email and the freshly generated password — using the
 * exported in-memory recorder when `NBFC_PORTAL_EMAIL_INMEMORY=1` is set.
 */
import { Queue } from "bullmq";
import { connection } from "../connection";

export type NbfcPortalCredentialJob = {
  nbfcId: number;
  credentialId: string;
  toEmail: string;
  password: string;
  supabaseUserId: string;
};

const QUEUE_NAME = "nbfc-portal-credentials";

let _queue: Queue<NbfcPortalCredentialJob> | null = null;

function getQueue(): Queue<NbfcPortalCredentialJob> {
  if (_queue) return _queue;
  _queue = new Queue<NbfcPortalCredentialJob>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
  });
  return _queue;
}

// In-memory recorder used by tests — avoids touching Redis. Activates when
// NBFC_PORTAL_EMAIL_INMEMORY=1 (set by the loop test runner).
export const __inMemoryNbfcCredentialJobs: NbfcPortalCredentialJob[] = [];

function isInMemoryMode(): boolean {
  return process.env.NBFC_PORTAL_EMAIL_INMEMORY === "1";
}

export async function enqueueNbfcPortalCredentialsJob(
  payload: NbfcPortalCredentialJob,
): Promise<{ id: string }> {
  if (isInMemoryMode()) {
    __inMemoryNbfcCredentialJobs.push(payload);
    return { id: `inmem-${__inMemoryNbfcCredentialJobs.length}` };
  }
  const job = await getQueue().add("send-portal-credentials", payload, {
    jobId: payload.credentialId,
  });
  return { id: String(job.id) };
}

export function __resetInMemoryNbfcCredentialJobs() {
  __inMemoryNbfcCredentialJobs.length = 0;
}
