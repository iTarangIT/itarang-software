import { parseTranscript } from "@/lib/ai/analysis/parser";

async function test() {
  const res = await parseTranscript(
    "mujhe 15 batteries chahiye, kal call karo",
  );

  console.log("FINAL RESULT:", JSON.stringify(res, null, 2));
}

test();
