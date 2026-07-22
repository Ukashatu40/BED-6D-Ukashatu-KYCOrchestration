// src/application/use-cases/escalate-kyc-tier.use-case.ts
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { VerificationRequestRepositoryPort } from '../ports/verification-request-repository.port';
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { AuditTrailPort } from '../ports/audit-trail.port';

export class EscalationRequestNotFoundError extends Error {
  constructor(requestId: string) {
    super(`No verification request found with ID ${requestId}`);
    this.name = 'EscalationRequestNotFoundError';
  }
}

export class InvalidEscalationTargetError extends Error {
  constructor(currentTier: KycTier, targetTier: KycTier) {
    super(
      `Cannot escalate from ${currentTier} to ${targetTier} — target must be a strictly higher tier`,
    );
    this.name = 'InvalidEscalationTargetError';
  }
}

const TIER_ORDER = [KycTier.MINIMUM, KycTier.FULL, KycTier.EDD];

export interface EscalateKycTierCommand {
  requestId: string;
  targetTier: KycTier;
  reason: string;
  actorId: string;
  actorType: AuditActorType;
  correlationId: string;
}

/**
 * POST /api/v1/kyc/{requestId}/escalate — manual escalation to a higher
 * KYC tier per the Internal APIs table (p.55). Distinct from
 * RecalculateRiskScoreUseCase's automatic EDD upgrade: this path exists
 * for a human decision to require deeper verification for reasons the
 * risk-scoring formula doesn't capture (e.g. a business/compliance
 * judgment call), and is always audit-logged with the reason and acting
 * officer, same traceability standard as an AML disposition.
 */
export class EscalateKycTierUseCase {
  constructor(
    private readonly requestRepository: VerificationRequestRepositoryPort,
    private readonly customerRepository: CustomerRepositoryPort,
    private readonly auditTrail: AuditTrailPort,
  ) {}

  async execute(
    command: EscalateKycTierCommand,
  ): Promise<{ previousTier: KycTier; newTier: KycTier }> {
    const request = await this.requestRepository.findById(command.requestId);
    if (!request) throw new EscalationRequestNotFoundError(command.requestId);

    const props = request.toProps();
    if (TIER_ORDER.indexOf(command.targetTier) <= TIER_ORDER.indexOf(props.tier)) {
      throw new InvalidEscalationTargetError(props.tier, command.targetTier);
    }

    const customer = await this.customerRepository.findById(props.customerId);
    if (!customer) throw new EscalationRequestNotFoundError(command.requestId);

    const previousTier = props.tier;
    if (TIER_ORDER.indexOf(command.targetTier) > TIER_ORDER.indexOf(customer.kycTier)) {
      customer.upgradeTier(command.targetTier);
      await this.customerRepository.save(customer);
    }

    await this.auditTrail.recordEvent({
      customerId: props.customerId,
      eventType: 'ManualTierEscalation',
      actorType: command.actorType,
      actorId: command.actorId,
      correlationId: command.correlationId,
      eventPayload: {
        requestId: command.requestId,
        previousTier,
        newTier: command.targetTier,
        reason: command.reason,
      },
    });

    return { previousTier, newTier: command.targetTier };
  }
}
