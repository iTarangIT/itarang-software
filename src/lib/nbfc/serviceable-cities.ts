export const NBFC_SERVICEABLE_CITIES = [
  "Delhi",
  "Faridabad",
  "Ghaziabad",
  "Noida",
  "Gurgaon",
  "Lucknow",
  "Mathura",
  "Agra",
  "Saharanpur",
  "Meerut",
  "Jhansi",
  "Aligarh",
  "Gwalior",
  "Jaipur",
] as const;

export type NbfcServiceableCity = (typeof NBFC_SERVICEABLE_CITIES)[number];
