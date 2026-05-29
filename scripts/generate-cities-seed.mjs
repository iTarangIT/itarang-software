// One-shot generator for drizzle/E-111_seed_all_indian_districts.sql.
//
// Source: states-and-districts dataset (sab99r/Indian-States-And-Districts on
// GitHub) — every district in India + the state it belongs to. For dealer
// lead scraping, district names ARE the cities we care about (district HQs).
//
// Output: an idempotent SQL file with INSERT … ON CONFLICT DO NOTHING for
// cities + city_aliases, ready to paste into pgAdmin.
//
// Re-run with: `node scripts/generate-cities-seed.mjs`

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, "..", "drizzle", "E-111_seed_all_indian_districts.sql");

// State name (as in dataset) → state code (matches E-108 seed).
const STATE_CODE = {
  "Andhra Pradesh": "AP",
  "Arunachal Pradesh": "AR",
  "Assam": "AS",
  "Bihar": "BR",
  "Chandigarh (UT)": "CH",
  "Chhattisgarh": "CG",
  "Dadra and Nagar Haveli (UT)": "DN",
  "Daman and Diu (UT)": "DN",
  "Delhi (NCT)": "DL",
  "Goa": "GA",
  "Gujarat": "GJ",
  "Haryana": "HR",
  "Himachal Pradesh": "HP",
  "Jammu and Kashmir": "JK",
  "Jharkhand": "JH",
  "Karnataka": "KA",
  "Kerala": "KL",
  "Lakshadweep (UT)": "LD",
  "Madhya Pradesh": "MP",
  "Maharashtra": "MH",
  "Manipur": "MN",
  "Meghalaya": "ML",
  "Mizoram": "MZ",
  "Nagaland": "NL",
  "Odisha": "OD",
  "Puducherry (UT)": "PY",
  "Punjab": "PB",
  "Rajasthan": "RJ",
  "Sikkim": "SK",
  "Tamil Nadu": "TN",
  "Telangana": "TS",
  "Tripura": "TR",
  "Uttarakhand": "UK",
  "Uttar Pradesh": "UP",
  "West Bengal": "WB",
};

// Districts that belong to Ladakh (split from J&K). Override the dataset.
const LADAKH = new Set(["Kargil", "Leh"]);

// District names from the dataset that map to a canonical city ID already
// inserted by E-108 or E-110 under a different (modern / metro) name. We
// emit ONLY an alias row for these — no new canonical insert — so the
// region tree never has two rows for the same place.
//
// Key: "{state code}::{raw district name lowercased}". Value: existing
// canonical city_id from E-108/E-110.
const ALIAS_ONLY = {
  // Haryana — Gurgaon (district name) → Gurugram (canonical from E-108).
  "HR::gurgaon": "c_gurugram_hr",
  // Karnataka — district names split Bengaluru into Rural/Urban; both alias
  // to the metro row from E-108.
  "KA::bengaluru (bangalore) rural": "c_bengaluru_ka",
  "KA::bengaluru (bangalore) urban": "c_bengaluru_ka",
  // Maharashtra — Mumbai is split into City/Suburban district rows; both
  // alias to the metro row from E-108.
  "MH::mumbai city": "c_mumbai_mh",
  "MH::mumbai suburban": "c_mumbai_mh",
  // Telangana — Warangal split into Rural/Urban; alias both to Warangal
  // from E-110.
  "TS::warangal (rural)": "c_warangal_ts",
  "TS::warangal (urban)": "c_warangal_ts",
  // UP — Allahabad was renamed to Prayagraj in 2018; E-108 uses the new
  // name. Alias both forms to the canonical Prayagraj row.
  "UP::allahabad": "c_prayagraj_up",
};

