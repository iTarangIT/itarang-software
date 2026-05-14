/**
 * One-off: build an Excel sheet of the highest-signal questions dealers
 * actually asked the ElevenLabs Priya agent. Source: 47 conversations,
 * 431 dealer turns, 204 raw questions — manually curated down to the
 * distinct, business-critical ones the agent must answer well.
 *
 * Run:  npx tsx scripts/generate-dealer-questions-sheet.ts
 * Out:  D:\itarang-software\Dealer_Important_Questions.xlsx
 */

import ExcelJS from "exceljs";
import path from "path";

type Frequency = "HIGH" | "MEDIUM" | "LOW";

interface Q {
  category: string;
  question: string;
  sample: string; // one representative phrasing from the raw data
  frequency: Frequency;
  whyItMatters: string;
}

// ── Curated list of important questions ──────────────────────────────────────
const QUESTIONS: Q[] = [
  // PRODUCT / CATALOGUE / BRAND LINE-UP
  {
    category: "Product / Catalogue",
    question:
      "Which battery brands do you deal with? Give me the full brand line-up.",
    sample:
      "हाँ, कौन-कौन सी brand की battery है आपके पास? / कौन सी brand की battery deal करते हो?",
    frequency: "HIGH",
    whyItMatters:
      "Most-asked product question. Dealers need the brand list before any other discussion (Trontek, Eastman, Eco Star, 9AP, CLN, etc.).",
  },
  {
    category: "Product / Catalogue",
    question:
      "Do you also deal in inverters? Which inverter brands and models?",
    sample:
      "आप inverter भी मतलब बेचते हो क्या? / कौन-से inverters बेचते हो?",
    frequency: "HIGH",
    whyItMatters:
      "Frequently asked across calls. Many dealers want a single supplier for both batteries and inverters.",
  },
  {
    category: "Product / Catalogue",
    question:
      "What is your product portfolio — chemistry, lifespan, safety features, applications?",
    sample:
      "Trontek के बारे में जानना है। उसका product catalogue क्या-क्या है? Cell chemistry क्या है? Battery life span कितनी है, safety features और application?",
    frequency: "MEDIUM",
    whyItMatters:
      "Detail-oriented dealers want full spec breakdown — agent should be able to walk through one specific brand thoroughly.",
  },
  {
    category: "Product / Catalogue",
    question:
      "What's the lifespan of your inverter battery / your battery in general?",
    sample: "उसका life span कितना है, inverter battery का?",
    frequency: "MEDIUM",
    whyItMatters: "Lifespan = direct ROI driver in dealer's mind.",
  },
  {
    category: "Product / Catalogue",
    question:
      "What's special about your battery vs. the one I'm currently using?",
    sample: "मैं कोई भी battery use कर रहा हूँ। आपकी battery में क्या फायदा है?",
    frequency: "MEDIUM",
    whyItMatters:
      "Switching cost question — agent must be able to articulate USP cleanly.",
  },
  {
    category: "Product / Catalogue",
    question: "Do you have a standard battery for e-rickshaw?",
    sample: "तुम्हारे पास e-rickshaw के लिए standard battery है क्या?",
    frequency: "LOW",
    whyItMatters: "Vehicle-fit question — common entry point for dealer conversations.",
  },

  // BATTERY SPECS
  {
    category: "Battery Specs",
    question:
      "List all the voltages / Ah configurations you offer (51 V, 60 V, 64 V, 72 V).",
    sample: "तुम मतलब list down करो तो voltage कौन-सी कौन-सी है तुम्हारे पास?",
    frequency: "HIGH",
    whyItMatters:
      "Spec drilldown — agent should rattle off the SKU matrix without hesitation.",
  },
  {
    category: "Battery Specs",
    question: "What is your highest-capacity battery?",
    sample: "तुम्हारे पास highest capacity battery क्या है?",
    frequency: "MEDIUM",
    whyItMatters: "Top-of-line interest — common from larger fleet buyers.",
  },
  {
    category: "Battery Specs",
    question: "Tell me the difference between 51.2 V and 105 Ah battery.",
    sample: "मुझे 512 और 105 का difference बताओ।",
    frequency: "MEDIUM",
    whyItMatters:
      "Voltage vs. capacity is genuinely confusing — agent must explain in plain Hindi.",
  },
  {
    category: "Battery Specs",
    question:
      "Which charger do you provide? Tell me about TK500 — range, safety features, lithium-safe?",
    sample:
      "TK 500 चार्जर है क्या? चार्जर का क्या रेंज है? Lithium safe है? Safety features क्या है?",
    frequency: "MEDIUM",
    whyItMatters: "Charger is bundled with battery — must be addressed.",
  },
  {
    category: "Battery Specs",
    question: "Do you have an SOC meter / IoT module?",
    sample: "SOC meter के लिए? SOC IoT क्या है आपके पास?",
    frequency: "LOW",
    whyItMatters:
      "Tech-savvy dealers ask for telemetry — important differentiator.",
  },

  // COMPANY / TRUST / BACKGROUND
  {
    category: "Company / Trust",
    question:
      "Tell me about iTarang Technologies — what do you do? Are you new?",
    sample:
      "What is iTarang Technologies? कौन हैं आप? कहाँ हैं? आपका company नया है क्या?",
    frequency: "HIGH",
    whyItMatters:
      "Trust gate. Asked verbatim multiple times. Agent should give 30-second elevator pitch first.",
  },
  {
    category: "Company / Trust",
    question:
      "Are you a supplier, dealer, financier, or aggregator? What's iTarang's exact role?",
    sample:
      "iTarang का role क्या है? आप supplier हो, dealer हो? आइतरंग कुछ खुद financer है?",
    frequency: "HIGH",
    whyItMatters:
      "Confusion is widespread. Agent must clearly position iTarang's role in the value chain.",
  },
  {
    category: "Company / Trust",
    question: "Who is your manufacturing partner? Do you manufacture yourself?",
    sample: "आपका manufacturing partner कौन है? कौन सा खुद बनाते हो?",
    frequency: "MEDIUM",
    whyItMatters:
      "OEM relationship — dealers want to know if you're an OEM partner or marketplace.",
  },
  {
    category: "Company / Trust",
    question: "Where is iTarang located / where do you operate?",
    sample: "Aaitarang कहाँ पे है? आपकी geographical places कहाँ हैं?",
    frequency: "MEDIUM",
    whyItMatters:
      "Often a soft trust check — gives agent a chance to mention HQ + presence.",
  },
  {
    category: "Company / Trust",
    question: "What are your terms and conditions?",
    sample: "तुम्हारी company के terms and conditions क्या है?",
    frequency: "MEDIUM",
    whyItMatters:
      "Vague but recurring — agent should know to surface payment, return, and dealer-tie-up T&Cs.",
  },

  // FINANCING — single biggest topic
  {
    category: "Financing",
    question: "Do you offer battery financing?",
    sample:
      "क्या आपकी battery finance भी होती है? / Finance, finance करवाते हैं आप लोग?",
    frequency: "HIGH",
    whyItMatters: "Top opener. If yes, agent should immediately bridge to finance details.",
  },
  {
    category: "Financing",
    question: "What is the minimum CIBIL score required for the driver?",
    sample:
      "Minimum कितना CIBIL score चाहिए driver को battery finance करवाने के लिए?",
    frequency: "HIGH",
    whyItMatters:
      "Most-asked finance qualifier. Direct number expected (current threshold).",
  },
  {
    category: "Financing",
    question: "What documents does the driver need for financing?",
    sample:
      "Driver के क्या-क्या document लगेंगे finance पे, जब वो finance चलाने आएगा?",
    frequency: "HIGH",
    whyItMatters: "Operational question — agent should list exact docs.",
  },
  {
    category: "Financing",
    question:
      "How is the dealer's finance code opened? What's the process / documents / charges?",
    sample:
      "हमारा finance का code कैसे खुलेगा? क्या process है? कोई charges है?",
    frequency: "HIGH",
    whyItMatters:
      "Dealer onboarding question — must be answered with concrete steps.",
  },
  {
    category: "Financing",
    question:
      "Maximum loan amount per battery? Down payment? Dealer margin?",
    sample:
      "Maximum कितना loan हो जाता है? कितना down payment है? कितना dealer का margin है?",
    frequency: "HIGH",
    whyItMatters: "Pricing-economics drilldown — needs specific numbers.",
  },
  {
    category: "Financing",
    question:
      "Can you finance batteries that are already in my stock (Trontek, Eastman, 9AP, CLN, etc.)?",
    sample:
      "मेरे पास available battery already है stock में, वो आप finance कर सकते हैं?",
    frequency: "HIGH",
    whyItMatters:
      "Repeated across calls — dealers want to monetise existing inventory. Critical yes/no.",
  },
  {
    category: "Financing",
    question: "Can you finance any brand of battery, or only specific brands?",
    sample: "तो कोई भी brand का हो, आप finance कर सकते हैं?",
    frequency: "HIGH",
    whyItMatters: "Defines the scope of the financing offering.",
  },
  {
    category: "Financing",
    question:
      "Which financiers do you work with? Are there options besides Bajaj Finserv?",
    sample:
      "Bajaj Finserv के अलावा कौन-कौन से financier हैं? कौन-सा financer available है?",
    frequency: "HIGH",
    whyItMatters: "Many dealers already have Bajaj — they want alternatives.",
  },
  {
    category: "Financing",
    question:
      "Is iTarang itself the financier, or do you aggregate across multiple financiers?",
    sample:
      "iTarang केवल अकेले financer है या कोई और भी? वो खुद finance करता है?",
    frequency: "MEDIUM",
    whyItMatters:
      "Position clarification. Agent must explain the model cleanly.",
  },
  {
    category: "Financing",
    question:
      "Geographically, where does iTarang finance? Which states / cities?",
    sample:
      "आयतरंग आज की date में कहाँ-कहाँ finance कर रही है? कौन-कौन से location?",
    frequency: "MEDIUM",
    whyItMatters: "Coverage gate — dealer wants to know if their region is served.",
  },
  {
    category: "Financing",
    question:
      "How many batteries per month does iTarang finance overall? (volume / proof of scale)",
    sample:
      "महीने की कितनी battery आज की date में iTarang कितनी battery finance कर रहा है overall?",
    frequency: "LOW",
    whyItMatters: "Trust signal — they're checking if you're a real player.",
  },
  {
    category: "Financing",
    question:
      "Who actually pays the EMI — the leaser, the driver, or the dealer?",
    sample:
      "EMI-VMI कौन भरता है इसकी? Leaser के लिए, customer के लिए, किसके लिए?",
    frequency: "MEDIUM",
    whyItMatters:
      "Cash-flow clarity — dealers need to know who's on the hook for what.",
  },

  // PRICING
  {
    category: "Pricing",
    question: "What is the exact price of 51 V / 105 Ah Trontek battery?",
    sample:
      "TronTech का price क्या है? 100 volt का 105 ampere का? / one zero five ampere की battery का exact price बताइए।",
    frequency: "HIGH",
    whyItMatters: "Top-asked specific SKU. Agent must give an exact number.",
  },
  {
    category: "Pricing",
    question:
      "What is the price difference between your different battery models?",
    sample: "बैटरीज़ में दोनों price का difference क्या है?",
    frequency: "MEDIUM",
    whyItMatters: "Comparative pricing across SKUs.",
  },
  {
    category: "Pricing",
    question:
      "Why should I buy from you when another dealer is selling 51.2 V at ₹70k?",
    sample:
      "मुझे वो 51.2 वोल्ट की battery दूसरे dealer के पास, दूसरे company के पास 70 में मिल रही है आपसे। तो मैं आपके ऐसे क्यों लूँ?",
    frequency: "MEDIUM",
    whyItMatters:
      "Price-objection handler. Agent must articulate value beyond price.",
  },

  // SERVICE & SUPPORT
  {
    category: "Service",
    question:
      "If I'm getting OEM service directly from Trontek already, why use iTarang?",
    sample:
      "Trontek already service fulfill कर रहा है। तो आपकी company क्या करेगी? iTrang से कोई benefit नहीं है directly काम करने से।",
    frequency: "HIGH",
    whyItMatters:
      "The hardest objection. Agent must clearly explain iTarang's value-add over direct OEM.",
  },
  {
    category: "Service",
    question:
      "If a battery is defective, what's the SOP? Do I send it to Trontek's plant or to iTarang? How many days for resolution?",
    sample:
      "Trontek की battery खराब हो गई, manufacturing defect, plant भेजना होता है, 10-15 दिन लग जाते हैं। आपके यहाँ कितने दिन में?",
    frequency: "HIGH",
    whyItMatters:
      "Plant turnaround is 10–15 days — dealers want to know if iTarang can do better.",
  },
  {
    category: "Service",
    question:
      "Will defective-battery resolution be faster on a financed battery vs. a regular one?",
    sample: "Finance की battery में भी ये issue आएगा या तुरंत resolve होगा?",
    frequency: "MEDIUM",
    whyItMatters: "Specific to financed inventory — important if iTarang offers SLA.",
  },
  {
    category: "Service",
    question:
      "Do you also service non-Trontek brands like Eco Star? What's the SOP?",
    sample: "Eco Star का service कैसे देते हैं? क्या SOP है उसकी?",
    frequency: "MEDIUM",
    whyItMatters:
      "Multi-brand service is a USP — agent should know which brands are covered.",
  },
  {
    category: "Service",
    question:
      "If a driver's charger breaks, who replaces it and how long does it take?",
    sample:
      "Driver का charger खराब हो जाए तो उसका क्या होगा? कितने दिन में charger replace होगा?",
    frequency: "MEDIUM",
    whyItMatters:
      "Charger warranty is bundled with battery — common operational ask.",
  },

  // DEALER / PARTNERSHIP / TERRITORY
  {
    category: "Dealer / Partnership",
    question:
      "How many dealers do you currently have in Delhi NCR / [my territory]?",
    sample: "अभी Delhi NCR में कितने dealer हैं?",
    frequency: "MEDIUM",
    whyItMatters: "Territory presence — affects exclusivity and competition.",
  },
  {
    category: "Dealer / Partnership",
    question:
      "Who are your existing dealers/distributors in my territory (e.g. Gurugram)?",
    sample:
      "अभी तक के किन-किन dealer distributor के साथ आप काम कर रहे हैं? Gurugram में current dealer कौन है?",
    frequency: "MEDIUM",
    whyItMatters:
      "Competitive intel — dealer wants to know what they're up against.",
  },
  {
    category: "Dealer / Partnership",
    question: "Can I work exclusively in my territory?",
    sample:
      "मैं exclusively काम करना चाहता हूँ अपने territory में। क्या वैसा कोई provision है?",
    frequency: "MEDIUM",
    whyItMatters: "Exclusivity is a deal-breaker for many dealers.",
  },
  {
    category: "Dealer / Partnership",
    question: "What documents are needed to become an iTarang dealer?",
    sample:
      "हमारा अगर iTarang से tie-up करना होगा, तो कैसे होगा tie-up? क्या-क्या document लगेंगे?",
    frequency: "MEDIUM",
    whyItMatters: "Onboarding logistics — concrete answer expected.",
  },

  // WARRANTY
  {
    category: "Warranty",
    question:
      "Do I get extra warranty (e.g. 4 years instead of 3) by buying through iTarang?",
    sample:
      "iTarang से purchase करूँ तो तीन साल के अलावा चार साल की warranty मिलेगी?",
    frequency: "MEDIUM",
    whyItMatters: "Warranty boost is a real iTarang differentiator if true.",
  },
  {
    category: "Warranty",
    question: "What's the warranty on a 232 Ah battery / specific model?",
    sample: "232 ampere की battery के लिए कितने साल की warranty?",
    frequency: "LOW",
    whyItMatters: "SKU-specific warranty.",
  },

  // PERFORMANCE / MILEAGE
  {
    category: "Performance",
    question:
      "Average mileage of 51 V / 105 Ah battery in an e-rickshaw?",
    sample:
      "51 volt 105 ampere की battery driver को e-rickshaw में लग के कितने का average mileage देगा?",
    frequency: "MEDIUM",
    whyItMatters: "Mileage = ROI proxy. Agent should give a realistic range.",
  },
  {
    category: "Performance",
    question:
      "What battery do you recommend for heavy-load applications?",
    sample: "Heavy load के लिए क्या recommend करोगे?",
    frequency: "LOW",
    whyItMatters: "Use-case fit — agent should map load to SKU.",
  },

  // AGENT QUALITY / META
  {
    category: "Agent Quality (meta)",
    question:
      "[Feedback] Don't mix Hindi and English numbers / units — pick one and stay consistent.",
    sample:
      "आप 51.2 क्यों बोल रहे हो? पूरा हिंदी में बोलो या English में। आधा-आधा मत बोलो।",
    frequency: "MEDIUM",
    whyItMatters:
      "Recurring agent-experience complaint. Fix this in the agent prompt — pick a language convention for measurements.",
  },
  {
    category: "Agent Quality (meta)",
    question:
      "[Feedback] Pronunciation of measurements is unclear — say them slowly and crisply.",
    sample: "Measurement जो होते हैं आप ठीक से pronounce नहीं कर रहे हो।",
    frequency: "LOW",
    whyItMatters:
      "TTS / phrasing tweak needed in the agent script.",
  },
  {
    category: "Agent Quality (meta)",
    question:
      "[Feedback] Stop jumping straight to finance — give product information first when asked.",
    sample:
      "Batteries के बारे में बताओ ना। आप कौन सी batteries दे रहे हैं? सीधा finance से कूट गए। पहले product information दे दो।",
    frequency: "MEDIUM",
    whyItMatters:
      "The agent's flow currently anchors too quickly on financing. Reorder the script.",
  },
  {
    category: "Agent Quality (meta)",
    question:
      "[Feedback] Agent introduced a price the dealer hadn't asked for — let dealer drive the conversation.",
    sample: "ये price आपने कहाँ से बताई? मतलब मैंने तो आपसे पूछी भी नहीं थी।",
    frequency: "LOW",
    whyItMatters:
      "Agent over-volunteers info. Wait for the dealer to ask before pricing.",
  },
];

