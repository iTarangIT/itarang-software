import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function generateQueries(baseQuery: string): Promise<string[]> {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    const prompt = `
Expand this business search query into 20 high-quality variations.

Rules:
- Focus on business intent (dealer, supplier, distributor)
- Include EV, lithium, e-rickshaw context
- Keep it relevant to Indian market
- Return ONLY JSON array

Query: "${baseQuery}"
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const clean = text.replace(/```json|```/g, "").trim();

    const queries = JSON.parse(clean);

    return queries.slice(0, 20);
  } catch (err) {
    console.error("AI failed, fallback used:", err);

    return [baseQuery, `${baseQuery} supplier`, `${baseQuery} distributor`];
  }
}
