import { redirect } from "next/navigation";

/** Risk Head dashboard root → land on the immobilisation Approvals inbox. */
export default function RiskHeadHome() {
  redirect("/risk-head/approvals");
}
