const cache = new Map<string, string[]>();

export function getCachedQueries(key: string): string[] | null {
  return cache.get(key) || null;
}

export function setCachedQueries(key: string, queries: string[]) {
  cache.set(key, queries);
}