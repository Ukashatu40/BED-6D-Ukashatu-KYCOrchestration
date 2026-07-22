// src/application/use-cases/dispose-aml-alert.use-case.ts
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { AuditTrailPort } from '../ports/audit-trail.port';

export const MIN_JUSTIFICATION_LENGTH = 50;

export class JustificationTooShortError extends Error {
  constructor(actualLength: number) {
    super(
      `Disposition justification must be at least ${MIN_JUSTIFICATION_LENGTH} characters (got ${actualLength}) — ` +
        `per the Deutsche Bank AML fine case study, alerts cannot be cleared without a traceable, substantive reason`,
    );
    this.name = 'JustificationTooShortError';
  }
}

export class InvalidDispositionError extends Error {
  constructor(disposition: string) {
    super(`Invalid disposition "${disposition}" — must be CLEARED or ESCALATED`);
    this.name = 'InvalidDispositionError';
  }
}

export type AlertDisposition = 'CLEARED' | 'ESCALATED';

/** Minimal shape this use case needs from an AML match/screening repository — the concrete Prisma-backed implementation (AmlMatchRepository) is Day 6+ scope; this port keeps the use case testable today. */
export interface AmlMatchRepositoryPort {
  findMatchById(matchId: string): Promise<{
    matchId: string;
    customerId: string;
    matchedName: string;
    matchConfidence: number;
  } | null>;
  saveDisposition(params: {
    matchId: string;
    disposition: AlertDisposition;
    dispositionBy: string;
    justification: string;
    dispositionAt: Date;
  }): Promise<void>;
}

export interface DisposeAmlAlertCommand {
  matchId: string;
  disposition: AlertDisposition;
  justification: string;
  actorId: string;
  actorType: AuditActorType;
  correlationId: string;
}

export class AmlMatchNotFoundError extends Error {
  constructor(matchId: string) {
    super(`No AML match found with ID ${matchId}`);
    this.name = 'AmlMatchNotFoundError';
  }
}

/**
 * Records a compliance officer's disposition of an AML match (clear or
 * escalate). Enforces the mandatory 50-character justification at the
 * point of disposition — not at the database layer (see Day 4 schema
 * commit's note: a CHECK constraint can't validate the length of an
 * ENCRYPTED BYTEA column since Postgres never sees the plaintext).
 * Every disposition is permanently audit-logged with the acting
 * compliance officer's ID and full justification text, matching the
 * spec's "Every disposition must be traceable to the individual who made
 * it, with the full reasoning preserved" requirement (p.21).
 */
export class DisposeAmlAlertUseCase {
  constructor(
    private readonly amlMatchRepository: AmlMatchRepositoryPort,
    private readonly auditTrail: AuditTrailPort,
  ) {}

  async execute(command: DisposeAmlAlertCommand): Promise<void> {
    if (command.disposition !== 'CLEARED' && command.disposition !== 'ESCALATED') {
      throw new InvalidDispositionError(command.disposition);
    }
    if (command.justification.trim().length < MIN_JUSTIFICATION_LENGTH) {
      throw new JustificationTooShortError(command.justification.trim().length);
    }

    const match = await this.amlMatchRepository.findMatchById(command.matchId);
    if (!match) {
      throw new AmlMatchNotFoundError(command.matchId);
    }

    const dispositionAt = new Date();
    await this.amlMatchRepository.saveDisposition({
      matchId: command.matchId,
      disposition: command.disposition,
      dispositionBy: command.actorId,
      justification: command.justification,
      dispositionAt,
    });

    await this.auditTrail.recordEvent({
      customerId: match.customerId,
      eventType: command.disposition === 'CLEARED' ? 'AmlAlertCleared' : 'AmlAlertEscalated',
      actorType: command.actorType,
      actorId: command.actorId,
      correlationId: command.correlationId,
      eventPayload: {
        matchId: command.matchId,
        matchedName: match.matchedName,
        matchConfidence: match.matchConfidence,
        justification: command.justification,
        dispositionAt: dispositionAt.toISOString(),
      },
    });
  }
}
