type Decision = {
  status: "qualified" | "warm" | "cold" | "disqualified";
  action: "push_to_crm" | "schedule_call" | "follow_up" | "stop";
};

export function decideNextAction(score: number, outcome?: string): Decision {
  if (outcome === "callback_requested") {
    return { status: "warm", action: "schedule_call" };
  }

  if (score >= 80) {
    return { status: "qualified", action: "push_to_crm" };
  }

  if (score >= 50) {
    return { status: "warm", action: "schedule_call" };
  }

  if (score >= 20) {
    return { status: "cold", action: "follow_up" };
  }

  return { status: "disqualified", action: "stop" };
}
