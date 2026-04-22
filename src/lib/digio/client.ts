import axios from "axios";

/**
 * DigiO API Client
 *
 * Set DIGIO_BASE_URL explicitly in env to pin the environment:
 *   Sandbox:    https://ext.digio.in:444
 *   Production: https://api.digio.in
 *
 * If unset, we fall back on NODE_ENV. Every caller in the codebase MUST read
 * the base URL and credentials through the helpers below — do not re-derive
 * them locally. Doing so has historically caused sandbox/prod splits within a
 * single request (status probe hits one env, PDF download hits the other),
 * surfacing as the "download returned 500" admin error.
 */

export const DIGIO_SANDBOX_BASE_URL = "https://ext.digio.in:444";
export const DIGIO_PRODUCTION_BASE_URL = "https://api.digio.in";

export function cleanEnv(value?: string) {
  return (value || "").trim().replace(/^["']|["']$/g, "");
}

export function getDigioBaseUrl(): string {
  const explicit = cleanEnv(process.env.DIGIO_BASE_URL);
  if (explicit) return explicit;
  return process.env.NODE_ENV === "production"
    ? DIGIO_PRODUCTION_BASE_URL
    : DIGIO_SANDBOX_BASE_URL;
}

export function getDigioCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
  const clientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function basicAuthHeader(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

export function getDigioBasicAuth(): string | null {
  const creds = getDigioCreds();
  if (!creds) return null;
  return basicAuthHeader(creds.clientId, creds.clientSecret);
}

const BASE_URL = getDigioBaseUrl();
const creds = getDigioCreds();

export const digioClient = axios.create({
  baseURL: BASE_URL,
  auth: creds
    ? { username: creds.clientId, password: creds.clientSecret }
    : undefined,
  headers: {
    "Content-Type": "application/json",
  },
});
