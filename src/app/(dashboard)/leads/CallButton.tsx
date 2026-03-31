"use client";

import { useState } from "react";
import { Phone, Loader2, CheckCircle, XCircle } from "lucide-react";

interface CallButtonProps {
  leadId: string;
  phone: string;
  disabled?: boolean;
}

type CallState = "idle" | "calling" | "success" | "error";

export function CallButton({ leadId, phone, disabled }: CallButtonProps) {
  const [state, setState] = useState<CallState>("idle");
  const [message, setMessage] = useState("");

  const handleCall = async () => {
    if (state === "calling" || disabled) return;

    setState("calling");
    setMessage("");

    try {
      const res = await fetch("/api/bolna/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, leadId }),
      });

      const data = await res.json();

      if (data.success) {
        setState("success");
        setMessage("Call initiated!");
        setTimeout(() => setState("idle"), 3000);
      } else {
        setState("error");
        setMessage(data.error || "Call failed");
        setTimeout(() => setState("idle"), 3000);
      }
    } catch {
      setState("error");
      setMessage("Network error");
      setTimeout(() => setState("idle"), 3000);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleCall}
        disabled={disabled || state === "calling"}
        className={`
          flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium
          transition-all duration-200 border
          ${state === "idle" ? "bg-white border-gray-200 text-gray-700 hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-700" : ""}
          ${state === "calling" ? "bg-blue-50 border-blue-200 text-blue-600 cursor-not-allowed" : ""}
          ${state === "success" ? "bg-emerald-50 border-emerald-300 text-emerald-700" : ""}
          ${state === "error" ? "bg-red-50 border-red-300 text-red-600" : ""}
          ${disabled ? "opacity-40 cursor-not-allowed" : ""}
        `}
      >
        {state === "idle" && <Phone className="w-3.5 h-3.5" />}
        {state === "calling" && (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        )}
        {state === "success" && <CheckCircle className="w-3.5 h-3.5" />}
        {state === "error" && <XCircle className="w-3.5 h-3.5" />}
        {state === "idle" && "Call"}
        {state === "calling" && "Calling..."}
        {state === "success" && "Called!"}
        {state === "error" && "Failed"}
      </button>
      {message && (
        <p
          className={`text-[10px] ${state === "error" ? "text-red-500" : "text-emerald-600"}`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
