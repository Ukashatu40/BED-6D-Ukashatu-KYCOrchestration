// src/application/use-cases/recalculate-risk-score.use-case.ts
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import {
  RiskDelta,
  RiskFactorInputs,
  RiskScoringEngine,
} from '../../domain/risk-scoring/risk-scoring.engine';
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { AuditTrailPort } from '../ports/audit-trail.port';

export class CustomerNotFoundError extends Error {
  constructor(customerId: string) {
    super(`No customer found with ID ${customerId}`);
    this.name = 'CustomerNotFoundError';
  }
}

export interface RecalculateWithFullFactorsCommand {
  kind: 'FULL_RECALCULATION';
  customerId: string;
  factors: RiskFactorInputs;
  actorId: string;
  actorType: AuditActorType;
  correlationId: string;
}

export interface RecalculateWithDeltasCommand {
  kind: 'DELTA_APPLICATION';
  customerId: string;
  deltas: RiskDelta[];
  actorId: string;
  actorType: AuditActorType;
  correlationId: string;
}

export type RecalculateRiskScoreCommand =
  RecalculateWithFullFactorsCommand | RecalculateWithDeltasCommand;

export interface RecalculateRiskScoreResult {
  previousScore: number;
  newScore: number;
  tierUpgraded: boolean;
  previousTier: KycTier;
  newTier: KycTier;
}

/**
 * Orchestrates a risk score recalculation: computes the new score via
 * RiskScoringEngine (pure domain logic), persists it on the Customer
 * aggregate, and — per Section D.5's explicit requirement — automatically
 * upgrades the customer to EDD tier when the new score crosses the EDD
 * threshold (60) and they aren't already at EDD. Every recalculation is
 * audit-logged (RiskScoreCalculated), and a tier upgrade additionally logs
 * RiskTierUpgraded with the triggering factors — matching the spec's
 * B4.4 scenario requirement: "generate a tier upgrade event with full
 * justification."
 *
 * Deliberately does NOT touch VerificationStateMachine directly (e.g.
 * transitioning to ESCALATED_TO_MANUAL via the risk.elevated event) — that
 * belongs to whatever use case owns the customer's active
 * VerificationRequest, which this use case has no reference to. This use
 * case's responsibility ends at "score recalculated, tier upgraded if
 * warranted, audit trail updated." Wiring risk.elevated into the state
 * machine is the caller's job (or a follow-on use case reacting to
 * RiskTierUpgraded).
 */
export class RecalculateRiskScoreUseCase {
  constructor(
    private readonly customerRepository: CustomerRepositoryPort,
    private readonly auditTrail: AuditTrailPort,
    private readonly engine: RiskScoringEngine = new RiskScoringEngine(),
  ) {}

  async execute(command: RecalculateRiskScoreCommand): Promise<RecalculateRiskScoreResult> {
    const customer = await this.customerRepository.findById(command.customerId);
    if (!customer) {
      throw new CustomerNotFoundError(command.customerId);
    }

    const previousScore = customer.riskScore.getValue();
    const previousTier = customer.kycTier;

    const { score: newScore, breakdown } =
      command.kind === 'FULL_RECALCULATION'
        ? this.engine.calculateWeightedScore(command.factors)
        : this.engine.applyDeltas(
            customer.riskScore,
            customer.toProps().riskFactors,
            command.deltas,
          );

    customer.updateRiskScore(newScore, breakdown);

    await this.auditTrail.recordEvent({
      customerId: command.customerId,
      eventType: 'RiskScoreCalculated',
      actorType: command.actorType,
      actorId: command.actorId,
      correlationId: command.correlationId,
      eventPayload: {
        previousScore,
        newScore: newScore.getValue(),
        method: command.kind,
        ...(command.kind === 'DELTA_APPLICATION'
          ? { deltas: command.deltas }
          : { factors: command.factors }),
      },
    });

    let tierUpgraded = false;
    let newTier = previousTier;

    if (newScore.exceedsEddThreshold() && previousTier !== KycTier.EDD) {
      customer.upgradeTier(KycTier.EDD);
      newTier = KycTier.EDD;
      tierUpgraded = true;

      await this.auditTrail.recordEvent({
        customerId: command.customerId,
        eventType: 'RiskTierUpgraded',
        actorType: command.actorType,
        actorId: command.actorId,
        correlationId: command.correlationId,
        eventPayload: {
          previousTier,
          newTier: KycTier.EDD,
          triggeringScore: newScore.getValue(),
          eddThreshold: newScore.getValue(), // documents the score that caused the crossing
          justification:
            command.kind === 'DELTA_APPLICATION'
              ? `Score reached ${newScore.getValue()} (EDD threshold: 60) due to: ${command.deltas.map((d) => d.reason).join('; ')}`
              : `Score reached ${newScore.getValue()} (EDD threshold: 60) via full risk re-assessment`,
        },
      });
    }

    await this.customerRepository.save(customer);

    return {
      previousScore,
      newScore: newScore.getValue(),
      tierUpgraded,
      previousTier,
      newTier,
    };
  }
}
