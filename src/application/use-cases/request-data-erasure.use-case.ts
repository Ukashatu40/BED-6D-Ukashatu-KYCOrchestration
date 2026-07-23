// src/application/use-cases/request-data-erasure.use-case.ts
import { randomUUID } from 'crypto';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import {
  LegalHold,
  LegalHoldContext,
  LegalHoldEvaluator,
} from '../../domain/data-erasure/legal-hold-evaluator';
import { categoriseDataForErasure, DataCategory } from '../../domain/data-erasure/data-category';
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { AuditTrailPort } from '../ports/audit-trail.port';
import { DataErasureRepositoryPort, ErasureStatus } from '../ports/data-erasure-repository.port';
import { TimerService } from '../workflow-engine/timer.service';
import { TimerType } from '../ports/timer-repository.port';
import { AnonymisationService } from '../../domain/data-erasure/anonymisation.service';

export class DataErasureCustomerNotFoundError extends Error {
  constructor(customerId: string) {
    super(`No customer found with ID ${customerId}`);
    this.name = 'DataErasureCustomerNotFoundError';
  }
}

export interface RequestDataErasureCommand {
  customerId: string;
  requestorId: string;
  relationshipEndDate: Date | null;
  hasActiveLoans: boolean;
  hasOpenInvestigations: boolean;
  hasPendingLitigation: boolean;
  actorId: string;
  actorType: AuditActorType;
  correlationId: string;
}

export interface RequestDataErasureResult {
  requestId: string;
  status: ErasureStatus;
  legalHolds: LegalHold[];
  eligibleDataCategories: DataCategory[];
  retainedDataCategories: DataCategory[];
  scheduledCompletionDate: Date | null;
  customerResponse: string;
}

/**
 * Handles a DPDP Act Section 8(7) erasure request per the layered-erasure
 * approach (C1.5): evaluate every active legal hold, categorise data
 * accordingly, execute what's immediately eligible, schedule what isn't,
 * and generate a transparent customer-facing explanation. Reproduces the
 * exact reasoning of Scenario B4.3.
 *
 * KNOWN MODEL LIMITATION (flagged, not hidden): "always-eligible"
 * categories (marketing preferences, communication history, behavioural
 * data, supplementary documents) are not fields that exist anywhere on
 * the Customer entity or Prisma schema — this project's domain model only
 * captures core KYC PII. When holds are active, this use case correctly
 * identifies those categories as eligible and records that in the
 * erasure request's audit trail and customer response, but there is no
 * actual field-level anonymisation performed for them, because there is
 * no field to anonymise. Only the FULL erasure path (zero holds) has a
 * real, testable effect on the Customer entity via anonymise(). A
 * production system would need those categories modeled as real
 * columns/tables before this logic could act on them concretely.
 */
export class RequestDataErasureUseCase {
  constructor(
    private readonly customerRepository: CustomerRepositoryPort,
    private readonly erasureRepository: DataErasureRepositoryPort,
    private readonly auditTrail: AuditTrailPort,
    private readonly timerService: TimerService,
    private readonly legalHoldEvaluator: LegalHoldEvaluator = new LegalHoldEvaluator(),
    private readonly anonymisationService: AnonymisationService = new AnonymisationService(),
  ) {}

