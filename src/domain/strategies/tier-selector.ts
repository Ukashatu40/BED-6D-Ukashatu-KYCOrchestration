// src/domain/strategies/tier-selector.ts
import { KycTier } from '../value-objects/kyc-tier.enum';

export interface TierSelectionContext {
  loanAmountInr: number;
  isPep: boolean;
  isHighRiskJurisdiction: boolean;
}

const MINIMUM_TIER_MAX_LOAN_INR = 50_000;
const EDD_TIER_MIN_LOAN_INR = 5_000_000; // INR 50 lakh, per spec's B3 trigger column

/** Pure tier-assignment logic per the B3 tier trigger table. EDD triggers (PEP, high-risk jurisdiction, large loan) take priority over the loan-amount-only MINIMUM/FULL split. */
export class TierSelector {
  selectTier(context: TierSelectionContext): KycTier {
    if (
      context.isPep ||
      context.isHighRiskJurisdiction ||
      context.loanAmountInr > EDD_TIER_MIN_LOAN_INR
    ) {
      return KycTier.EDD;
    }
    if (context.loanAmountInr < MINIMUM_TIER_MAX_LOAN_INR) {
      return KycTier.MINIMUM;
    }
    return KycTier.FULL;
  }
}
