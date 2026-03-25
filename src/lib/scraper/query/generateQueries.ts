import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function generateQueries(baseQuery: string): Promise<string[]> {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    const prompt = `
    Expand this business search query into 15 high-quality Google Maps search queries.

    Rules:
    - Make queries suitable for Google Maps (real business searches)
    - Replace vague terms with real-world terms
    - Example: "3w battery" → "e rickshaw battery"
    - Include: dealer, shop, supplier, distributor
    - Keep original location (do not change city)
    - Return ONLY JSON array

    Query: "${baseQuery}"
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const clean = text.replace(/```json|```/g, "").trim();

    const queries = JSON.parse(clean);

    return queries.slice(0, 20);
  } catch {
    return [
      baseQuery,
      `${baseQuery} dealer`,
      `${baseQuery} supplier`,
      `${baseQuery} distributor`,
    ];
  }
}
