import { relations } from "drizzle-orm/relations";
import { leads, loanOffers, loanApplications, accounts, loanDetails, loanFiles, leadDocuments, loanPayments, leadAssignments, products, otherDocumentRequests, inventory, oemInventoryForPdi, oems, orders, orderDisputes, provisions, pdiRecords, scrapedDealerLeads, personalDetails, deployedAssets, serviceTickets, campaignSegments, callSessions, callRecords, aiCallLogs, bolnaCalls, coBorrowers, coBorrowerDocuments, adminKycReviews, assignmentChangeLogs, couponBatches, dealerOnboardingApplications, dealerAgreementEvents, dealerAgreementSigners, deals, conversationMessages, deploymentHistory, dealerSubscriptions, consentRecords, documents, couponCodes, dealerOnboardingDocuments, oemContacts, kycDocuments, kycVerifications, productCategories, facilitationPayments } from "./schema";

export const loanOffersRelations = relations(loanOffers, ({one}) => ({
	lead: one(leads, {
		fields: [loanOffers.leadId],
		references: [leads.id]
	}),
}));

export const leadsRelations = relations(leads, ({one, many}) => ({
	loanOffers: many(loanOffers),
	loanApplications: many(loanApplications),
	loanDetails: many(loanDetails),
	loanFiles: many(loanFiles),
	leadDocuments: many(leadDocuments),
	leadAssignments: many(leadAssignments),
	account: one(accounts, {
		fields: [leads.dealerId],
		references: [accounts.id]
	}),
	product: one(products, {
		fields: [leads.primaryProductId],
		references: [products.id]
	}),
	otherDocumentRequests: many(otherDocumentRequests),
	scrapedDealerLeads: many(scrapedDealerLeads),
	personalDetails: many(personalDetails),
	callSessions: many(callSessions),
	aiCallLogs: many(aiCallLogs),
	bolnaCalls: many(bolnaCalls),
	coBorrowers: many(coBorrowers),
	coBorrowerDocuments: many(coBorrowerDocuments),
	adminKycReviews: many(adminKycReviews),
	assignmentChangeLogs: many(assignmentChangeLogs),
	deployedAssets: many(deployedAssets),
	deals: many(deals),
	consentRecords: many(consentRecords),
	documents: many(documents),
	couponCodes_usedByLeadId: many(couponCodes, {
		relationName: "couponCodes_usedByLeadId_leads_id"
	}),
	couponCodes_reservedForLeadId: many(couponCodes, {
		relationName: "couponCodes_reservedForLeadId_leads_id"
	}),
	kycDocuments: many(kycDocuments),
	kycVerifications: many(kycVerifications),
	facilitationPayments: many(facilitationPayments),
}));

export const loanApplicationsRelations = relations(loanApplications, ({one, many}) => ({
	lead: one(leads, {
		fields: [loanApplications.leadId],
		references: [leads.id]
	}),
	account: one(accounts, {
		fields: [loanApplications.dealerId],
		references: [accounts.id]
	}),
	loanFiles: many(loanFiles),
}));

export const accountsRelations = relations(accounts, ({many}) => ({
	loanApplications: many(loanApplications),
	loanFiles: many(loanFiles),
	leads: many(leads),
	orders: many(orders),
	serviceTickets: many(serviceTickets),
	campaignSegments: many(campaignSegments),
	deployedAssets: many(deployedAssets),
	couponBatches: many(couponBatches),
	dealerSubscriptions: many(dealerSubscriptions),
	couponCodes: many(couponCodes),
	inventories: many(inventory),
}));

export const loanDetailsRelations = relations(loanDetails, ({one}) => ({
	lead: one(leads, {
		fields: [loanDetails.leadId],
		references: [leads.id]
	}),
}));

export const loanFilesRelations = relations(loanFiles, ({one, many}) => ({
	lead: one(leads, {
		fields: [loanFiles.leadId],
		references: [leads.id]
	}),
	loanApplication: one(loanApplications, {
		fields: [loanFiles.loanApplicationId],
		references: [loanApplications.id]
	}),
	account: one(accounts, {
		fields: [loanFiles.dealerId],
		references: [accounts.id]
	}),
	loanPayments: many(loanPayments),
}));

export const leadDocumentsRelations = relations(leadDocuments, ({one}) => ({
	lead: one(leads, {
		fields: [leadDocuments.leadId],
		references: [leads.id]
	}),
}));

