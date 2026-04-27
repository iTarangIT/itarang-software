import { relations } from "drizzle-orm/relations";
import { leads, aiCallLogs, callSessions, callRecords, adminKycReviews, coBorrowers, users, coBorrowerRequests, consentRecords, accounts, couponBatches, dealerOnboardingApplications, dealerAgreementEvents, dealerAgreementSigners, dealerOnboardingDocuments, dealerSubscriptions, deals, conversationMessages, couponCodes, facilitationPayments, kycDocuments, documents, deployedAssets, deploymentHistory, kycVerifications, inventory, oems, products, loanDetails, loanFiles, loanPayments, productCategories, oemContacts, oemInventoryForPdi, personalDetails, orders, provisions, loanApplications, loanOffers, serviceTickets, scrapedDealerLeads, couponAuditLog, leadAssignments, coBorrowerDocuments, otherDocumentRequests, nbfcLoans, nbfcTenants, orderDisputes, riskCardRuns, riskHypotheses, afterSalesRecords, productSelections, loanSanctions, otpConfirmations, assignmentChangeLogs, leadDocuments, bolnaCalls, pdiRecords, campaignSegments, nbfcUsers } from "./schema";

export const aiCallLogsRelations = relations(aiCallLogs, ({one}) => ({
	lead: one(leads, {
		fields: [aiCallLogs.leadId],
		references: [leads.id]
	}),
}));

export const leadsRelations = relations(leads, ({one, many}) => ({
	aiCallLogs: many(aiCallLogs),
	adminKycReviews: many(adminKycReviews),
	coBorrowers: many(coBorrowers),
	coBorrowerRequests: many(coBorrowerRequests),
	callSessions: many(callSessions),
	consentRecords: many(consentRecords),
	deals: many(deals),
	couponCodes_reservedForLeadId: many(couponCodes, {
		relationName: "couponCodes_reservedForLeadId_leads_id"
	}),
	couponCodes_usedByLeadId: many(couponCodes, {
		relationName: "couponCodes_usedByLeadId_leads_id"
	}),
	facilitationPayments: many(facilitationPayments),
	kycDocuments: many(kycDocuments),
	documents: many(documents),
	kycVerifications: many(kycVerifications),
	deployedAssets: many(deployedAssets),
	loanDetails: many(loanDetails),
	account: one(accounts, {
		fields: [leads.dealerId],
		references: [accounts.id]
	}),
	product: one(products, {
		fields: [leads.primaryProductId],
		references: [products.id]
	}),
	personalDetails: many(personalDetails),
	loanFiles: many(loanFiles),
	loanOffers: many(loanOffers),
	scrapedDealerLeads: many(scrapedDealerLeads),
	couponAuditLogs: many(couponAuditLog),
	leadAssignments: many(leadAssignments),
	coBorrowerDocuments: many(coBorrowerDocuments),
	otherDocumentRequests: many(otherDocumentRequests),
	afterSalesRecords: many(afterSalesRecords),
	productSelections: many(productSelections),
	loanSanctions: many(loanSanctions),
	otpConfirmations: many(otpConfirmations),
	assignmentChangeLogs: many(assignmentChangeLogs),
	leadDocuments: many(leadDocuments),
	bolnaCalls: many(bolnaCalls),
	loanApplications: many(loanApplications),
}));

export const callRecordsRelations = relations(callRecords, ({one, many}) => ({
	callSession: one(callSessions, {
		fields: [callRecords.sessionId],
		references: [callSessions.id]
	}),
	conversationMessages: many(conversationMessages),
}));

export const callSessionsRelations = relations(callSessions, ({one, many}) => ({
	callRecords: many(callRecords),
	lead: one(leads, {
		fields: [callSessions.leadId],
		references: [leads.id]
	}),
}));

export const adminKycReviewsRelations = relations(adminKycReviews, ({one}) => ({
	lead: one(leads, {
		fields: [adminKycReviews.leadId],
		references: [leads.id]
	}),
}));

export const coBorrowersRelations = relations(coBorrowers, ({one, many}) => ({
	lead: one(leads, {
		fields: [coBorrowers.leadId],
		references: [leads.id]
	}),
	coBorrowerDocuments: many(coBorrowerDocuments),
}));

