// Cron routes refuse any caller without `Bearer $CRON_SECRET`, in every
// environment (tracker ID 130) — specs that poke a job must send it.
export function cronAuth(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` };
}
