"use client";

import { useState } from "react";
import { Phone, PhoneCall, CheckCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CallButtonProps {
  leadId: string;
  phone: string;
  disabled?: boolean;
}

type CallState = "idle" | "calling" | "success" | "error";

export function CallButton({ leadId, phone, disabled }: CallButtonProps) {
  const [state, setState] = useState<CallState>("idle");

  const handleCall = async () => {
    if (state === "calling" || disabled) return;

    setState("calling");

    try {
      const res = await fetch("/api/bolna/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, leadId }),
      });

      const data = await res.json();

      if (data.success) {
        setState("success");
        setTimeout(() => setState("idle"), 3000);
      } else {
        setState("error");
        setTimeout(() => setState("idle"), 3000);
      }
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 3000);
    }
  };

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={handleCall}
      disabled={disabled || state === "calling"}
      className={`
        flex items-center gap-2 transition-all duration-200
        ${state === "idle" ? "text-brand-600 border-brand-200 hover:bg-brand-50" : ""}
        ${state === "calling" ? "bg-orange-50 text-orange-600 border-orange-200" : ""}
        ${state === "success" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : ""}
        ${state === "error" ? "bg-red-50 text-red-600 border-red-200" : ""}
        ${disabled ? "opacity-40 cursor-not-allowed" : ""}
      `}
    >
      {state === "idle" && (
        <>
          <Phone className="w-3.5 h-3.5" /> Call
        </>
      )}
      {state === "calling" && (
        <>
          <PhoneCall className="w-3.5 h-3.5 animate-pulse" /> Calling...
        </>
      )}
      {state === "success" && (
        <>
          <CheckCircle className="w-3.5 h-3.5" /> Called!
        </>
      )}
      {state === "error" && (
        <>
          <XCircle className="w-3.5 h-3.5" /> Failed
        </>
      )}
    </Button>
  );
}
