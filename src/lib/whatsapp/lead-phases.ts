/**
 * E-264 — the one place that pulls the journey phase modules in, for their
 * registration side effects.
 *
 * WHY THIS FILE EXISTS INSTEAD OF A DYNAMIC IMPORT.
 *
 * The first cut of this looped over an array of module paths and did
 * `await import(path)`. That is a specifier webpack cannot resolve statically,
 * so it either builds a require-context over the whole directory or fails — and
 * because a phase that has not shipped yet legitimately does not exist, the loop
 * swallowed every failure in a catch. The result was a registry that could come
 * up EMPTY in production with no error anywhere: a button tap would fall through
 * every gate and land in the "sorry, unclear message" branch, which looks exactly
 * like a parser bug and is not one.
 *
 * Static imports cost one line per phase and cannot fail silently. Add the next
 * phase's line here when it lands.
 *
 * Import order is irrelevant — each module registers its own states and actions,
 * and registerLeadState() throws on a duplicate, so a collision is loud.
 */

import "./doc-request-flow";
import "./coborrower-flow";     // Phase 1
import "./step4-flow";          // Phase 2
// import "./offer-flow";        // Phase 3
// import "./dispatch-flow";     // Phase 4

import { registeredLeadStates } from "./lead-states";

/**
 * Call once from the turn entry point. The imports above have already run by
 * then — this only exists so the call site has something to reference, which is
 * what stops a bundler from tree-shaking a module imported purely for effects.
 */
export function loadLeadPhases(): void {
  if (process.env.WA_DEBUG_PHASES === "1") {
    console.log("[WhatsApp] journey states:", registeredLeadStates().join(", "));
  }
}
