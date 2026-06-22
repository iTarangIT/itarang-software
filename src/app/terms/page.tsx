import type { Metadata } from "next";

// Public legal page — companion to /privacy. Meta asks for a Terms of Service
// URL alongside the Privacy Policy URL when taking an app Live. Renders without
// a session (anonymous requests fall through the auth middleware) so it returns
// HTTP 200 to Meta's validator.
//
// NOTE: Baseline terms reflecting current usage. Have legal review before relying
// on them.

export const metadata: Metadata = {
  title: "Terms of Service — iTarang",
  description:
    "Terms governing use of iTarang Technologies LLP's dealer CRM, KYC, and WhatsApp services.",
};

const LAST_UPDATED = "22 June 2026";

export default function TermsOfServicePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-slate-800">
      <h1 className="text-3xl font-bold text-slate-900">Terms of Service</h1>
      <p className="mt-2 text-sm text-slate-500">Last updated: {LAST_UPDATED}</p>

      <section className="mt-8 space-y-4 leading-relaxed">
        <p>
          These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and
          use of the dealer and customer management platform, website, web
          application, and WhatsApp-based services (the &ldquo;Services&rdquo;)
          provided by <strong>iTarang Technologies LLP</strong>{" "}
          (&ldquo;iTarang&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;). By using the
          Services, you agree to these Terms.
        </p>
      </section>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        1. Use of the Services
      </h2>
      <p className="mt-3 leading-relaxed">
        You may use the Services only for lawful business purposes and in
        accordance with these Terms. You are responsible for the accuracy of the
        information you provide and for maintaining the confidentiality of your
        account credentials.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        2. KYC &amp; Verification
      </h2>
      <p className="mt-3 leading-relaxed">
        Onboarding and certain features require identity, KYC, and bank
        verification carried out through us and our verification partners. You
        confirm that documents and details you submit are genuine and that you are
        authorised to share them.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        3. WhatsApp Communications
      </h2>
      <p className="mt-3 leading-relaxed">
        If you interact with us over WhatsApp, you consent to receive
        account-related and service messages there. You can opt out at any time by
        messaging <strong>STOP</strong>. Messaging is also subject to WhatsApp&rsquo;s
        own terms and policies.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        4. Payments &amp; Financing
      </h2>
      <p className="mt-3 leading-relaxed">
        Payments are processed through our payment partner, and any financing is
        provided by third-party financing partners (NBFCs) on their own terms.
        iTarang is not the lender and does not guarantee approval of any
        financing.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        5. Intellectual Property
      </h2>
      <p className="mt-3 leading-relaxed">
        The Services, including software, content, and trademarks, are owned by
        iTarang or its licensors and are protected by applicable laws. You may not
        copy, modify, or redistribute them without our written permission.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        6. Disclaimers &amp; Limitation of Liability
      </h2>
      <p className="mt-3 leading-relaxed">
        The Services are provided on an &ldquo;as is&rdquo; basis without
        warranties of any kind. To the maximum extent permitted by law, iTarang
        is not liable for any indirect, incidental, or consequential damages
        arising from your use of the Services.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        7. Changes to These Terms
      </h2>
      <p className="mt-3 leading-relaxed">
        We may update these Terms from time to time. Continued use of the Services
        after changes are posted constitutes acceptance of the updated Terms.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        8. Governing Law
      </h2>
      <p className="mt-3 leading-relaxed">
        These Terms are governed by the laws of India, and the courts at
        Gurugram, Haryana shall have exclusive jurisdiction over any disputes.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-slate-900">
        9. Contact Us
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
    </main>
  );
}
