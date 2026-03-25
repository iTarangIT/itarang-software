const cities = ["Delhi", "Mumbai", "Pune", "Nashik"];

export function expandQueries(baseQueries: string[]): string[] {
  const expanded: string[] = [];

  for (const q of baseQueries) {
    for (const city of cities) {
      expanded.push(`${q} ${city}`);
    }
  }

  return expanded.slice(0, 10);
}
