// src/domain/data-erasure/legal-hold.ts
export type LegalHoldType = 'PMLA' | 'ACTIVE_LOAN' | 'INVESTIGATION' | 'LITIGATION';

export interface LegalHold {
  holdType: LegalHoldType;
  reason: string;
  /** null = indefinite — resolved externally (loan closes, investigation concludes, litigation settles), not on a fixed timer like PMLA's 5-year clock. */
  expiryDate: Date | null;
}

export interface LegalHoldContext {
  /** null = relationship still active (e.g. loan ongoing) — the PMLA 5-year clock has not started yet. */
  relationshipEndDate: Date | null;
  hasActiveLoans: boolean;
  hasOpenInvestigations: boolean;
  hasPendingLitigation: boolean;
}

const PMLA_RETENTION_YEARS = 5;

/**
 * Evaluates all active legal holds against a customer per Section A1.3's
 * "smart erasure" requirement: PMLA retention, active loans, ongoing
 * investigations, pending litigation. Pure domain logic — no persistence,
 * no I/O. Matches the exact reasoning in Scenario B4.3: a loan closed 18
 * months ago still has 3.5 years remaining on its 5-year PMLA hold.
 */
export class LegalHoldEvaluator {
  evaluate(context: LegalHoldContext, asOf: Date = new Date()): LegalHold[] {
    const holds: LegalHold[] = [];

    if (context.hasActiveLoans) {
      holds.push({
        holdType: 'ACTIVE_LOAN',
        reason: 'Customer has an active loan relationship',
        expiryDate: null,
      });
    }
    if (context.hasOpenInvestigations) {
      holds.push({
        holdType: 'INVESTIGATION',
        reason: 'Customer is subject to an open investigation',
        expiryDate: null,
      });
    }
    if (context.hasPendingLitigation) {
      holds.push({
        holdType: 'LITIGATION',
        reason: 'Customer has pending litigation',
        expiryDate: null,
      });
    }

    if (context.relationshipEndDate) {
      const pmlaExpiry = new Date(context.relationshipEndDate);
      pmlaExpiry.setFullYear(pmlaExpiry.getFullYear() + PMLA_RETENTION_YEARS);
      if (pmlaExpiry > asOf) {
        holds.push({
          holdType: 'PMLA',
          reason: 'Section 12 PMLA record retention (5 years post-relationship end)',
          expiryDate: pmlaExpiry,
        });
      }
    }

    return holds;
  }

  /** Latest expiry among all time-bound holds. Returns null if any hold is indefinite (active loan/investigation/litigation — no fixed date to schedule against) or if there are no holds at all. */
  latestExpiry(holds: LegalHold[]): Date | null {
    if (holds.length === 0) return null;
    if (holds.some((h) => h.expiryDate === null)) return null;
    return holds.reduce(
      (latest, h) => (h.expiryDate! > latest ? h.expiryDate! : latest),
      holds[0].expiryDate!,
    );
  }
}
