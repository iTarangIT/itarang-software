import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function generateQueries(baseQuery: string): Promise<string[]> {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `
Expand this business search query into 15 high-quality Google Maps search queries.

Rules:
- Make queries suitable for Google Maps (real business searches)
- Replace vague terms with real-world terms (e.g. "3w battery" → "e rickshaw battery")
- Include variations: dealer, shop, supplier, distributor
- Do NOT include any city or location in the queries — return only business type queries
- Return ONLY a JSON array of strings, no explanation, no markdown

Query: "${baseQuery}"
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const clean = text.replace(/```json|```/g, "").trim();
    const queries = JSON.parse(clean);
    return [...new Set<string>(queries)].slice(0, 15);
  } catch {
    return [
      baseQuery,
      `${baseQuery} dealer`,
      `${baseQuery} supplier`,
      `${baseQuery} distributor`,
    ];
  }
}

export async function generateCitiesForQuery(baseQuery: string): Promise<string[]> {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `
Given this business search query: "${baseQuery}"

1. Extract the location from the query (could be a state, region, or city)
2. Return a JSON array of 20-30 cities ONLY within that location
3. If the location is a STATE, return cities within that state only
4. If the location is a CITY, return just that city
5. If no location is found, return major Indian cities
6. Return ONLY a JSON array of city name strings — no explanation, no markdown

Examples:
- "3w battery in Maharashtra" → ["Mumbai", "Pune", "Nagpur", "Nashik", "Aurangabad", "Kolhapur", "Solapur", "Amravati"]
- "battery dealer in Delhi" → ["Delhi", "New Delhi", "Dwarka", "Rohini", "Noida", "Gurugram"]

Query: "${baseQuery}"
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const clean = text.replace(/```json|```/g, "").trim();
    const cities = JSON.parse(clean);
    return [...new Set<string>(cities)];
  } catch {
    return extractCitiesFallback(baseQuery);
  }
}

