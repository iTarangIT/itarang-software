/**
 * E-264 — the state→handler table for the journey phases.
 *
 * WHY A TABLE RATHER THAN MORE SWITCH CASES.
 *
 * The fourteen DC_LEAD_* states are handled by TWO hand-maintained switch
 * statements — runConsoleTurn (dealer) and runCustomerTurn (self-serve) — which
 * are identical apart from the dealer argument and the fallback branch. The
 * product requirement is that a dealer running the journey for a customer and a
 * customer running it themselves take exactly the same path, so adding ~20 new
 * states to both switches by hand is a guarantee they will drift.
 *
 * The cheap fix is not to rewrite the working switches. It is to add ONE clause
 * to each, before its `default:`, that consults this table. Two edit sites,
 * once, for all four phases — and every new state is automatically reachable
 * from both entry points because there is only one place to add it.
 *
 * Phases register into this map at module load, so this file never imports them
 * and the dependency runs one way only (the same rule session-store.ts states
 * for itself).
 */

import type { ActiveDealer } from "./customer-lead";
import type { SessionRow } from "./session-store";
import type { InboundEvent } from "./types";

export type LeadStateHandler = (
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
) => Promise<void>;

export interface LeadStateOptions {
  /**
   * Opt in to re-rendering this step when a bare greeting ("hi", "hello")
   * arrives, instead of letting the greeting abandon the journey.
   *
   * WHY IT IS OPT-IN AND NOT THE DEFAULT.
   *
   * Both turn functions treat a typed greeting as "start over", which clears
   * `ctx.lead`. Mid-journey that is destructive: the lead pointer is the only
   * route back into a step, and the dealer menu offers no way to reopen a
   * submitted lead — so one "hi" strands the application permanently.
   *
   * The obvious fix, routing every greeting to the current handler, is wrong.
   * In the states where FREE TEXT IS THE PAYLOAD it would submit the greeting
   * as data: "hi" typed at DC_S4_AMT would be parsed as a loan amount, and
   * at DC_CB_FIELD it is stored as a co-borrower's name. Those states genuinely want the escape hatch.
   *
   * So a state opts in only when its input is a tap — a list row, a button, a
   * document — and arbitrary text is already handled by re-rendering the
   * prompt. For those, a greeting is a request to see the message again.
   */
  rerenderOnGreeting?: boolean;
  /**
   * Re-render this step from scratch after the journey was parked in Save
   * Drafts and picked up again (ctx.lead and current_state are already
   * restored when this runs). States whose input is free text cannot use the
   * greeting re-render above, so they supply an explicit prompt here.
   */
  resume?: LeadStateResumer;
}

export type LeadStateResumer = (
  session: SessionRow,
  dealer: ActiveDealer,
) => Promise<void>;

const LEAD_STATE_HANDLERS: Record<string, LeadStateHandler> = {};
const RERENDER_ON_GREETING = new Set<string>();
const LEAD_STATE_RESUMERS: Record<string, LeadStateResumer> = {};

/**
 * Register one state. Called by a phase module at import time.
 *
 * `current_state` is varchar(32) and code-owned — there is no DB constraint to
 * catch an over-long name, and a silently truncated state would route to the
 * fallback forever. So it is checked here, loudly, at startup.
 */
export function registerLeadState(
  state: string,
  handler: LeadStateHandler,
  options: LeadStateOptions = {},
): void {
  if (state.length > 32) {
    throw new Error(
      `WhatsApp state "${state}" is ${state.length} chars; whatsapp_onboarding_sessions.current_state is varchar(32)`,
    );
  }
  if (!state.startsWith("DC_")) {
    // stage.ts maps any DC_-prefixed state to the admin console's
    // "customer_lead" stage. A journey state without the prefix would render as
    // an unknown stage in the admin WhatsApp view.
    throw new Error(`WhatsApp journey state "${state}" must start with "DC_"`);
  }
  if (LEAD_STATE_HANDLERS[state]) {
    throw new Error(`WhatsApp state "${state}" is already registered`);
  }
  LEAD_STATE_HANDLERS[state] = handler;
  if (options.rerenderOnGreeting) RERENDER_ON_GREETING.add(state);
  if (options.resume) LEAD_STATE_RESUMERS[state] = options.resume;
}

export function registerLeadStates(
  handlers: Record<string, LeadStateHandler>,
): void {
  for (const [state, handler] of Object.entries(handlers)) {
    registerLeadState(state, handler);
  }
}

export function leadStateHandler(state: string): LeadStateHandler | undefined {
  return LEAD_STATE_HANDLERS[state];
}

/**
 * Should a bare greeting in this state re-render the step rather than abandon
 * the journey? See LeadStateOptions.rerenderOnGreeting.
 */
export function rerendersOnGreeting(state: string): boolean {
  return RERENDER_ON_GREETING.has(state);
}

/** Explicit resume prompt for a state, if the phase registered one. */
export function leadStateResumer(state: string): LeadStateResumer | undefined {
  return LEAD_STATE_RESUMERS[state];
}

/** For diagnostics and tests. */
export function registeredLeadStates(): string[] {
  return Object.keys(LEAD_STATE_HANDLERS).sort();
}

// Registration happens via the static imports in ./lead-phases, which the turn
// entry point imports. Deliberately NOT a dynamic import loop here: see the
// header of that file for why a swallowed failure was worse than the duplication.
