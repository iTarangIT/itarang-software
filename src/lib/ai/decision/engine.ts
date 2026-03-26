export function decideNextAction(score: number) {
  if (score >= 75) {
    return {
      status: "hot",
      action: "push_to_crm",
    };
  }

  if (score >= 40) {
    return {
      status: "warm",
      action: "schedule_call",
    };
  }

  if (score >= 10) {
    return {
      status: "cold",
      action: "follow_up",
    };
  }

  return {
    status: "disqualified",
    action: "stop",
  };
}