function extractCitiesFallback(query: string): string[] {
  const lower = query.toLowerCase();

  const stateMap: Record<string, string[]> = {
    maharashtra: ["Mumbai", "Pune", "Nagpur", "Nashik", "Aurangabad", "Kolhapur", "Solapur", "Amravati", "Akola", "Jalgaon", "Sangli", "Satara", "Ratnagiri", "Ahmednagar", "Latur", "Nanded", "Chandrapur", "Dhule", "Jalna", "Parbhani", "Osmanabad", "Beed", "Washim", "Yavatmal", "Wardha", "Gondia", "Bhandara", "Gadchiroli", "Hingoli", "Buldhana"],

    "uttar pradesh": ["Lucknow", "Kanpur", "Agra", "Varanasi", "Meerut", "Prayagraj", "Ghaziabad", "Noida", "Bareilly", "Aligarh", "Moradabad", "Saharanpur", "Gorakhpur", "Firozabad", "Jhansi", "Muzaffarnagar", "Mathura", "Rampur", "Shahjahanpur", "Farrukhabad", "Mau", "Hapur", "Etawah", "Mirzapur", "Bulandshahr", "Sambhal", "Amroha", "Hardoi", "Fatehpur", "Raebareli"],
    up: ["Lucknow", "Kanpur", "Agra", "Varanasi", "Meerut", "Prayagraj", "Ghaziabad", "Noida", "Bareilly", "Aligarh"],

    gujarat: ["Ahmedabad", "Surat", "Vadodara", "Rajkot", "Bhavnagar", "Jamnagar", "Gandhinagar", "Junagadh", "Anand", "Navsari", "Morbi", "Nadiad", "Surendranagar", "Bharuch", "Mehsana", "Bhuj", "Porbandar", "Amreli", "Ankleshwar", "Valsad", "Vapi", "Godhra", "Patan", "Dahod", "Botad", "Aravalli", "Mahisagar", "Kheda", "Banaskantha", "Sabarkantha"],

    rajasthan: ["Jaipur", "Jodhpur", "Udaipur", "Kota", "Ajmer", "Bikaner", "Alwar", "Bharatpur", "Sri Ganganagar", "Sikar", "Pali", "Barmer", "Tonk", "Bhilwara", "Chittorgarh", "Jhunjhunu", "Hanumangarh", "Nagaur", "Sawai Madhopur", "Churu", "Jhalawar", "Banswara", "Dholpur", "Baran", "Dausa", "Sirohi", "Rajsamand", "Dungarpur", "Jaisalmer", "Karauli"],

    "madhya pradesh": ["Bhopal", "Indore", "Jabalpur", "Gwalior", "Ujjain", "Sagar", "Dewas", "Satna", "Ratlam", "Rewa", "Murwara", "Singrauli", "Burhanpur", "Khandwa", "Bhind", "Chhindwara", "Guna", "Shivpuri", "Vidisha", "Chhatarpur", "Damoh", "Mandsaur", "Khargone", "Neemuch", "Pithampur", "Hoshangabad", "Itarsi", "Sehore", "Betul", "Seoni"],
    mp: ["Bhopal", "Indore", "Jabalpur", "Gwalior", "Ujjain", "Sagar", "Dewas", "Satna", "Ratlam", "Rewa"],

    karnataka: ["Bangalore", "Mysore", "Hubli", "Mangalore", "Belgaum", "Gulbarga", "Davanagere", "Bellary", "Bijapur", "Shimoga", "Tumkur", "Raichur", "Bidar", "Hospet", "Hassan", "Gadag", "Udupi", "Robertsonpet", "Bhadravati", "Chitradurga", "Kolar", "Mandya", "Chikmagalur", "Gangavati", "Bagalkot", "Ranebennuru", "Yadgir", "Chamarajanagar", "Kodagu", "Vijayapura"],

    "tamil nadu": ["Chennai", "Coimbatore", "Madurai", "Tiruchirappalli", "Salem", "Tirunelveli", "Tiruppur", "Ranipet", "Nagercoil", "Thanjavur", "Vellore", "Kancheepuram", "Erode", "Tiruvannamalai", "Pollachi", "Rajapalayam", "Sivakasi", "Pudukkottai", "Neyveli", "Nagapattinam", "Dindigul", "Cuddalore", "Thoothukudi", "Karur", "Ooty", "Hosur", "Kumbakonam", "Dharmapuri", "Krishnagiri", "Namakkal"],

    "west bengal": ["Kolkata", "Howrah", "Durgapur", "Asansol", "Siliguri", "Bardhaman", "Malda", "Baharampur", "Habra", "Kharagpur", "Shantipur", "Dankuni", "Dhulian", "Ranaghat", "Haldia", "Raiganj", "Krishnanagar", "Nabadwip", "Medinipur", "Jalpaiguri", "Balurghat", "Basirhat", "Bankura", "Chakdaha", "Darjeeling", "Alipurduar", "Purulia", "Murshidabad", "Cooch Behar", "English Bazar"],
    wb: ["Kolkata", "Howrah", "Durgapur", "Asansol", "Siliguri", "Bardhaman", "Malda"],

    "andhra pradesh": ["Visakhapatnam", "Vijayawada", "Guntur", "Nellore", "Kurnool", "Rajahmundry", "Kakinada", "Tirupati", "Kadapa", "Anantapur", "Vizianagaram", "Eluru", "Ongole", "Nandyal", "Machilipatnam", "Adoni", "Tenali", "Chittoor", "Hindupur", "Proddatur", "Bhimavaram", "Madanapalle", "Guntakal", "Dharmavaram", "Gudivada", "Narasaraopet", "Tadipatri", "Tadepalligudem", "Chilakaluripet", "Mangalagiri"],
    ap: ["Visakhapatnam", "Vijayawada", "Guntur", "Nellore", "Kurnool", "Rajahmundry", "Kakinada", "Tirupati"],

    telangana: ["Hyderabad", "Warangal", "Nizamabad", "Karimnagar", "Ramagundam", "Khammam", "Mahbubnagar", "Nalgonda", "Adilabad", "Suryapet", "Miryalaguda", "Siddipet", "Mancherial", "Jagtial", "Kamareddy", "Wanaparthy", "Bhongir", "Zahirabad", "Sangareddy", "Nirmal", "Vikarabad", "Narayanpet", "Medak", "Jangaon", "Bhadrachalam", "Kothagudem", "Palwancha", "Bodhan", "Koratla", "Metpally"],

    bihar: ["Patna", "Gaya", "Muzaffarpur", "Bhagalpur", "Darbhanga", "Arrah", "Begusarai", "Chhapra", "Katihar", "Munger", "Purnia", "Saharsa", "Sasaram", "Hajipur", "Dehri", "Siwan", "Motihari", "Nawada", "Bagaha", "Buxar", "Kishanganj", "Sitamarhi", "Jamalpur", "Jehanabad", "Aurangabad", "Bettiah", "Madhubani", "Samastipur", "Gopalganj", "Supaul"],

    odisha: ["Bhubaneswar", "Cuttack", "Rourkela", "Berhampur", "Sambalpur", "Puri", "Balasore", "Bhadrak", "Baripada", "Jharsuguda", "Jeypore", "Barbil", "Kendujhar", "Angul", "Paradip", "Phulbani", "Rayagada", "Koraput", "Sundargarh", "Dhenkanal", "Bolangir", "Bargarh", "Bhawanipatna", "Kendrapara", "Jajpur", "Jagatsinghpur", "Nayagarh", "Malkangiri", "Nabarangpur", "Nuapada"],

    punjab: ["Ludhiana", "Amritsar", "Jalandhar", "Patiala", "Bathinda", "Mohali", "Hoshiarpur", "Batala", "Pathankot", "Moga", "Abohar", "Malerkotla", "Khanna", "Phagwara", "Muktsar", "Barnala", "Rajpura", "Firozpur", "Kapurthala", "Dera Bassi", "Faridkot", "Gurdaspur", "Ropar", "Sangrur", "Fazilka", "Nawanshahr", "Tarn Taran", "Fatehgarh Sahib", "Mansa", "Rupnagar"],

    haryana: ["Gurugram", "Faridabad", "Panipat", "Ambala", "Hisar", "Rohtak", "Karnal", "Sonipat", "Yamunanagar", "Panchkula", "Bhiwani", "Bahadurgarh", "Jind", "Thanesar", "Kaithal", "Rewari", "Palwal", "Sirsa", "Fatehabad", "Gohana", "Tohana", "Narnaul", "Mewat", "Charkhi Dadri", "Hansi", "Narwana", "Mahendragarh", "Nuh", "Hodal", "Ellenabad"],

    kerala: ["Thiruvananthapuram", "Kochi", "Kozhikode", "Thrissur", "Kollam", "Palakkad", "Alappuzha", "Malappuram", "Kannur", "Kottayam", "Kasaragod", "Pathanamthitta", "Idukki", "Wayanad", "Ernakulam", "Manjeri", "Thalassery", "Kalpetta", "Kayamkulam", "Tirur", "Ponnani", "Vatakara", "Paravur", "Perinthalmanna", "Chalakudy", "Changanacherry", "Punalur", "Varkala", "Irinjalakuda", "Thodupuzha"],

    jharkhand: ["Ranchi", "Jamshedpur", "Dhanbad", "Bokaro", "Deoghar", "Phusro", "Hazaribagh", "Giridih", "Ramgarh", "Medininagar", "Chaibasa", "Chirkunda", "Gumia", "Dumka", "Madhupur", "Chatra", "Sahibganj", "Baharagora", "Simdega", "Jamtara", "Lohardaga", "Garhwa", "Koderma", "Pakur", "Godda", "Latehar", "Khunti", "Seraikela", "Giridih", "Ramgarh"],

    assam: ["Guwahati", "Silchar", "Dibrugarh", "Jorhat", "Nagaon", "Tinsukia", "Tezpur", "Bongaigaon", "Dhubri", "Diphu", "North Lakhimpur", "Haflong", "Sivasagar", "Goalpara", "Barpeta", "Karimganj", "Hailakandi", "Kokrajhar", "Nalbari", "Mangaldoi", "Sibsagar", "Golaghat", "Morigaon", "Hojai", "Lanka", "Lumding", "Mariani", "Duliajan", "Namrup", "Makum"],

    chhattisgarh: ["Raipur", "Bhilai", "Korba", "Bilaspur", "Durg", "Rajnandgaon", "Jagdalpur", "Raigarh", "Ambikapur", "Mahasamund", "Dhamtari", "Chirmiri", "Bhatapara", "Naila Janjgir", "Tilda Newra", "Mungeli", "Manendragarh", "Sakti", "Kawardha", "Kondagaon", "Kanker", "Dantewada", "Bijapur", "Sukma", "Balod", "Baloda Bazar", "Gariaband", "Bemetara", "Surajpur", "Balrampur"],

    uttarakhand: ["Dehradun", "Haridwar", "Roorkee", "Haldwani", "Rudrapur", "Kashipur", "Rishikesh", "Kotdwar", "Ramnagar", "Jaspur", "Pithoragarh", "Manglaur", "Tehri", "Pauri", "Chamoli", "Uttarkashi", "Bageshwar", "Champawat", "Almora", "Nainital", "Lansdowne", "Mussoorie", "Srinagar", "New Tehri", "Vikasnagar", "Doiwala", "Clement Town", "Herbertpur", "Sitarganj", "Bazpur"],

    "himachal pradesh": ["Shimla", "Dharamshala", "Solan", "Mandi", "Palampur", "Baddi", "Nahan", "Paonta Sahib", "Sundarnagar", "Chamba", "Una", "Kullu", "Hamirpur", "Bilaspur", "Kangra", "Nurpur", "Nagrota Bagwan", "Rampur", "Rohroo", "Nalagarh", "Mehatpur Basdehra", "Daulatpur Chowk", "Theog", "Rohru", "Kotkhai", "Jubbal", "Arki", "Kasauli", "Parwanoo", "Yol"],
    hp: ["Shimla", "Dharamshala", "Solan", "Mandi", "Palampur", "Baddi", "Nahan"],

    goa: ["Panaji", "Margao", "Vasco da Gama", "Mapusa", "Ponda", "Bicholim", "Curchorem", "Sanquelim", "Cuncolim", "Quepem", "Valpoi", "Canacona", "Pernem", "Sanguem", "Calangute", "Candolim", "Anjuna", "Colva", "Benaulim", "Bogmalo"],

    delhi: ["New Delhi", "Dwarka", "Rohini", "Janakpuri", "Laxmi Nagar", "Saket", "Pitampura", "Shahdara", "Preet Vihar", "Vikaspuri", "Uttam Nagar", "Mayur Vihar", "Vasant Kunj", "Okhla", "Punjabi Bagh", "Karol Bagh", "Connaught Place", "Nehru Place", "Noida", "Gurugram"],
    "new delhi": ["New Delhi", "Dwarka", "Rohini", "Janakpuri", "Saket", "Pitampura", "Shahdara"],

    "jammu and kashmir": ["Srinagar", "Jammu", "Anantnag", "Sopore", "Baramulla", "Kathua", "Udhampur", "Punch", "Rajouri", "Leh", "Kargil", "Kupwara", "Bandipore", "Ganderbal", "Shopian", "Kulgam", "Ramban", "Reasi", "Samba", "Doda"],
    "j&k": ["Srinagar", "Jammu", "Anantnag", "Sopore", "Baramulla", "Kathua", "Udhampur"],

    tripura: ["Agartala", "Dharmanagar", "Udaipur", "Kailasahar", "Belonia", "Khowai", "Ambassa", "Ranir Bazar", "Sonamura", "Sabroom", "Kumarghat", "Amarpur", "Bishalgarh", "Melaghar", "Teliamura", "Mohanpur", "Kamalpur", "Jogendranagar", "Santir Bazar", "Bilonia"],

    meghalaya: ["Shillong", "Tura", "Jowai", "Nongstoin", "Williamnagar", "Baghmara", "Resubelpara", "Mairang", "Nongpoh", "Khliehriat", "Cherrapunji", "Mawsynram", "Mawkyrwat", "Ampati", "Phulbari", "Betasing", "Dadengiri", "Garobadha", "Tikrikilla", "Dalu"],

    manipur: ["Imphal", "Thoubal", "Kakching", "Churachandpur", "Senapati", "Ukhrul", "Tamenglong", "Chandel", "Bishnupur", "Jiribam", "Moreh", "Moirang", "Nambol", "Mayang Imphal", "Lilong", "Yairipok", "Wangjing", "Khongman", "Lamlai", "Sugnu"],

    nagaland: ["Kohima", "Dimapur", "Mokokchung", "Tuensang", "Wokha", "Zunheboto", "Phek", "Mon", "Kiphire", "Longleng", "Peren", "Noklak", "Chumukedima", "Pfutsero", "Tseminyu", "Meluri", "Bhandari", "Jalukie", "Tizit", "Tobu"],

    "arunachal pradesh": ["Itanagar", "Naharlagun", "Pasighat", "Tawang", "Bomdila", "Ziro", "Along", "Tezu", "Changlang", "Daporijo", "Khonsa", "Roing", "Anini", "Yingkiong", "Namsai", "Longding", "Tirap", "Kurung Kumey", "Dibang Valley", "Anjaw"],

    mizoram: ["Aizawl", "Lunglei", "Saiha", "Champhai", "Kolasib", "Serchhip", "Mamit", "Lawngtlai", "Hnahthial", "Saitual", "Khawzawl", "Longpuia", "Thenzawl", "Khawhai", "Zawlnuam", "Biate", "Sangau", "East Lungdar", "Darlawn", "Haulawng"],

    sikkim: ["Gangtok", "Namchi", "Gyalshing", "Mangan", "Rangpo", "Singtam", "Jorethang", "Nayabazar", "Rongli", "Ravangla", "Yuksom", "Pelling", "Lachen", "Lachung", "Chungthang", "Soreng", "Dentam", "Kaluk", "Chakung", "Rinchenpong"],

    puducherry: ["Puducherry", "Karaikal", "Mahe", "Yanam", "Ozhukarai", "Villianur", "Ariyankuppam", "Nettapakkam", "Bahour", "Mannadipet"],
    pondicherry: ["Puducherry", "Karaikal", "Mahe", "Yanam"],

    chandigarh: ["Chandigarh", "Mohali", "Panchkula"],

    ladakh: ["Leh", "Kargil", "Diskit", "Padum", "Sankoo", "Dras", "Nyoma", "Hanle", "Turtuk", "Khaltsi"],
  };

  for (const [state, cities] of Object.entries(stateMap)) {
    if (lower.includes(state)) return cities;
  }

  return [
    "Mumbai", "Delhi", "Bangalore", "Hyderabad", "Chennai",
    "Kolkata", "Pune", "Ahmedabad", "Jaipur", "Lucknow",
    "Surat", "Kanpur", "Nagpur", "Patna", "Indore",
    "Bhopal", "Visakhapatnam", "Vadodara", "Ludhiana", "Agra",
  ];
}