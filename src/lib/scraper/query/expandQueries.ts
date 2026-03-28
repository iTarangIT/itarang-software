
const DEFAULT_CITIES = ["Nashik", "Pune", "Mumbai"];

function extractCityFromQuery(query: string): string | null {
  const words = query.split(" ");
  const lastWord = words[words.length - 1];

  const ignore = ["dealers", "suppliers", "shops", "near", "me"];

  if (!ignore.includes(lastWord.toLowerCase())) {
    return lastWord;
  }

  return null;
}

export function expandQueries(
  baseQueries: string[],
  userCities?: string[]
) {
  let cities: string[] = [];

  if (userCities && userCities.length > 0) {
    cities = userCities;
  } else {
    const extractedCities = baseQueries
      .map((q) => extractCityFromQuery(q))
      .filter(Boolean) as string[];

    if (extractedCities.length > 0) {
      cities = extractedCities;
    } else {
      cities = DEFAULT_CITIES;
    }
  }

  const expanded: string[] = [];

  for (const query of baseQueries) {
    for (const city of cities) {
      expanded.push(`${query} in ${city}`);
    }
  }

  return [...new Set(expanded)];
}