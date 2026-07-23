// src/domain/data-erasure/data-category.ts
import { LegalHold } from './legal-hold-evaluator';
export enum DataCategory {
  // PMLA-required — retained for the life of ANY active hold, per Section 12.
  KYC_DOCUMENTS = 'KYC_DOCUMENTS',
  VERIFICATION_RECORDS = 'VERIFICATION_RECORDS',
  TRANSACTION_HISTORY = 'TRANSACTION_HISTORY',
  AML_SCREENING_RESULTS = 'AML_SCREENING_RESULTS',
  AUDIT_EVENTS = 'AUDIT_EVENTS',
  CORE_IDENTITY_PII = 'CORE_IDENTITY_PII', // name, DOB — the fields Customer entity actually holds

  // Not required for PMLA compliance — eligible for immediate anonymisation
  // regardless of hold status, per Section A1.3(b).
  MARKETING_PREFERENCES = 'MARKETING_PREFERENCES',
  COMMUNICATION_HISTORY = 'COMMUNICATION_HISTORY',
  BEHAVIOURAL_DATA = 'BEHAVIOURAL_DATA',
  SUPPLEMENTARY_DOCUMENTS = 'SUPPLEMENTARY_DOCUMENTS',
}

const PMLA_REQUIRED_CATEGORIES = [
  DataCategory.KYC_DOCUMENTS,
  DataCategory.VERIFICATION_RECORDS,
  DataCategory.TRANSACTION_HISTORY,
  DataCategory.AML_SCREENING_RESULTS,
  DataCategory.AUDIT_EVENTS,
  DataCategory.CORE_IDENTITY_PII,
];

const ALWAYS_ELIGIBLE_CATEGORIES = [
  DataCategory.MARKETING_PREFERENCES,
  DataCategory.COMMUNICATION_HISTORY,
  DataCategory.BEHAVIOURAL_DATA,
  DataCategory.SUPPLEMENTARY_DOCUMENTS,
];

export interface DataCategorisation {
  eligibleForErasure: DataCategory[];
  retainedUnderHold: DataCategory[];
}

/**
 * Splits data categories into "erase now" vs. "retain until hold clears"
 * per the layered-erasure approach described in C1.5. If ANY legal hold is
 * active, PMLA-required categories are retained wholesale — there is no
 * partial retention within a category (e.g. "keep some KYC documents but
 * not others"), matching how the spec's own B4.3 walkthrough treats it.
 */
export function categoriseDataForErasure(holds: LegalHold[]): DataCategorisation {
  const anyHoldActive = holds.length > 0;
  return {
    eligibleForErasure: [
      ...ALWAYS_ELIGIBLE_CATEGORIES,
      ...(anyHoldActive ? [] : PMLA_REQUIRED_CATEGORIES),
    ],
    retainedUnderHold: anyHoldActive ? [...PMLA_REQUIRED_CATEGORIES] : [],
  };
}
