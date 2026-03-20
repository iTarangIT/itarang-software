import { DealerOnboardingState } from "./onboardingTypes";

const GST_REGEX =
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
const PHONE_REGEX = /^[6-9]\d{9}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PINCODE_REGEX = /^\d{6}$/;

export function validateStep(
  state: DealerOnboardingState
): Record<string, string> {
  const errors: Record<string, string> = {};

  if (state.step === 1) {
    if (!state.company.companyName.trim()) {
      errors.companyName = "Company name is required";
    }

    if (!state.company.companyAddress.trim()) {
      errors.companyAddress = "Company address is required";
    }

    if (!state.company.companyType) {
      errors.companyType = "Company type is required";
    }

    if (!state.company.gstNumber.trim()) {
      errors.gstNumber = "GST number is required";
    } else if (!GST_REGEX.test(state.company.gstNumber.trim().toUpperCase())) {
      errors.gstNumber = "Enter a valid GST number";
    }

    if (!state.company.companyPanNumber.trim()) {
      errors.companyPanNumber = "Company PAN is required";
    } else if (
      !PAN_REGEX.test(state.company.companyPanNumber.trim().toUpperCase())
    ) {
      errors.companyPanNumber = "Enter a valid PAN number";
    }

    if (!state.company.businessSummary?.trim()) {
      errors.businessSummary = "Business details summary is required";
    }

    if (!state.company.gstCertificate?.file) {
      errors.gstCertificate = "Upload GST certificate";
    }

    if (!state.company.companyPanFile?.file) {
      errors.companyPanFile = "Upload company PAN";
    }
  }

  if (state.step === 2) {
    if (!state.compliance.itr3Years?.file) {
      errors.itr3Years = "Upload last 3 years ITR";
    }

    if (!state.compliance.bankStatement3Months?.file) {
      errors.bankStatement3Months = "Upload last 3 months bank statement";
    }

    if (!state.compliance.undatedCheques?.file) {
      errors.undatedCheques = "Upload undated cheques";
    }

    if (!state.compliance.passportPhoto?.file) {
      errors.passportPhoto = "Upload passport size photograph";
    }

    if (!state.compliance.udyamCertificate?.file) {
      errors.udyamCertificate = "Upload Udyam registration certificate";
    }
  }

  if (state.step === 3) {
    if (state.company.companyType === "sole_proprietorship") {
      if (!state.ownership.ownerName.trim()) {
        errors.ownerName = "Owner name is required";
      }

      if (!PHONE_REGEX.test(state.ownership.ownerPhone || "")) {
        errors.ownerPhone = "Enter valid owner phone";
      }

      if (!EMAIL_REGEX.test(state.ownership.ownerEmail || "")) {
        errors.ownerEmail = "Enter valid owner email";
      }

      if (!state.ownership.ownerAge?.trim()) {
        errors.ownerAge = "Owner age is required";
      }

      if (!state.ownership.ownerPhoto?.file) {
        errors.ownerPhoto = "Upload owner photograph";
      }

      if (!state.ownership.ownerAddressLine1?.trim()) {
        errors.ownerAddressLine1 = "Owner address line 1 is required";
      }

      if (!state.ownership.ownerCity?.trim()) {
        errors.ownerCity = "Owner city is required";
      }

      if (!state.ownership.ownerDistrict?.trim()) {
        errors.ownerDistrict = "Owner district is required";
      }

      if (!state.ownership.ownerState?.trim()) {
        errors.ownerState = "Owner state is required";
      }

      if (!PINCODE_REGEX.test(state.ownership.ownerPinCode || "")) {
        errors.ownerPinCode = "Enter valid owner pin code";
      }
    }

    if (state.company.companyType === "partnership_firm") {
      if (!state.ownership.partnershipDeed?.file) {
        errors.partnershipDeed = "Upload partnership deed";
      }

      if (state.ownership.partners.length === 0) {
        errors.partners = "Add at least one partner";
      }

      state.ownership.partners.forEach((partner, index) => {
        if (!partner.name?.trim()) {
          errors[`partner_name_${index}`] = "Partner name required";
        }

        if (!PHONE_REGEX.test(partner.phone || "")) {
          errors[`partner_phone_${index}`] = "Valid partner phone required";
        }

        if (!EMAIL_REGEX.test(partner.email || "")) {
          errors[`partner_email_${index}`] = "Valid partner email required";
        }

        if (!partner.age?.trim()) {
          errors[`partner_age_${index}`] = "Partner age required";
        }

        if (!partner.photo?.file) {
          errors[`partner_photo_${index}`] = "Partner photograph required";
        }

        if (!partner.addressLine1?.trim()) {
          errors[`partner_addressLine1_${index}`] =
            "Partner address line 1 required";
        }

        if (!partner.city?.trim()) {
          errors[`partner_city_${index}`] = "Partner city required";
        }

        if (!partner.district?.trim()) {
          errors[`partner_district_${index}`] = "Partner district required";
        }

        if (!partner.state?.trim()) {
          errors[`partner_state_${index}`] = "Partner state required";
        }

        if (!PINCODE_REGEX.test(partner.pinCode || "")) {
          errors[`partner_pinCode_${index}`] = "Valid partner pin code required";
        }
      });
    }

    if (state.company.companyType === "private_limited_firm") {
      if (!state.ownership.mouDocument?.file) {
        errors.mouDocument = "Upload MoU";
      }

      if (!state.ownership.aoaDocument?.file) {
        errors.aoaDocument = "Upload AoA";
      }

      if (state.ownership.directors.length === 0) {
        errors.directors = "Add at least one director";
      }

      state.ownership.directors.forEach((director, index) => {
        if (!director.name?.trim()) {
          errors[`director_name_${index}`] = "Director name required";
        }

        if (!PHONE_REGEX.test(director.phone || "")) {
          errors[`director_phone_${index}`] = "Valid director phone required";
        }

        if (!EMAIL_REGEX.test(director.email || "")) {
          errors[`director_email_${index}`] = "Valid director email required";
        }

        if (!director.age?.trim()) {
          errors[`director_age_${index}`] = "Director age required";
        }

        if (!director.photo?.file) {
          errors[`director_photo_${index}`] = "Director photograph required";
        }

        if (!director.addressLine1?.trim()) {
          errors[`director_addressLine1_${index}`] =
            "Director address line 1 required";
        }

        if (!director.city?.trim()) {
          errors[`director_city_${index}`] = "Director city required";
        }

        if (!director.district?.trim()) {
          errors[`director_district_${index}`] = "Director district required";
        }

        if (!director.state?.trim()) {
          errors[`director_state_${index}`] = "Director state required";
        }

        if (!PINCODE_REGEX.test(director.pinCode || "")) {
          errors[`director_pinCode_${index}`] =
            "Valid director pin code required";
        }
      });
    }

    if (!state.ownership.bankName.trim()) {
      errors.bankName = "Bank name is required";
    } else if (!/^[A-Za-z\s]+$/.test(state.ownership.bankName.trim())) {
      errors.bankName = "Bank name must be alphabetic";
    }

    if (!state.ownership.accountNumber.trim()) {
      errors.accountNumber = "Account number is required";
    } else if (!/^\d+$/.test(state.ownership.accountNumber.trim())) {
      errors.accountNumber = "Account number must be numeric";
    }

    if (!state.ownership.ifsc.trim()) {
      errors.ifsc = "IFSC is required";
    } else if (!IFSC_REGEX.test(state.ownership.ifsc.trim().toUpperCase())) {
      errors.ifsc = "Enter a valid IFSC";
    }

    if (!state.ownership.beneficiaryName.trim()) {
      errors.beneficiaryName = "Beneficiary name is required";
    }

    if (!state.ownership.branch?.trim()) {
      errors.branch = "Branch is required";
    }

    if (!state.ownership.accountType?.trim()) {
      errors.accountType = "Account type is required";
    }
  }

  if (state.step === 4) {
    if (!state.finance.enableFinance) {
      errors.enableFinance = "Choose finance preference";
    }

    if (
      state.finance.financeContactPhone.trim() &&
      !PHONE_REGEX.test(state.finance.financeContactPhone.trim())
    ) {
      errors.financeContactPhone = "Valid finance contact phone required";
    }

    if (
      state.finance.financeContactEmail.trim() &&
      !EMAIL_REGEX.test(state.finance.financeContactEmail.trim())
    ) {
      errors.financeContactEmail = "Valid finance contact email required";
    }
  }

  if (state.step === 5 && state.finance.enableFinance === "yes") {
    if (!state.agreement.dateOfSigning.trim()) {
      errors.dateOfSigning = "Date of signing is required";
    }

    if (!state.agreement.expiryDays || state.agreement.expiryDays <= 0) {
      errors.expiryDays = "Expiry days must be greater than 0";
    }

    if (!state.agreement.dealerSignerName.trim()) {
      errors.dealerSignerName = "Dealer signatory name is required";
    }

    if (!state.agreement.dealerSignerDesignation.trim()) {
      errors.dealerSignerDesignation = "Dealer signatory designation is required";
    }

    if (!state.agreement.dealerSignerEmail.trim()) {
      errors.dealerSignerEmail = "Dealer signatory email is required";
    } else if (!EMAIL_REGEX.test(state.agreement.dealerSignerEmail.trim())) {
      errors.dealerSignerEmail = "Enter a valid dealer signatory email";
    }

    if (!state.agreement.dealerSignerPhone.trim()) {
      errors.dealerSignerPhone = "Dealer signatory phone is required";
    } else if (!PHONE_REGEX.test(state.agreement.dealerSignerPhone.trim())) {
      errors.dealerSignerPhone = "Enter a valid dealer signatory phone";
    }

    if (!state.agreement.dealerSigningMethod) {
      errors.dealerSigningMethod = "Dealer signing method is required";
    }

    if (!state.agreement.financierName.trim()) {
      errors.financierName = "Financier name is required";
    }

    if (!state.agreement.itarangSignatory1.name.trim()) {
      errors.itarangSignatory1_name = "iTarang signatory 1 name is required";
    }

    if (!state.agreement.itarangSignatory1.designation.trim()) {
      errors.itarangSignatory1_designation =
        "iTarang signatory 1 designation is required";
    }

    if (!state.agreement.itarangSignatory1.email.trim()) {
      errors.itarangSignatory1_email = "iTarang signatory 1 email is required";
    } else if (!EMAIL_REGEX.test(state.agreement.itarangSignatory1.email.trim())) {
      errors.itarangSignatory1_email = "Enter a valid iTarang signatory 1 email";
    }

    if (!state.agreement.itarangSignatory1.mobile.trim()) {
      errors.itarangSignatory1_mobile = "iTarang signatory 1 mobile is required";
    } else if (!PHONE_REGEX.test(state.agreement.itarangSignatory1.mobile.trim())) {
      errors.itarangSignatory1_mobile = "Enter a valid iTarang signatory 1 mobile";
    }

    if (!state.agreement.itarangSignatory1.signingMethod) {
      errors.itarangSignatory1_signingMethod =
        "iTarang signatory 1 signing method is required";
    }

    if (!state.agreement.itarangSignatory2.name.trim()) {
      errors.itarangSignatory2_name = "iTarang signatory 2 name is required";
    }

    if (!state.agreement.itarangSignatory2.designation.trim()) {
      errors.itarangSignatory2_designation =
        "iTarang signatory 2 designation is required";
    }

    if (!state.agreement.itarangSignatory2.email.trim()) {
      errors.itarangSignatory2_email = "iTarang signatory 2 email is required";
    } else if (!EMAIL_REGEX.test(state.agreement.itarangSignatory2.email.trim())) {
      errors.itarangSignatory2_email = "Enter a valid iTarang signatory 2 email";
    }

    if (!state.agreement.itarangSignatory2.mobile.trim()) {
      errors.itarangSignatory2_mobile = "iTarang signatory 2 mobile is required";
    } else if (!PHONE_REGEX.test(state.agreement.itarangSignatory2.mobile.trim())) {
      errors.itarangSignatory2_mobile = "Enter a valid iTarang signatory 2 mobile";
    }

    if (!state.agreement.itarangSignatory2.signingMethod) {
      errors.itarangSignatory2_signingMethod =
        "iTarang signatory 2 signing method is required";
    }

    if (!state.agreement.financierSignatory.name.trim()) {
      errors.financierSignatory_name = "Financier signatory name is required";
    }

    if (!state.agreement.financierSignatory.designation.trim()) {
      errors.financierSignatory_designation =
        "Financier signatory designation is required";
    }

    if (!state.agreement.financierSignatory.email.trim()) {
      errors.financierSignatory_email = "Financier signatory email is required";
    } else if (
      !EMAIL_REGEX.test(state.agreement.financierSignatory.email.trim())
    ) {
      errors.financierSignatory_email =
        "Enter a valid financier signatory email";
    }

    if (!state.agreement.financierSignatory.mobile.trim()) {
      errors.financierSignatory_mobile = "Financier signatory mobile is required";
    } else if (
      !PHONE_REGEX.test(state.agreement.financierSignatory.mobile.trim())
    ) {
      errors.financierSignatory_mobile =
        "Enter a valid financier signatory mobile";
    }

    if (!state.agreement.financierSignatory.address.trim()) {
      errors.financierSignatory_address =
        "Financier signatory address is required";
    }

    if (!state.agreement.financierSignatory.signingMethod) {
      errors.financierSignatory_signingMethod =
        "Financier signatory signing method is required";
    }

    if (state.agreement.includeWitnessesInSigning) {
      if (!state.agreement.witness1.name.trim()) {
        errors.witness1_name = "Witness 1 name is required";
      }

      if (!state.agreement.witness1.designation.trim()) {
        errors.witness1_designation = "Witness 1 designation is required";
      }

      if (!state.agreement.witness1.email.trim()) {
        errors.witness1_email = "Witness 1 email is required";
      } else if (!EMAIL_REGEX.test(state.agreement.witness1.email.trim())) {
        errors.witness1_email = "Enter a valid witness 1 email";
      }

      if (!state.agreement.witness1.mobile.trim()) {
        errors.witness1_mobile = "Witness 1 mobile is required";
      } else if (!PHONE_REGEX.test(state.agreement.witness1.mobile.trim())) {
        errors.witness1_mobile = "Enter a valid witness 1 mobile";
      }

      if (!state.agreement.witness1.address.trim()) {
        errors.witness1_address = "Witness 1 address is required";
      }

      if (!state.agreement.witness1.signingMethod) {
        errors.witness1_signingMethod = "Witness 1 signing method is required";
      }

      if (!state.agreement.witness2.name.trim()) {
        errors.witness2_name = "Witness 2 name is required";
      }

      if (!state.agreement.witness2.designation.trim()) {
        errors.witness2_designation = "Witness 2 designation is required";
      }

      if (!state.agreement.witness2.email.trim()) {
        errors.witness2_email = "Witness 2 email is required";
      } else if (!EMAIL_REGEX.test(state.agreement.witness2.email.trim())) {
        errors.witness2_email = "Enter a valid witness 2 email";
      }

      if (!state.agreement.witness2.mobile.trim()) {
        errors.witness2_mobile = "Witness 2 mobile is required";
      } else if (!PHONE_REGEX.test(state.agreement.witness2.mobile.trim())) {
        errors.witness2_mobile = "Enter a valid witness 2 mobile";
      }

      if (!state.agreement.witness2.address.trim()) {
        errors.witness2_address = "Witness 2 address is required";
      }

      if (!state.agreement.witness2.signingMethod) {
        errors.witness2_signingMethod = "Witness 2 signing method is required";
      }
    }
  }

  if (state.step === 6) {
    if (!state.reviewChecks.confirmInfo) {
      errors.confirmInfo = "Please confirm information accuracy";
    }

    if (!state.reviewChecks.confirmDocs) {
      errors.confirmDocs = "Please confirm document validity";
    }

    if (!state.reviewChecks.agreeTerms) {
      errors.agreeTerms = "Please agree to onboarding terms";
    }
  }

  return errors;
}