"use client";

import { useState } from "react";
import { Phone, PhoneCall, CheckCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type Provider = "bolna" | "elevenlabs";

interface CallButtonProps {
  leadId: string;
  phone: string;
  disabled?: boolean;
  provider?: Provider;
  /** Side-channel notification fired the moment the call request is dispatched.
      Used by the Leads page to mark the lead's row as "calling" optimistically. */
  onCallStart?: (leadId: string) => void;
}

type CallState = "idle" | "calling" | "success" | "error";

const PROVIDER_LABEL: Record<Provider, string> = {
  bolna: "Bolna",
  elevenlabs: "ElevenLabs",
};

const PROVIDER_ENDPOINT: Record<Provider, string> = {
  bolna: "/api/bolna/call",
  elevenlabs: "/api/elevenlabs/call",
};

const PROVIDER_THEME: Record<Provider, { idle: string; success: string }> = {
  bolna: {
    idle: "text-brand-600 border-brand-200 hover:bg-brand-50",
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  elevenlabs: {
    idle: "text-violet-600 border-violet-200 hover:bg-violet-50",
    success: "bg-violet-50 text-violet-700 border-violet-200",
  },
};

export function CallButton({
  leadId,
  phone,
  disabled,
  provider = "bolna",
  onCallStart,
}: CallButtonProps) {
  const [state, setState] = useState<CallState>("idle");

  const handleCall = async () => {
    if (state === "calling" || disabled) return;

    setState("calling");
    onCallStart?.(leadId);

    try {
      const res = await fetch(PROVIDER_ENDPOINT[provider], {
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

  const label = PROVIDER_LABEL[provider];
  const theme = PROVIDER_THEME[provider];

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={handleCall}
      disabled={disabled || state === "calling"}
      className={`
        flex items-center gap-2 transition-all duration-200
        ${state === "idle" ? theme.idle : ""}
        ${state === "calling" ? "bg-orange-50 text-orange-600 border-orange-200" : ""}
        ${state === "success" ? theme.success : ""}
        ${state === "error" ? "bg-red-50 text-red-600 border-red-200" : ""}
        ${disabled ? "opacity-40 cursor-not-allowed" : ""}
      `}
    >
      {state === "idle" && (
        <>
          <Phone className="w-3.5 h-3.5" /> {label}
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
