export type CompanyType =
  | "Sole Proprietorship"
  | "Partnership Firm"
  | "Private Limited Firm"

export interface DealerOnboardingForm {
  companyName: string
  companyType: CompanyType
  gstNumber: string
  panNumber: string
  address: string

  ownerName?: string
  ownerEmail?: string
  ownerPhone?: string

  partners?: Partner[]
  directors?: Director[]

  financeEnabled: boolean

  financeContactName?: string
  financeContactPhone?: string
  financeContactEmail?: string
}

export interface Partner {
  name: string
  email: string
  phone: string
}

export interface Director {
  name: string
  email: string
  phone: string
}