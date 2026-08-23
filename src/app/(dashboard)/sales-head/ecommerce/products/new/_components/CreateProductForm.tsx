"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { rupeesToMinor } from "@/lib/ecommerce/format";

type CreateResult = {
    productId: string;
    title: string;
    status: string;
    adminUrl: string;
    draftFailed?: boolean;
    draftError?: string;
};

export function CreateProductForm() {
    const router = useRouter();
    const [kind, setKind] = useState<"physical" | "digital">("physical");
    const [name, setName] = useState("");
    const [priceInput, setPriceInput] = useState("");
    const [description, setDescription] = useState("");
    const [downloadUrl, setDownloadUrl] = useState("");
    const [publish, setPublish] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<CreateResult | null>(null);

    // Recomputed on every keystroke and shown to the operator, so a wrong scale
    // is visible BEFORE submitting rather than discovered on the storefront.
    const priceMinor = useMemo(() => rupeesToMinor(priceInput), [priceInput]);
    const canSubmit = name.trim().length > 0 && priceMinor !== null && !busy;

    async function submit() {
        if (priceMinor === null) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch("/api/ecommerce/products", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    kind,
                    name: name.trim(),
                    priceMinor,
                    publish,
                    ...(description.trim() ? { description: description.trim() } : {}),
                    ...(kind === "digital" && downloadUrl.trim()
                        ? { downloadUrl: downloadUrl.trim() }
                        : {}),
                }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error?.message ?? "Create failed");
            setResult(body.data as CreateResult);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Create failed");
        } finally {
            setBusy(false);
        }
    }

    if (result) {
        return (
            <div className="space-y-4 rounded-xl border border-border bg-surface p-5 shadow-card">
                <p className="text-sm text-ink">
                    Created <span className="font-semibold">{result.title}</span> —{" "}
                    <span className="font-mono text-xs">{result.productId}</span>
                </p>

                {result.draftFailed ? (
                    /* The create succeeded and only the follow-up draft PATCH failed.
                       Reporting a plain "failed" here would invite a retry and produce
                       a second product, so the exact state is spelled out instead. */
                    <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg/60 px-4 py-3 text-sm text-ink">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                        <span>
                            The product was created but could <strong>not</strong> be switched to
                            draft, so it is currently <strong>published</strong>. Do not create it
                            again — set it to draft from the edit page.
                            {result.draftError ? (
                                <span className="block text-xs text-ink-muted">{result.draftError}</span>
                            ) : null}
                        </span>
                    </div>
                ) : (
                    <p className="text-sm text-ink-muted">
                        Status: <span className="font-medium text-ink">{result.status}</span>
                    </p>
                )}

                <div className="flex flex-wrap gap-2">
                    <Button
                        onClick={() =>
                            router.push(`/sales-head/ecommerce/products/${result.productId}`)
                        }
                    >
                        View product
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => router.push("/sales-head/ecommerce/products")}
                    >
                        Back to list
                    </Button>
                    <a href={result.adminUrl} target="_blank" rel="noopener noreferrer">
                        <Button variant="ghost">Open in Hostinger</Button>
                    </a>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-5 rounded-xl border border-border bg-surface p-5 shadow-card">
            <div className="flex gap-2">
                {(["physical", "digital"] as const).map((k) => (
                    <Button
                        key={k}
                        variant={kind === k ? "primary" : "outline"}
                        size="sm"
                        onClick={() => setKind(k)}
                    >
                        {k}
                    </Button>
                ))}
            </div>

            <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                    id="name"
                    value={name}
                    maxLength={255}
                    onChange={(e) => setName(e.target.value)}
                />
            </div>

            <div className="space-y-1.5">
                <Label htmlFor="price">Price (INR)</Label>
                <Input
                    id="price"
                    value={priceInput}
                    inputMode="decimal"
                    placeholder="1234.56"
                    onChange={(e) => setPriceInput(e.target.value)}
                />
                <p className="text-xs text-ink-muted">
                    {priceInput.trim() === "" ? (
                        "Up to 2 decimals."
                    ) : priceMinor === null ? (
                        <span className="text-danger">
                            Not a valid amount — must be positive with at most 2 decimals.
                        </span>
                    ) : (
                        <>
                            Will send <span className="font-mono text-ink">{priceMinor}</span> paise
                            to Hostinger.
                        </>
                    )}
                </p>
            </div>

            <div className="space-y-1.5">
                <Label htmlFor="description">Description</Label>
                <textarea
                    id="description"
                    value={description}
                    maxLength={5000}
                    rows={4}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
                />
                <p className="text-xs text-ink-muted">
                    Set it here if you want one — Hostinger provides no way to read a description
                    back, so the CRM cannot show or edit it afterwards.
                </p>
            </div>

            {kind === "digital" ? (
                <div className="space-y-1.5">
                    <Label htmlFor="download">Download URL</Label>
                    <Input
                        id="download"
                        value={downloadUrl}
                        maxLength={2048}
                        onChange={(e) => setDownloadUrl(e.target.value)}
                        placeholder="https://..."
                    />
                </div>
            ) : null}

            <div className="space-y-1">
                <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                        type="checkbox"
                        checked={publish}
                        onChange={(e) => setPublish(e.target.checked)}
                    />
                    Publish immediately
                </label>
                <p className="text-xs text-ink-muted">
                    Hostinger has no create-as-draft. Unchecking this creates the product
                    published, then switches it to draft in a second call.
                </p>
            </div>

            {error ? (
                <div className="flex items-center gap-2 rounded-lg bg-danger-bg/50 px-4 py-3 text-sm text-danger">
                    <AlertTriangle className="h-4 w-4" />
                    {error}
                </div>
            ) : null}

            <div className="flex gap-2">
                <Button disabled={!canSubmit} onClick={submit}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create product"}
                </Button>
                <Button variant="outline" onClick={() => router.back()} disabled={busy}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}