export const loanPaymentsRelations = relations(loanPayments, ({one}) => ({
	loanFile: one(loanFiles, {
		fields: [loanPayments.loanFileId],
		references: [loanFiles.id]
	}),
}));

export const leadAssignmentsRelations = relations(leadAssignments, ({one}) => ({
	lead: one(leads, {
		fields: [leadAssignments.leadId],
		references: [leads.id]
	}),
}));

export const productsRelations = relations(products, ({one, many}) => ({
	leads: many(leads),
	inventories: many(inventory),
	productCategory: one(productCategories, {
		fields: [products.categoryId],
		references: [productCategories.id]
	}),
}));

export const otherDocumentRequestsRelations = relations(otherDocumentRequests, ({one}) => ({
	lead: one(leads, {
		fields: [otherDocumentRequests.leadId],
		references: [leads.id]
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

export const inventoryRelations = relations(inventory, ({one, many}) => ({
	oemInventoryForPdis: many(oemInventoryForPdi),
	pdiRecords: many(pdiRecords),
	deployedAssets: many(deployedAssets),
	oem: one(oems, {
		fields: [inventory.oemId],
		references: [oems.id]
	}),
	account: one(accounts, {
		fields: [inventory.dealerId],
		references: [accounts.id]
	}),
	product: one(products, {
		fields: [inventory.productId],
		references: [products.id]
	}),
}));

export const oemsRelations = relations(oems, ({many}) => ({
	oemInventoryForPdis: many(oemInventoryForPdi),
	orders: many(orders),
	provisions: many(provisions),
	oemContacts: many(oemContacts),
	inventories: many(inventory),
}));

export const orderDisputesRelations = relations(orderDisputes, ({one}) => ({
	order: one(orders, {
		fields: [orderDisputes.orderId],
		references: [orders.id]
	}),
}));

export const ordersRelations = relations(orders, ({one, many}) => ({
	orderDisputes: many(orderDisputes),
	provision: one(provisions, {
		fields: [orders.provisionId],
		references: [provisions.id]
	}),
	oem: one(oems, {
		fields: [orders.oemId],
		references: [oems.id]
	}),
	account: one(accounts, {
		fields: [orders.accountId],
		references: [accounts.id]
	}),
}));

export const provisionsRelations = relations(provisions, ({one, many}) => ({
	orders: many(orders),
	oem: one(oems, {
		fields: [provisions.oemId],
		references: [oems.id]
	}),
}));

export const pdiRecordsRelations = relations(pdiRecords, ({one}) => ({
	inventory: one(inventory, {
		fields: [pdiRecords.inventoryId],
		references: [inventory.id]
	}),
}));

export const scrapedDealerLeadsRelations = relations(scrapedDealerLeads, ({one}) => ({
	lead: one(leads, {
		fields: [scrapedDealerLeads.convertedLeadId],
		references: [leads.id]
	}),
}));

export const personalDetailsRelations = relations(personalDetails, ({one}) => ({
	lead: one(leads, {
		fields: [personalDetails.leadId],
		references: [leads.id]
	}),
}));

export const serviceTicketsRelations = relations(serviceTickets, ({one}) => ({
	deployedAsset: one(deployedAssets, {
		fields: [serviceTickets.deployedAssetId],
		references: [deployedAssets.id]
	}),
	account: one(accounts, {
		fields: [serviceTickets.dealerId],
		references: [accounts.id]
	}),
}));

export const deployedAssetsRelations = relations(deployedAssets, ({one, many}) => ({
	serviceTickets: many(serviceTickets),
	inventory: one(inventory, {
		fields: [deployedAssets.inventoryId],
		references: [inventory.id]
	}),
	lead: one(leads, {
		fields: [deployedAssets.leadId],
		references: [leads.id]
	}),
	account: one(accounts, {
		fields: [deployedAssets.dealerId],
		references: [accounts.id]
	}),
	deploymentHistories: many(deploymentHistory),
}));

export const campaignSegmentsRelations = relations(campaignSegments, ({one}) => ({
	account: one(accounts, {
		fields: [campaignSegments.dealerId],
		references: [accounts.id]
	}),
}));

export const callSessionsRelations = relations(callSessions, ({one, many}) => ({
	lead: one(leads, {
		fields: [callSessions.leadId],
		references: [leads.id]
	}),
	callRecords: many(callRecords),
	aiCallLogs: many(aiCallLogs),
}));

export const callRecordsRelations = relations(callRecords, ({one, many}) => ({
	callSession: one(callSessions, {
		fields: [callRecords.sessionId],
		references: [callSessions.id]
	}),
	conversationMessages: many(conversationMessages),
}));

export const aiCallLogsRelations = relations(aiCallLogs, ({one}) => ({
	lead: one(leads, {
		fields: [aiCallLogs.leadId],
		references: [leads.id]
	}),
	callSession: one(callSessions, {
		fields: [aiCallLogs.callSessionId],
		references: [callSessions.id]
	}),
}));

export const bolnaCallsRelations = relations(bolnaCalls, ({one}) => ({
	lead: one(leads, {
		fields: [bolnaCalls.leadId],
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

export const coBorrowerDocumentsRelations = relations(coBorrowerDocuments, ({one}) => ({
	lead: one(leads, {
		fields: [coBorrowerDocuments.leadId],
		references: [leads.id]
	}),
	coBorrower: one(coBorrowers, {
		fields: [coBorrowerDocuments.coBorrowerId],
		references: [coBorrowers.id]
	}),
}));

export const adminKycReviewsRelations = relations(adminKycReviews, ({one}) => ({
	lead: one(leads, {
		fields: [adminKycReviews.leadId],
		references: [leads.id]
	}),
}));

export const assignmentChangeLogsRelations = relations(assignmentChangeLogs, ({one}) => ({
	lead: one(leads, {
		fields: [assignmentChangeLogs.leadId],
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

export const deploymentHistoryRelations = relations(deploymentHistory, ({one}) => ({
	deployedAsset: one(deployedAssets, {
		fields: [deploymentHistory.deployedAssetId],
		references: [deployedAssets.id]
	}),
}));

export const dealerSubscriptionsRelations = relations(dealerSubscriptions, ({one}) => ({
	account: one(accounts, {
		fields: [dealerSubscriptions.dealerId],
		references: [accounts.id]
	}),
}));

export const consentRecordsRelations = relations(consentRecords, ({one}) => ({
	lead: one(leads, {
		fields: [consentRecords.leadId],
		references: [leads.id]
	}),
}));

export const documentsRelations = relations(documents, ({one}) => ({
	lead: one(leads, {
		fields: [documents.leadId],
		references: [leads.id]
	}),
}));

export const couponCodesRelations = relations(couponCodes, ({one}) => ({
	account: one(accounts, {
		fields: [couponCodes.dealerId],
		references: [accounts.id]
	}),
	lead_usedByLeadId: one(leads, {
		fields: [couponCodes.usedByLeadId],
		references: [leads.id],
		relationName: "couponCodes_usedByLeadId_leads_id"
	}),
	couponBatch: one(couponBatches, {
		fields: [couponCodes.batchId],
		references: [couponBatches.id]
	}),
	lead_reservedForLeadId: one(leads, {
		fields: [couponCodes.reservedForLeadId],
		references: [leads.id],
		relationName: "couponCodes_reservedForLeadId_leads_id"
	}),
}));

export const dealerOnboardingDocumentsRelations = relations(dealerOnboardingDocuments, ({one}) => ({
	dealerOnboardingApplication: one(dealerOnboardingApplications, {
		fields: [dealerOnboardingDocuments.applicationId],
		references: [dealerOnboardingApplications.id]
	}),
}));

export const oemContactsRelations = relations(oemContacts, ({one}) => ({
	oem: one(oems, {
		fields: [oemContacts.oemId],
		references: [oems.id]
	}),
}));

export const kycDocumentsRelations = relations(kycDocuments, ({one}) => ({
	lead: one(leads, {
		fields: [kycDocuments.leadId],
		references: [leads.id]
	}),
}));

export const kycVerificationsRelations = relations(kycVerifications, ({one}) => ({
	lead: one(leads, {
		fields: [kycVerifications.leadId],
		references: [leads.id]
	}),
}));

export const productCategoriesRelations = relations(productCategories, ({many}) => ({
	products: many(products),
}));

export const facilitationPaymentsRelations = relations(facilitationPayments, ({one}) => ({
	lead: one(leads, {
		fields: [facilitationPayments.leadId],
		references: [leads.id]
	}),
}));