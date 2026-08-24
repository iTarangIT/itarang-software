"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { rupeesToMinor } from "@/lib/ecommerce/format";

type SetupResult = {
    variantId?: string;
    variantCreated?: boolean;
    defaultVariantRemoved?: boolean;
    discountApplied?: boolean;
    stockApplied?: boolean;
    skuApplied?: boolean;
    failed?: { step: string; error: string }[];
};

type CreateResult = {
    productId: string;
    title: string;
    status: string;
    adminUrl: string;
    draftFailed?: boolean;
    draftError?: string;
    setup?: SetupResult;
};

/** Plain-English names for the steps that run after the product exists. */
const SETUP_STEPS: Record<string, string> = {
    "read-variants": "reading the new product's variant",
    "variant-create": "creating the variant with its SKU, price and stock",
    "placeholder-delete": "removing Hostinger's placeholder variant",
    discount: "setting the discount price",
    stock: "setting stock",
};

/** Outcome of the post-create image attach, reported separately and honestly. */
type ImageOutcome = { attempted: number; attached: number; error?: string };

export function CreateProductForm() {
    const router = useRouter();
    const [kind, setKind] = useState<"physical" | "digital">("physical");
    const [name, setName] = useState("");
    const [priceInput, setPriceInput] = useState("");
    const [discountInput, setDiscountInput] = useState("");
    const [optionName, setOptionName] = useState("");
    const [optionValue, setOptionValue] = useState("");
    const [sku, setSku] = useState("");
    const [track, setTrack] = useState(false);
    const [qty, setQty] = useState("");
    const [description, setDescription] = useState("");
    const [downloadUrl, setDownloadUrl] = useState("");
    const [publish, setPublish] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<CreateResult | null>(null);
    const [imageOutcome, setImageOutcome] = useState<ImageOutcome | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const [fileNames, setFileNames] = useState<string[]>([]);

    // Recomputed on every keystroke and shown to the operator, so a wrong scale
    // is visible BEFORE submitting rather than discovered on the storefront.
    const priceMinor = useMemo(() => rupeesToMinor(priceInput), [priceInput]);
    const discountMinor = useMemo(() => rupeesToMinor(discountInput), [discountInput]);

    const discountInvalid = discountInput.trim() !== "" && discountMinor === null;
    const discountTooHigh =
        discountMinor !== null && priceMinor !== null && discountMinor >= priceMinor;

    // Both halves or neither — Hostinger has no concept of an option without a value.
    const hasOption = optionName.trim() !== "" && optionValue.trim() !== "";
    const optionHalfFilled =
        (optionName.trim() !== "") !== (optionValue.trim() !== "");
    // The vendor constraint, surfaced before submitting rather than as a 422.
    const skuNeedsOption = sku.trim() !== "" && !hasOption;

    const qtyInvalid = qty.trim() !== "" && !/^\d+$/.test(qty.trim());
    const trackNeedsQty = track && qty.trim() === "";

    const canSubmit =
        name.trim().length > 0 &&
        priceMinor !== null &&
        !discountInvalid &&
        !discountTooHigh &&
        !optionHalfFilled &&
        !skuNeedsOption &&
        !qtyInvalid &&
        !trackNeedsQty &&
        !busy;

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
                    ...(discountMinor !== null ? { saleAmountMinor: discountMinor } : {}),
                    // Sent only as a pair, and only when the operator named a real
                    // attribute — nothing here is ever defaulted.
                    ...(hasOption
                        ? { options: [{ name: optionName.trim(), value: optionValue.trim() }] }
                        : {}),
                    ...(sku.trim() ? { sku: sku.trim() } : {}),
                    ...(track ? { trackQuantity: true, quantity: Number(qty.trim()) } : {}),
                    ...(description.trim() ? { description: description.trim() } : {}),
                    ...(kind === "digital" && downloadUrl.trim()
                        ? { downloadUrl: downloadUrl.trim() }
                        : {}),
                }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error?.message ?? "Create failed");
            const created = body.data as CreateResult;
            setResult(created);

            // Hostinger attaches images to an EXISTING product, so this can only
            // happen after the create returns an id. That makes a partial failure
            // real: the product may exist while its images do not. Reported
            // separately below rather than folded into a single "failed", which
            // would invite a retry and produce a duplicate product.
            const files = Array.from(fileRef.current?.files ?? []);
            if (files.length) {
                let attached = 0;
                let firstError: string | undefined;
                for (const f of files) {
                    try {
                        const form = new FormData();
                        form.append("file", f);
                        const imgRes = await fetch(
                            `/api/ecommerce/products/${created.productId}/images`,
                            { method: "POST", body: form },
                        );
                        if (!imgRes.ok) {
                            const b = await imgRes.json().catch(() => null);
                            throw new Error(b?.error?.message ?? `Upload of ${f.name} failed`);
                        }
                        attached += 1;
                    } catch (e) {
                        firstError ??= e instanceof Error ? e.message : String(e);
                    }
                }
                setImageOutcome({ attempted: files.length, attached, error: firstError });
            }
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

                {result.setup?.failed?.length ? (
                    /* The product exists. Naming the steps that failed beats a
                       generic error, which would invite a retry and a duplicate. */
                    <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg/60 px-4 py-3 text-sm text-ink">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                        <span>
                            The product was created, but not everything after it landed.{" "}
                            <strong>Do not create it again</strong> — finish the rest from the
                            product page.
                            <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
                                {result.setup.failed.map((f) => (
                                    <li key={f.step}>
                                        {SETUP_STEPS[f.step] ?? f.step}: {f.error}
                                    </li>
                                ))}
                            </ul>
                        </span>
                    </div>
                ) : result.setup ? (
                    <p className="text-sm text-ink-muted">
                        {[
                            result.setup.variantCreated ? "Variant created" : null,
                            result.setup.skuApplied ? "SKU set" : null,
                            result.setup.discountApplied ? "discount set" : null,
                            result.setup.stockApplied ? "stock set" : null,
                        ]
                            .filter(Boolean)
                            .join(", ")}
                        .
                    </p>
                ) : null}

                {imageOutcome ? (
                    imageOutcome.attached === imageOutcome.attempted ? (
                        <p className="text-sm text-ink-muted">
                            {imageOutcome.attached} image
                            {imageOutcome.attached === 1 ? "" : "s"} attached.
                        </p>
                    ) : (
                        /* The product exists either way. Saying "create failed" here
                           would invite a retry and produce a second product. */
                        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg/60 px-4 py-3 text-sm text-ink">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                            <span>
                                The product was created, but only{" "}
                                <strong>
                                    {imageOutcome.attached} of {imageOutcome.attempted}
                                </strong>{" "}
                                images attached. Do not create it again — add the rest from the
                                product page.
                                {imageOutcome.error ? (
                                    <span className="block text-xs text-ink-muted">
                                        {imageOutcome.error}
                                    </span>
                                ) : null}
                            </span>
                        </div>
                    )
                ) : null}

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
            <div className="space-y-1.5">
                <Label htmlFor="media">Product images</Label>
                <input
                    id="media"
                    ref={fileRef}
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    onChange={(e) =>
                        setFileNames(Array.from(e.target.files ?? []).map((f) => f.name))
                    }
                    className="block w-full text-sm text-ink file:mr-3 file:rounded-lg file:border file:border-border file:bg-bg file:px-3 file:py-1.5 file:text-sm file:text-ink"
                />
                <p className="text-xs text-ink-muted">
                    {fileNames.length
                        ? `${fileNames.length} selected: ${fileNames.join(", ")}`
                        : "Optional. JPEG, PNG, GIF or WebP, up to 15 MB each. SVG is not accepted."}
                </p>
                <p className="text-xs text-ink-muted">
                    {/* Being upfront about the ordering, because it explains why an
                        image can fail while the product still exists. */}
                    Images are attached after the product is created — Hostinger has no
                    create-with-image call. The first one becomes the primary image.
                </p>
            </div>

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

            <section className="space-y-4 rounded-lg border border-border bg-bg/30 px-4 py-4">
                <h3 className="text-sm font-semibold text-ink">Pricing</h3>

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
                                Will send <span className="font-mono text-ink">{priceMinor}</span>{" "}
                                paise to Hostinger.
                            </>
                        )}
                    </p>
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="discount">Discount price (INR)</Label>
                    <Input
                        id="discount"
                        value={discountInput}
                        inputMode="decimal"
                        placeholder="leave empty for none"
                        onChange={(e) => setDiscountInput(e.target.value)}
                    />
                    <p className="text-xs text-ink-muted">
                        {discountInvalid ? (
                            <span className="text-danger">
                                Not a valid amount — positive, at most 2 decimals.
                            </span>
                        ) : discountTooHigh ? (
                            <span className="text-danger">
                                Must be lower than the price, or it is not a discount.
                            </span>
                        ) : discountMinor !== null ? (
                            <>
                                Will send <span className="font-mono text-ink">{discountMinor}</span>{" "}
                                paise as the sale price.
                            </>
                        ) : (
                            "The price customers actually pay. Empty means no discount."
                        )}
                    </p>
                </div>
            </section>

            <section className="space-y-4 rounded-lg border border-border bg-bg/30 px-4 py-4">
                <div>
                    <h3 className="text-sm font-semibold text-ink">Variant</h3>
                    <p className="text-xs text-ink-muted">
                        {/* Price and stock live on the variant too, but SKU is the one
                            people expect to be a product field, so it is spelled out. */}
                        Every product has at least one variant, and the SKU and stock belong to
                        it — not to the product.
                    </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                        <Label htmlFor="optionName">Option name</Label>
                        <Input
                            id="optionName"
                            value={optionName}
                            maxLength={255}
                            placeholder="Capacity"
                            onChange={(e) => setOptionName(e.target.value)}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="optionValue">Option value</Label>
                        <Input
                            id="optionValue"
                            value={optionValue}
                            maxLength={255}
                            placeholder="150Ah"
                            onChange={(e) => setOptionValue(e.target.value)}
                        />
                    </div>
                </div>
                <p className="text-xs text-ink-muted">
                    {optionHalfFilled ? (
                        <span className="text-danger">
                            Give both a name and a value, or leave both empty.
                        </span>
                    ) : (
                        /* Stated up front because none of it can be undone: Hostinger
                           has no endpoint to rename or remove an option. */
                        <>
                            Optional, and only for a genuine attribute of the product. An option
                            becomes a real selector on the storefront and{" "}
                            <strong className="text-ink">cannot be renamed or removed later</strong>
                            . Required if you want to set a SKU.
                        </>
                    )}
                </p>

                <div className="space-y-1.5">
                    <Label htmlFor="sku">Variant SKU</Label>
                    <Input
                        id="sku"
                        value={sku}
                        maxLength={255}
                        placeholder="ITG-LB-150AH"
                        onChange={(e) => setSku(e.target.value)}
                    />
                    <p className="text-xs text-ink-muted">
                        {skuNeedsOption ? (
                            <span className="text-danger">
                                Hostinger only accepts a SKU when a variant with an option is
                                created. Add a real option above, or leave this empty and set the
                                SKU in the Hostinger dashboard.
                            </span>
                        ) : (
                            "Set here or not at all — Hostinger has no way to change a SKU afterwards."
                        )}
                    </p>
                </div>

                <div className="space-y-1">
                    <label className="flex items-center gap-2 text-sm text-ink">
                        <input
                            type="checkbox"
                            checked={track}
                            onChange={(e) => setTrack(e.target.checked)}
                        />
                        Track quantity
                    </label>
                    <p className="text-xs text-ink-muted">
                        Off means Hostinger does not count stock for this product and it never
                        shows as out of stock.
                    </p>
                </div>

                {track ? (
                    <div className="space-y-1.5">
                        <Label htmlFor="qty">Quantity</Label>
                        <Input
                            id="qty"
                            value={qty}
                            inputMode="numeric"
                            placeholder="0"
                            onChange={(e) => setQty(e.target.value)}
                        />
                        <p className="text-xs text-ink-muted">
                            {qtyInvalid ? (
                                <span className="text-danger">Whole numbers only.</span>
                            ) : trackNeedsQty ? (
                                <span className="text-danger">
                                    {/* Hostinger defaults this to 0, which would publish the
                                        product as out of stock. */}
                                    Required when tracking is on — leaving it empty would publish
                                    the product as out of stock.
                                </span>
                            ) : (
                                "Units in stock right now."
                            )}
                        </p>
                    </div>
                ) : null}
            </section>

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

            <div className="rounded-lg border border-border bg-bg/40 px-4 py-3 text-xs text-ink-muted">
                {/* Named explicitly so nobody concludes the CRM simply forgot them.
                    None of these appear anywhere in Hostinger's documented API. */}
                <strong className="text-ink">Only in the Hostinger dashboard.</strong>{" "}
                <em>Weight</em>, low-stock tracking, subtitle, ribbon, additional info sections and
                custom fields cannot be set here. They appear nowhere in Hostinger&apos;s API —
                not on product creation, not on variant creation and not on variant update — so
                the dashboard is the only place to enter them.
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
