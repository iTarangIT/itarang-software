/**
 * Typed HTTP errors for the buyback module.
 *
 * The repo's `withErrorHandler` maps any thrown error to a 500. That is wrong
 * for a refused state transition (which is a legitimate 409, not a server bug)
 * and for a role violation (403). withErrorHandler now honours `.status` on a
 * thrown error — nothing else in the repo sets it, so the change is inert
 * everywhere but here.
 */

export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

/**
 * The state machine refused this action. 409 Conflict, not 403 — the caller may
 * well be allowed to do this, just not to a deal in *this* state.
 *
 * BRD invariant 3: illegal transitions are rejected SERVER-SIDE. The UI ghosting
 * is cosmetic; this is the gate.
 */
export class TransitionError extends HttpError {
  constructor(message: string) {
    super(message, 409);
  }
}

/** The caller's role may not do this at all. */
export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") {
    super(message, 403);
  }
}

/**
 * Not found — or found but not the caller's. Entity scoping returns 404 rather
 * than 403 on purpose (BRD M01 AC): a dealer must not be able to probe for the
 * existence of another dealer's request.
 */
export class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(message, 404);
  }
}

/**
 * The request is well-formed but breaks a business rule (e.g. submit with 4
 * photos on a line).
 *
 * `details` carries the structured reasons alongside the sentence — the submit
 * gate returns one issue per battery line, so the intake page can highlight the
 * offending rows instead of printing a paragraph. withErrorHandler passes it
 * through to `error.details` in the JSON body.
 */
export class ValidationError extends HttpError {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message, 422);
    this.details = details;
  }
}
