"use client";

// Tracker ID 196 (PJP phase 1) — the shop photo + live location a done visit
// needs. Step 1 reads the phone's location (live, never cached) and shows how
// accurate it is; step 2 opens the CAMERA (not the gallery) and sends the
// photo with that location to POST /api/visits/capture, which stamps both on
// it. The returned capture id goes with the visit. Rules shared with the
// server: @/lib/visits/verifiedCapture.

import { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Loader2, MapPin, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_VISIT_ACCURACY_M, checkVisitLocation, checkVisitPhoto } from "@/lib/visits/verifiedCapture";

export type CapturedVisit = { captureId: string; photoUrl: string; accuracyM: number };

type Loc = { lat: number; lng: number; accuracy: number; at: number };

/** A location older than this is read again before the photo goes up. */
const LOCATION_MAX_AGE_MS = 2 * 60 * 1000;

export function VerifiedVisitCapture({
    leadId,
    accountId,
    value,
    onChange,
    disabled,
    onUnavailable,
}: {
    leadId?: string | null;
    accountId?: string | null;
    value: CapturedVisit | null;
    onChange: (c: CapturedVisit | null) => void;
    disabled?: boolean;
    /** The server has no E-363 yet (503): the caller falls back to the old fields. */
    onUnavailable?: () => void;
}) {
    const [loc, setLoc] = useState<Loc | null>(null);
    const [locState, setLocState] = useState<"idle" | "loading" | "error">("idle");
    const [message, setMessage] = useState<string | null>(null);
    const [uploading, setUploading] = useState(false);
    const [preview, setPreview] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => () => {
        if (preview) URL.revokeObjectURL(preview);
    }, [preview]);

    const readLocation = () => {
        setMessage(null);
        if (!("geolocation" in navigator)) {
            setLocState("error");
            setMessage("This phone cannot share its location. A visit needs it.");
            return;
        }
        setLocState("loading");
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const next = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    accuracy: pos.coords.accuracy,
                    at: Date.now(),
                };
                setLoc(next);
                setLocState("idle");
                const check = checkVisitLocation(next.lat, next.lng, next.accuracy);
                setMessage(check.ok ? null : check.message);
            },
            (err) => {
                setLocState("error");
                setLoc(null);
                setMessage(
                    err.code === err.PERMISSION_DENIED
                        ? "Turn on location: allow this site to use your location, then try again."
                        : "Could not read the location. Turn location on and try again.",
                );
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
        );
    };

    const locOk = !!loc && checkVisitLocation(loc.lat, loc.lng, loc.accuracy).ok;
    const locFresh = !!loc && Date.now() - loc.at < LOCATION_MAX_AGE_MS;

    const upload = async (file: File) => {
        if (!loc || !locOk) return;
        const pic = checkVisitPhoto({ type: file.type || "image/jpeg", size: file.size });
        if (!pic.ok) {
            setMessage(pic.message);
            return;
        }
        if (!locFresh) {
            setMessage("The location is more than 2 minutes old. Read it again, then take the photo.");
            return;
        }
        setUploading(true);
        setMessage(null);
        try {
            const fd = new FormData();
            fd.set("photo", file);
            fd.set("lat", String(loc.lat));
            fd.set("lng", String(loc.lng));
            fd.set("accuracy_m", String(loc.accuracy));
            if (leadId) fd.set("lead_id", leadId);
            if (accountId) fd.set("account_id", accountId);
            const res = await fetch("/api/visits/capture", { method: "POST", body: fd });
            const json = await res.json().catch(() => null);
            if (res.status === 503 && onUnavailable) {
                onUnavailable();
                return;
            }
            if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Could not save the photo");
            setPreview(URL.createObjectURL(file));
            onChange({ captureId: json.data.capture_id, photoUrl: json.data.photo_url, accuracyM: loc.accuracy });
        } catch (e) {
            setMessage((e as Error).message);
        } finally {
            setUploading(false);
        }
    };

    if (value) {
        return (
            <div className="flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
                {preview && (
                    // eslint-disable-next-line @next/next/no-img-element -- the phone's own copy, never a stored URL
                    <img src={preview} alt="Shop photo" className="h-14 w-14 rounded object-cover" />
                )}
                <div className="flex-1 text-xs text-emerald-800">
                    <div className="flex items-center gap-1 font-medium">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Verified: photo and location saved
                    </div>
                    <div>Location accurate to {Math.round(value.accuracyM)} m. Location and time are printed on the photo.</div>
                </div>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => {
                        onChange(null);
                        setPreview(null);
                        setLoc(null);
                    }}
                    className="gap-1"
                >
                    <RotateCcw className="h-3.5 w-3.5" /> Retake
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-2 rounded-md border border-gray-200 p-3">
            <p className="text-xs text-gray-600">
                A done visit needs the phone&apos;s live location ({MAX_VISIT_ACCURACY_M} m or better) and a photo of
                the shop taken now with the camera.
            </p>
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    onClick={readLocation}
                    disabled={disabled || locState === "loading" || uploading}
                    className="gap-1.5"
                >
                    {locState === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
                    {loc ? "Read location again" : "1. Read my location"}
                </Button>
                {loc && (
                    <span className={`text-xs ${locOk ? "text-emerald-700" : "text-amber-700"}`}>
                        {locOk
                            ? `Location OK: within ${Math.round(loc.accuracy)} m`
                            : `Location not within ${MAX_VISIT_ACCURACY_M} m (now ${Math.round(loc.accuracy)} m)`}
                    </span>
                )}
            </div>
            <div>
                <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) void upload(f);
                    }}
                />
                <Button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={disabled || !locOk || uploading}
                    className="gap-1.5"
                >
                    {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
                    2. Take shop photo
                </Button>
            </div>
            {message && <p className="text-xs text-rose-700">{message}</p>}
        </div>
    );
}
