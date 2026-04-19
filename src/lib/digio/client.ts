import axios from "axios";

/**
 * DigiO API Client
 * Set DIGIO_BASE_URL to switch between environments:
 *   Sandbox:    https://ext.digio.in:444
 *   Production: https://api.digio.in
 */
const BASE_URL = process.env.DIGIO_BASE_URL || (
  process.env.NODE_ENV === 'production'
    ? 'https://api.digio.in'
    : 'https://ext.digio.in:444'
);
const CLIENT_ID = process.env.DIGIO_CLIENT_ID!;
const CLIENT_SECRET = process.env.DIGIO_CLIENT_SECRET!;

export const digioClient = axios.create({
  baseURL: BASE_URL,
  auth: {
    username: CLIENT_ID,
    password: CLIENT_SECRET,
  },
  headers: {
    "Content-Type": "application/json",
  },
});