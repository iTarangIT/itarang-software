// /lib/queue/dialerSession.ts

type DialerSession = {
  queue: string[]; // lead IDs in priority order
  position: number;
  callsMade: number;
  lastCallAt: number; // timestamp of when current call started
};

const CALL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes max per call

// In-memory store (survives across requests in the same process)
let session: DialerSession | null = null;

export const dialerSession = {
  start(queue: string[]) {
    // position starts at 0 because the first call is triggered directly
    session = { queue, position: 0, callsMade: 1, lastCallAt: Date.now() };
  },
  getNext(): string | null {
    if (!session) return null;
    session.position += 1;
    if (session.position >= session.queue.length) {
      session = null; // queue exhausted
      return null;
    }
    session.callsMade += 1;
    session.lastCallAt = Date.now();
    return session.queue[session.position];
  },
  current(): string | null {
    if (!session) return null;
    return session.queue[session.position] ?? null;
  },
  isActive(): boolean {
    return session !== null;
  },
  remaining(): number {
    if (!session) return 0;
    return session.queue.length - session.position - 1;
  },
  isCallTimedOut(): boolean {
    if (!session) return false;
    return Date.now() - session.lastCallAt > CALL_TIMEOUT_MS;
  },
  status() {
    if (!session) return { active: false, currentLeadId: null, callsMade: 0, total: 0, remaining: 0, timedOut: false };
    return {
      active: true,
      currentLeadId: session.queue[session.position] ?? null,
      callsMade: session.callsMade,
      total: session.queue.length,
      remaining: session.queue.length - session.position - 1,
      timedOut: Date.now() - session.lastCallAt > CALL_TIMEOUT_MS,
    };
  },
  stop() {
    session = null;
  },
};