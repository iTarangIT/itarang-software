"use client";

/**
 * Public passive Video KYC capture page — Addendum V0.3.1 §11.
 *
 * Opened by the CUSTOMER via a single-use link (no login). Records a short LIVE
 * selfie video in-browser (getUserMedia + MediaRecorder) and uploads it; the
 * server scores it with Decentro's passive liveness engine. Mobile-first.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

interface Context {
  customer_name: string;
  expires_at: string | null;
}

const RECORD_SECONDS = 6;

type Phase =
  | "loading"
  | "intro"
  | "starting"
  | "ready"
  | "recording"
  | "recorded"
  | "uploading"
  | "done"
  | "failed";

export default function VkycCapturePage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [ctx, setCtx] = useState<Context | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(RECORD_SECONDS);
  const [result, setResult] = useState<"verified" | "failed" | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load context ───────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/nbfc/vkyc/capture/${token}`);
        const j = await res.json();
        if (!res.ok || j.ok === false) {
          setLoadError(j.error ?? "This link is no longer valid.");
          return;
        }
        setCtx(j as Context);
        setPhase("intro");
      } catch {
        setLoadError("Could not load the verification. Check your connection and reload.");
      }
    })();
  }, [token]);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => () => stopStream(), [stopStream]);

  async function startCamera() {
    setError(null);
    setPhase("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        await videoRef.current.play().catch(() => {});
      }
      setPhase("ready");
    } catch {
      setError("Camera access is required. Please allow camera + microphone and try again.");
      setPhase("intro");
    }
  }

  function pickMimeType(): string {
    const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
    for (const c of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
    }
    return "";
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    blobRef.current = null;
    const mimeType = pickMimeType();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      setError("Recording is not supported on this browser. Try Chrome or Safari.");
      return;
    }
    recorderRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      blobRef.current = new Blob(chunksRef.current, { type: mimeType || "video/webm" });
      // Show the recorded clip back to the customer.
      if (videoRef.current) {
        videoRef.current.srcObject = null;
        videoRef.current.muted = false;
        videoRef.current.src = URL.createObjectURL(blobRef.current);
        videoRef.current.controls = true;
      }
      stopStream();
      setPhase("recorded");
    };
    rec.start();
    setPhase("recording");
    setCountdown(RECORD_SECONDS);
    timerRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          stopRecording();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  function stopRecording() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }

  function reset() {
    blobRef.current = null;
    if (videoRef.current) {
      videoRef.current.removeAttribute("src");
      videoRef.current.controls = false;
      videoRef.current.load();
    }
    setError(null);
    void startCamera();
  }

  async function submit() {
    const blob = blobRef.current;
    if (!blob) return;
    setPhase("uploading");
    setError(null);
    try {
      const fd = new FormData();
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      fd.append("video", blob, `liveness.${ext}`);
      const res = await fetch(`/api/nbfc/vkyc/capture/${token}/submit`, { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) {
        setError(j.error ?? `Submission failed (HTTP ${res.status}).`);
        setPhase("recorded");
        return;
      }
      setResult(j.status === "verified" ? "verified" : "failed");
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network problem — please try again.");
      setPhase("recorded");
    }
  }

  // ── render ───────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <Shell>
        <div className="text-center py-10">
          <p className="text-lg font-semibold text-slate-800">Link unavailable</p>
          <p className="text-sm text-slate-500 mt-2">{loadError}</p>
        </div>
      </Shell>
    );
  }
  if (phase === "loading" || !ctx) {
    return (
      <Shell>
        <p className="text-sm text-slate-500 text-center py-10">Loading…</p>
      </Shell>
    );
  }
  if (phase === "done") {
    return (
      <Shell>
        <div className="text-center py-10">
          <div className="text-4xl">{result === "verified" ? "✅" : "⚠️"}</div>
          <p className="text-lg font-semibold text-slate-800 mt-3">
            {result === "verified" ? "Video verification complete" : "Video submitted"}
          </p>
          <p className="text-sm text-slate-500 mt-2">
            {result === "verified"
              ? "Thank you. You can close this page."
              : "Thanks — we've received your video. Our team will review it. You can close this page."}
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="space-y-5">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Video verification</p>
          <h1 className="text-xl font-bold text-slate-900">Hello {ctx.customer_name}</h1>
          <p className="text-sm text-slate-600 mt-1">
            Record a short {RECORD_SECONDS}-second selfie video to verify it&apos;s really you. Look at the
            camera in good light.
          </p>
        </div>

        {/* Camera / preview surface */}
        <div className="relative overflow-hidden rounded-xl bg-black aspect-[3/4]">
          <video
            ref={videoRef}
            playsInline
            className="h-full w-full object-cover"
            style={{ transform: phase === "recorded" ? undefined : "scaleX(-1)" }}
          />
          {phase === "recording" && (
            <div className="absolute top-3 left-3 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-xs font-bold text-white">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              REC · {countdown}s
            </div>
          )}
          {(phase === "intro" || phase === "starting") && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-300">
              {phase === "starting" ? "Starting camera…" : "Camera off"}
            </div>
          )}
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        {/* Controls */}
        {phase === "intro" && (
          <button onClick={startCamera} className="w-full py-3 rounded-lg bg-[color:var(--color-brand-navy,#0f2540)] text-white font-semibold">
            Start camera
          </button>
        )}
        {phase === "ready" && (
          <button onClick={startRecording} className="w-full py-3 rounded-lg bg-[color:var(--color-brand-navy,#0f2540)] text-white font-semibold">
            Start recording ({RECORD_SECONDS}s)
          </button>
        )}
        {phase === "recording" && (
          <button onClick={stopRecording} className="w-full py-3 rounded-lg bg-red-600 text-white font-semibold">
            Stop ({countdown}s)
          </button>
        )}
        {phase === "recorded" && (
          <div className="space-y-2">
            <button onClick={submit} className="w-full py-3 rounded-lg bg-emerald-600 text-white font-semibold">
              Submit video
            </button>
            <button onClick={reset} className="w-full py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-semibold">
              Re-record
            </button>
          </div>
        )}
        {phase === "uploading" && (
          <button disabled className="w-full py-3 rounded-lg bg-emerald-600/70 text-white font-semibold">
            Verifying…
          </button>
        )}

        <p className="text-[11px] text-slate-400 text-center">
          Your video is used only to verify your identity for this loan application.
        </p>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-100 py-6 px-4">
      <div className="max-w-md mx-auto bg-white rounded-xl shadow-sm border border-slate-200 p-5">{children}</div>
      <p className="max-w-md mx-auto text-center text-[10px] text-slate-400 mt-4">iTarang Video KYC</p>
    </div>
  );
}
