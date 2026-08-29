/**
 * Vendor collectors.
 *
 * Split by what they talk to, not by vendor:
 *
 *   elevenlabs.ts — the only one that calls a vendor API. Credit balance and
 *                   quota, which nothing else in this codebase polls.
 *   usage.ts      — everything countable from our own tables, as one
 *                   declarative probe list.
 *
 * Spread into COLLECTORS by ../index.ts, so adding a vendor collector is one
 * line here and nothing else in the system changes.
 */

import type { OpsCollector } from "../types";

import { elevenLabsCollector } from "./elevenlabs";
import { vendorUsageCollector } from "./usage";

export const vendorCollectors: OpsCollector[] = [
  elevenLabsCollector,
  vendorUsageCollector,
];
