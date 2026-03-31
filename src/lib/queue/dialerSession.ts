// /lib/queue/dialerSession.ts

type DialerSession = {
    queue: string[]; // lead IDs in priority order
    position: number;
  };
  
  // In-memory store (survives across requests in the same process)
  let session: DialerSession | null = null;
  
  export const dialerSession = {
    start(queue: string[]) {
      session = { queue, position: 0 };
    },
    getNext(): string | null {
      if (!session) return null;
      session.position += 1;
      if (session.position >= session.queue.length) {
        session = null; // queue exhausted
        return null;
      }
      return session.queue[session.position];
    },
    isActive(): boolean {
      return session !== null;
    },
    stop() {
      session = null;
    },
  };