export const coBorrowerRequestsRelations = relations(coBorrowerRequests, ({one}) => ({
	user: one(users, {
		fields: [coBorrowerRequests.createdBy],
		references: [users.id]
	}),
	lead: one(leads, {
		fields: [coBorrowerRequests.leadId],
		references: [leads.id]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	coBorrowerRequests: many(coBorrowerRequests),
	consentRecords: many(consentRecords),
	otherDocumentRequests: many(otherDocumentRequests),
	nbfcUsers: many(nbfcUsers),
}));

export const consentRecordsRelations = relations(consentRecords, ({one}) => ({
	user: one(users, {
		fields: [consentRecords.adminViewedBy],
		references: [users.id]
	}),
	lead: one(leads, {
		fields: [consentRecords.leadId],
		references: [leads.id]
	}),
}));

export const couponBatchesRelations = relations(couponBatches, ({one, many}) => ({
	account: one(accounts, {
		fields: [couponBatches.dealerId],
		references: [accounts.id]
	}),
	couponCodes: many(couponCodes),
}));

export const accountsRelations = relations(accounts, ({many}) => ({
	couponBatches: many(couponBatches),
	dealerSubscriptions: many(dealerSubscriptions),
	couponCodes: many(couponCodes),
	deployedAssets: many(deployedAssets),
	inventories: many(inventory),
	leads: many(leads),
	orders: many(orders),
	loanFiles: many(loanFiles),
	serviceTickets: many(serviceTickets),
	loanApplications: many(loanApplications),
	campaignSegments: many(campaignSegments),
}));

export const dealerAgreementEventsRelations = relations(dealerAgreementEvents, ({one}) => ({
	dealerOnboardingApplication: one(dealerOnboardingApplications, {
		fields: [dealerAgreementEvents.applicationId],
		references: [dealerOnboardingApplications.id]
	}),
}));

export const dealerOnboardingApplicationsRelations = relations(dealerOnboardingApplications, ({many}) => ({
	dealerAgreementEvents: many(dealerAgreementEvents),
	dealerAgreementSigners: many(dealerAgreementSigners),
	dealerOnboardingDocuments: many(dealerOnboardingDocuments),
}));

export const dealerAgreementSignersRelations = relations(dealerAgreementSigners, ({one}) => ({
	dealerOnboardingApplication: one(dealerOnboardingApplications, {
		fields: [dealerAgreementSigners.applicationId],
		references: [dealerOnboardingApplications.id]
	}),
}));

export const dealerOnboardingDocumentsRelations = relations(dealerOnboardingDocuments, ({one}) => ({
	dealerOnboardingApplication: one(dealerOnboardingApplications, {
		fields: [dealerOnboardingDocuments.applicationId],
		references: [dealerOnboardingApplications.id]
	}),
}));

export const dealerSubscriptionsRelations = relations(dealerSubscriptions, ({one}) => ({
	account: one(accounts, {
		fields: [dealerSubscriptions.dealerId],
		references: [accounts.id]
	}),
}));

export const dealsRelations = relations(deals, ({one}) => ({
	lead: one(leads, {
		fields: [deals.leadId],
		references: [leads.id]
	}),
}));

export const conversationMessagesRelations = relations(conversationMessages, ({one}) => ({
	callRecord: one(callRecords, {
		fields: [conversationMessages.callRecordId],
		references: [callRecords.id]
	}),
}));

export const couponCodesRelations = relations(couponCodes, ({one, many}) => ({
	couponBatch: one(couponBatches, {
		fields: [couponCodes.batchId],
		references: [couponBatches.id]
	}),
	account: one(accounts, {
		fields: [couponCodes.dealerId],
		references: [accounts.id]
	}),
	lead_reservedForLeadId: one(leads, {
		fields: [couponCodes.reservedForLeadId],
		references: [leads.id],
		relationName: "couponCodes_reservedForLeadId_leads_id"
	}),
	lead_usedByLeadId: one(leads, {
		fields: [couponCodes.usedByLeadId],
		references: [leads.id],
		relationName: "couponCodes_usedByLeadId_leads_id"
	}),
	couponAuditLogs: many(couponAuditLog),
}));

export const facilitationPaymentsRelations = relations(facilitationPayments, ({one}) => ({
	lead: one(leads, {
		fields: [facilitationPayments.leadId],
		references: [leads.id]
	}),
}));

export const kycDocumentsRelations = relations(kycDocuments, ({one}) => ({
	lead: one(leads, {
		fields: [kycDocuments.leadId],
		references: [leads.id]
	}),
}));

export const documentsRelations = relations(documents, ({one}) => ({
	lead: one(leads, {
		fields: [documents.leadId],
		references: [leads.id]
	}),
}));

export const deploymentHistoryRelations = relations(deploymentHistory, ({one}) => ({
	deployedAsset: one(deployedAssets, {
		fields: [deploymentHistory.deployedAssetId],
		references: [deployedAssets.id]
	}),
}));

export const deployedAssetsRelations = relations(deployedAssets, ({one, many}) => ({
	deploymentHistories: many(deploymentHistory),
	account: one(accounts, {
		fields: [deployedAssets.dealerId],
		references: [accounts.id]
	}),
	inventory: one(inventory, {
		fields: [deployedAssets.inventoryId],
		references: [inventory.id]
	}),
	lead: one(leads, {
		fields: [deployedAssets.leadId],
		references: [leads.id]
	}),
	serviceTickets: many(serviceTickets),
}));

export const kycVerificationsRelations = relations(kycVerifications, ({one}) => ({
	lead: one(leads, {
		fields: [kycVerifications.leadId],
		references: [leads.id]
	}),
}));

export const inventoryRelations = relations(inventory, ({one, many}) => ({
	deployedAssets: many(deployedAssets),
	account: one(accounts, {
		fields: [inventory.dealerId],
		references: [accounts.id]
	}),
	oem: one(oems, {
		fields: [inventory.oemId],
		references: [oems.id]
	}),
	product: one(products, {
		fields: [inventory.productId],
		references: [products.id]
	}),
	oemInventoryForPdis: many(oemInventoryForPdi),
	pdiRecords: many(pdiRecords),
}));

export const oemsRelations = relations(oems, ({many}) => ({
	inventories: many(inventory),
	oemContacts: many(oemContacts),
	oemInventoryForPdis: many(oemInventoryForPdi),
	orders: many(orders),
	provisions: many(provisions),
}));

export const productsRelations = relations(products, ({one, many}) => ({
	inventories: many(inventory),
	leads: many(leads),
	productCategory: one(productCategories, {
		fields: [products.categoryId],
		references: [productCategories.id]
	}),
}));

export const loanDetailsRelations = relations(loanDetails, ({one}) => ({
	lead: one(leads, {
		fields: [loanDetails.leadId],
		references: [leads.id]
	}),
}));

export const loanPaymentsRelations = relations(loanPayments, ({one}) => ({
	loanFile: one(loanFiles, {
		fields: [loanPayments.loanFileId],
		references: [loanFiles.id]
	}),
}));

export const loanFilesRelations = relations(loanFiles, ({one, many}) => ({
	loanPayments: many(loanPayments),
	account: one(accounts, {
		fields: [loanFiles.dealerId],
		references: [accounts.id]
	}),
	lead: one(leads, {
		fields: [loanFiles.leadId],
		references: [leads.id]
	}),
	loanApplication: one(loanApplications, {
		fields: [loanFiles.loanApplicationId],
		references: [loanApplications.id]
	}),
}));

export const productCategoriesRelations = relations(productCategories, ({many}) => ({
	products: many(products),
}));

export const oemContactsRelations = relations(oemContacts, ({one}) => ({
	oem: one(oems, {
		fields: [oemContacts.oemId],
		references: [oems.id]
	}),
}));

export const oemInventoryForPdiRelations = relations(oemInventoryForPdi, ({one}) => ({
	inventory: one(inventory, {
		fields: [oemInventoryForPdi.inventoryId],
		references: [inventory.id]
	}),
	oem: one(oems, {
		fields: [oemInventoryForPdi.oemId],
		references: [oems.id]
	}),
}));

export const personalDetailsRelations = relations(personalDetails, ({one}) => ({
	lead: one(leads, {
		fields: [personalDetails.leadId],
		references: [leads.id]
	}),
}));

export const ordersRelations = relations(orders, ({one, many}) => ({
	account: one(accounts, {
		fields: [orders.accountId],
		references: [accounts.id]
	}),
	oem: one(oems, {
		fields: [orders.oemId],
		references: [oems.id]
	}),
	provision: one(provisions, {
		fields: [orders.provisionId],
		references: [provisions.id]
	}),
	orderDisputes: many(orderDisputes),
}));

export const provisionsRelations = relations(provisions, ({one, many}) => ({
	orders: many(orders),
	oem: one(oems, {
		fields: [provisions.oemId],
		references: [oems.id]
	}),
}));

export const loanApplicationsRelations = relations(loanApplications, ({one, many}) => ({
	loanFiles: many(loanFiles),
	nbfcLoans: many(nbfcLoans),
	account: one(accounts, {
		fields: [loanApplications.dealerId],
		references: [accounts.id]
	}),
	lead: one(leads, {
		fields: [loanApplications.leadId],
		references: [leads.id]
	}),
}));

export const loanOffersRelations = relations(loanOffers, ({one}) => ({
	lead: one(leads, {
		fields: [loanOffers.leadId],
		references: [leads.id]
	}),
}));

export const serviceTicketsRelations = relations(serviceTickets, ({one}) => ({
	account: one(accounts, {
		fields: [serviceTickets.dealerId],
		references: [accounts.id]
	}),
	deployedAsset: one(deployedAssets, {
		fields: [serviceTickets.deployedAssetId],
		references: [deployedAssets.id]
	}),
}));

export const scrapedDealerLeadsRelations = relations(scrapedDealerLeads, ({one}) => ({
	lead: one(leads, {
		fields: [scrapedDealerLeads.convertedLeadId],
		references: [leads.id]
	}),
}));

export const couponAuditLogRelations = relations(couponAuditLog, ({one}) => ({
	couponCode: one(couponCodes, {
		fields: [couponAuditLog.couponId],
		references: [couponCodes.id]
	}),
	lead: one(leads, {
		fields: [couponAuditLog.leadId],
		references: [leads.id]
	}),
}));

export const leadAssignmentsRelations = relations(leadAssignments, ({one}) => ({
	lead: one(leads, {
		fields: [leadAssignments.leadId],
		references: [leads.id]
	}),
}));

export const coBorrowerDocumentsRelations = relations(coBorrowerDocuments, ({one}) => ({
	coBorrower: one(coBorrowers, {
		fields: [coBorrowerDocuments.coBorrowerId],
		references: [coBorrowers.id]
	}),
	lead: one(leads, {
		fields: [coBorrowerDocuments.leadId],
		references: [leads.id]
	}),
}));

export const otherDocumentRequestsRelations = relations(otherDocumentRequests, ({one}) => ({
	lead: one(leads, {
		fields: [otherDocumentRequests.leadId],
		references: [leads.id]
	}),
	user: one(users, {
		fields: [otherDocumentRequests.reviewedBy],
		references: [users.id]
	}),
}));

export const nbfcLoansRelations = relations(nbfcLoans, ({one}) => ({
	loanApplication: one(loanApplications, {
		fields: [nbfcLoans.loanApplicationId],
		references: [loanApplications.id]
	}),
	nbfcTenant: one(nbfcTenants, {
		fields: [nbfcLoans.tenantId],
		references: [nbfcTenants.id]
	}),
}));

export const nbfcTenantsRelations = relations(nbfcTenants, ({many}) => ({
	nbfcLoans: many(nbfcLoans),
	riskCardRuns: many(riskCardRuns),
	nbfcUsers: many(nbfcUsers),
}));

export const orderDisputesRelations = relations(orderDisputes, ({one}) => ({
	order: one(orders, {
		fields: [orderDisputes.orderId],
		references: [orders.id]
	}),
}));

export const riskCardRunsRelations = relations(riskCardRuns, ({one}) => ({
	nbfcTenant: one(nbfcTenants, {
		fields: [riskCardRuns.tenantId],
		references: [nbfcTenants.id]
	}),
	riskHypothesis: one(riskHypotheses, {
		fields: [riskCardRuns.hypothesisId],
		references: [riskHypotheses.id]
	}),
}));

export const riskHypothesesRelations = relations(riskHypotheses, ({many}) => ({
	riskCardRuns: many(riskCardRuns),
}));

export const afterSalesRecordsRelations = relations(afterSalesRecords, ({one}) => ({
	lead: one(leads, {
		fields: [afterSalesRecords.leadId],
		references: [leads.id]
	}),
}));

export const productSelectionsRelations = relations(productSelections, ({one}) => ({
	lead: one(leads, {
		fields: [productSelections.leadId],
		references: [leads.id]
	}),
}));

export const loanSanctionsRelations = relations(loanSanctions, ({one}) => ({
	lead: one(leads, {
		fields: [loanSanctions.leadId],
		references: [leads.id]
	}),
}));

export const otpConfirmationsRelations = relations(otpConfirmations, ({one}) => ({
	lead: one(leads, {
		fields: [otpConfirmations.leadId],
		references: [leads.id]
	}),
}));

export const assignmentChangeLogsRelations = relations(assignmentChangeLogs, ({one}) => ({
	lead: one(leads, {
		fields: [assignmentChangeLogs.leadId],
		references: [leads.id]
	}),
}));

export const leadDocumentsRelations = relations(leadDocuments, ({one}) => ({
	lead: one(leads, {
		fields: [leadDocuments.leadId],
		references: [leads.id]
	}),
}));

export const bolnaCallsRelations = relations(bolnaCalls, ({one}) => ({
	lead: one(leads, {
		fields: [bolnaCalls.leadId],
		references: [leads.id]
	}),
}));

export const pdiRecordsRelations = relations(pdiRecords, ({one}) => ({
	inventory: one(inventory, {
		fields: [pdiRecords.inventoryId],
		references: [inventory.id]
	}),
}));

export const campaignSegmentsRelations = relations(campaignSegments, ({one}) => ({
	account: one(accounts, {
		fields: [campaignSegments.dealerId],
		references: [accounts.id]
	}),
}));

export const nbfcUsersRelations = relations(nbfcUsers, ({one}) => ({
	user: one(users, {
		fields: [nbfcUsers.userId],
		references: [users.id]
	}),
	nbfcTenant: one(nbfcTenants, {
		fields: [nbfcUsers.tenantId],
		references: [nbfcTenants.id]
	}),
}));