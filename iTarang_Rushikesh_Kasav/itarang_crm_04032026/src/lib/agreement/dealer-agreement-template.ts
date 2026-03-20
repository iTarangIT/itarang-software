type AgreementTemplateInput = {
  company: {
    companyName?: string;
    companyAddress?: string;
    companyType?: string;
    gstNumber?: string;
    companyPanNumber?: string;
    companyCity?: string;
    companyDistrict?: string;
    companyState?: string;
    companyPinCode?: string;
  };
  ownership: {
    ownerName?: string;
    ownerPhone?: string;
    ownerEmail?: string;
    ownerAge?: string;
    ownerAddressLine1?: string;
    ownerCity?: string;
    ownerDistrict?: string;
    ownerState?: string;
    ownerPinCode?: string;
    bankName?: string;
    accountNumber?: string;
    ifsc?: string;
    beneficiaryName?: string;
    branch?: string;
    accountType?: string;
  };
  agreement: {
    dateOfSigning?: string;
    executionPlace?: string;
    dealerSignerName?: string;
    dealerSignerDesignation?: string;
    dealerSignerEmail?: string;
    dealerSignerPhone?: string;
    financierName?: string;
    financerLegalEntityName?: string;
    vehicleType?: string;
    manufacturer?: string;
    brand?: string;
    statePresence?: string;
    itarangSignatory1?: {
      name?: string;
      designation?: string;
      email?: string;
      mobile?: string;
      address?: string;
    };
    itarangSignatory2?: {
      name?: string;
      designation?: string;
      email?: string;
      mobile?: string;
      address?: string;
    };
    financierSignatory?: {
      name?: string;
      designation?: string;
      email?: string;
      mobile?: string;
      address?: string;
    };
    includeWitnessesInSigning?: boolean;
    witness1?: {
      name?: string;
      email?: string;
      mobile?: string;
      address?: string;
    };
    witness2?: {
      name?: string;
      email?: string;
      mobile?: string;
      address?: string;
    };
  };
};

function esc(value?: string | number | null) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatCompanyType(value?: string) {
  const map: Record<string, string> = {
    sole_proprietorship: "Proprietorship",
    partnership_firm: "Partnership",
    private_limited_firm: "Pvt. Ltd.",
  };
  return map[value || ""] || value || "";
}

function formatDateParts(input?: string) {
  if (!input) {
    return { day: "", month: "", year: "" };
  }

  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    return { day: "", month: "", year: input };
  }

  return {
    day: String(d.getDate()).padStart(2, "0"),
    month: d.toLocaleString("en-IN", { month: "long" }),
    year: String(d.getFullYear()),
  };
}

