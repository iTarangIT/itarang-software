export async function saveCallAttempt(data: any) {
  try {
    console.log("💾 SAVING CALL ATTEMPT");

    console.log({
      leadId: data.leadId,
      phone: data.phone,
      outcome: data.outcome,
      nextCallAt: data.nextCallAt,
      intentScore: data.intentScore,
    });

    // todo: replace with DB insert
  } catch (err) {
    console.error("❌ Failed to save call attempt:", err);
  }
}
