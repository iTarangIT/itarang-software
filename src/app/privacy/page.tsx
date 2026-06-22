import type { Metadata } from "next";

// Public legal page. Meta (WhatsApp / Facebook Login) requires a reachable,
// publicly accessible Privacy Policy URL before an app can go Live. The auth
// middleware lets `/privacy` fall through for anonymous visitors (it is neither
// a "public" auth route nor a "protected" dashboard route), so this renders
// without a session and returns HTTP 200 to Meta's validator.
//
// NOTE: This is a baseline policy reflecting iTarang's current data flows. Have
// it reviewed by legal/DPO before relying on it for compliance.

export const metadata: Metadata = {
  title: "Privacy Policy — iTarang",
  description:
    "How iTarang Technologies LLP collects, uses, and protects personal data across its dealer CRM, KYC, and WhatsApp services.",
};

const LAST_UPDATED = "22 June 2026";

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-slate-800">
      <h1 className="text-3xl font-bold text-slate-900">Privacy Policy</h1>
      <p className="mt-2 text-sm text-slate-500">Last updated: {LAST_UPDATED}</p>

      <section className="mt-8 space-y-4 leading-relaxed">
        <p>
          This Privacy Policy explains how <strong>iTarang Technologies LLP</strong>{" "}
          (&ldquo;iTarang&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) collects,
          uses, shares, and protects personal information when you use our dealer
          and customer management platform, including our website, web
          application, and WhatsApp-based onboarding and support services
          (collectively, the &ldquo;Services&rdquo;).
        </p>
      </section>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        1. Information We Collect
      </h2>
      <ul className="mt-3 list-disc space-y-2 pl-6 leading-relaxed">
        <li>
          <strong>Identity &amp; KYC data:</strong> name, date of birth, address,
          PAN, Aadhaar (where legally permitted), and bank account details
          provided for identity and financial verification.
        </li>
        <li>
          <strong>Contact data:</strong> mobile number, email address, and
          WhatsApp number used to communicate with you.
        </li>
        <li>
          <strong>Business data:</strong> dealership, distributor, and order
          information used to manage onboarding, sales, and after-sales service.
        </li>
        <li>
          <strong>Communications:</strong> messages, documents, and media you
          send to us over WhatsApp, email, or the application, including those
          processed to assist your onboarding.
        </li>
        <li>
          <strong>Payment data:</strong> transaction references and payment
          status processed through our payment partner. We do not store full card
          details.
        </li>
        <li>
          <strong>Technical data:</strong> device, log, and usage information
          collected automatically when you access the Services.
        </li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        2. How We Use Your Information
      </h2>
      <ul className="mt-3 list-disc space-y-2 pl-6 leading-relaxed">
        <li>To onboard dealers and verify identity, KYC, and bank details.</li>
        <li>To process leads, orders, financing, payments, and after-sales service.</li>
        <li>
          To send and receive WhatsApp messages, notifications, and document
          requests related to your account and onboarding.
        </li>
        <li>To operate, secure, and improve the Services.</li>
        <li>To comply with legal, regulatory, and audit obligations.</li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        3. Sharing &amp; Service Providers
      </h2>
      <p className="mt-3 leading-relaxed">
        We share personal data only as needed to deliver the Services and meet
        legal obligations, including with trusted processors who act on our
        behalf:
      </p>
      <ul className="mt-3 list-disc space-y-2 pl-6 leading-relaxed">
        <li>
          <strong>Meta Platforms (WhatsApp Business Platform)</strong> — to deliver
          and receive WhatsApp messages.
        </li>
        <li>
          <strong>KYC &amp; e-signature providers</strong> (e.g. Decentro, DigiO) —
          for identity, PAN, Aadhaar, and bank verification and agreement signing.
        </li>
        <li>
          <strong>Payment provider</strong> (e.g. Razorpay) — to process payments.
        </li>
        <li>
          <strong>Cloud &amp; infrastructure providers</strong> — to host and
          secure data.
        </li>
        <li>
          <strong>Regulators, financing partners (NBFCs), and authorities</strong>{" "}
          — where required by law or to provide financing you request.
        </li>
      </ul>
      <p className="mt-3 leading-relaxed">
        We do not sell your personal information.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        4. Data Retention
      </h2>
      <p className="mt-3 leading-relaxed">
        We retain personal data for as long as needed to provide the Services and
        to comply with legal, tax, accounting, and regulatory requirements, after
        which it is deleted or anonymised.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        5. Data Security
      </h2>
      <p className="mt-3 leading-relaxed">
        We apply appropriate technical and organisational measures, including
        encryption in transit, access controls, and audit logging, to protect
        personal data against unauthorised access, alteration, or disclosure.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        6. Your Rights
      </h2>
      <p className="mt-3 leading-relaxed">
        Subject to applicable law, you may request access to, correction of, or
        deletion of your personal data, and you may withdraw consent for
        WhatsApp communications at any time by messaging{" "}
        <strong>STOP</strong> or contacting us. To exercise these rights, contact
        us using the details below.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        7. Contact Us
      </h2>
      <address className="mt-3 not-italic leading-relaxed">
        iTarang Technologies LLP
        <br />
        B103, 1st Floor, Unitech Business Tower
        <br />
        Gurugram, Haryana 122018, India
        <br />
        Email:{" "}
        <a className="text-sky-600 underline" href="mailto:it@itarang.com">
          it@itarang.com
        </a>
      </address>

      <p className="mt-10 text-sm text-slate-500">
        We may update this Privacy Policy from time to time. Changes take effect
        when posted on this page.
      </p>
    </main>
  );
}
