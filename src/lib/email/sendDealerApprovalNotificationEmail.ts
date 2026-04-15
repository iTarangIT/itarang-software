export type DealerApprovalNotificationPayload = {
  toEmail: string;
  companyName: string;
  dealerCode: string;
  dealerName: string;
  approvedAt: string;
};

export async function sendDealerApprovalNotificationEmail(
  payload: DealerApprovalNotificationPayload
) {
  const serviceId = process.env.EMAILJS_SERVICE_ID;
  const templateId =
    process.env.EMAILJS_APPROVAL_NOTIFICATION_TEMPLATE_ID;
  const publicKey = process.env.EMAILJS_PUBLIC_KEY;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;

  if (!serviceId || !templateId || !publicKey) {
    throw new Error(
      "Missing EmailJS environment variables for approval notification"
    );
  }

  const requestBody: Record<string, unknown> = {
    service_id: serviceId,
    template_id: templateId,
    user_id: publicKey,
    template_params: {
      to_email: payload.toEmail,
      company_name: payload.companyName,
      dealer_code: payload.dealerCode,
      dealer_name: payload.dealerName,
      approved_at: payload.approvedAt,
    },
  };

  if (privateKey) {
    requestBody.accessToken = privateKey;
  }

  const response = await fetch(
    "https://api.emailjs.com/api/v1.0/email/send",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      cache: "no-store",
    }
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Approval notification send failed: ${response.status} ${responseText}`
    );
  }

  return {
    ok: true,
    responseText,
  };
}