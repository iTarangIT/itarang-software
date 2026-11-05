/**
 * ID 209 (decided 2 Nov, Kartik): in every download the "Type (code)" column
 * shows a person's phone call as `call` — the stored code `inside_sales_call`
 * reads as if only an ISR made it, but ASMs and managers log the same type.
 * AI calls keep `ai_call`. Only the downloaded text changes; the stored code,
 * the dashboards and the call counts do not.
 */
const DOWNLOAD_TYPE_CODE: Record<string, string> = {
    inside_sales_call: "call",
};

export function typeCodeForDownload(code: string | null | undefined): string | null {
    if (code == null || code === "") return null;
    return DOWNLOAD_TYPE_CODE[code] ?? code;
}
