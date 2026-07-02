/**
 * iTarang Loan Calculator — CANONICAL GOLDEN FIXTURE (all 260 workbook rows).
 * Source: Copy_of_Bajaj_itarang_realisation_June_2026.xlsx — verified 260/260.
 * BatteryPool 60, Delovita 20, Bajaj 180. Scheme codes normalised to "XbyY".
 * totalUpfront = the workbook's single "Driver upfront" value (already contains
 * down payment + advance instalments + fees + variant-B interest). Never re-add parts.
 */

export interface GoldenCase {
  nbfc: "BatteryPool" | "Delovita" | "Bajaj";
  variant: "A" | "B";
  model: string;
  scheme: string;
  tenure: number;
  advance: number;
  priceToDriver: number;
  loanAmount: number;
  expected: { downPayment: number; totalUpfront: number; emi: number };
}

export const GOLDEN_CASES: GoldenCase[] = [
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 105 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 69293,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 7293,
   "totalUpfront": 14794,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 105 AMP",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 69293,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 7293,
   "totalUpfront": 14794,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 105 AMP",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 69293,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 7293,
   "totalUpfront": 14794,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 140 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 89943,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 27943,
   "totalUpfront": 35444,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 140 AMP",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 89943,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 27943,
   "totalUpfront": 35444,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 140 AMP",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 89943,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 27943,
   "totalUpfront": 35444,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 153 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 107643,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 45643,
   "totalUpfront": 53144,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 153 AMP",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 107643,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 45643,
   "totalUpfront": 53144,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 153 AMP",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 107643,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 45643,
   "totalUpfront": 53144,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 232 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 133013,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 71013,
   "totalUpfront": 78514,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 232 AMP - JN",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 133013,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 71013,
   "totalUpfront": 78514,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 232 AMP - JN",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 133013,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 71013,
   "totalUpfront": 78514,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 105 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 78143,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 16143,
   "totalUpfront": 23644,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 105 AMP",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 78143,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 16143,
   "totalUpfront": 23644,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 105 AMP",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 78143,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 16143,
   "totalUpfront": 23644,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "64V - 105 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 81093,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 19093,
   "totalUpfront": 26594,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "64V - 105 AMP",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 81093,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 19093,
   "totalUpfront": 26594,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "64V - 105 AMP",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 81093,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 19093,
   "totalUpfront": 26594,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 140 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 100563,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 38563,
   "totalUpfront": 46064,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 140 AMP",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 100563,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 38563,
   "totalUpfront": 46064,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 140 AMP",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 100563,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 38563,
   "totalUpfront": 46064,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "64V - 140 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 106463,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 44463,
   "totalUpfront": 51964,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "64V - 140 AMP",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 106463,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 44463,
   "totalUpfront": 51964,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "64V - 140 AMP",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 106463,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 44463,
   "totalUpfront": 51964,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 153 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 120623,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 58623,
   "totalUpfront": 66124,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 153 AMP",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 120623,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 58623,
   "totalUpfront": 66124,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 153 AMP",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 120623,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 58623,
   "totalUpfront": 66124,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "64V - 153 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 127113,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 65113,
   "totalUpfront": 72614,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "64V - 153 AMP",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 127113,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 65113,
   "totalUpfront": 72614,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "64V - 153 AMP",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 127113,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 65113,
   "totalUpfront": 72614,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 232 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 151303,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 89303,
   "totalUpfront": 96804,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 232 AMP - JN",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 151303,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 89303,
   "totalUpfront": 96804,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 232 AMP - JN",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 151303,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 89303,
   "totalUpfront": 96804,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 105 AMP - Prime",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 74013,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 12013,
   "totalUpfront": 19514,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 105 AMP - Prime",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 74013,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 12013,
   "totalUpfront": 19514,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 105 AMP - Prime",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 74013,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 12013,
   "totalUpfront": 19514,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 206 AMP - AN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 127703,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 65703,
   "totalUpfront": 73204,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 206 AMP - AN",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 127703,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 65703,
   "totalUpfront": 73204,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 206 AMP - AN",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 127703,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 65703,
   "totalUpfront": 73204,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 314 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 167823,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 105823,
   "totalUpfront": 113324,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 314 AMP - JN",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 167823,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 105823,
   "totalUpfront": 113324,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "51.2V - 314 AMP - JN",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 167823,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 105823,
   "totalUpfront": 113324,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 206 AMP - AN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 147763,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 85763,
   "totalUpfront": 93264,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 206 AMP - AN",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 147763,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 85763,
   "totalUpfront": 93264,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 206 AMP - AN",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 147763,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 85763,
   "totalUpfront": 93264,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "64V - 232 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 157793,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 95793,
   "totalUpfront": 103294,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "64V - 232 AMP - JN",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 157793,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 95793,
   "totalUpfront": 103294,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "64V - 232 AMP - JN",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 157793,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 95793,
   "totalUpfront": 103294,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 314 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 189063,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 127063,
   "totalUpfront": 134564,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 314 AMP - JN",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 189063,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 127063,
   "totalUpfront": 134564,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "60.8V - 314 AMP - JN",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 189063,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 127063,
   "totalUpfront": 134564,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "73.6V - 105 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 89353,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 27353,
   "totalUpfront": 34854,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "73.6V - 105 AMP",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 89353,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 27353,
   "totalUpfront": 34854,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "73.6V - 105 AMP",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 89353,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 27353,
   "totalUpfront": 34854,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "73.6V - 140 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 119443,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 57443,
   "totalUpfront": 64944,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "73.6V - 140 AMP",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 119443,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 57443,
   "totalUpfront": 64944,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "73.6V - 140 AMP",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 119443,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 57443,
   "totalUpfront": 64944,
   "emi": 4375
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "73.6V - 232 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 178443,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 116443,
   "totalUpfront": 123944,
   "emi": 6097
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "73.6V - 232 AMP - JN",
  "scheme": "15by0",
  "tenure": 15,
  "advance": 0,
  "priceToDriver": 178443,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 116443,
   "totalUpfront": 123944,
   "emi": 5064
  }
 },
 {
  "nbfc": "BatteryPool",
  "variant": "A",
  "model": "73.6V - 232 AMP - JN",
  "scheme": "18by0",
  "tenure": 18,
  "advance": 0,
  "priceToDriver": 178443,
  "loanAmount": 62000,
  "expected": {
   "downPayment": 116443,
   "totalUpfront": 123944,
   "emi": 4375
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "51.2V - 105 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 69293,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 12593,
   "totalUpfront": 19993,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "51.2V - 140 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 89943,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 33243,
   "totalUpfront": 40643,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "51.2V - 153 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 107643,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 50943,
   "totalUpfront": 58343,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "51.2V - 232 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 133013,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 76313,
   "totalUpfront": 83713,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "60.8V - 105 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 78143,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 21443,
   "totalUpfront": 28843,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "64V - 105 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 81093,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 24393,
   "totalUpfront": 31793,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "60.8V - 140 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 100563,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 43863,
   "totalUpfront": 51263,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "64V - 140 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 106463,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 49763,
   "totalUpfront": 57163,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "60.8V - 153 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 120623,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 63923,
   "totalUpfront": 71323,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "64V - 153 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 127113,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 70413,
   "totalUpfront": 77813,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "60.8V - 232 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 151303,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 94603,
   "totalUpfront": 102003,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "51.2V - 105 AMP - Prime",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 74013,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 17313,
   "totalUpfront": 24713,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "51.2V - 206 AMP - AN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 127703,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 71003,
   "totalUpfront": 78403,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "51.2V - 314 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 167823,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 111123,
   "totalUpfront": 118523,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "60.8V - 206 AMP - AN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 147763,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 91063,
   "totalUpfront": 98463,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "64V - 232 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 157793,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 101093,
   "totalUpfront": 108493,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "60.8V - 314 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 189063,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 132363,
   "totalUpfront": 139763,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "73.6V - 105 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 89353,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 32653,
   "totalUpfront": 40053,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "73.6V - 140 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 119443,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 62743,
   "totalUpfront": 70143,
   "emi": 5670
  }
 },
 {
  "nbfc": "Delovita",
  "variant": "A",
  "model": "73.6V - 232 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 178443,
  "loanAmount": 56700,
  "expected": {
   "downPayment": 121743,
   "totalUpfront": 129143,
   "emi": 5670
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 69293,
  "loanAmount": 69293,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 30683,
   "emi": 4331
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 69293,
  "loanAmount": 69293,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 30884,
   "emi": 4077
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 69293,
  "loanAmount": 69293,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 31171,
   "emi": 3850
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 69293,
  "loanAmount": 69293,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 13828,
   "emi": 5775
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 69293,
  "loanAmount": 69293,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 19602,
   "emi": 5775
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 69293,
  "loanAmount": 69293,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 8788,
   "emi": 8662
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 69293,
  "loanAmount": 69293,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 16726,
   "emi": 7700
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 69293,
  "loanAmount": 69293,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 22997,
   "emi": 6930
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 69293,
  "loanAmount": 69293,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 30731,
   "emi": 5775
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 140 AMP",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 89943,
  "loanAmount": 89943,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 39159,
   "emi": 5622
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 140 AMP",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 89943,
  "loanAmount": 89943,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 39420,
   "emi": 5291
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 140 AMP",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 89943,
  "loanAmount": 89943,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 39793,
   "emi": 4997
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 140 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 89943,
  "loanAmount": 89943,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 17282,
   "emi": 7496
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 140 AMP",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 89943,
  "loanAmount": 89943,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 24777,
   "emi": 7496
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 140 AMP",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 89943,
  "loanAmount": 89943,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 10738,
   "emi": 11243
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 140 AMP",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 89943,
  "loanAmount": 89943,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 21043,
   "emi": 9994
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 140 AMP",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 89943,
  "loanAmount": 89943,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 29182,
   "emi": 8995
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 140 AMP",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 89943,
  "loanAmount": 89943,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 39397,
   "emi": 7496
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 153 AMP",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 107643,
  "loanAmount": 107643,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 46424,
   "emi": 6728
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 153 AMP",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 107643,
  "loanAmount": 107643,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 46737,
   "emi": 6332
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 153 AMP",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 107643,
  "loanAmount": 107643,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 47182,
   "emi": 5981
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 153 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 107643,
  "loanAmount": 107643,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 20241,
   "emi": 8971
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 153 AMP",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 107643,
  "loanAmount": 107643,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 29211,
   "emi": 8971
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 153 AMP",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 107643,
  "loanAmount": 107643,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 12411,
   "emi": 13456
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 153 AMP",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 107643,
  "loanAmount": 107643,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 24742,
   "emi": 11961
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 153 AMP",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 107643,
  "loanAmount": 107643,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 34483,
   "emi": 10765
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 153 AMP",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 107643,
  "loanAmount": 107643,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 46825,
   "emi": 8971
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 232 AMP - JN",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 133013,
  "loanAmount": 133013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 56838,
   "emi": 8314
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 232 AMP - JN",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 133013,
  "loanAmount": 133013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 57224,
   "emi": 7825
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 232 AMP - JN",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 133013,
  "loanAmount": 133013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 57774,
   "emi": 7390
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 232 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 133013,
  "loanAmount": 133013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 24484,
   "emi": 11085
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 232 AMP - JN",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 133013,
  "loanAmount": 133013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 35568,
   "emi": 11085
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 232 AMP - JN",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 133013,
  "loanAmount": 133013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 14807,
   "emi": 16627
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 232 AMP - JN",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 133013,
  "loanAmount": 133013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 30046,
   "emi": 14780
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 232 AMP - JN",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 133013,
  "loanAmount": 133013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 42082,
   "emi": 13302
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 232 AMP - JN",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 133013,
  "loanAmount": 133013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 57472,
   "emi": 11085
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 105 AMP",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 78143,
  "loanAmount": 78143,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 34316,
   "emi": 4884
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 105 AMP",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 78143,
  "loanAmount": 78143,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 34543,
   "emi": 4597
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 105 AMP",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 78143,
  "loanAmount": 78143,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 34866,
   "emi": 4342
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 105 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 78143,
  "loanAmount": 78143,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 15308,
   "emi": 6512
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 105 AMP",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 78143,
  "loanAmount": 78143,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 21820,
   "emi": 6512
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 105 AMP",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 78143,
  "loanAmount": 78143,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 9624,
   "emi": 9768
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 105 AMP",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 78143,
  "loanAmount": 78143,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 18577,
   "emi": 8683
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 105 AMP",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 78143,
  "loanAmount": 78143,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 25648,
   "emi": 7815
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 105 AMP",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 78143,
  "loanAmount": 78143,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 34445,
   "emi": 6512
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 105 AMP",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 81093,
  "loanAmount": 81093,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 35527,
   "emi": 5069
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 105 AMP",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 81093,
  "loanAmount": 81093,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 35763,
   "emi": 4771
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 105 AMP",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 81093,
  "loanAmount": 81093,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 36098,
   "emi": 4506
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 105 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 81093,
  "loanAmount": 81093,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 15802,
   "emi": 6758
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 105 AMP",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 81093,
  "loanAmount": 81093,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 22560,
   "emi": 6758
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 105 AMP",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 81093,
  "loanAmount": 81093,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 9902,
   "emi": 10137
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 105 AMP",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 81093,
  "loanAmount": 81093,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 19193,
   "emi": 9011
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 105 AMP",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 81093,
  "loanAmount": 81093,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 26531,
   "emi": 8110
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 105 AMP",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 81093,
  "loanAmount": 81093,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 35683,
   "emi": 6758
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 140 AMP",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 100563,
  "loanAmount": 100563,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 43519,
   "emi": 6286
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 140 AMP",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 100563,
  "loanAmount": 100563,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 43810,
   "emi": 5916
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 140 AMP",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 100563,
  "loanAmount": 100563,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 44227,
   "emi": 5587
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 140 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 100563,
  "loanAmount": 100563,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 19057,
   "emi": 8381
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 140 AMP",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 100563,
  "loanAmount": 100563,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 27437,
   "emi": 8381
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 140 AMP",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 100563,
  "loanAmount": 100563,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 11742,
   "emi": 12571
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 140 AMP",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 100563,
  "loanAmount": 100563,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 23263,
   "emi": 11174
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 140 AMP",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 100563,
  "loanAmount": 100563,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 32363,
   "emi": 10057
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 140 AMP",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 100563,
  "loanAmount": 100563,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 43854,
   "emi": 8381
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 140 AMP",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 106463,
  "loanAmount": 106463,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 45940,
   "emi": 6654
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 140 AMP",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 106463,
  "loanAmount": 106463,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 46250,
   "emi": 6263
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 140 AMP",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 106463,
  "loanAmount": 106463,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 46689,
   "emi": 5915
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 140 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 106463,
  "loanAmount": 106463,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 20044,
   "emi": 8872
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 140 AMP",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 106463,
  "loanAmount": 106463,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 28916,
   "emi": 8872
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 140 AMP",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 106463,
  "loanAmount": 106463,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 12299,
   "emi": 13308
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 140 AMP",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 106463,
  "loanAmount": 106463,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 24496,
   "emi": 11830
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 140 AMP",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 106463,
  "loanAmount": 106463,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 34130,
   "emi": 10647
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 140 AMP",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 106463,
  "loanAmount": 106463,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 46330,
   "emi": 8872
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 153 AMP",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 120623,
  "loanAmount": 120623,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 51752,
   "emi": 7539
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 153 AMP",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 120623,
  "loanAmount": 120623,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 52102,
   "emi": 7096
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 153 AMP",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 120623,
  "loanAmount": 120623,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 52601,
   "emi": 6702
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 153 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 120623,
  "loanAmount": 120623,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 22412,
   "emi": 10052
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 153 AMP",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 120623,
  "loanAmount": 120623,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 32464,
   "emi": 10052
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 153 AMP",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 120623,
  "loanAmount": 120623,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 13637,
   "emi": 15078
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 153 AMP",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 120623,
  "loanAmount": 120623,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 27457,
   "emi": 13403
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 153 AMP",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 120623,
  "loanAmount": 120623,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 38371,
   "emi": 12063
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 153 AMP",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 120623,
  "loanAmount": 120623,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 52273,
   "emi": 10052
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 153 AMP",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 127113,
  "loanAmount": 127113,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 54416,
   "emi": 7945
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 153 AMP",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 127113,
  "loanAmount": 127113,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 54786,
   "emi": 7478
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 153 AMP",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 127113,
  "loanAmount": 127113,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 55311,
   "emi": 7062
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 153 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 127113,
  "loanAmount": 127113,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 23497,
   "emi": 10593
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 153 AMP",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 127113,
  "loanAmount": 127113,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 34090,
   "emi": 10593
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 153 AMP",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 127113,
  "loanAmount": 127113,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 14250,
   "emi": 15890
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 153 AMP",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 127113,
  "loanAmount": 127113,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 28813,
   "emi": 14124
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 153 AMP",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 127113,
  "loanAmount": 127113,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 40315,
   "emi": 12712
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 153 AMP",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 127113,
  "loanAmount": 127113,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 54996,
   "emi": 10593
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 232 AMP - JN",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 151303,
  "loanAmount": 151303,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 64345,
   "emi": 9457
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 232 AMP - JN",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 151303,
  "loanAmount": 151303,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 64785,
   "emi": 8901
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 232 AMP - JN",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 151303,
  "loanAmount": 151303,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 65410,
   "emi": 8406
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 232 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 151303,
  "loanAmount": 151303,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 27542,
   "emi": 12609
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 232 AMP - JN",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 151303,
  "loanAmount": 151303,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 40151,
   "emi": 12609
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 232 AMP - JN",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 151303,
  "loanAmount": 151303,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 16535,
   "emi": 18913
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 232 AMP - JN",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 151303,
  "loanAmount": 151303,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 33869,
   "emi": 16812
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 232 AMP - JN",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 151303,
  "loanAmount": 151303,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 47561,
   "emi": 15131
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 232 AMP - JN",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 151303,
  "loanAmount": 151303,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 65147,
   "emi": 12609
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP - Prime",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 74013,
  "loanAmount": 74013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 32620,
   "emi": 4626
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP - Prime",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 74013,
  "loanAmount": 74013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 32836,
   "emi": 4354
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP - Prime",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 74013,
  "loanAmount": 74013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 33142,
   "emi": 4112
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP - Prime",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 74013,
  "loanAmount": 74013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 14618,
   "emi": 6168
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP - Prime",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 74013,
  "loanAmount": 74013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 20786,
   "emi": 6168
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP - Prime",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 74013,
  "loanAmount": 74013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 9233,
   "emi": 9252
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP - Prime",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 74013,
  "loanAmount": 74013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 17713,
   "emi": 8224
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP - Prime",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 74013,
  "loanAmount": 74013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 24410,
   "emi": 7402
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 105 AMP - Prime",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 74013,
  "loanAmount": 74013,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 32712,
   "emi": 6168
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 206 AMP - AN",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 127703,
  "loanAmount": 127703,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 54658,
   "emi": 7982
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 206 AMP - AN",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 127703,
  "loanAmount": 127703,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 55030,
   "emi": 7512
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 206 AMP - AN",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 127703,
  "loanAmount": 127703,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 55557,
   "emi": 7095
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 206 AMP - AN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 127703,
  "loanAmount": 127703,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 23596,
   "emi": 10642
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 206 AMP - AN",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 127703,
  "loanAmount": 127703,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 34238,
   "emi": 10642
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 206 AMP - AN",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 127703,
  "loanAmount": 127703,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 14306,
   "emi": 15963
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 206 AMP - AN",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 127703,
  "loanAmount": 127703,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 28936,
   "emi": 14190
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 206 AMP - AN",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 127703,
  "loanAmount": 127703,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 40492,
   "emi": 12771
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 206 AMP - AN",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 127703,
  "loanAmount": 127703,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 55244,
   "emi": 10642
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 314 AMP - JN",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 167823,
  "loanAmount": 167823,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 71126,
   "emi": 10489
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 314 AMP - JN",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 167823,
  "loanAmount": 167823,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 71614,
   "emi": 9872
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 314 AMP - JN",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 167823,
  "loanAmount": 167823,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 72307,
   "emi": 9324
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 314 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 167823,
  "loanAmount": 167823,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 30305,
   "emi": 13986
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 314 AMP - JN",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 167823,
  "loanAmount": 167823,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 44290,
   "emi": 13986
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 314 AMP - JN",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 167823,
  "loanAmount": 167823,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 18096,
   "emi": 20978
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 314 AMP - JN",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 167823,
  "loanAmount": 167823,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 37323,
   "emi": 18647
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 314 AMP - JN",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 167823,
  "loanAmount": 167823,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 52509,
   "emi": 16783
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "51.2V - 314 AMP - JN",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 167823,
  "loanAmount": 167823,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 72080,
   "emi": 13986
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 206 AMP - AN",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 147763,
  "loanAmount": 147763,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 62893,
   "emi": 9236
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 206 AMP - AN",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 147763,
  "loanAmount": 147763,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 63322,
   "emi": 8692
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 206 AMP - AN",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 147763,
  "loanAmount": 147763,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 63932,
   "emi": 8210
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 206 AMP - AN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 147763,
  "loanAmount": 147763,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 26950,
   "emi": 12314
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 206 AMP - AN",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 147763,
  "loanAmount": 147763,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 39264,
   "emi": 12314
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 206 AMP - AN",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 147763,
  "loanAmount": 147763,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 16201,
   "emi": 18471
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 206 AMP - AN",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 147763,
  "loanAmount": 147763,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 33129,
   "emi": 16419
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 206 AMP - AN",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 147763,
  "loanAmount": 147763,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 46500,
   "emi": 14777
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 206 AMP - AN",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 147763,
  "loanAmount": 147763,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 63662,
   "emi": 12314
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 232 AMP - JN",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 157793,
  "loanAmount": 157793,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 67009,
   "emi": 9863
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 232 AMP - JN",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 157793,
  "loanAmount": 157793,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 67468,
   "emi": 9282
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 232 AMP - JN",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 157793,
  "loanAmount": 157793,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 68120,
   "emi": 8767
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 232 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 157793,
  "loanAmount": 157793,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 28627,
   "emi": 13150
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 232 AMP - JN",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 157793,
  "loanAmount": 157793,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 41776,
   "emi": 13150
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 232 AMP - JN",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 157793,
  "loanAmount": 157793,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 17148,
   "emi": 19725
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 232 AMP - JN",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 157793,
  "loanAmount": 157793,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 35226,
   "emi": 17533
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 232 AMP - JN",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 157793,
  "loanAmount": 157793,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 49505,
   "emi": 15780
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "64V - 232 AMP - JN",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 157793,
  "loanAmount": 157793,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 67871,
   "emi": 13150
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 314 AMP - JN",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 189063,
  "loanAmount": 189063,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 79844,
   "emi": 11817
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 314 AMP - JN",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 189063,
  "loanAmount": 189063,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 80393,
   "emi": 11122
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 314 AMP - JN",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 189063,
  "loanAmount": 189063,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 81175,
   "emi": 10504
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 314 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 189063,
  "loanAmount": 189063,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 33856,
   "emi": 15756
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 314 AMP - JN",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 189063,
  "loanAmount": 189063,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 49611,
   "emi": 15756
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 314 AMP - JN",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 189063,
  "loanAmount": 189063,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 20103,
   "emi": 23633
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 314 AMP - JN",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 189063,
  "loanAmount": 189063,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 41763,
   "emi": 21007
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 314 AMP - JN",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 189063,
  "loanAmount": 189063,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 58871,
   "emi": 18907
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "60.8V - 314 AMP - JN",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 189063,
  "loanAmount": 189063,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 80994,
   "emi": 15756
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 105 AMP",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 89353,
  "loanAmount": 89353,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 38917,
   "emi": 5585
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 105 AMP",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 89353,
  "loanAmount": 89353,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 39177,
   "emi": 5257
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 105 AMP",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 89353,
  "loanAmount": 89353,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 39546,
   "emi": 4965
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 105 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 89353,
  "loanAmount": 89353,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 17183,
   "emi": 7447
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 105 AMP",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 89353,
  "loanAmount": 89353,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 24629,
   "emi": 7447
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 105 AMP",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 89353,
  "loanAmount": 89353,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 10683,
   "emi": 11170
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 105 AMP",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 89353,
  "loanAmount": 89353,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 20919,
   "emi": 9929
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 105 AMP",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 89353,
  "loanAmount": 89353,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 29005,
   "emi": 8936
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 105 AMP",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 89353,
  "loanAmount": 89353,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 39149,
   "emi": 7447
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 140 AMP",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 119443,
  "loanAmount": 119443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 51268,
   "emi": 7466
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 140 AMP",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 119443,
  "loanAmount": 119443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 51615,
   "emi": 7027
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 140 AMP",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 119443,
  "loanAmount": 119443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 52108,
   "emi": 6636
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 140 AMP",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 119443,
  "loanAmount": 119443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 22215,
   "emi": 9954
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 140 AMP",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 119443,
  "loanAmount": 119443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 32169,
   "emi": 9954
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 140 AMP",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 119443,
  "loanAmount": 119443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 13525,
   "emi": 14931
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 140 AMP",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 119443,
  "loanAmount": 119443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 27209,
   "emi": 13272
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 140 AMP",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 119443,
  "loanAmount": 119443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 38018,
   "emi": 11945
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 140 AMP",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 119443,
  "loanAmount": 119443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 51777,
   "emi": 9954
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 232 AMP - JN",
  "scheme": "16by3",
  "tenure": 16,
  "advance": 3,
  "priceToDriver": 178443,
  "loanAmount": 178443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 75485,
   "emi": 11153
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 232 AMP - JN",
  "scheme": "17by3",
  "tenure": 17,
  "advance": 3,
  "priceToDriver": 178443,
  "loanAmount": 178443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 76004,
   "emi": 10497
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 232 AMP - JN",
  "scheme": "18by3",
  "tenure": 18,
  "advance": 3,
  "priceToDriver": 178443,
  "loanAmount": 178443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 76741,
   "emi": 9914
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 232 AMP - JN",
  "scheme": "12by0",
  "tenure": 12,
  "advance": 0,
  "priceToDriver": 178443,
  "loanAmount": 178443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 32081,
   "emi": 14871
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 232 AMP - JN",
  "scheme": "12by1",
  "tenure": 12,
  "advance": 1,
  "priceToDriver": 178443,
  "loanAmount": 178443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 46951,
   "emi": 14871
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 232 AMP - JN",
  "scheme": "8by0",
  "tenure": 8,
  "advance": 0,
  "priceToDriver": 178443,
  "loanAmount": 178443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 19099,
   "emi": 22306
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 232 AMP - JN",
  "scheme": "9by1",
  "tenure": 9,
  "advance": 1,
  "priceToDriver": 178443,
  "loanAmount": 178443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 39543,
   "emi": 19827
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 232 AMP - JN",
  "scheme": "10by2",
  "tenure": 10,
  "advance": 2,
  "priceToDriver": 178443,
  "loanAmount": 178443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 55690,
   "emi": 17845
  }
 },
 {
  "nbfc": "Bajaj",
  "variant": "B",
  "model": "73.6V - 232 AMP - JN",
  "scheme": "12by4",
  "tenure": 12,
  "advance": 4,
  "priceToDriver": 178443,
  "loanAmount": 178443,
  "expected": {
   "downPayment": 0,
   "totalUpfront": 76537,
   "emi": 14871
  }
 }
];

/** total_upfront = the workbook's single upfront figure. Do NOT sum the parts. */
export function totalUpfront(c: GoldenCase): number { return c.expected.totalUpfront; }