export function buildTarangDealerAgreementHtml(data: AgreementTemplateInput) {
  const { company, ownership, agreement } = data;
  const signedDate = formatDateParts(agreement.dateOfSigning);

  const dealerAddress = [
    company.companyAddress,
    company.companyCity,
    company.companyDistrict,
    company.companyState,
    company.companyPinCode,
  ]
    .filter(Boolean)
    .join(", ");

  const residentialAddress = [
    ownership.ownerAddressLine1,
    ownership.ownerCity,
    ownership.ownerDistrict,
    ownership.ownerState,
    ownership.ownerPinCode,
  ]
    .filter(Boolean)
    .join(", ");

  const firmType = formatCompanyType(company.companyType);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Tarang Dealer Agreement</title>
  <style>
    body {
      font-family: Arial, Helvetica, sans-serif;
      color: #111827;
      font-size: 12px;
      line-height: 1.5;
      padding: 24px;
    }
    h1, h2, h3 {
      color: #173F63;
      margin-bottom: 8px;
    }
    h1 { font-size: 20px; }
    h2 { font-size: 16px; margin-top: 24px; }
    h3 { font-size: 13px; margin-top: 18px; }
    p { margin: 6px 0; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      margin-bottom: 16px;
    }
    td, th {
      border: 1px solid #d1d5db;
      padding: 8px;
      vertical-align: top;
    }
    .label {
      width: 34%;
      background: #f9fafb;
      font-weight: 600;
    }
    .signature-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 28px;
      margin-top: 40px;
    }
    .signature-box {
      min-height: 90px;
    }
    .line {
      border-top: 1px solid #111827;
      margin-top: 42px;
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <h1>Distributor & Dealer Agreement</h1>

  <p>
    This Agreement is made and executed on this day of ${esc(signedDate.day)} ${esc(signedDate.month)} ${esc(signedDate.year)}.
  </p>

  <p>
    By and between The iTarang Technologies LLP, having registered office at B103, Business Zone, Tower B, Nirvana Country, Gurugram - 122018, GST - 06AALFI7813E1ZE.
  </p>

  <p>
    And M/S <strong>${esc(company.companyName)}</strong>, GST No. <strong>${esc(company.gstNumber)}</strong>, a <strong>${esc(firmType)}</strong> having its office at <strong>${esc(dealerAddress)}</strong>.
  </p>

  <h2>Dealer Core Details</h2>
  <table>
    <tr><td class="label">Firm Name</td><td>${esc(company.companyName)}</td></tr>
    <tr><td class="label">Firm Type</td><td>${esc(firmType)}</td></tr>
    <tr><td class="label">GST Number</td><td>${esc(company.gstNumber)}</td></tr>
    <tr><td class="label">PAN Number</td><td>${esc(company.companyPanNumber)}</td></tr>
    <tr><td class="label">Office Address</td><td>${esc(dealerAddress)}</td></tr>
    <tr><td class="label">Dealer Signatory</td><td>${esc(agreement.dealerSignerName)}</td></tr>
    <tr><td class="label">Dealer Signatory Designation</td><td>${esc(agreement.dealerSignerDesignation)}</td></tr>
    <tr><td class="label">Dealer Signatory Email</td><td>${esc(agreement.dealerSignerEmail)}</td></tr>
    <tr><td class="label">Dealer Signatory Phone</td><td>${esc(agreement.dealerSignerPhone)}</td></tr>
  </table>

  <h2>Schedule 3 — Dealer Onboarding Details</h2>
  <table>
    <tr><td class="label">Name</td><td>${esc(ownership.ownerName)}</td></tr>
    <tr><td class="label">Phone No.</td><td>${esc(ownership.ownerPhone)}</td></tr>
    <tr><td class="label">Email ID</td><td>${esc(ownership.ownerEmail)}</td></tr>
    <tr><td class="label">Residential Address</td><td>${esc(residentialAddress)}</td></tr>
    <tr><td class="label">PAN No.</td><td>${esc(company.companyPanNumber)}</td></tr>
    <tr><td class="label">City</td><td>${esc(ownership.ownerCity)}</td></tr>
    <tr><td class="label">District</td><td>${esc(ownership.ownerDistrict)}</td></tr>
    <tr><td class="label">State</td><td>${esc(ownership.ownerState)}</td></tr>
    <tr><td class="label">PIN Code</td><td>${esc(ownership.ownerPinCode)}</td></tr>
    <tr><td class="label">Firm Name</td><td>${esc(company.companyName)}</td></tr>
    <tr><td class="label">Firm Type</td><td>${esc(firmType)}</td></tr>
    <tr><td class="label">GST No.</td><td>${esc(company.gstNumber)}</td></tr>
    <tr><td class="label">Office Address</td><td>${esc(dealerAddress)}</td></tr>
    <tr><td class="label">Vehicle Type</td><td>${esc(agreement.vehicleType)}</td></tr>
    <tr><td class="label">Manufacturer</td><td>${esc(agreement.manufacturer)}</td></tr>
    <tr><td class="label">Brand</td><td>${esc(agreement.brand)}</td></tr>
    <tr><td class="label">State Presence</td><td>${esc(agreement.statePresence)}</td></tr>
    <tr><td class="label">Bank Account Name</td><td>${esc(ownership.beneficiaryName)}</td></tr>
    <tr><td class="label">A/C No.</td><td>${esc(ownership.accountNumber)}</td></tr>
    <tr><td class="label">IFSC Code</td><td>${esc(ownership.ifsc)}</td></tr>
    <tr><td class="label">Branch</td><td>${esc(ownership.branch)}</td></tr>
    <tr><td class="label">Account Type</td><td>${esc(ownership.accountType)}</td></tr>
  </table>

  <h2>Memorandum of Understanding</h2>
  <p>
    This Agreement is executed at <strong>${esc(agreement.executionPlace || "Delhi")}</strong> on ${esc(signedDate.day)} ${esc(signedDate.month)} ${esc(signedDate.year)}.
  </p>

  <p>
    M/s. iTarang on behalf of Authorised Financer Partner/financers and M/s <strong>${esc(company.companyName)}</strong>, a <strong>${esc(firmType)}</strong> firm with GST <strong>${esc(company.gstNumber)}</strong>, having office/shop at <strong>${esc(dealerAddress)}</strong>, represented by Mr. <strong>${esc(agreement.dealerSignerName)}</strong> aged <strong>${esc(ownership.ownerAge)}</strong> years.
  </p>

  <h2>Financer / iTarang Signatory Details</h2>
  <table>
    <tr><td class="label">Financier Name</td><td>${esc(agreement.financierName)}</td></tr>
    <tr><td class="label">Financier Signatory</td><td>${esc(agreement.financierSignatory?.name)}</td></tr>
    <tr><td class="label">Financier Designation</td><td>${esc(agreement.financierSignatory?.designation)}</td></tr>
    <tr><td class="label">Financier Email</td><td>${esc(agreement.financierSignatory?.email)}</td></tr>
    <tr><td class="label">Financier Mobile</td><td>${esc(agreement.financierSignatory?.mobile)}</td></tr>
    <tr><td class="label">Financier Address</td><td>${esc(agreement.financierSignatory?.address)}</td></tr>
    <tr><td class="label">iTarang Signatory 1</td><td>${esc(agreement.itarangSignatory1?.name)} - ${esc(agreement.itarangSignatory1?.designation)}</td></tr>
    <tr><td class="label">iTarang Signatory 2</td><td>${esc(agreement.itarangSignatory2?.name)} - ${esc(agreement.itarangSignatory2?.designation)}</td></tr>
  </table>

  ${
    agreement.includeWitnessesInSigning
      ? `
  <h2>Witness Details</h2>
  <table>
    <tr><td class="label">Witness 1</td><td>${esc(agreement.witness1?.name)}</td></tr>
    <tr><td class="label">Witness 1 Address</td><td>${esc(agreement.witness1?.address)}</td></tr>
    <tr><td class="label">Witness 1 Mobile</td><td>${esc(agreement.witness1?.mobile)}</td></tr>
    <tr><td class="label">Witness 2</td><td>${esc(agreement.witness2?.name)}</td></tr>
    <tr><td class="label">Witness 2 Address</td><td>${esc(agreement.witness2?.address)}</td></tr>
    <tr><td class="label">Witness 2 Mobile</td><td>${esc(agreement.witness2?.mobile)}</td></tr>
  </table>
  `
      : ""
  }

  <div class="signature-grid">
    <div class="signature-box">
      <div class="line"></div>
      <p>For and on behalf of The iTarang Technologies LLP</p>
      <p>${esc(agreement.itarangSignatory1?.name)}</p>
      <p>${esc(agreement.itarangSignatory1?.designation)}</p>
    </div>

    <div class="signature-box">
      <div class="line"></div>
      <p>For and on behalf of The Dealer</p>
      <p>${esc(company.companyName)}</p>
      <p>${esc(agreement.dealerSignerName)}</p>
      <p>${esc(agreement.dealerSignerDesignation)}</p>
    </div>

    <div class="signature-box">
      <div class="line"></div>
      <p>Authorized Financer Partner</p>
      <p>${esc(agreement.financierSignatory?.name)}</p>
      <p>${esc(agreement.financierSignatory?.designation)}</p>
    </div>

    <div class="signature-box">
      <div class="line"></div>
      <p>iTarang Authorized Signatory 2</p>
      <p>${esc(agreement.itarangSignatory2?.name)}</p>
      <p>${esc(agreement.itarangSignatory2?.designation)}</p>
    </div>
  </div>
</body>
</html>
`;
}