// Dataset (verbatim from sab99r/Indian-States-And-Districts).
const DATA = {
  states: [
    { state: "Andhra Pradesh", districts: ["Anantapur","Chittoor","East Godavari","Guntur","Krishna","Kurnool","Nellore","Prakasam","Srikakulam","Visakhapatnam","Vizianagaram","West Godavari","YSR Kadapa"] },
    { state: "Arunachal Pradesh", districts: ["Tawang","West Kameng","East Kameng","Papum Pare","Kurung Kumey","Kra Daadi","Lower Subansiri","Upper Subansiri","West Siang","East Siang","Siang","Upper Siang","Lower Siang","Lower Dibang Valley","Dibang Valley","Anjaw","Lohit","Namsai","Changlang","Tirap","Longding"] },
    { state: "Assam", districts: ["Baksa","Barpeta","Biswanath","Bongaigaon","Cachar","Charaideo","Chirang","Darrang","Dhemaji","Dhubri","Dibrugarh","Goalpara","Golaghat","Hailakandi","Hojai","Jorhat","Kamrup Metropolitan","Kamrup","Karbi Anglong","Karimganj","Kokrajhar","Lakhimpur","Majuli","Morigaon","Nagaon","Nalbari","Dima Hasao","Sivasagar","Sonitpur","South Salmara-Mankachar","Tinsukia","Udalguri","West Karbi Anglong"] },
    { state: "Bihar", districts: ["Araria","Arwal","Aurangabad","Banka","Begusarai","Bhagalpur","Bhojpur","Buxar","Darbhanga","East Champaran (Motihari)","Gaya","Gopalganj","Jamui","Jehanabad","Kaimur (Bhabua)","Katihar","Khagaria","Kishanganj","Lakhisarai","Madhepura","Madhubani","Munger (Monghyr)","Muzaffarpur","Nalanda","Nawada","Patna","Purnia (Purnea)","Rohtas","Saharsa","Samastipur","Saran","Sheikhpura","Sheohar","Sitamarhi","Siwan","Supaul","Vaishali","West Champaran"] },
    { state: "Chandigarh (UT)", districts: ["Chandigarh"] },
    { state: "Chhattisgarh", districts: ["Balod","Baloda Bazar","Balrampur","Bastar","Bemetara","Bijapur","Bilaspur","Dantewada (South Bastar)","Dhamtari","Durg","Gariyaband","Janjgir-Champa","Jashpur","Kabirdham (Kawardha)","Kanker (North Bastar)","Kondagaon","Korba","Korea (Koriya)","Mahasamund","Mungeli","Narayanpur","Raigarh","Raipur","Rajnandgaon","Sukma","Surajpur","Surguja"] },
    { state: "Dadra and Nagar Haveli (UT)", districts: ["Dadra & Nagar Haveli"] },
    { state: "Daman and Diu (UT)", districts: ["Daman","Diu"] },
    { state: "Delhi (NCT)", districts: ["Central Delhi","East Delhi","New Delhi","North Delhi","North East Delhi","North West Delhi","Shahdara","South Delhi","South East Delhi","South West Delhi","West Delhi"] },
    { state: "Goa", districts: ["North Goa","South Goa"] },
    { state: "Gujarat", districts: ["Ahmedabad","Amreli","Anand","Aravalli","Banaskantha (Palanpur)","Bharuch","Bhavnagar","Botad","Chhota Udepur","Dahod","Dangs (Ahwa)","Devbhoomi Dwarka","Gandhinagar","Gir Somnath","Jamnagar","Junagadh","Kachchh","Kheda (Nadiad)","Mahisagar","Mehsana","Morbi","Narmada (Rajpipla)","Navsari","Panchmahal (Godhra)","Patan","Porbandar","Rajkot","Sabarkantha (Himmatnagar)","Surat","Surendranagar","Tapi (Vyara)","Vadodara","Valsad"] },
    { state: "Haryana", districts: ["Ambala","Bhiwani","Charkhi Dadri","Faridabad","Fatehabad","Gurgaon","Hisar","Jhajjar","Jind","Kaithal","Karnal","Kurukshetra","Mahendragarh","Mewat","Palwal","Panchkula","Panipat","Rewari","Rohtak","Sirsa","Sonipat","Yamunanagar"] },
    { state: "Himachal Pradesh", districts: ["Bilaspur","Chamba","Hamirpur","Kangra","Kinnaur","Kullu","Lahaul & Spiti","Mandi","Shimla","Sirmaur (Sirmour)","Solan","Una"] },
    { state: "Jammu and Kashmir", districts: ["Anantnag","Bandipore","Baramulla","Budgam","Doda","Ganderbal","Jammu","Kargil","Kathua","Kishtwar","Kulgam","Kupwara","Leh","Poonch","Pulwama","Rajouri","Ramban","Reasi","Samba","Shopian","Srinagar","Udhampur"] },
    { state: "Jharkhand", districts: ["Bokaro","Chatra","Deoghar","Dhanbad","Dumka","East Singhbhum","Garhwa","Giridih","Godda","Gumla","Hazaribag","Jamtara","Khunti","Koderma","Latehar","Lohardaga","Pakur","Palamu","Ramgarh","Ranchi","Sahibganj","Seraikela-Kharsawan","Simdega","West Singhbhum"] },
    { state: "Karnataka", districts: ["Bagalkot","Ballari (Bellary)","Belagavi (Belgaum)","Bengaluru (Bangalore) Rural","Bengaluru (Bangalore) Urban","Bidar","Chamarajanagar","Chikballapur","Chikkamagaluru (Chikmagalur)","Chitradurga","Dakshina Kannada","Davangere","Dharwad","Gadag","Hassan","Haveri","Kalaburagi (Gulbarga)","Kodagu","Kolar","Koppal","Mandya","Mysuru (Mysore)","Raichur","Ramanagara","Shivamogga (Shimoga)","Tumakuru (Tumkur)","Udupi","Uttara Kannada (Karwar)","Vijayapura (Bijapur)","Yadgir"] },
    { state: "Kerala", districts: ["Alappuzha","Ernakulam","Idukki","Kannur","Kasaragod","Kollam","Kottayam","Kozhikode","Malappuram","Palakkad","Pathanamthitta","Thiruvananthapuram","Thrissur","Wayanad"] },
    { state: "Lakshadweep (UT)", districts: ["Agatti","Amini","Androth","Bithra","Chethlath","Kavaratti","Kadmath","Kalpeni","Kilthan","Minicoy"] },
    { state: "Madhya Pradesh", districts: ["Agar Malwa","Alirajpur","Anuppur","Ashoknagar","Balaghat","Barwani","Betul","Bhind","Bhopal","Burhanpur","Chhatarpur","Chhindwara","Damoh","Datia","Dewas","Dhar","Dindori","Guna","Gwalior","Harda","Hoshangabad","Indore","Jabalpur","Jhabua","Katni","Khandwa","Khargone","Mandla","Mandsaur","Morena","Narsinghpur","Neemuch","Panna","Raisen","Rajgarh","Ratlam","Rewa","Sagar","Satna","Sehore","Seoni","Shahdol","Shajapur","Sheopur","Shivpuri","Sidhi","Singrauli","Tikamgarh","Ujjain","Umaria","Vidisha"] },
    { state: "Maharashtra", districts: ["Ahmednagar","Akola","Amravati","Aurangabad","Beed","Bhandara","Buldhana","Chandrapur","Dhule","Gadchiroli","Gondia","Hingoli","Jalgaon","Jalna","Kolhapur","Latur","Mumbai City","Mumbai Suburban","Nagpur","Nanded","Nandurbar","Nashik","Osmanabad","Palghar","Parbhani","Pune","Raigad","Ratnagiri","Sangli","Satara","Sindhudurg","Solapur","Thane","Wardha","Washim","Yavatmal"] },
    { state: "Manipur", districts: ["Bishnupur","Chandel","Churachandpur","Imphal East","Imphal West","Jiribam","Kakching","Kamjong","Kangpokpi","Noney","Pherzawl","Senapati","Tamenglong","Tengnoupal","Thoubal","Ukhrul"] },
    { state: "Meghalaya", districts: ["East Garo Hills","East Jaintia Hills","East Khasi Hills","North Garo Hills","Ri Bhoi","South Garo Hills","South West Garo Hills","South West Khasi Hills","West Garo Hills","West Jaintia Hills","West Khasi Hills"] },
    { state: "Mizoram", districts: ["Aizawl","Champhai","Kolasib","Lawngtlai","Lunglei","Mamit","Saiha","Serchhip"] },
    { state: "Nagaland", districts: ["Dimapur","Kiphire","Kohima","Longleng","Mokokchung","Mon","Peren","Phek","Tuensang","Wokha","Zunheboto"] },
    { state: "Odisha", districts: ["Angul","Balangir","Balasore","Bargarh","Bhadrak","Boudh","Cuttack","Deogarh","Dhenkanal","Gajapati","Ganjam","Jagatsinghapur","Jajpur","Jharsuguda","Kalahandi","Kandhamal","Kendrapara","Kendujhar (Keonjhar)","Khordha","Koraput","Malkangiri","Mayurbhanj","Nabarangpur","Nayagarh","Nuapada","Puri","Rayagada","Sambalpur","Sonepur","Sundargarh"] },
    { state: "Puducherry (UT)", districts: ["Karaikal","Mahe","Pondicherry","Yanam"] },
    { state: "Punjab", districts: ["Amritsar","Barnala","Bathinda","Faridkot","Fatehgarh Sahib","Fazilka","Ferozepur","Gurdaspur","Hoshiarpur","Jalandhar","Kapurthala","Ludhiana","Mansa","Moga","Muktsar","Nawanshahr (Shahid Bhagat Singh Nagar)","Pathankot","Patiala","Rupnagar","Sahibzada Ajit Singh Nagar (Mohali)","Sangrur","Tarn Taran"] },
    { state: "Rajasthan", districts: ["Ajmer","Alwar","Banswara","Baran","Barmer","Bharatpur","Bhilwara","Bikaner","Bundi","Chittorgarh","Churu","Dausa","Dholpur","Dungarpur","Hanumangarh","Jaipur","Jaisalmer","Jalore","Jhalawar","Jhunjhunu","Jodhpur","Karauli","Kota","Nagaur","Pali","Pratapgarh","Rajsamand","Sawai Madhopur","Sikar","Sirohi","Sri Ganganagar","Tonk","Udaipur"] },
    { state: "Sikkim", districts: ["East Sikkim","North Sikkim","South Sikkim","West Sikkim"] },
    { state: "Tamil Nadu", districts: ["Ariyalur","Chennai","Coimbatore","Cuddalore","Dharmapuri","Dindigul","Erode","Kanchipuram","Kanyakumari","Karur","Krishnagiri","Madurai","Nagapattinam","Namakkal","Nilgiris","Perambalur","Pudukkottai","Ramanathapuram","Salem","Sivaganga","Thanjavur","Theni","Thoothukudi (Tuticorin)","Tiruchirappalli","Tirunelveli","Tiruppur","Tiruvallur","Tiruvannamalai","Tiruvarur","Vellore","Viluppuram","Virudhunagar"] },
    { state: "Telangana", districts: ["Adilabad","Bhadradri Kothagudem","Hyderabad","Jagtial","Jangaon","Jayashankar Bhoopalpally","Jogulamba Gadwal","Kamareddy","Karimnagar","Khammam","Komaram Bheem Asifabad","Mahabubabad","Mahabubnagar","Mancherial","Medak","Medchal","Nagarkurnool","Nalgonda","Nirmal","Nizamabad","Peddapalli","Rajanna Sircilla","Rangareddy","Sangareddy","Siddipet","Suryapet","Vikarabad","Wanaparthy","Warangal (Rural)","Warangal (Urban)","Yadadri Bhuvanagiri"] },
    { state: "Tripura", districts: ["Dhalai","Gomati","Khowai","North Tripura","Sepahijala","South Tripura","Unakoti","West Tripura"] },
    { state: "Uttarakhand", districts: ["Almora","Bageshwar","Chamoli","Champawat","Dehradun","Haridwar","Nainital","Pauri Garhwal","Pithoragarh","Rudraprayag","Tehri Garhwal","Udham Singh Nagar","Uttarkashi"] },
    { state: "Uttar Pradesh", districts: ["Agra","Aligarh","Allahabad","Ambedkar Nagar","Amethi (Chatrapati Sahuji Mahraj Nagar)","Amroha (J.P. Nagar)","Auraiya","Azamgarh","Baghpat","Bahraich","Ballia","Balrampur","Banda","Barabanki","Bareilly","Basti","Bhadohi","Bijnor","Budaun","Bulandshahr","Chandauli","Chitrakoot","Deoria","Etah","Etawah","Faizabad","Farrukhabad","Fatehpur","Firozabad","Gautam Buddha Nagar","Ghaziabad","Ghazipur","Gonda","Gorakhpur","Hamirpur","Hapur (Panchsheel Nagar)","Hardoi","Hathras","Jalaun","Jaunpur","Jhansi","Kannauj","Kanpur Dehat","Kanpur Nagar","Kanshiram Nagar (Kasganj)","Kaushambi","Kushinagar (Padrauna)","Lakhimpur - Kheri","Lalitpur","Lucknow","Maharajganj","Mahoba","Mainpuri","Mathura","Mau","Meerut","Mirzapur","Moradabad","Muzaffarnagar","Pilibhit","Pratapgarh","RaeBareli","Rampur","Saharanpur","Sambhal (Bhim Nagar)","Sant Kabir Nagar","Shahjahanpur","Shamali (Prabuddh Nagar)","Shravasti","Siddharth Nagar","Sitapur","Sonbhadra","Sultanpur","Unnao","Varanasi"] },
    { state: "West Bengal", districts: ["Alipurduar","Bankura","Birbhum","Burdwan (Bardhaman)","Cooch Behar","Dakshin Dinajpur (South Dinajpur)","Darjeeling","Hooghly","Howrah","Jalpaiguri","Kalimpong","Kolkata","Malda","Murshidabad","Nadia","North 24 Parganas","Paschim Medinipur (West Medinipur)","Purba Medinipur (East Medinipur)","Purulia","South 24 Parganas","Uttar Dinajpur (North Dinajpur)"] },
  ],
};