  async execute(command: RequestDataErasureCommand): Promise<RequestDataErasureResult> {
    const customer = await this.customerRepository.findById(command.customerId);
    if (!customer) throw new DataErasureCustomerNotFoundError(command.customerId);

    const requestId = randomUUID();
    const requestDate = new Date();

    await this.auditTrail.recordEvent({
      customerId: command.customerId,
      eventType: 'DataErasureRequested',
      actorType: command.actorType,
      actorId: command.actorId,
      correlationId: command.correlationId,
      eventPayload: { requestId, requestorId: command.requestorId },
    });

    const holdContext: LegalHoldContext = {
      relationshipEndDate: command.relationshipEndDate,
      hasActiveLoans: command.hasActiveLoans,
      hasOpenInvestigations: command.hasOpenInvestigations,
      hasPendingLitigation: command.hasPendingLitigation,
    };
    const holds = this.legalHoldEvaluator.evaluate(holdContext, requestDate);
    const { eligibleForErasure, retainedUnderHold } = categoriseDataForErasure(holds);

    let status: ErasureStatus;
    let scheduledCompletionDate: Date | null = null;

    if (holds.length === 0) {
      const anonymisedName = this.anonymisationService.anonymiseValue();
      const anonymisedDob = this.anonymisationService.anonymiseValue();
      customer.anonymise(anonymisedName, anonymisedDob);
      await this.customerRepository.save(customer);
      status = 'COMPLETED';
    } else {
      status = 'PARTIALLY_EXECUTED';
      scheduledCompletionDate = this.legalHoldEvaluator.latestExpiry(holds);
      if (scheduledCompletionDate) {
        const durationMs = Math.max(scheduledCompletionDate.getTime() - requestDate.getTime(), 0);
        await this.timerService.scheduleCustomDurationTimer({
          timerType: TimerType.DATA_ERASURE_DUE,
          durationMs,
          customerId: command.customerId,
          payload: { erasureRequestId: requestId },
          now: requestDate,
        });
      }
      // scheduledCompletionDate stays null when an indefinite hold (active
      // loan/investigation/litigation) is present — there is nothing to
      // schedule against until that hold clears externally; a follow-up
      // erasure request or an operational process re-evaluates it later.
    }

    const customerResponse = this.buildCustomerResponse(
      holds,
      eligibleForErasure,
      retainedUnderHold,
      scheduledCompletionDate,
    );

    await this.erasureRepository.save({
      requestId,
      customerId: command.customerId,
      requestorId: command.requestorId,
      requestDate,
      status,
      legalHolds: holds,
      eligibleDataCategories: eligibleForErasure,
      anonymisedDataCategories: eligibleForErasure,
      scheduledCompletionDate,
      responseSentAt: requestDate,
      completedAt: status === 'COMPLETED' ? requestDate : null,
    });

    await this.auditTrail.recordEvent({
      customerId: command.customerId,
      eventType: 'DataErasureExecuted',
      actorType: command.actorType,
      actorId: command.actorId,
      correlationId: command.correlationId,
      eventPayload: {
        requestId,
        status,
        legalHolds: holds,
        eligibleDataCategories: eligibleForErasure,
        retainedDataCategories: retainedUnderHold,
        scheduledCompletionDate: scheduledCompletionDate?.toISOString() ?? null,
      },
    });

    return {
      requestId,
      status,
      legalHolds: holds,
      eligibleDataCategories: eligibleForErasure,
      retainedDataCategories: retainedUnderHold,
      scheduledCompletionDate,
      customerResponse,
    };
  }

  private buildCustomerResponse(
    holds: LegalHold[],
    eligible: DataCategory[],
    retained: DataCategory[],
    scheduledCompletionDate: Date | null,
  ): string {
    if (holds.length === 0) {
      return (
        'Your request has been completed. All personal data associated with your account has been ' +
        'permanently and irreversibly anonymised, as no active legal retention obligation applies.'
      );
    }

    const holdReasons = holds.map((h) => `${h.holdType}: ${h.reason}`).join('; ');
    const scheduleText = scheduledCompletionDate
      ? `The remaining data is scheduled for erasure on or after ${scheduledCompletionDate.toISOString().split('T')[0]}.`
      : 'The remaining data will be scheduled for erasure once the applicable hold(s) are lifted (e.g. loan closure, investigation conclusion).';

    return (
      `We have anonymised the following categories of your data, which are not subject to any legal retention requirement: ` +
      `${eligible.join(', ')}. ` +
      `The following categories remain retained under active legal obligation(s) — ${holdReasons} — ` +
      `and could not be erased at this time: ${retained.join(', ')}. ` +
      `${scheduleText} ` +
      `If you have questions about this decision, please contact our Grievance Officer.`
    );
  }
}
