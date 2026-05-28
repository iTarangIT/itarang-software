import { fetchCibilScore, fetchCibilReport } from '@/lib/decentro';
import { humanizeCibilError } from '@/lib/kyc/cibil-friendly-errors';
import type {
  CreditBureauProvider,
  ProviderError,
  ProviderInput,
  ReportAccountSummary,
  ReportResult,
  ScoreResult,
} from './types';

// CIBIL via Decentro. Wraps `lib/decentro.ts` and normalizes the response so
// callers don't have to know Decentro JSON layouts.

type DecentroEnvelope = {
  responseKey?: string;
  message?: string;
  status?: string;
  data?: Record<string, unknown>;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function isEnvelopeError(env: DecentroEnvelope): boolean {
  const key = env?.responseKey ?? '';
  return key.startsWith('error_') || env?.status === 'FAILURE';
}

function extractBureauErrorDesc(envelope: DecentroEnvelope): string | null {
  const data = (envelope?.data ?? {}) as Record<string, unknown>;
  const cCRResponse = data.cCRResponse as Record<string, unknown> | undefined;
  const reportLst = cCRResponse?.cIRReportDataLst as Array<Record<string, unknown>> | undefined;
  const first = Array.isArray(reportLst) && reportLst.length > 0 ? reportLst[0] : undefined;
  const bureauError = first?.error as Record<string, unknown> | undefined;
  const desc = bureauError?.errorDesc;
  return typeof desc === 'string' ? desc : null;
}

function extractScore(envelope: DecentroEnvelope): number | null {
  const data = (envelope?.data ?? {}) as Record<string, unknown>;
  const cCRResponse = data.cCRResponse as Record<string, unknown> | undefined;
  const reportLst = cCRResponse?.cIRReportDataLst as Array<Record<string, unknown>> | undefined;
  const first = Array.isArray(reportLst) && reportLst.length > 0 ? reportLst[0] : undefined;
  const reportData =
    (first?.cIRReportData as Record<string, unknown> | undefined) ??
    (cCRResponse?.cIRReportData as Record<string, unknown> | undefined);

  const scoreDetails =
    (data.scoreDetails as unknown[] | undefined) ??
    (reportData?.scoreDetails as unknown[] | undefined) ??
    (cCRResponse?.scoreDetails as unknown[] | undefined);

  const candidates: unknown[] = [
    Array.isArray(scoreDetails) && scoreDetails.length > 0
      ? (scoreDetails[0] as Record<string, unknown> | undefined)?.value
      : null,
    (reportData?.creditScore as Record<string, unknown> | undefined)?.score,
    (data.creditScore as Record<string, unknown> | undefined)?.score,
    data.credit_score,
    data.score,
  ];

  for (const c of candidates) {
    const n = num(c);
    if (n !== null) return n;
  }
  return null;
}

function buildError(
  envelope: DecentroEnvelope,
  endpoint: 'score' | 'report',
): ProviderError | null {
  const bureauErrorDesc = endpoint === 'report' ? extractBureauErrorDesc(envelope) : null;
  if (!isEnvelopeError(envelope) && !bureauErrorDesc) return null;

  const friendly = humanizeCibilError({
    endpoint,
    responseKey: envelope.responseKey ?? null,
    rawMessage: envelope.message ?? null,
    bureauErrorDesc,
  });

  return {
    code: envelope.responseKey ?? null,
    category: friendly.code,
    message: friendly.message,
    suggestion: friendly.suggestion,
    retryable: friendly.code === 'network',
  };
}

function extractAccountsSummary(envelope: DecentroEnvelope): ReportAccountSummary | null {
  const data = (envelope?.data ?? {}) as Record<string, unknown>;
  const cCRResponse = data.cCRResponse as Record<string, unknown> | undefined;
  const reportLst = cCRResponse?.cIRReportDataLst as Array<Record<string, unknown>> | undefined;
  const first = Array.isArray(reportLst) && reportLst.length > 0 ? reportLst[0] : undefined;
  const reportData =
    (first?.cIRReportData as Record<string, unknown> | undefined) ??
    (cCRResponse?.cIRReportData as Record<string, unknown> | undefined) ??
    cCRResponse ??
    data;

  const retail =
    (reportData?.retailAccountsSummary as Record<string, unknown> | undefined) ??
    (reportData?.accountSummary as Record<string, unknown> | undefined) ??
    (data.accountSummary as Record<string, unknown> | undefined) ??
    {};

  const total = num(retail.noOfAccounts);
  const active = num(retail.noOfActiveAccounts);
  const closed =
    num(retail.noOfClosedAccounts) ??
    (total !== null && active !== null ? total - active : null);
  const totalBalance = num(retail.totalBalanceAmount);
  const totalOverdue = num(retail.totalPastDueAmount);

  if (
    total === null &&
    active === null &&
    totalBalance === null &&
    totalOverdue === null
  ) {
    return null;
  }
  return {
    total_accounts: total,
    active_accounts: active,
    closed_accounts: closed,
    total_balance: totalBalance,
    total_overdue: totalOverdue,
  };
}

function extractEnquiries(envelope: DecentroEnvelope): number | null {
  const data = (envelope?.data ?? {}) as Record<string, unknown>;
  const cCRResponse = data.cCRResponse as Record<string, unknown> | undefined;
  const reportLst = cCRResponse?.cIRReportDataLst as Array<Record<string, unknown>> | undefined;
  const first = Array.isArray(reportLst) && reportLst.length > 0 ? reportLst[0] : undefined;
  const reportData =
    (first?.cIRReportData as Record<string, unknown> | undefined) ??
    (cCRResponse?.cIRReportData as Record<string, unknown> | undefined);

  const recent = reportData?.recentActivities as Record<string, unknown> | undefined;
  return (
    num(recent?.totalInquiries) ??
    num((reportData?.enquirySummary as Record<string, unknown> | undefined)?.totalEnquiries)
  );
}

export class CibilProvider implements CreditBureauProvider {
  readonly bureau = 'cibil' as const;

  async fetchScore(input: ProviderInput): Promise<ScoreResult> {
    const envelope = (await fetchCibilScore({
      name: input.name,
      pan: input.pan,
      dob: input.dob,
      phone: input.phone,
      address: input.address,
      pincode: input.pincode,
      address_type: input.address_type,
    })) as DecentroEnvelope;

    const error = buildError(envelope, 'score');
    const score = error ? null : extractScore(envelope);

    return { bureau: 'cibil', score, error, raw: envelope };
  }

  async fetchReport(input: ProviderInput): Promise<ReportResult> {
    const envelope = (await fetchCibilReport({
      name: input.name,
      pan: input.pan,
      dob: input.dob,
      phone: input.phone,
      address: input.address,
      pincode: input.pincode,
      address_type: input.address_type,
    })) as DecentroEnvelope;

    const error = buildError(envelope, 'report');
    if (error) {
      return {
        bureau: 'cibil',
        score: null,
        accounts_summary: null,
        recent_enquiries: null,
        error,
        raw: envelope,
      };
    }

    return {
      bureau: 'cibil',
      score: extractScore(envelope),
      accounts_summary: extractAccountsSummary(envelope),
      recent_enquiries: extractEnquiries(envelope),
      error: null,
      raw: envelope,
    };
  }
}