// Admin suffix words that should never be added as a standalone alias —
// "Rural", "Urban", "City" alone shouldn't resolve to a specific city.
const ADMIN_SUFFIXES = new Set([
  "rural",
  "urban",
  "city",
  "town",
  "north",
  "south",
  "east",
  "west",
  "metropolitan",
]);

// Strip parenthesized parts for the canonical name; the parenthesized text
// becomes an alias. "Belagavi (Belgaum)" → canonical "Belagavi", alias
// "Belgaum". "Gurgaon" is preserved as-is. When the parenthesized text is
// a generic admin suffix ("Rural", "Urban"), we keep it joined to the
// canonical name and skip the standalone alias.
function canonicalAndAliases(raw) {
  const name = raw.trim();
  const m = name.match(/^([^()]+?)\s*\(([^)]+)\)\s*(.*)$/);
  const aliases = new Set();
  let canonical;
  if (m) {
    canonical = m[1].trim();
    const inside = m[2].trim();
    const tail = (m[3] || "").trim();
    if (inside && !ADMIN_SUFFIXES.has(inside.toLowerCase())) {
      aliases.add(inside);
    }
    if (tail) aliases.add(`${canonical} ${tail}`.trim());
    // Also alias the full raw (with parens collapsed to a space) so a
    // scrape that wrote "Warangal Rural" still resolves.
    const flattened = name.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
    if (flattened !== canonical) aliases.add(flattened);
  } else {
    canonical = name;
  }
  // Always self-alias on lowercase canonical so the JOIN in regions/tree
  // works without a separate direct-name branch.
  aliases.add(canonical);
  return { canonical, aliases };
}

