// lib/scraper/city-expander.ts

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) return digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) return digits.slice(1);
  return digits;
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(
      /\b(pvt|ltd|private|limited|enterprises|agency|store|shop|centre|center|battery|batteries|electric|electronics)\b/g,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Parse user query into base + state ───────────────────────────────────────

export function parseQuery(query: string): {
  baseQuery: string;
  state: string | null;
  isStateBased: boolean;
} {
  const normalized = query.toLowerCase().trim();

  // Indian states list for detection
  const INDIAN_STATES: Record<string, string> = {
    maharashtra: "Maharashtra",
    "uttar pradesh": "Uttar Pradesh",
    up: "Uttar Pradesh",
    rajasthan: "Rajasthan",
    gujarat: "Gujarat",
    karnataka: "Karnataka",
    "madhya pradesh": "Madhya Pradesh",
    mp: "Madhya Pradesh",
    "tamil nadu": "Tamil Nadu",
    "andhra pradesh": "Andhra Pradesh",
    ap: "Andhra Pradesh",
    bihar: "Bihar",
    "west bengal": "West Bengal",
    odisha: "Odisha",
    kerala: "Kerala",
    punjab: "Punjab",
    haryana: "Haryana",
    uttarakhand: "Uttarakhand",
    "himachal pradesh": "Himachal Pradesh",
    jharkhand: "Jharkhand",
    chhattisgarh: "Chhattisgarh",
    assam: "Assam",
    telangana: "Telangana",
    delhi: "Delhi",
    goa: "Goa",
  };

  for (const [key, fullName] of Object.entries(INDIAN_STATES)) {
    // Check if query contains "in <state>" pattern
    const patterns = [`in ${key}`, `in ${key} `, `${key}`];

    for (const pattern of patterns) {
      if (normalized.includes(pattern)) {
        // Extract base query by removing the state part
        let baseQuery = query
          .toLowerCase()
          .replace(`in ${key}`, "")
          .replace(key, "")
          .replace("in ", "")
          .trim();

        // Clean up extra spaces
        baseQuery = baseQuery.replace(/\s+/g, " ").trim();

        return {
          baseQuery,
          state: fullName,
          isStateBased: true,
        };
      }
    }
  }

  // Not state-based — treat as regular city query
  return {
    baseQuery: query,
    state: null,
    isStateBased: false,
  };
}

// ─── Get cities from Gemini ───────────────────────────────────────────────────

export async function getCitiesForState(state: string): Promise<string[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `List all major cities and towns in ${state}, India that are known for business activity and commerce. Include district headquarters, industrial cities, and tier-2/tier-3 cities. Return ONLY a JSON array of city name strings, nothing else. No explanations, no markdown, just the raw JSON array. Example format: ["Mumbai","Pune","Nashik"]`,
              },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.1,
        },
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Gemini API error: ${res.status}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";

  try {
    // Strip any accidental markdown
    const clean = text.replace(/```json|```/g, "").trim();
    const cities = JSON.parse(clean);
    if (!Array.isArray(cities)) throw new Error("Not an array");
    return cities.filter((c: any) => typeof c === "string" && c.trim());
  } catch {
    console.error("[CITY EXPANDER] Failed to parse Gemini response:", text);
    return [];
  }
}

// ─── Dedup logic ──────────────────────────────────────────────────────────────

export interface RawLead {
  name?: string | null;
  phone?: string | null;
  city?: string | null;
  source_url?: string | null;
  address?: string | null;
  source?: string | null;
  [key: string]: any;
}

export interface DedupResult {
  toInsert: RawLead[];
  duplicatesSkipped: number;
  breakdown: { phone: number; url: number; nameCity: number };
}

export function deduplicateLeads(
  incoming: RawLead[],
  existingLeads: {
    phone: string | null;
    name: string | null;
    city: string | null;
    source_url: string | null;
  }[],
): DedupResult {
  const breakdown = { phone: 0, url: 0, nameCity: 0 };
  const toInsert: RawLead[] = [];

  // Build lookup sets from existing DB leads
  const existingPhones = new Set(
    existingLeads.filter((l) => l.phone).map((l) => normalizePhone(l.phone!)),
  );

  const existingUrls = new Set(
    existingLeads.filter((l) => l.source_url).map((l) => l.source_url!),
  );

  const existingNameCity = new Set(
    existingLeads
      .filter((l) => l.name && l.city)
      .map((l) => `${normalizeName(l.name!)}_${l.city!.toLowerCase().trim()}`),
  );

  // Also deduplicate within the incoming batch itself
  const batchPhones = new Set<string>();
  const batchUrls = new Set<string>();
  const batchNameCities = new Set<string>();

  for (const lead of incoming) {
    let isDuplicate = false;

    // Level 1: Phone
    if (lead.phone && lead.phone.trim()) {
      const normalized = normalizePhone(lead.phone);
      if (normalized.length >= 10) {
        if (existingPhones.has(normalized) || batchPhones.has(normalized)) {
          breakdown.phone++;
          isDuplicate = true;
        } else {
          batchPhones.add(normalized);
        }
      }
    }

    // Level 2: Source URL
    if (!isDuplicate && lead.source_url && lead.source_url.trim()) {
      if (existingUrls.has(lead.source_url) || batchUrls.has(lead.source_url)) {
        breakdown.url++;
        isDuplicate = true;
      } else {
        batchUrls.add(lead.source_url);
      }
    }

    // Level 3: Name + City
    if (!isDuplicate && lead.name && lead.city) {
      const key = `${normalizeName(lead.name)}_${lead.city.toLowerCase().trim()}`;
      if (existingNameCity.has(key) || batchNameCities.has(key)) {
        breakdown.nameCity++;
        isDuplicate = true;
      } else {
        batchNameCities.add(key);
      }
    }

    if (!isDuplicate) {
      toInsert.push(lead);
    }
  }

  return {
    toInsert,
    duplicatesSkipped: breakdown.phone + breakdown.url + breakdown.nameCity,
    breakdown,
  };
}
