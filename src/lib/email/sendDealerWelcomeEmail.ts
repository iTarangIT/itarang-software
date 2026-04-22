export type DealerWelcomeEmailPayload = {
  toEmail: string;
  dealerName: string;
  companyName: string;
  dealerId: string;
  userId: string;
  password: string;
  loginUrl: string;
  supportEmail: string;
  supportPhone: string;
};
// hello world

export async function sendDealerWelcomeEmail(
  payload: DealerWelcomeEmailPayload
) {
  const serviceId = process.env.EMAILJS_SERVICE_ID;
  const templateId = process.env.EMAILJS_TEMPLATE_ID;
  const publicKey = process.env.EMAILJS_PUBLIC_KEY;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;

  if (!serviceId || !templateId || !publicKey) {
    throw new Error(
      "Missing EmailJS environment variables: EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, or EMAILJS_PUBLIC_KEY"
    );
  }

  const requestBody: Record<string, unknown> = {
    service_id: serviceId,
    template_id: templateId,
    user_id: publicKey,
    template_params: {
      to_email: payload.toEmail,
      dealer_name: payload.dealerName,
      company_name: payload.companyName,
      dealer_id: payload.dealerId,
      user_id: payload.userId,
      password: payload.password,
      login_url: payload.loginUrl,
      support_email: payload.supportEmail,
      support_phone: payload.supportPhone,
    },
  };

  if (privateKey) {
    requestBody.accessToken = privateKey;
  }

  const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    cache: "no-store",
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`EmailJS send failed: ${response.status} ${responseText}`);
  }
  
  return {
    ok: true,
    responseText,
  };
}