function citySlug(name, code) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `c_${slug}_${code.toLowerCase()}`;
}

// SQL escape — single quotes only, no other chars allowed in city names.
function sq(s) {
  return s.replace(/'/g, "''");
}

const cityRows = []; // { id, name, code }
const aliasRows = []; // { alias, cityId }
const seenCityIds = new Set();
const seenAliases = new Set();

for (const { state, districts } of DATA.states) {
  for (const raw of districts) {
    const defaultCode = STATE_CODE[state];
    // Special-case J&K → Ladakh.
    const code = state === "Jammu and Kashmir" && LADAKH.has(raw) ? "LA" : defaultCode;
    if (!code) {
      console.warn(`No state code for ${state}`);
      continue;
    }

    // Alias-only override path: this district name already has a canonical
    // row in E-108/E-110 under a different name. Emit only the alias.
    const overrideKey = `${code}::${raw.toLowerCase()}`;
    const overrideId = ALIAS_ONLY[overrideKey];
    if (overrideId) {
      const { aliases } = canonicalAndAliases(raw);
      for (const alias of aliases) {
        const lower = alias.toLowerCase();
        const key = `${lower}::${overrideId}`;
        if (seenAliases.has(key)) continue;
        aliasRows.push({ alias: lower, cityId: overrideId });
        seenAliases.add(key);
      }
      continue;
    }

    const { canonical, aliases } = canonicalAndAliases(raw);
    const id = citySlug(canonical, code);
    if (!seenCityIds.has(id)) {
      cityRows.push({ id, name: canonical, code });
      seenCityIds.add(id);
    }
    for (const alias of aliases) {
      const lower = alias.toLowerCase();
      const key = `${lower}::${id}`;
      if (seenAliases.has(key)) continue;
      aliasRows.push({ alias: lower, cityId: id });
      seenAliases.add(key);
    }
  }
}

const header = `-- E-111 — Exhaustive Indian district seed for the canonical cities table.
--
-- Generated by scripts/generate-cities-seed.mjs from the
-- sab99r/Indian-States-And-Districts dataset. Every district in India is
-- inserted as a canonical city under its state. Parenthesized alternate
-- names (e.g. "Belagavi (Belgaum)") become aliases pointing at the
-- canonical row.
--
-- Combined with E-108 (metros + state capitals) and E-110 (additional
-- tier-2/3 cities), this covers every common scrape location. The auto-grow
-- path in src/lib/locations/normalize.ts still handles any city that
-- isn't a district HQ.
--
-- Idempotent: every INSERT is guarded by ON CONFLICT DO NOTHING. Re-running
-- against a DB that already has these rows is a no-op.
--
-- Apply via pgAdmin Query Tool against AWS Postgres.

`;

const cityValues = cityRows
  .map((r) => `    ('${sq(r.id)}', '${sq(r.name)}', '${r.code}', 'seed')`)
  .join(",\n");

const aliasValues = aliasRows
  .map((r) => `    ('${sq(r.alias)}', '${sq(r.cityId)}')`)
  .join(",\n");

const sql = `${header}-- ${cityRows.length} canonical cities.
INSERT INTO cities (id, name, state_code, source) VALUES
${cityValues}
ON CONFLICT (id) DO NOTHING;

-- ${aliasRows.length} alias rows (incl. self-aliases for direct LOWER(name) lookup).
INSERT INTO city_aliases (alias_lower, city_id) VALUES
${aliasValues}
ON CONFLICT (alias_lower) DO NOTHING;
`;

writeFileSync(OUTPUT, sql);
console.log(`Wrote ${OUTPUT}: ${cityRows.length} cities, ${aliasRows.length} aliases`);
