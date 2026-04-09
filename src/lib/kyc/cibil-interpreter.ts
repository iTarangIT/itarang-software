export interface CibilInterpretation {
  rating: "Excellent" | "Good" | "Moderate" | "Poor";
  riskLevel: "low" | "medium" | "high";
  coBorrowerRequired: boolean;
  color: "green" | "blue" | "yellow" | "red";
  description: string;
}

export function interpretCibilScore(score: number): CibilInterpretation {
  if (score >= 750) {
    return {
      rating: "Excellent",
      riskLevel: "low",
      coBorrowerRequired: false,
      color: "green",
      description: "Excellent credit score - Low risk",
    };
  }
  if (score >= 700) {
    return {
      rating: "Good",
      riskLevel: "low",
      coBorrowerRequired: false,
      color: "blue",
      description: "Good credit score - Low risk",
    };
  }
  if (score >= 650) {
    return {
      rating: "Moderate",
      riskLevel: "medium",
      coBorrowerRequired: false,
      color: "yellow",
      description: "Moderate credit score - Medium risk",
    };
  }
  return {
    rating: "Poor",
    riskLevel: "high",
    coBorrowerRequired: true,
    color: "red",
    description: "Poor credit score - High risk, co-borrower required",
  };
}