async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "iTarang";
  wb.created = new Date();

  const sheet = wb.addWorksheet("Important Dealer Questions", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "#", key: "n", width: 5 },
    { header: "Category", key: "category", width: 22 },
    { header: "Question (canonical)", key: "question", width: 60 },
    { header: "Sample original phrasing", key: "sample", width: 60 },
    { header: "Frequency", key: "frequency", width: 12 },
    { header: "Why it matters / what agent must answer", key: "whyItMatters", width: 60 },
  ];

  // Header style
  sheet.getRow(1).eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A1A1A" } };
    c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  sheet.getRow(1).height = 32;

  const freqColor = (f: Frequency) =>
    f === "HIGH" ? "FFFEE2E2" : f === "MEDIUM" ? "FFFEF3C7" : "FFE0F2FE";
  const freqText = (f: Frequency) =>
    f === "HIGH" ? "FF991B1B" : f === "MEDIUM" ? "FF92400E" : "FF075985";

  QUESTIONS.forEach((q, i) => {
    const row = sheet.addRow({
      n: i + 1,
      category: q.category,
      question: q.question,
      sample: q.sample,
      frequency: q.frequency,
      whyItMatters: q.whyItMatters,
    });

    row.eachCell((cell, colNumber) => {
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = { bottom: { style: "hair", color: { argb: "FFE5E7EB" } } };
      if (i % 2 === 0) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF9FAFB" },
        };
      }
      // Frequency cell — colored chip
      if (colNumber === 5) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: freqColor(q.frequency) },
        };
        cell.font = { bold: true, color: { argb: freqText(q.frequency) }, size: 10 };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }
    });
    row.height = 60;
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columns.length },
  };

  // ── Summary tab ──────────────────────────────────────────────
  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 36 },
    { header: "Value", key: "value", width: 24 },
  ];
  summary.getRow(1).eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A1A1A" } };
    c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    c.alignment = { vertical: "middle", horizontal: "center" };
  });
  summary.getRow(1).height = 24;

  const byCat = new Map<string, number>();
  const byFreq = new Map<Frequency, number>();
  for (const q of QUESTIONS) {
    byCat.set(q.category, (byCat.get(q.category) ?? 0) + 1);
    byFreq.set(q.frequency, (byFreq.get(q.frequency) ?? 0) + 1);
  }

  summary.addRow({ metric: "Total important questions", value: QUESTIONS.length });
  summary.addRow({ metric: "Source conversations analysed", value: 47 });
  summary.addRow({ metric: "Source dealer turns analysed", value: 431 });
  summary.addRow({ metric: "Source raw questions reviewed", value: 204 });
  summary.addRow({});
  summary.addRow({ metric: "── BY FREQUENCY ──", value: "" }).font = { bold: true };
  (["HIGH", "MEDIUM", "LOW"] as Frequency[]).forEach((f) =>
    summary.addRow({ metric: f, value: byFreq.get(f) ?? 0 }),
  );
  summary.addRow({});
  summary.addRow({ metric: "── BY CATEGORY ──", value: "" }).font = { bold: true };
  Array.from(byCat.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) =>
      summary.addRow({ metric: cat, value: count }),
    );
  summary.addRow({});
  summary.addRow({
    metric: "Generated at",
    value: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
  });

  // ── Write file ───────────────────────────────────────────────
  const outPath = path.resolve("D:/itarang-software/Dealer_Important_Questions.xlsx");
  await wb.xlsx.writeFile(outPath);
  console.log(`✓ Wrote ${QUESTIONS.length} curated questions → ${outPath}`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
