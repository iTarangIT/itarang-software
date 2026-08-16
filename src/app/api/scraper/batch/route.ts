import { z } from "zod";
import {
  withErrorHandler,
  successResponse,
  errorResponse,
} from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { assertQStashConfigured } from "@/lib/queue/scheduler";
import {
  buildPairs,
  jobCap,
  parseCities,
  parseCommands,
  MAX_CITIES,
  MAX_COMMANDS,
  type Pair,
} from "@/lib/scraper/commandParser";
import {
  countOutstandingJobs,
  enqueueBatch,
  listBatches,
  WEEKDAYS,
} from "@/lib/scraper/jobQueue";

// E-241 — POST /api/scraper/batch (submit) and GET (list).
//
// POST only WRITES. It does not start anything: the rows land in
// scraper_job_queue at status='queued' and the dispatcher ticker picks them up
// on its next pass. That is deliberate — a submission of 500 jobs must return
// in milliseconds and survive the operator closing the tab, and the alternative
// (start the first job inline) would put a 60s fan-out inside a form submit.

export const dynamic = "force-dynamic";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const ScheduleSchema = z
  .object({
    mode: z.enum(["now", "once", "daily"]).default("now"),
    run_after: z.string().datetime().optional().nullable(),
    window_start: z.string().regex(HHMM, "must be HH:MM").optional().nullable(),
    window_end: z.string().regex(HHMM, "must be HH:MM").optional().nullable(),
    window_days: z.array(z.enum(WEEKDAYS)).min(1).optional().nullable(),
  })
  .superRefine((s, ctx) => {
    // Cross-field rules. Each mode is only meaningful with its own fields, and
    // accepting a 'once' with no run_after would enqueue jobs that can never
    // become eligible — a batch that sits at 0/N forever with nothing to see.
    if (s.mode === "once" && !s.run_after) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run_after"],
        message: "run_after is required when mode is 'once'",
      });
    }
    if (s.mode === "daily") {
      if (!s.window_start || !s.window_end) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["window_start"],
          message:
            "window_start and window_end are both required when mode is 'daily'",
        });
      } else if (s.window_start === s.window_end) {
        // Equal bounds are ambiguous: under the wrap-aware predicate they read
        // as a zero-length window, so the batch would never run and nothing
        // would say why. Reject at the door instead.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["window_end"],
          message:
            "window_start and window_end cannot be the same time — that is a zero-length window",
        });
      }
    }
  });

const PairSchema = z.object({
  query: z.string().trim().min(2).max(200),
  city: z.string().trim().max(100).nullable().optional(),
  max_results: z.number().int().positive().max(200).nullable().optional(),
});

const BodySchema = z.object({
  // Either the textarea path (commands + cities, crossed here) or the
  // spreadsheet path (pairs, already crossed by the operator's own file).
  commands: z.string().max(8000).optional(),
  cities: z.string().max(8000).optional(),
  pairs: z.array(PairSchema).max(2000).optional(),
  expand_with_ai: z.boolean().default(false),
  schedule: ScheduleSchema.default({ mode: "now" }),
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["sales_head", "ceo", "business_head"]);

  const body = BodySchema.parse(await req.json());

  // Same fail-fast as /api/scraper/run. Enqueuing work that can never fan out
  // would produce a batch of jobs that each dispatch, immediately fail, and
  // leave the operator with N identical error rows instead of one message here.
  try {
    assertQStashConfigured();
  } catch (err) {
    return errorResponse(
      `Scraper queue not configured: ${
        err instanceof Error ? err.message : "unknown"
      }`,
      500,
    );
  }

  let pairs: Pair[];

  if (body.pairs?.length) {
    // The spreadsheet path. The preview endpoint already validated this file,
    // but that response is a courtesy — this is the write path, so the pairs
    // are re-validated by PairSchema above and re-capped below.
    pairs = body.pairs.map((p) => ({
      query: p.query.toLowerCase(),
      city: p.city ? p.city.toLowerCase() : null,
      max_results: p.max_results ?? null,
    }));
  } else {
    const commands = parseCommands(body.commands ?? "");
    const cities = parseCities(body.cities ?? "");

    if (!commands.length) {
      return errorResponse(
        "At least one command is required. Separate multiple commands with commas or new lines.",
        400,
      );
    }
    pairs = buildPairs(commands, cities);
  }

  if (!pairs.length) {
    return errorResponse("Nothing to queue — no valid query/city pairs.", 400);
  }

  const cap = jobCap(body.expand_with_ai);
  if (pairs.length > cap) {
    // The AI-expansion cap is the expensive one: each job then fans out to ~15
    // chunks and every chunk is a billed QStash message, so 500 jobs would be
    // ~7,500 messages from a single click.
    return errorResponse(
      `${pairs.length} jobs exceeds the limit of ${cap}${
        body.expand_with_ai
          ? " when AI query expansion is on (each job fans out to ~15 chunks). Turn expansion off, or submit fewer commands/cities."
          : ". Submit fewer commands or cities."
      }`,
      400,
    );
  }

  const { batchId, queued } = await enqueueBatch({
    pairs,
    expandWithAi: body.expand_with_ai,
    schedule: {
      mode: body.schedule.mode,
      run_after: body.schedule.run_after ?? null,
      window_start: body.schedule.window_start ?? null,
      window_end: body.schedule.window_end ?? null,
      window_days: body.schedule.window_days ?? null,
    },
    userId: user.id,
  });

  // How much work is already ahead of this batch. Jobs run strictly one at a
  // time, so a backlog is the honest answer to "when will mine start?" and the
  // operator should see it at submit time, not discover it later.
  const outstanding = await countOutstandingJobs();

  return successResponse(
    {
      batch_id: batchId,
      queued,
      outstanding,
      expand_with_ai: body.expand_with_ai,
      schedule_mode: body.schedule.mode,
      limits: { max_commands: MAX_COMMANDS, max_cities: MAX_CITIES, max_jobs: cap },
    },
    202,
  );
});

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole(["sales_head", "ceo", "business_head"]);

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const [batches, outstanding] = await Promise.all([
    listBatches(limit, offset),
    countOutstandingJobs(),
  ]);

  return successResponse({ batches, outstanding });
});
