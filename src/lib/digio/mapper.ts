export function buildDigioPayload(data: any) {
  return {
    template_id: process.env.DIGIO_TEMPLATE_ID,

    signers: [
      {
        name: data.dealer.name,
        email: data.dealer.email,
        mobile: data.dealer.mobile,
        sequence: 1,
      },
      {
        name: data.financier.name,
        email: data.financier.email,
        mobile: data.financier.mobile,
        sequence: 2,
      },
      {
        name: data.itarang1.name,
        email: data.itarang1.email,
        mobile: data.itarang1.mobile,
        sequence: 3,
      },
      {
        name: data.itarang2.name,
        email: data.itarang2.email,
        mobile: data.itarang2.mobile,
        sequence: 4,
      },
    ],

    variables: {
      company_name: data.companyName,
      gst_number: data.gst,
      company_address: data.address,

      dealer_signatory_name: data.dealer.name,

      financier_name: data.financier.name,

      witness1_name: data.witness1.name,
      witness2_name: data.witness2.name,
    },
  };
}