/**
 * Shared helpers for the telemetry API routes that read from the IoT VPS
 * (see src/lib/db/iot.ts). When the VPS Postgres can't be reached, those
 * routes degrade to zero-data instead of 500ing — these helpers classify the
 * failure and turn it into a human-readable banner reason for the dashboard.
 */

/** True when the error is "can't reach / isn't configured", not a real query bug. */
export function isVpsUnreachable(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') return true;
    const message = error instanceof Error ? error.message : String(error);
    return /ECONNREFUSED|getaddrinfo|connection terminated|IOT_DATABASE_URL is not set/i.test(message);
}

/**
 * Map the failure to a specific, actionable banner message. The previous code
 * hardcoded "start the SSH tunnel" for every failure, which hid the real cause
 * (e.g. env not configured, DNS failure). The component renders this verbatim.
 */
export function vpsDegradedReason(error: unknown): string {
    const code = (error as { code?: string } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);

    if (/IOT_DATABASE_URL is not set/i.test(message)) {
        return 'Intellicar telemetry DB not configured — set IOT_DATABASE_URL in .env.local.';
    }
    if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(message)) {
        return 'IoT VPS unreachable — the SSH tunnel is down. In a terminal run: ssh -N -L 5433:127.0.0.1:5433 root@72.61.246.37, then refresh.';
    }
    if (code === 'ETIMEDOUT' || /ETIMEDOUT|connection terminated/i.test(message)) {
        return 'IoT VPS unreachable — connection timed out. Check the SSH tunnel and the VPS firewall (port 5433).';
    }
    if (code === 'ENOTFOUND' || /getaddrinfo|ENOTFOUND/i.test(message)) {
        return 'IoT VPS unreachable — host not found. Check the host in IOT_DATABASE_URL.';
    }
    return `IoT VPS unreachable — ${message}`;
}
