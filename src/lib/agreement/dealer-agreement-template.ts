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
    expiryDays?: number;
    executionPlace?: string;
    dealerSignerName?: string;
    dealerSignerDesignation?: string;
    dealerSignerEmail?: string;
    dealerSignerPhone?: string;
    dealerSigningMethod?: string;
    financierName?: string;
    financerLegalEntityName?: string;
    sequenceMode?: "sequential" | "parallel";
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
      signingMethod?: string;
    };
    itarangSignatory2?: {
      name?: string;
      designation?: string;
      email?: string;
      mobile?: string;
      address?: string;
      signingMethod?: string;
    };
    financierSignatory?: {
      name?: string;
      designation?: string;
      email?: string;
      mobile?: string;
      address?: string;
      signingMethod?: string;
    };
    includeWitnessesInSigning?: boolean;
    witness1?: {
      name?: string;
      designation?: string;
      email?: string;
      mobile?: string;
      address?: string;
      signingMethod?: string;
    };
    witness2?: {
      name?: string;
      designation?: string;
      email?: string;
      mobile?: string;
      address?: string;
      signingMethod?: string;
    };
  };
};

function esc(value?: string | number | null) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCompanyType(value?: string) {
  const map: Record<string, string> = {
    sole_proprietorship: "Proprietorship",
    proprietorship: "Proprietorship",
    partnership_firm: "Partnership",
    partnership: "Partnership",
    private_limited_firm: "Pvt. Ltd.",
    private_limited: "Pvt. Ltd.",
    pvt_ltd: "Pvt. Ltd.",
    llp: "LLP",
  };

  return map[(value || "").toLowerCase()] || value || "";
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

function joinParts(parts: Array<string | undefined>) {
  return parts
    .map((p) => (p || "").trim())
    .filter(Boolean)
    .join(", ");
}

function safe(value?: string, fallback = "________________") {
  const v = (value || "").trim();
  return v || fallback;
}

function yesNo(value?: boolean) {
  return value ? "Yes" : "No";
}

export function buildTarangDealerAgreementHtml(data: AgreementTemplateInput) {
  const { company, ownership, agreement } = data;

  const signedDate = formatDateParts(agreement.dateOfSigning);
  const firmType = formatCompanyType(company.companyType);
  const executionPlace = agreement.executionPlace || "Delhi";

  const dealerAddress = joinParts([
    company.companyAddress,
    company.companyCity,
    company.companyDistrict,
    company.companyState,
    company.companyPinCode,
  ]);

  const residentialAddress = joinParts([
    ownership.ownerAddressLine1,
    ownership.ownerCity,
    ownership.ownerDistrict,
    ownership.ownerState,
    ownership.ownerPinCode,
  ]);

  const financerEntity =
    agreement.financerLegalEntityName ||
    agreement.financierName ||
    "Authorised Financer Partner";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Distributor & Dealer Agreement</title>
  <style>
    @page {
      size: A4;
      margin: 14mm 12mm 16mm 12mm;
    }

    body {
      font-family: Arial, Helvetica, sans-serif;
      color: #111827;
      font-size: 11px;
      line-height: 1.45;
      margin: 0;
      padding: 0;
    }

    h1, h2, h3, h4 {
      margin: 0 0 8px 0;
      color: #173f63;
    }

    h1 {
      font-size: 18px;
      text-align: center;
      text-transform: uppercase;
      margin-bottom: 14px;
    }

    h2 {
      font-size: 13px;
      margin-top: 16px;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 4px;
      text-transform: uppercase;
    }

    h3 {
      font-size: 12px;
      margin-top: 14px;
    }

    p {
      margin: 6px 0;
      text-align: justify;
    }

    ul, ol {
      margin: 6px 0 8px 18px;
      padding: 0;
    }

    li {
      margin: 4px 0;
      text-align: justify;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      margin-bottom: 14px;
      table-layout: fixed;
    }

    th, td {
      border: 1px solid #cbd5e1;
      padding: 6px 7px;
      vertical-align: top;
      word-wrap: break-word;
    }

    th {
      background: #edf4f8;
      font-weight: 700;
      text-align: left;
    }

    .label {
      width: 34%;
      background: #f8fafc;
      font-weight: 700;
    }

    .center {
      text-align: center;
    }

    .bold {
      font-weight: 700;
    }

    .small {
      font-size: 10px;
    }

    .page-break {
      page-break-before: always;
    }

    .signature-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 28px;
      margin-top: 26px;
    }

    .signature-box {
      min-height: 120px;
    }

    .sign-line {
      border-top: 1px solid #111827;
      margin-top: 52px;
      padding-top: 6px;
    }

    .no-border td, .no-border th {
      border: none;
      padding: 2px 0;
    }

    .boxed {
      border: 1px solid #cbd5e1;
      padding: 8px 10px;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <h1>Distributor & Dealer Agreement</h1>

  <p>
    THIS is a Distributor & Dealer relationship agreement (hereinafter referred to as “Agreement”)
    is made and executed on this <strong>${esc(signedDate.day)}</strong> day of
    <strong>${esc(signedDate.month)} ${esc(signedDate.year)}</strong>,
  </p>

  <p><strong>By and between</strong></p>

  <p>
    The iTarang technologies LLP a Company incorporated under the provisions of the Companies Act 2013,
    having its registered office at B103, Business zone, Tower B, Nirvana Country, Gurugram - 122018,
    having GST - 06AALFI7813E1ZE (hereinafter referred to as “Distributor” which expression shall,
    unless it be repugnant to the context or meaning thereof, mean and include its executors,
    administrators, agents and permitted assigns) of the ONE PART;
  </p>

  <p><strong>And</strong></p>

  <p>
    M/S <strong>${esc(safe(company.companyName))}</strong>
    ${company.gstNumber ? `(GST No. <strong>${esc(company.gstNumber)}</strong>)` : `(GST No. ${esc(safe(company.gstNumber))})`},
    a <strong>${esc(safe(firmType))}</strong> having its office at
    <strong>${esc(safe(dealerAddress))}</strong>.
  </p>

  <p>
    (Hereinafter referred to as the “Dealer”, which expression shall, unless it be repugnant to the context
    or meaning thereof, mean and include its executors, administrators, successors, agents and permitted assigns)
    of the OTHER PART.
  </p>

  <p>
    Distributor and Dealer are individually referred to as “Party” and collectively as “Parties”.
  </p>

  <h2>Recital</h2>

  <p>Whereas:</p>
  <ol>
    <li>Distributor is inter alia engaged in the business of procurement and distribution of batteries for sell purpose under the ‘iTarang’ brand.</li>
    <li>Dealer is inter alia engaged in carrying business activities of selling EV products.</li>
    <li>Dealer has shown its willingness to develop the infrastructure, setup to conduct the battery selling business with Distributor.</li>
    <li>Dealer has approached Distributor and requested for obtaining batteries for selling its customers.</li>
    <li>Based upon above representations, the Distributor has agreed to provide batteries on cash and carry basis for selling.</li>
  </ol>

  <h2>Definitions and Interpretations</h2>

  <p><strong>“Agreement”</strong> means this agreement including annexures and schedules added from time to time.</p>
  <p><strong>“Authorized Signatory”</strong> means a signatory signed this Agreement and other documents which are integral part of this document.</p>
  <p><strong>“Commencement Date”</strong> means the Commencement Date of operations/services as stated in this Agreement.</p>
  <p>
    <strong>“Equipment/ Product”</strong> means and includes batteries, chargers, harness and SOC meters and other related products
    given for sale together with any software and manuals supplied with that equipment and includes any part of that equipment
    or any substituted equipment.
  </p>
  <p><strong>“Maximum Dealer Price”</strong> means the price paid by the Dealer to the Distributor for acquiring the battery and related product, defined in Schedule 1.</p>
  <p><strong>“Invoicing Date”</strong> means last day of the month.</p>
  <p><strong>“Payment Term”</strong> means 100% payment before product dispatch.</p>
  <p><strong>“Tax” or “Taxes”</strong> means any direct or indirect tax, cess, rate, duty, fee, lease tax or any other tax applicable under the governing laws.</p>

  <h2>General</h2>

  <p>In this Agreement headings are for convenience of reference only and do not affect interpretation and, unless the context otherwise requires:</p>
  <ol>
    <li>the singular includes the plural and vice versa and masculine includes feminine or neuter gender as the context may require and vice versa;</li>
    <li>a reference to a recital, clause, schedule or annexure is to a recital, clause, schedule or annexure of or to this Agreement;</li>
    <li>a recital, schedule or annexure forms part of this Agreement;</li>
    <li>a reference to any agreement or document is to that agreement or document (and, where applicable, any of its provisions) as amended, novated, supplemented or replaced from time to time;</li>
    <li>if the day on which any act, matter or thing is to be done under or pursuant to this Agreement is not a Business Day, that act, matter or thing shall be done on the preceding Business Day; and</li>
    <li>Capitalized terms used in this Agreement including the Schedules shall have the meaning set out therein.</li>
  </ol>

  <h2>Scope of Work</h2>

  <p>
    The Dealer shall take Product on cash and carry model or financing under the brand “iTarang” (the Products)
    of the Company for the purpose of selling to its customers governed by the terms and conditions as contained hereunder
    (further operational scope between Dealer and Company is mentioned under Schedule – 2).
  </p>

  <p>
    Financing shall be done as per set rules and regulation by financier which iTarang technologies LLP will help facilitate.
  </p>

  <h2>Agreement Validity</h2>

  <p>
    This Agreement shall be valid for one (1) years initially unless terminated earlier as per the provision of this Agreement.
    However, if the Parties agree, this Agreement may be renewed on the same or modified terms mutually agreeable to the Parties.
  </p>

  <h2>Payment and Commercial Terms</h2>

  <p>
    The payment and commercial terms are more particularly defined in Schedule 1.
  </p>

  <h2>Representations by the Dealer</h2>

  <ol>
    <li>It has the full right, power and authority to enter into this Product Sale Agreement and to perform all its obligations hereunder.</li>
    <li>It is financially capable of undertaking the business operations which it conducts and of performing its obligations hereunder.</li>
    <li>It has complied with all the applicable laws, rules and regulations.</li>
    <li>Dealer shall maintain infrastructure, including required land & building, manpower, equipment, electricity load, computers, fire/asset and shop insurance recommended tools etc. as under:</li>
  </ol>

  <table>
    <tr>
      <th>Particular</th>
      <th>Minimum Requirement</th>
      <th>Scope / Usability</th>
    </tr>
    <tr>
      <td>Shop Area (sq. ft.)</td>
      <td>Min 220</td>
      <td>Useable carpet area for this business to keep batteries / engage drivers</td>
    </tr>
    <tr>
      <td>Manpower</td>
      <td>1</td>
      <td>Have computer system and android phone owner and operator for running ops, asset management, customer management. End user and Company’s representative can reach out to Dealer in the mentioned working hours.</td>
    </tr>
    <tr>
      <td>Service Hours</td>
      <td>7 AM to 9 PM</td>
      <td>Operational business support</td>
    </tr>
    <tr>
      <td>Computer System and Android Phone</td>
      <td>1</td>
      <td>Required for app usage and operations</td>
    </tr>
    <tr>
      <td>Electricity Load (KW)</td>
      <td>5</td>
      <td>To charge idle / under all category of battery assets to prevent deep discharge and loss of asset</td>
    </tr>
  </table>

  <ol start="5">
    <li>The Dealer shall also be liable to purchase, at its own cost, any testing / servicing equipment / tools which may be suggested by the Company from time to time.</li>
    <li>The Dealer makes a finance facilitation fee with the Company as per the provision of this Agreement.</li>
    <li>To carry on the business under the Brand “iTarang” and no other name.</li>
    <li>Not to carry the agreed business from any other location other than the prescribed location without the Company’s prior written consent.</li>
    <li>To ensure that all its employees are well trained and having appropriate skills to carry the Business Operations.</li>
    <li>Dealer will not restrict Distributors staff and its representative to interact and taking feedback from any customer / Dealers staff about the services provided by the Dealer.</li>
    <li>The Dealer agrees to sell the asset to the financier at the value set by the financier and only thereafter, based on the battery serial number the financier will finance the aforesaid battery.</li>
  </ol>

  <h2>Representations and Warranties of the Distributor / Dealer</h2>

  <ol>
    <li>The Parties herein declare that the respective signatories to this Agreement are fully authorized and competent to sign and execute the documents on behalf of the respective entities.</li>
    <li>Each Party represents and warrants to the other Party as follows:</li>
  </ol>

  <ol type="a">
    <li>It has full authority to enter into this Agreement and subject to obtaining the necessary approvals, wherever required, under the applicable Law, to perform its obligations hereunder according to the terms hereof.</li>
    <li>It shall abide by all the statutory provisions that may be applicable for Services under this Agreement.</li>
    <li>It shall abide by the terms and conditions of this Agreement.</li>
  </ol>

  <h2>Intellectual Property</h2>

  <p>
    The Parties agree for all purposes that any trademarks, logos, trade names or identifying slogans affixed to the services,
    whether registered or not registered, constitute the exclusive property of the respective party and cannot be used without
    the prior written consent of the other party in writing and only in connection with the services mentioned under this Agreement.
    The Parties shall not contest, at any time, the right of the Parties to any trademark or trade name or claimed by either party.
  </p>

  <h2>Confidential Information</h2>

  <ol>
    <li>Each Party may be given access to Confidential Information from the other Party in order to perform its obligations under this Agreement. The Party that receive Confidential Information shall be known as “Receiving Party”. The Party that discloses Confidential Information shall be known as “Disclosing Party”.</li>
    <li>The Receiving Party acknowledges that the Confidential Information is received on a confidential basis and that the Disclosing Party shall remain the exclusive owner of its Confidential Information and of Intellectual Property rights contained therein. No license or conveyance of any such rights to the Receiving Party is granted or implied under this Agreement.</li>
    <li>The Receiving Party shall:</li>
  </ol>

  <ol type="a">
    <li>use the Confidential Information of the Disclosing Party only for purposes of complying with its obligations under this Agreement and, without limiting the generality of the foregoing, shall not, directly or indirectly, deal with, use, exploit or disclose such Confidential Information or any part thereof to any person or entity or for any purpose whatsoever (or in any manner which would benefit any competitor of the Disclosing Party) except as expressly permitted hereunder or unless and until expressly authorized in writing to do so by the Disclosing Party;</li>
    <li>use reasonable efforts to treat, and to cause all its officers, agents, servants, employees, professional advisors and contractors and prospective contractors to treat, as strictly confidential all Confidential Information. In no event shall such efforts be less than the degree of care and discretion as the Receiving Party exercises in protecting its own valuable confidential information. Any contractors engaged by or prospective contractors to be engaged by the Receiving Party in connection with the performance of the Services shall be required to assume obligations of secrecy equal to or greater than the obligations that the Receiving Party has assumed in this Agreement with respect to the Confidential Information;</li>
    <li>not, without the prior written consent of the Disclosing Party, disclose or otherwise make available the Disclosing Party’s Confidential Information or any part thereof to any party other than those of its directors, officers, agents, servants, employees, professional advisors, contractors or prospective contractors who need to know the Confidential Information for the purposes set forth herein;</li>
    <li>not copy or reproduce in any manner whatsoever the Confidential Information of the Disclosing Party or any part thereof without the prior written consent of the Disclosing Party, except where required for its own internal use in accordance with this Agreement; and</li>
    <li>promptly, upon termination or expiration of this Agreement, return and confirm in writing the return of all originals, copies, reproductions and summaries of Confidential Information or, or at the option of the Disclosing Party, destroy and confirm in writing the destruction of the Confidential Information.</li>
  </ol>

  <p>
    Provided, however that nothing herein shall restrict in any manner the ability of either Party to use or disclose Confidential Information owned by it in any manner whatsoever, and the obligations of confidentiality herein shall apply to each Party only to the extent that the Confidential Information or portion thereof is not owned by that particular Party.
  </p>

  <p>
    Any information which are already in public domain or other party has independently developed without breaching the terms of this Agreement shall not be construed as confidential information.
  </p>

  <h2>Force Majeure</h2>

  <p>
    If either Party is prevented, directly or indirectly, from performing any obligation under this Agreement or arising in connection herewith,
    by reason of acts of God, war, riots, terrorist attacks, fire, floods and any change in government policy which are beyond the reasonable control
    of the Party claiming relief under this section (collectively referred to herein as "Force Majeure"), such delayed performance or non-performance
    shall not constitute a default hereunder or subject the Party whose performance is delayed or prevented to any obligation or liability to the other Party,
    and the affected Party shall be given an additional time to perform equal to the delay caused by the event of Force Majeure, provided, however,
    that the Party so affected shall promptly notify the other in writing not later than forty-eight (48) hours of the occurrence of any such circumstances
    with all pertinent facts relating thereto.
  </p>

  <h2>Obligations of the Dealer</h2>

  <p>
    This Agreement covers selling of the Company’s Products to the Dealer and the Dealer shall have the following responsibilities:
  </p>

  <ol>
    <li>Not to make any representation or give any warranties other than those authorized by the Company in accordance with its Policy as in force from time to time.</li>
    <li>In case financing is availed through iTarang platform below requirements are to be met compulsorily:-</li>
  </ol>

  <ol type="a">
    <li>All relevant driver details and documents to the satisfaction of the financier both in soft copy and hard copy.</li>
    <li>Physical inspection (FI) to be done under financier regulations and guidelines and report to be submitted to the financier as per said rules and conditions in Schedule 3.</li>
    <li>Processing fee for financing of the asset to be submitted to iTarang which will further take care of the proceeds.</li>
    <li>Timely collection and follow up with the driver for EMI’s including and not limited to tenure of the financing including 3 EMI’s in case of battery finance and 6 EMI’s in case of e-rickshaw finance with iTarang batteries whichever is later.</li>
    <li>All EMI collection, processing fee to be transferred to iTarang platform digitally - UPI / Net banking / Debit Card / Any other collection agency or payment gateway authorised by iTarang.</li>
  </ol>

  <ol start="3">
    <li>To comply with all reasonable requirements consistent with the terms of this Agreement as are from time to time notified by the Company for the efficient conduct of the business.</li>
    <li>To use its best endeavors and the highest standards in all matters connected with the Business and to carry on the business diligently and in a manner in all material respects to the reasonable satisfaction of the Company and as may be reasonably required by the Company from time to time in accordance with its image and reputation.</li>
    <li>To ensure that all personnel employed by the Dealer in the Business shall always be clean and tidily clothed in any designated clothing or otherwise.</li>
    <li>Its premises and office equipment including furniture, electronics equipment etc. The Company shall not be liable for any loss. The Dealer will provide the necessary documents, support as may be required by the Company for insurance claim, including lodging of first information report (FIR) in case of theft or physical damage of the batteries or other material provided by the Company to the Dealer.</li>
    <li>The Dealer shall be liable to pay the damages to the Company in case the insurance proceeds do not cover the damage caused to the Company, including but not limited to batteries or other material of the Company at the Location(s).</li>
    <li>Further course of responsibility is mentioned in Schedule-2.</li>
    <li>The Dealer shall not have the authority to enter or conclude any agreements on behalf of the Company nor otherwise bind nor obligate the Company, except as provided in terms of this Agreement. For additional clarity, it is acknowledged and agreed that the Dealer will not make any statement, or engage in any activity or make any representation, which would have an effect on the Company, without the written consent of the Company.</li>
    <li>The Dealer shall get a signed off account reconciliation of its ledger with the Company at the end of every quarter.</li>
    <li>The Dealer shall be liable to ensure to comply with all the applicable laws, rules and regulations applicable to him.</li>
    <li>The Dealer acknowledges that the Company brand is the property of the Company. The logo of the Company as well as those of its various brands cannot be used freely by the Dealer and, therefore, prior written permission of the Company will be required for any specific use. The Company reserves the right to withdraw permission for the use of such logo at any time without assigning any reason whatsoever. After such withdrawal any use of the logo shall be deemed unauthorized and illegal.</li>
    <li>The Dealer will not sell / resell any products which may infringe any of the brands of the Company or its affiliates or group companies. The Company reserves the right to take legal action in case of such infringement.</li>
    <li>In case the Dealers have any knowledge of a Company/individual engaged in duplicating Products of the Company or its affiliated or group companies, or, of infringement of the Company’s Trademark, the Dealer agrees to provide information and complete support to the Company for taking appropriate legal action.</li>
  </ol>

  <h2>Non-Competition</h2>

  <p>
    The Dealer shall be responsible for observing the rules of fair competition and shall be solely responsible for any violation thereof.
    Without the prior written consent of the Company, the Dealer shall not promote, or engage in the sale, supply, or distribution,
    directly or indirectly, of products of other manufacturers that are similar or identical to the Company’s Products.
  </p>

  <p>In particular, the Dealer shall not, without the prior written consent of the Company, directly or indirectly:</p>

  <ol type="a">
    <li>Copy the Company’s Products or their parts thereof.</li>
    <li>Promote, mediate or sell the Products outside the Territory.</li>
    <li>Develop, manufacture, act as an intermediary for, or sell products that compete directly with the Company’s Products or its parts thereof; or</li>
    <li>Appear as a sponsor, commercial Dealer, commission Dealer or contract Dealer on behalf of any competitor of the Company.</li>
  </ol>

  <p>
    The Dealer shall always advise the Company regarding the representation of another principal (being a competitor of the Company or otherwise) before doing so.
    The rules of unfair competition will extend to the promoters, directors, shareholders, holding, subsidiary or group companies of the Dealer.
    The foregoing applies to companies/firms in competitive business situated within or outside India.
    The Dealer agrees and acknowledges that the above covenants are fair, just, reasonable and necessary to protect the operations and interests of the Company,
    that adequate consideration has been and will be revised during the Agreement for such obligations, and that these obligations do not prevent the Dealer from earning a livelihood.
  </p>

  <h2>Order Registration</h2>

  <p>
    Based on the scope of supply agreed between the Company and the Dealer, the Dealer would follow the guidelines defined in the Company’s Policy for order placement with the Company.
  </p>

  <h2>Default in Payment</h2>

  <p>
    In case of a default in payment, the Company reserves the right to impose late payment fees @ 12% per annum for the period of default.
    The Company further, without prejudice to the other remedy, shall be at liberty to take legal action and terminate all business relations with the Dealer
    (including this Agreement) if the issue is not settled amicably within thirty (30) days from the communication of the default by the Company to the Dealer.
  </p>

  <h2>Confidentiality and Moral Obligations</h2>

  <p>
    The Dealer acknowledge that, in connection with this Agreement hereunder, it may obtain information relating to the Company which is of a confidential and proprietary nature
    (hereinafter referred to as “Confidential Information”). Confidential information includes, the Company’s past, present and future development, methodology, delivery systems,
    data, summaries, reports, contracts, networks or staffing, business activities, plans, projections, proposals, financial and strategic information, clients, methods, copyrights,
    designs, documentation, products, trade secrets, and other such items owned by the Company, and any other information which the Dealer knows or should know is confidential,
    proprietary or trade secret information of the Company.
  </p>

  <p>In connection therewith, the following shall apply:</p>

  <ol>
    <li>The Dealer shall hold in confidence and shall not at any time before, during or after termination of the Agreement with the Company:</li>
  </ol>

  <ol type="a">
    <li>directly or indirectly reveal, report, publish, disclose or transfer Confidential Information or any part thereof to any person or entity;</li>
    <li>use any Confidential Information or any part thereof for any purpose other than for the benefit of the Company;</li>
    <li>assist any person or entity other than the Company to secure any benefit from Confidential Information or any part thereof; or</li>
    <li>make any copies of the Confidential Information provided by the Company.</li>
  </ol>

  <ol start="2">
    <li>In the event of a breach or threatened breach of the provisions of this Section, the Dealer agrees that:</li>
  </ol>

  <ol type="a">
    <li>the Company will be irreparably harmed by the release of its Confidential Information; and</li>
    <li>the Dealer agrees that in the event of a violation of this Agreement, the Company shall be entitled (in addition to the liquidated damages which shall be determined by the quantum of damages) to seek an appropriate decree of specific performance for any violation(s) and breach(es) by the Dealer, its employees, staff members without the necessity of demonstrating actual damages or that monetary damages would not afford an adequate remedy.</li>
  </ol>

  <h2>Limitation of Liability</h2>

  <p>
    In no event shall the Company be liable to the Dealer for special, incidental, indirect or consequential damages,
    damages from loss of use, profits, or business opportunities, failure to achieve cost savings, in contract, tort or otherwise,
    even if the Company has been advised in advance of the possibility of such loss, cost or damages, arising out of or in connection with this Agreement.
  </p>

  <h2>Termination</h2>

  <ol>
    <li>Without prejudice to the other rights and remedies available under law, either party may, by giving thirty (30) days written advance notice to the other party, terminate this Agreement where the other party has committed a serious breach of his obligations under this Agreement, unless such party rectifies the position.</li>
    <li>In addition to the above, the Company can also terminate this agreement at any time on the following grounds:</li>
  </ol>

  <ol type="a">
    <li>Where the Dealer has failed to account or make any payments as required under this agreement.</li>
    <li>Where the Dealer goes into voluntary or involuntary liquidation, is declared insolvent either in bankruptcy proceedings or other legal proceedings, or where an agreement with creditors has been reached due to its failure or inability to pay its debts as they fall due, and where a receiver is appointed over the whole or part of the Dealer’s business.</li>
    <li>On the termination of this Agreement the Company shall be entitled to instruct the Dealer to return all the Company’s Products and other material in the possession of or under the control of the Dealer relating to the rights granted under this Agreement. Failure to return the equipment may cause to adjust the security deposit and claim remaining amount which shall be paid immediately.</li>
  </ol>

  <p>
    The Company may also terminate this Agreement at any time by giving 30 (thirty) days written notice to the Dealer without assigning any reason to that effect.
    In the event of termination of this Agreement for any reason, the Company shall be, under no circumstances, liable to the Dealer for any compensations or reimbursements
    of such damages on account of any lost profits on current or anticipated sales of the Products, or any expenditures, investments or commitments made in connection with the business of the Distributor in any manner.
  </p>

  <h2>Effect of Termination</h2>

  <ol>
    <li>The Dealer shall discontinue in any way all use of products, trademarks or trade names that are authorized by the Company to use under this Agreement, nor shall thereafter use in any manner or under all circumstances any name, title or expression which, in the Company’s judgment, confusingly resembles the trademarks or trade names, or part thereof owned by the Company.</li>
    <li>If any notice of termination of this Agreement is given, the Company will be entitled to reject all or part of any orders received from Dealer after notice but prior to the effective date of termination.</li>
  </ol>

  <h2>Indemnity</h2>

  <p>
    The Dealer hereby agrees to always indemnify and hold the Company harmless from any loss, claim, prejudice, damage, costs, taxes, duties, penalties, interest thereon
    or expenses of any kind, including attorney’s fees and legal costs to which the Company may be subjected:
  </p>

  <ol>
    <li>By virtue of a breach of the representations and warranties made by Dealer.</li>
    <li>By virtue of any finding related to the terms of this Agreement and/or to the services required to be provided under the terms of this Agreement.</li>
    <li>By virtue of any contravention and/or non-compliance on the part of the Dealer with any laws, ordinance, regulations and codes as may be applicable from time-to-time.</li>
    <li>On account of any act, commission or omission attributable to the improper handling of the Company’s information or to the negligence of any person of the Dealer, which has resulted whether on account of breach of any of the conditions of this Agreement by the Distributor and/or its employees or otherwise.</li>
    <li>On account of any improper disclosure of Confidential Information.</li>
    <li>On account of any act of negligence, misfeasance, or fraud, and undertakes to fully compensate the Company for the same.</li>
  </ol>

  <p>
    The provisions of this Section shall be without prejudice to any other rights available to the Company.
    In this regard, the Company’s estimation of claim or loss caused would be final and binding on the Dealer.
  </p>

  <h2>Miscellaneous</h2>

  <p>
    This Agreement constitutes the entire contract between the Parties with respect to the subject matter hereof.
    No changes, amendments, modifications or waiver of any of the terms and conditions hereof shall be valid,
    unless reduced to writing and signed by duly authorized representatives of both parties hereto.
    Notices shall be given by the Parties at the address mentioned above. Any change in the address of any Party shall be immediately notified by such Party to the other in writing.
    Neither any failure nor any delay on the part of either Party hereto in exercising any right hereunder shall operate as a waiver thereof, nor shall any single or partial exercise
    of any right hereunder preclude any other or further exercise thereof or exercise of any other right.
    If any clause, sub-clause, or provision of this Agreement, or the application of such clause, sub-clause, or provision, is held invalid by a court of competent jurisdiction
    or illegal for any reason the remainder of this Agreement, and the application of such clause, sub-clause, or provision to persons, or circumstances other than those with respect
    to which it is held invalid shall not be affected.
    Following the determination that any provision of this Agreement is unenforceable, the Parties shall negotiate in good faith a new provision that, as far as legally possible,
    most nearly reflects the intent of the Parties and that restores this Agreement as nearly as possible to its original intent and effect.
    Nothing in this Agreement (or any of the arrangements contemplated herein) shall be deemed to constitute a partnership, joint venture, agency, operating alliance, or fiduciary relationship
    between the Parties, nor, except as may be expressly provided herein, constitute any Party as the agent of the other Party for any purpose, or entitle any Party to commit or bind the other Party in any manner.
    Dealer shall not be permitted to assign or delegate this Agreement or any of its rights or duties under this Agreement without the prior written consent of the Distributor/Company.
    The cost of stamp duty and registration charges if any in relation to this Agreement shall be borne by the Dealer alone.
  </p>

  <h2>Dispute Resolution</h2>

  <p>
    (i) In the event of disputes, differences, claims and questions arising between the parties hereto arising out of this Agreement or in any way relating hereto or any term condition or provision herein mentioned
    or the construction or interpretation hereof or otherwise in relation hereto or otherwise, the parties shall first endeavor to settle such differences, disputes, claims or questions by friendly consultation
    and failing such settlement a dispute will be deemed to arise when one Party serves on the other Party a written notice stating the nature of the dispute.
  </p>

  <p>
    (ii) The Parties hereto agree that they will use all reasonable efforts to resolve between themselves, any disputes through negotiations.
  </p>

  <p>
    (iii) Any disputes and differences whatsoever arising under or in connection with this Agreement that could not be settled by the Parties through negotiations,
    after thirty (30) business days from the service of the notice of dispute, shall be finally settled by arbitration under the provisions of Arbitration and Conciliation Act, 1996
    (“Arbitration Act”) including any statutory modification and/or re-enactment thereof for the time being in force.
    All proceedings shall be conducted in English language. The arbitration shall be referred to a arbitrator appointed on the mutually agreed between by the Distributor and Dealer
    and the decision of such arbitrator shall be final and binding upon the Parties, the costs/expenses of such arbitration including Arbitrator fees
    (except respective counsel fees) shall be equally borne as per the Arbitration Act.
  </p>

  <h2>Exclusivity</h2>

  <p>
    During the term of this agreement and 1 years thereafter the Dealer shall not enter into similar agreement with any organization for rendering services in relation to the business as mentioned in this agreement.
  </p>

  <p>
    IN WITNESS WHEREOF both the parties append their signatures in token of having accepted the above terms and conditions on the date, month and year as mentioned above.
  </p>

  <div class="signature-grid">
    <div class="signature-box">
      <div class="sign-line"></div>
      <p><strong>For and on behalf of</strong></p>
      <p><strong>The Distributor / Company</strong></p>
      <p>e iTarang technologies LLP</p>
      <p>Name: ${esc(safe(agreement.itarangSignatory1?.name))}</p>
      <p>Designation: ${esc(safe(agreement.itarangSignatory1?.designation))}</p>
    </div>

    <div class="signature-box">
      <div class="sign-line"></div>
      <p><strong>For and on behalf of</strong></p>
      <p><strong>The Dealer</strong></p>
      <p>M/S ${esc(safe(company.companyName))}</p>
      <p>Name: ${esc(safe(agreement.dealerSignerName))}</p>
      <p>Designation: ${esc(safe(agreement.dealerSignerDesignation))}</p>
    </div>
  </div>

  <h2>Schedule-1: Commercial Terms</h2>

  <p>The Dealer shall pay to the Company for each battery (One time Product fee):</p>

  <table>
    <tr>
      <th>Product Package</th>
      <th>Maximum Dealer Price (INR)</th>
      <th>Non-refundable Security (INR)</th>
    </tr>
    <tr>
      <td>iTarang</td>
      <td>INR 58,000/-</td>
      <td>
        1. 31,000 + GST (for battery financing)<br/>
        2. 1,50,000 + GST for e rickshaw financing with iTarang batteries (OEM onboarding) and 61,000 + GST for dealer onboarding
      </td>
    </tr>
  </table>

  <ol>
    <li>The Company shall raise an invoice equal to the Maximum Dealer Price amount inclusive of GST to the Dealer.</li>
    <li>No interest is payable on any form of Refundable Security.</li>
    <li>All Payments to be made in terms of this Agreement will be subject to the deduction of tax at source, wherever applicable, as per the provisions of the Income Tax Act, 1961.</li>
    <li>All payment of product purchase including security deposit shall be made through the bank account pertaining to the respective Parties.</li>
    <li>No Cash Transaction is permissible.</li>
    <li>Any dispute pertaining to invoice raised by Company should be communicated in writing within seven working days from the invoice date, failing it will be deemed as an acceptance by Dealer.</li>
    <li>Dealer shall provide Form 16A to the Distributor/Company every quarter to substantiate the deposit of TDS deducted from the payments.</li>
    <li>If the Dealer has not deposited the TDS and complied with the necessary return filing within due date and because of it Distributor couldn’t claim the credit against the TDS then Distributor has all the rights to recover the TDS amount along with applicable interest as per Income Tax Act from the Dealer and said amount can be adjusted against refundable security. Dealer must pay sufficient amount to keep the refundable security amount intact immediately.</li>
    <li>The Company shall have the full right to change its Maximum Dealer Price without prior notice.</li>
    <li>The Distributor/Company and Dealer shall abide by the applicable GST laws at any given point of time.</li>
    <li>The Dealer agrees that the Company has the right to adjust any receivable amount (after reconciliation & mutual agreed between Company & Dealer) from the amount of Security deposit with the Company.</li>
    <li>The Dealer shall be bound to share signed and certified Equipment statements as per the frequency fixed by the Company.</li>
    <li>The Dealer shall be responsible for safeguarding the interest of the Company for the Equipment and shall be liable to return the service Equipment in good & working condition except for manufacturing default including normal wear and tear covered under manufacturer warranty.</li>
  </ol>

  <div class="page-break"></div>

  <h2>Schedule-2: Detailed Scope</h2>

  <h3>Lead Generation and Driver Onboarding</h3>
  <ol>
    <li><strong>Lead Generation:</strong> Dealer will 100% work on lead generation and sales. The distributor will have no responsibility.</li>
    <li><strong>Product Installation / Retro-fitment:</strong> Product installation should be done by the Dealer. All related forms and agreements to be signed and recognized by Dealer, Driver/End user, Company Personnel and shared with Company central within the same day via WhatsApp, mail and application.</li>
    <li><strong>Record Maintenance and compliance:</strong> Dealer is liable to onboard the end user with KYC, Onboarding form, onboarding agreement and other related documents fully filled and signed – all the said documents and entries should be recorded and maintained on Company provided application as well as in hard copies.</li>
  </ol>

  <h3>Daily operations</h3>
  <ol>
    <li><strong>Product Management:</strong> Dealer is liable to keep a record of Company provided Products on day-to-day basis and on Company provided app.</li>
    <li><strong>Product Retail Management:</strong> Dealer is liable to keep a record of the daily customer walk-in, battery sales, warranty claims, plan allocation on the ledger book and application provided by Company on a day-to-day basis.</li>
    <li><strong>Referral record:</strong> Any referral of end user should be recorded in the onboarding form with necessary details of referrer.</li>
  </ol>

  <h3>Service Operation</h3>
  <ol>
    <li><strong>Service ticket:</strong> Dealer to raise Service ticket on app, till app is rolled out, the same is to be done through WhatsApp in company group and confirmation with ticket id to be kept as record.</li>
    <li><strong>Troubleshooting:</strong> Company will address the Service ticket.</li>
    <li><strong>PDI of Product received at Dealer:</strong> Dealer is required to report PDI and actual voltage within 48 hours of the receival along with receiving document signed and stamped.</li>
    <li><strong>Battery maintenance (Lying at Dealer shop):</strong> Dealer must keep batteries at 50% (SOC/Charge percentage) lying at the shop.</li>
    <li><strong>Physical damage / deep discharge / water ingress issues:</strong> Any mentioned damage to SOC, Harness with connector, battery, charger or any other Company Product will be charged to end user/driver (in usage) or from DEALER (Product lying at shop) as per invoice value.</li>
  </ol>

  <h3>Payment terms</h3>
  <ol>
    <li><strong>Payment due date:</strong> Dealer is liable to clear dues before dispatch and after invoice date.</li>
    <li><strong>Payment method:</strong> Dealer shall make the payments through banking mode using RTGS, NEFT, UPI, cheques and like payment modes only. No payment in cash to the Company shall be accepted.</li>
    <li><strong>Late payment fees:</strong> 12% Interest/Month will be applicable in case of delay in the payment.</li>
  </ol>

  <h3>Third party issues</h3>
  <ol>
    <li><strong>Subcontracting:</strong> Dealer is not allowed to subcontract any aspect of the sale or delivery of products or services to third-party subcontractors without our written approval.</li>
    <li><strong>Compliance with laws and regulations:</strong> Our technology / business / operational process cannot be copied and reproduced in any form which can lead to breach of intellectual property rights. This includes confidentiality and protection of IP of product, Trade secrets, business and including customer database will not be shared without written approval of Company.</li>
  </ol>

  <h3>Product protection</h3>
  <ol>
    <li><strong>Termination and return of Products:</strong> The effective date of termination of Dealer agreement is counted effectively from the NOC is taken over from Company. The NOC will be given once our Products are handed over & Commercials are settled. Dealer cannot hold the inventory belonging to Company under any circumstances.</li>
    <li>To safeguard any loss of Product to the Company and non-cooperation from Dealer, Dealer is required to submit 3 undated Cheque to Company.</li>
  </ol>

  <h3>Tax compliance</h3>
  <ol>
    <li><strong>GST & taxes:</strong> DEALER will follow all regulatory norms of taxation as applicable by government.</li>
    <li><strong>Tax audits and disputes:</strong> The Dealer shall be bound to provide Product statement / balance confirmation certificates & any other document as and when required by the Company.</li>
  </ol>

  <h3>Inventory management</h3>
  <p>
    The Company has all the right to ask for the information relating to the Product and Dealer is bound to share the information as and when asked for and if any discrepancy in the physical Product is found, Dealer shall be liable to make good the loss.
  </p>

  <h3>Theft management</h3>
  <ol>
    <li><strong>Security measures:</strong> DEALER will implement security deterrence measures such as CCTV cameras, fire safety alarms and at any movement Company officials can access the logs, camera. The minimum record is 60 days’ storage of CCTV or as per Govt norms.</li>
    <li><strong>Reporting requirements:</strong> Dealer may be required to report any incidents of theft to the Company immediately. This allows the Company to take appropriate action to mitigate the impact of the theft on their business.</li>
    <li><strong>Investigation process:</strong> In the event of a theft / burnt / held by any other entity, support of manpower, law enforcement (FIR), the handling of evidence, basic liaison with authorities is expected from Dealer. Company has right to investigate via third party to have independent view.</li>
  </ol>

  <h3>Insurance</h3>
  <ol>
    <li><strong>Required insurance coverage:</strong> DEALER must maintain the general insurance of his property, products, third party and workers. He should follow the local government norms. Dealer will submit the required evidence as required.</li>
    <li><strong>Proof of insurance:</strong> Dealer may be required to provide proof of insurance coverage to the Company on a regular basis, such as annually or as requested by the Company.</li>
  </ol>

  <h3>Revenue reconciliation</h3>
  <ol>
    <li><strong>Sales reporting:</strong> DEALER may be required to provide regular reports to the Company on the number of batteries sold, warranty & service claims raised.</li>
    <li><strong>Business practices:</strong> DEALER will follow the general business practices which as desired by Company looking at the ethics, integrity and payment transactions among mutual parties, Dealer will also maintain the documentation for the future reference and such record should be kept safe as per Income Tax Act.</li>
  </ol>

  <h3>Safety Measures at Dealer Shop</h3>
  <p>
    Safety is a crucial consideration at Dealer shop, where electric vehicle batteries are replaced or charged.
    The following are some of the safety measures that should be implemented:
  </p>

  <ol>
    <li>Tempering of grid, battery and charger is not permissible.</li>
    <li>Any Connection upgrade above 5 KW should be consented on by the Company team.</li>
    <li>EV Connection cannot be used for any other commercial or residential purpose.</li>
    <li>Rating of wire / specification / make must be as per Company guidelines only.</li>
    <li>Earthing needs to be tested in our engineer’s presence before equipment is charged on.</li>
    <li>Ventilation to be provided at two sides.</li>
    <li>Proper illumination should be there at the designated area during operational hours.</li>
    <li>If additional electricity infra etc. is added due to business requirement, the workmanship, dimension / capacity of system needs to be validated & approved by Company team before the move.</li>
  </ol>

  <h3>Fire Safety</h3>
  <p>At least two fires extinguish of below configuration for 100 Batteries / 1000 square feet:</p>
  <ol>
    <li>CO2 Type - 4.5 KG</li>
    <li>ABC Type - 4 KG</li>
    <li>Fire safety kit (heat resistant gloves, fire blanket, and first aid kit, rope, etc. & needful)</li>
    <li>Norms of local fire authority to be followed.</li>
    <li>No inflammable items / chemicals / Hazard item to keep during operation.</li>
    <li>No smoking zone to be declared within the shop.</li>
    <li>Fire smoke Detector to be installed at shop.</li>
  </ol>

  <h3>Work force Safety and Environmental Safety</h3>
  <ol>
    <li>Trained Manpower - Each work force deployed for operation need to be certified by Company. Therefore, the best practice can be informed.</li>
    <li>Safety dress code to be followed which operations.</li>
    <li>Proper illumination of area should be made.</li>
    <li>No seepage, water rear / inside the shop is permissible.</li>
    <li>A clean, dust-free environment should be maintained.</li>
    <li>Digital temperature meter should be maintained on side to monitor the temperature of healthy operation of Batteries.</li>
    <li>Certified tool kits of Make & Model to be used.</li>
  </ol>

  <p>
    IN WITNESS WHEREOF, both the Parties have caused this Agreement to be executed in duplicate and duplicate copy of which shall be considered as original,
    by their duly authorized representatives as of the day and year first above written.
  </p>

  <div class="signature-grid">
    <div class="signature-box">
      <div class="sign-line"></div>
      <p><strong>For Company</strong></p>
      <p>Signed and delivered by within named M/s The iTarang technologies LLP, by its duly authorized representative</p>
      <p>Mr. ${esc(safe(agreement.itarangSignatory1?.name))}</p>
      <p>Mr. ${esc(safe(agreement.itarangSignatory2?.name))}</p>
    </div>

    <div class="signature-box">
      <div class="sign-line"></div>
      <p><strong>For Dealer</strong></p>
      <p>Signed and delivered by within named M/S ${esc(safe(company.companyName))}, by its duly authorized representative Mr. ${esc(safe(agreement.dealerSignerName))} (${esc(safe(agreement.dealerSignerDesignation, "Proprietor"))})</p>
    </div>
  </div>

  <div class="page-break"></div>

  <h2>Schedule 3</h2>
  <h3>Dealer Onboarding Details (Financer agreement)</h3>

  <table>
    <tr><td class="label">Photograph</td><td>To be attached separately if required</td></tr>
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
    <tr><td class="label">GST No</td><td>${esc(company.gstNumber)}</td></tr>
    <tr><td class="label">Office Address</td><td>${esc(dealerAddress)}</td></tr>
    <tr><td class="label">Vehicle Type</td><td>${esc(agreement.vehicleType)}</td></tr>
    <tr><td class="label">Manufacturer</td><td>${esc(agreement.manufacturer)}</td></tr>
    <tr><td class="label">Brand</td><td>${esc(agreement.brand)}</td></tr>
    <tr><td class="label">State (Presence)</td><td>${esc(agreement.statePresence)}</td></tr>
    <tr><td class="label">Bank Account Name</td><td>${esc(ownership.beneficiaryName)}</td></tr>
    <tr><td class="label">A/C No.</td><td>${esc(ownership.accountNumber)}</td></tr>
    <tr><td class="label">IFSC Code</td><td>${esc(ownership.ifsc)}</td></tr>
    <tr><td class="label">Branch</td><td>${esc(ownership.branch)}</td></tr>
    <tr><td class="label">Account Type</td><td>${esc(ownership.accountType)}</td></tr>
    <tr><td class="label">Date & Stamp with Signature</td><td>${esc(signedDate.day)} ${esc(signedDate.month)} ${esc(signedDate.year)}</td></tr>
  </table>

  <h2>Memorandum of Under Standing</h2>

  <p>
    This Agreement is executed at ${esc(executionPlace)} on ${esc(signedDate.day)} day of ${esc(signedDate.month)} ${esc(signedDate.year)}, by and between:
  </p>

  <p>
    M/s. iTarang on behalf of Authorised Financer Partner / financers, a company incorporated under the Companies Act, 2013 as amended from time to time
    and having its registered office at Office No. B103, Business zone, Tower B, Nirvana Country, Gurugram - 122018, having GST - 06AALFI7813E1ZE
    (herein after called as Party of "FIRST PART” / “Authorised Financer partner” / “LOAN SERVICE PROVIDER Partner”) which expression shall,
    unless otherwise repugnant to the context or meaning thereof, be deemed to include its legal representatives, executors, administrators and permitted assigns.
  </p>

  <p><strong>AND</strong></p>

  <p>
    M/s ${esc(safe(company.companyName))} (${esc(safe(firmType))} firm) with GST ${esc(safe(company.gstNumber))}
    having its Main Office / Shop at ${esc(safe(dealerAddress))} represented by Mr. ${esc(safe(agreement.dealerSignerName))}
    ${ownership.ownerAge ? `aged ${esc(ownership.ownerAge)} years` : ""}
    Proprietor and Authorized Signatory of the firm
    (Hereinafter called as Party of “SECOND PART” / “Dealer”, which expression unless repugnant to the subject or context shall mean and include all its successors and permitted assigns).
  </p>

  <p>
    Authorised Financer Partner / FIRST PARTY / LOAN SERVICE PROVIDER Partner and Dealer are hereinafter collectively referred to as the “Parties”
    and individually as a “Party”.
  </p>

  <p><strong>WHEREAS:</strong></p>

  <ol>
    <li>M/s ${esc(safe(financerEntity))} is financer of E-rickshaw / E-rickshaw battery and lithium batteries.</li>
    <li>Authorised Financer Partner is carrying on the business of Finance facility services through partnership with NBFC’s.</li>
    <li>Dealer has the responsibility of selling E-Rickshaw / Battery Rickshaw, three wheelers to prospective buyers in their locality for which it is duly authorized by “Finance Partner”.</li>
    <li>“Dealer”, in order to boost sale of its Products / E-Rickshaw / E-Cart is in search of reliable Financing Support and has approached Authorised Financer Partner in this regard and to have a separate Agreement / contract with its distributors and Authorised Financer Partner has agreed to the proposal of “Dealer” to work together to make accessible organized Finance facility at applicable interest rates to the customers in Live Locations only as agreed mutually from time to time in writing with Distributors and individual Customers who wish to buy the vehicle E-Rickshaw / E-Cart / Products with the iTarang and separate AGREEMENT is signed in respect of retail financing of said Vehicles registered in the States / Territories mutually agreed and mentioned therein (hereinafter called as “Dealer-Loan Service Provider AGREEMENT”).</li>
    <li>All authorized dealers should be agreed to enter this separate Agreement with Authorised Financer Partner for all Finance facility done through Authorised Financer Partner for products and has given its acknowledgement about the existence of “Dealer-Loan Service Provider AGREEMENT” which shall also be binding on for all relevant terms and conditions as may be applicable on all dealers. Thereby, Authorised Financer Partner acknowledges its responsibilities under present AGREEMENT as well as under “Dealer - Loan Service Provider AGREEMENT”.</li>
    <li>Subject to above, Dealer and Authorised Financer Partner has entered this Agreement on the following terms and conditions.</li>
  </ol>

  <p>
    NOW THEREFORE IN CONSIDERATION OF THE PROMISES AND MUTUAL COVENANTS HEREIN CONTAINED, AND OTHER GOOD AND VALUABLE CONSIDERATION,
    THE RECEIPT AND SUFFICIENCY OF WHICH IS HEREBY ACKNOWLEDGED, THE PARTIES HERETO AGREE AS FOLLOWS:
  </p>

  <h2>Interpretation</h2>

  <p>Except where the context requires otherwise, this Agreement will be interpreted as follows:</p>
  <ol type="I">
    <li>headings, sub-headings, titles, sub-titles to Clauses, sub-clauses and paragraphs are for information only and shall not form part of the operative provisions of this Agreement or the Schedules hereto and shall be ignored in construction or interpretation of this Agreement;</li>
    <li>where a word or phrase is defined, other parts of speech and grammatical forms and the cognate variations of that word or phrase shall have corresponding meanings;</li>
    <li>Words importing the singular shall include plural and vice versa;</li>
    <li>all words (whether gender-specific or gender neutral) shall be deemed to include each of the masculine, feminine and neutral genders;</li>
    <li>any reference in this Agreement to a legislation or a statutory provision includes that provision, a modification, or re-enactment thereof, a statutory provision substituted for it and a regulation or statutory instrument issued under it;</li>
    <li>the Recitals, Schedules and Exhibits (each as amended from time to time) are an integral part of this Agreement and shall be construed and shall have the same force and effect as if they were expressly set out in the main body of this Agreement and any reference to this Agreement includes the Recitals, Schedules and the Exhibits;</li>
    <li>references to “writing” includes an electronic transmission and any means of reproducing words in a tangible and permanently visible form;</li>
    <li>references to Rupees, Rs. and INR are references to the lawful currency of India;</li>
    <li>reference to a clause, schedule and exhibit is a reference to a Clause of, a Schedule to, or exhibit to, this Agreement;</li>
    <li>no rule of construction applies to the disadvantage of a Party because such Party was responsible for preparation of this Agreement or any part of it.</li>
  </ol>

  <h2>Services</h2>

  <p>
    Authorised Financer Partner agrees to offer financing facilities in partnership with NBFC’s to eligible customers as per the Know Your Customer (KYC) norms and credit policies of the NBFC
    for the E-Rickshaw / E-Rickshaw Battery delivered through dealer, as described herein above, except the ones which may be specifically excluded at the sole un-disputed discretion of Authorised Financer Partner.
  </p>

  <h2>Credit Evaluation / Financing</h2>

  <ol>
    <li>Authorized dealer shall identify and arrange to refer the customers to Authorised Financer Partner and Authorised Financer Partner agrees to offer financing facilities to eligible customers through its branches / outlets in the State of Delhi, NCR and other states as decided mutually under the jurisdiction of Authorised Financer Partner State Offices and at all Dealer premises, except those who may not be found eligible in credit appraisals. Authorised Financer Partner will have endeavor to process customer's request received through dealers as far as possible within four (4) working days after receipt of duly completed application forms along-with all necessary supporting documents. The assessment of the borrower and the Agreement of Finance facility to be extended to the borrower by way of credit facility shall purely be at the sole undisputed discretion of Authorised Financer Partner.</li>
    <li>Authorised Financer Partner will evaluate the needs of customers for the vehicles and develop appropriate financing packages including product structuring, down payment margin, more security guarantee, tenure of loan and effective rate of interest to customers on best efforts basis.</li>
    <li>Dealer shall have no authority to make commitments, representations or give any warranties or otherwise on behalf of Authorised Financer Partner to any purchasers of Dealer’s.</li>
    <li>Separate agreement may also be entered into between Authorised Financer Partner and Dealer which shall cover responsibilities of each party to that AGREEMENT. Dealer irrevocably indemnifies Financer and Financer Partner for its any delinquencies / defaults as authorized dealers in relation to such separate AGREEMENTs notwithstanding to anything as well as under its separate present AGREEMENT with Financer.</li>
  </ol>

  <h2>Terms and Conditions</h2>

  <ol>
    <li>Dealer shall be responsible for arranging the loan applications of the customers and to send it to the branches of Authorised Financer Partner within reasonable Time Frame as mutually agreed between parties.</li>
    <li>On receipt of leads from dealer, the field staff of Authorised Financer Partner will conduct F.I. (First Inspection) of the proposed customer / Co-applicant / Guarantor and in case the same is found satisfactory and without any negative observation, Authorised Financer Partner will issue the D.O. (Delivery Order) number to dealers which will be valid for maximum 15 working days from the date of D.O.</li>
    <li>On receipt of D.O. number, dealer shall complete the application form, documentation etc. on the booklets provided by Authorised Financer Partner for the purpose and completes it properly and Authorised Financer Partner shall ensure that no legal deficiency exists. Dealer shall also obtain photocopies of all self-attested KYC documents of applicant / guarantor and Authorised Financer Partner shall verify the same with originals. Thereafter the application, documents and all other papers including Invoice, Insurance, driving license, police verification, disclaimer and registration certificate etc. will be forwarded to the Office of Authorised Financer Partner.</li>
    <li>Authorised Financer Partner will have endeavor to process customer's requests preferably within four (4) working days after receipt of duly completed application form along with all the necessary supporting documents.</li>
  </ol>

  <p><strong>Dealer must provide:</strong></p>
  <ol>
    <li>One time payment of Rs. 31000 + GST to be renewed annually.</li>
    <li>Subvention Agreement of INR 1.5% MBD (Manufacturer buy down) per case with applicable taxes which is compulsory in each case.</li>
    <li>Buyback Clause based on ageing:
      <br/># loan Agreement within first 3 months
      <br/># Principal Outstanding after 3 months
    </li>
    <li>In case of default of any EMI in new cases for first 6 months, Authorised Financer Partner will stop all further new cases.</li>
    <li>Refinance facility with a down payment of INR 25000 at the POS value in 1 year.</li>
    <li>The value is applicable if the complete vehicle in working condition has been lifted and handed over with batteries and charges.</li>
  </ol>

  <h2>Prevention of Frauds</h2>

  <p>
    That Authorised Financer Partner and Dealer represent and commit to each other to help to avoid and prevent fraud in the sale and Finance facility of the Vehicles.
    In case such fraud occurs, the Parties would co-operate in detecting and eliminating the same and would establish working procedures to avoid repetition.
  </p>

  <p>
    Dealer also agrees that Authorised Financer Partner shall have the right to take appropriate action against in cases commits fraud and also entitled to claim damages from dealer end
    and in such case Dealer shall provide all necessary assistance to Authorised Financer Partner.
  </p>

  <h2>Termination</h2>

  <p>
    That this agreement can be terminated by any of the parties by giving a minimum of 30 days written notice to the other party.
    However, all commitments agreed between the parties prior to termination of the shall be valid, effective, and binding on the parties and enforceable
    till the entire Agreement of loans are repaid in full, particularly clause relating to future process and buy-back will survive the termination.
  </p>

  <p>
    Upon the termination of this AGREEMENT, for the reasons stated above, this AGREEMENT shall cease.
    Neither party shall be liable or obligated to the other party for any deed happening after the date of termination;
    both Parties shall pay the other all Agreements due and payable under this AGREEMENT immediately on termination and return all relevant documents, papers etc.
    however, the termination shall not have any impact on the activities / deed done / entered prior to date of termination.
    However, Authorised Financer Partner shall have the right to recover losses / expenses incurred by it for the breaches done by Dealer towards this AGREEMENT and / or
    “Dealer-Loan Service Provider AGREEMENT”.
  </p>

  <h2>Confidentiality</h2>

  <p>
    The parties shall treat and keep strictly confidential all matters and information including data base regarding the other obtained by it or which it became aware of while entering or performing its obligations under this agreement and neither Party shall disclose any such information to any other person without the express written consent of the other Party.
    However, information already in public domain is exempt from the provisions of this Clause.
    The obligation stipulated in this clause shall survive expiration / termination of this agreement.
  </p>

  <h2>Miscellaneous Provisions</h2>

  <p><strong>Relationship:</strong> The relationship between the Parties is that of principal-to-principal basis. This is also neither a joint venture nor a partnership, employer-employee or an agency arrangement and does not create any other similar relationship of any nature whatsoever.</p>

  <p><strong>Amendment / Modification:</strong> The conditions set forth herein can be amended by mutual consent of Authorised Financer Partner and Dealer and financer. Any amendment to this AGREEMENT, to be valid and binding, shall be in writing and signed by all the parties.</p>

  <p><strong>Assignment:</strong> Neither this AGREEMENT nor any right hereunder may be transferred, sub-contracted assigned or delegated by either party without prior written consent of the other. Any attempted assignment, delegation or transfer shall be null and void.</p>

  <p><strong>Severability:</strong> If any term or clause of this AGREEMENT is found by competent authority to be void, voidable, illegal, or otherwise unenforceable, the remaining provisions of this AGREEMENT shall remain in full force and effect.</p>

  <p><strong>Waiver:</strong> Any waiver by the Authorised Financer Partner at any time to enforce any obligation or to claim or a breach of any term of this AGREEMENT or to exercise any power agreed to hereunder shall not be construed as a waiver of any right future power or obligation under this AGREEMENT and it shall not affect any subsequent breach and shall not prejudice the Authorised Financer Partner as regards any subsequent action.</p>

  <p><strong>Notices:</strong> All notices to be given under this AGREEMENT shall be made in writing and shall be delivered either (a) by registered post (b) by courier service to their respective following addresses, unless otherwise designated or changed by written notice by the parties hereto.</p>

  <div class="boxed">
    <p><strong>iTarang technologies LLP</strong></p>
    <p>B103, Business zone, Tower B, Nirvana Country, Gurugram - 122018</p>
    <p>GST- 06AALFI7813E1ZE</p>
  </div>

  <p>
    Neither party shall use the logo, trademark / name or any other intellectual property of the other without prior written permission of the other party, which permission shall not be unduly withheld.
    This AGREEMENT may be executed in counterparts, each of which shall be deemed an original, but all of which taken together shall constitute one and the same AGREEMENT.
  </p>

  <h2>Governing Law and Jurisdiction</h2>

  <ol>
    <li>In case any dispute arises as to the liabilities or obligations on interpretations of the terms of this agreement, the same shall be endeavored to be resolved by consensus and mutual understanding within 15 days from the date of notification of the dispute by either party to the other party.</li>
    <li>If the issue cannot be settled by mutual discussions within the stipulated time, then the same shall be referred to a Sole Arbitrator who shall be appointed / nominated as mutually agreed by Authorised Financer Partner & Dealer. The Arbitration shall be conducted in accordance with the provisions contained in the Arbitration and Conciliation Act, 1996 and its subsequent amendments thereof. The place of arbitration shall be at Delhi and the language of arbitration shall be English. The arbitration proceedings will be on a fast-track basis. The cost of Arbitration shall be borne by respective parties equally; It is further agreed that in the event of the said Arbitrator dying or being unable to act for any reason, Authorised Financer Partner & Dealer shall appoint in his place another Arbitrator who shall be entitled to resume the said arbitration proceedings from the stage at which it was left by the predecessor.</li>
    <li>Subject to the arbitration clause above, the competent courts at DELHI, INDIA shall have exclusive jurisdiction to entertain, try and decide the dispute or difference between the parties.</li>
  </ol>

  <p>
    This AGREEMENT is signed, and one photocopy will be made available to the Dealer for its record.
  </p>

  <p>
    In affirmation of what has been written in all the clauses herein before, both the parties set their hands hereto and have signed this agreement on the day first herein above written in the presence of Witnesses:
  </p>

  <div class="signature-grid">
    <div class="signature-box">
      <div class="sign-line"></div>
      <p><strong>FOR Authorised Financer Partner (Authorized Signatory)</strong></p>
      <p>Name: ${esc(safe(agreement.financierSignatory?.name))}</p>
      <p>Designation: ${esc(safe(agreement.financierSignatory?.designation))}</p>
    </div>

    <div class="signature-box">
      <div class="sign-line"></div>
      <p><strong>FOR Dealer (Authorized Signatory)</strong></p>
      <p>Name: ${esc(safe(agreement.dealerSignerName))}</p>
      <p>Designation: ${esc(safe(agreement.dealerSignerDesignation))}</p>
    </div>
  </div>

  ${
    agreement.includeWitnessesInSigning
      ? `
  <div class="signature-grid">
    <div class="signature-box">
      <div class="sign-line"></div>
      <p><strong>Witness (1)</strong></p>
      <p>Name: ${esc(safe(agreement.witness1?.name))}</p>
      <p>Address: ${esc(safe(agreement.witness1?.address))}</p>
      <p>Mobile no.: ${esc(safe(agreement.witness1?.mobile))}</p>
    </div>

    <div class="signature-box">
      <div class="sign-line"></div>
      <p><strong>Witness (2)</strong></p>
      <p>Name: ${esc(safe(agreement.witness2?.name))}</p>
      <p>Address: ${esc(safe(agreement.witness2?.address))}</p>
      <p>Mobile no.: ${esc(safe(agreement.witness2?.mobile))}</p>
    </div>
  </div>
  `
      : `
  <div class="signature-grid">
    <div class="signature-box">
      <div class="sign-line"></div>
      <p><strong>Witness (1)</strong></p>
      <p>Name: ____________________</p>
      <p>Address: ____________________</p>
      <p>Mobile no.: ____________________</p>
    </div>

    <div class="signature-box">
      <div class="sign-line"></div>
      <p><strong>Witness (2)</strong></p>
      <p>Name: ____________________</p>
      <p>Address: ____________________</p>
      <p>Mobile no.: ____________________</p>
    </div>
  </div>
  `
  }
</body>
</html>
`;
}