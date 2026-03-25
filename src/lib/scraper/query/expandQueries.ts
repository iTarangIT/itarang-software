const INDIAN_CITIES = [
  "Delhi",
  "Mumbai",
  "Bangalore",
  "Hyderabad",
  "Chennai",
  "Pune",
  "Kolkata",
  "Ahmedabad",
  "Jaipur",
  "Surat",
  "Lucknow",
  "Nagpur",
  "Indore",
  "Bhopal",
  "Patna",
  "Chandigarh",
  "Nashik",
  "Vadodara",
  "Coimbatore",
  "Visakhapatnam",
];

export function expandQueries(baseQueries: string[]) {
  const expanded: string[] = [];

  for (const query of baseQueries) {
    for (const city of INDIAN_CITIES) {
      expanded.push(`${query} ${city}`);
    }
  }

  return expanded;
}
