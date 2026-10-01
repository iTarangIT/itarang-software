// Pass a file Ecofy serves (lead upload template, import report.csv) on to the
// browser. OpenAPI declares these as a bare `200 OK`, so both shapes are
// handled: the file itself (streamed with its type), or a JSON envelope
// carrying a short-lived `url` (the CRM redirects to it, as document
// downloads do). Server-only.

export async function proxyEcofyFile(res: Response, fallbackName: string, fallbackType: string): Promise<Response> {
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
        const j = (await res.json().catch(() => null)) as { data?: { url?: unknown } } | null;
        const url = j?.data?.url;
        if (typeof url === "string" && /^https:\/\//i.test(url)) return Response.redirect(url, 302);
        return new Response(JSON.stringify({ success: false, error: { message: "Ecofy returned no file" } }), {
            status: 502,
            headers: { "content-type": "application/json" },
        });
    }
    const disposition = res.headers.get("content-disposition") ?? `attachment; filename="${fallbackName}"`;
    return new Response(res.body, {
        status: 200,
        headers: {
            "content-type": type || fallbackType,
            "content-disposition": disposition,
            "cache-control": "no-store",
        },
    });
}
