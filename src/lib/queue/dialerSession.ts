// Redis-backed dialer session — must survive across serverless instances
// on Vercel. In-memory module state is lost between invocations.

import { connection as redis } from "./connection";
import { safeRedis } from "./safeRedis";

type DialerSession = {
  queue: string[];
  position: number;
  callsMade: number;
  lastCallAt: number;
};

const SESSION_KEY = "dialer:session";
const SESSION_TTL_SECONDS = 2 * 60 * 60;
const CALL_TIMEOUT_MS = 3 * 60 * 1000;

// safeRedis() returns `fallback` on Upstash quota exhaustion. For reads that
// means the session looks empty → `isActive()` returns false, `status()`
// returns emptyStatus(). Callers see a clean "idle" state instead of a throw,
// and the dialer UI degrades gracefully until quota resets.
async function readSession(): Promise<DialerSession | null> {
  return safeRedis(
    async () => {
      const raw = await redis.get(SESSION_KEY);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as DialerSession;
      } catch {
        await redis.del(SESSION_KEY);
        return null;
      }
    },
    null,
    "dialer:readSession",
  );
}

async function writeSession(session: DialerSession | null) {
  await safeRedis(
    async () => {
      if (!session) {
        await redis.del(SESSION_KEY);
        return;
      }
      await redis.set(
        SESSION_KEY,
        JSON.stringify(session),
        "EX",
        SESSION_TTL_SECONDS,
      );
    },
    undefined,
    "dialer:writeSession",
  );
}

function emptyStatus() {
  return {
    active: false,
    currentLeadId: null as string | null,
    callsMade: 0,
    total: 0,
    remaining: 0,
    timedOut: false,
  };
}

export const dialerSession = {
  async start(queue: string[]) {
    await writeSession({
      queue,
      position: 0,
      callsMade: 1,
      lastCallAt: Date.now(),
    });
  },

  async getNext(): Promise<string | null> {
    const session = await readSession();
    if (!session) return null;

    session.position += 1;
    if (session.position >= session.queue.length) {
      await writeSession(null);
      return null;
    }

    session.callsMade += 1;
    session.lastCallAt = Date.now();
    await writeSession(session);
    return session.queue[session.position];
  },

  async current(): Promise<string | null> {
    const session = await readSession();
    if (!session) return null;
    return session.queue[session.position] ?? null;
  },

  async isActive(): Promise<boolean> {
    const session = await readSession();
    return session !== null;
  },

  async remaining(): Promise<number> {
    const session = await readSession();
    if (!session) return 0;
    return session.queue.length - session.position - 1;
  },

  async isCallTimedOut(): Promise<boolean> {
    const session = await readSession();
    if (!session) return false;
    return Date.now() - session.lastCallAt > CALL_TIMEOUT_MS;
  },

  async status() {
    const session = await readSession();
    if (!session) return emptyStatus();
    return {
      active: true,
      currentLeadId: session.queue[session.position] ?? null,
      callsMade: session.callsMade,
      total: session.queue.length,
      remaining: session.queue.length - session.position - 1,
      timedOut: Date.now() - session.lastCallAt > CALL_TIMEOUT_MS,
    };
  },

  async stop() {
    await writeSession(null);
  },
};
