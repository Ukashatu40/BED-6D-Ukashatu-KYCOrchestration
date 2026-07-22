// src/application/use-cases/dispose-aml-alert.use-case.spec.ts
import {
  AmlMatchNotFoundError,
  AmlMatchRepositoryPort,
  DisposeAmlAlertUseCase,
  InvalidDispositionError,
  JustificationTooShortError,
  MIN_JUSTIFICATION_LENGTH,
} from './dispose-aml-alert.use-case';
import { InMemoryAuditTrail } from '../../infrastructure/audit/in-memory-audit-trail';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { it, expect, describe } from '@jest/globals';

class FakeAmlMatchRepo implements AmlMatchRepositoryPort {
  private matches = new Map<
    string,
    { matchId: string; customerId: string; matchedName: string; matchConfidence: number }
  >();
  public dispositions: unknown[] = [];
  seed(m: { matchId: string; customerId: string; matchedName: string; matchConfidence: number }) {
    this.matches.set(m.matchId, m);
  }
  async findMatchById(matchId: string) {
    return this.matches.get(matchId) ?? null;
  }
  async saveDisposition(params: unknown) {
    this.dispositions.push(params);
  }
}

const actorFields = {
  actorId: 'compliance-officer-001',
  actorType: AuditActorType.USER,
  correlationId: 'corr-001',
};
const validJustification =
  'This is a false positive because the birth dates and nationalities differ significantly.';

describe('DisposeAmlAlertUseCase', () => {
  it('rejects a justification shorter than 50 characters', async () => {
    const repo = new FakeAmlMatchRepo();
    repo.seed({
      matchId: 'match-001',
      customerId: 'cust-001',
      matchedName: 'Test',
      matchConfidence: 90,
    });
    const useCase = new DisposeAmlAlertUseCase(repo, new InMemoryAuditTrail());
    await expect(
      useCase.execute({
        matchId: 'match-001',
        disposition: 'CLEARED',
        justification: 'too short',
        ...actorFields,
      }),
    ).rejects.toBeInstanceOf(JustificationTooShortError);
  });

  it('accepts a justification at exactly the 50-character minimum', async () => {
    const repo = new FakeAmlMatchRepo();
    repo.seed({
      matchId: 'match-001',
      customerId: 'cust-001',
      matchedName: 'Test',
      matchConfidence: 90,
    });
    const useCase = new DisposeAmlAlertUseCase(repo, new InMemoryAuditTrail());
    const exactly50 = 'a'.repeat(MIN_JUSTIFICATION_LENGTH);
    await expect(
      useCase.execute({
        matchId: 'match-001',
        disposition: 'CLEARED',
        justification: exactly50,
        ...actorFields,
      }),
    ).resolves.not.toThrow();
  });

  it('rejects an invalid disposition value', async () => {
    const repo = new FakeAmlMatchRepo();
    repo.seed({
      matchId: 'match-001',
      customerId: 'cust-001',
      matchedName: 'Test',
      matchConfidence: 90,
    });
    const useCase = new DisposeAmlAlertUseCase(repo, new InMemoryAuditTrail());
    await expect(
      useCase.execute({
        matchId: 'match-001',
        disposition: 'MAYBE' as any,
        justification: validJustification,
        ...actorFields,
      }),
    ).rejects.toBeInstanceOf(InvalidDispositionError);
  });

  it('throws AmlMatchNotFoundError for an unknown matchId', async () => {
    const repo = new FakeAmlMatchRepo();
    const useCase = new DisposeAmlAlertUseCase(repo, new InMemoryAuditTrail());
    await expect(
      useCase.execute({
        matchId: 'nonexistent',
        disposition: 'CLEARED',
        justification: validJustification,
        ...actorFields,
      }),
    ).rejects.toBeInstanceOf(AmlMatchNotFoundError);
  });

  it('validates justification length before checking match existence (fails fast on the cheaper check)', async () => {
    const repo = new FakeAmlMatchRepo(); // no match seeded at all
    const useCase = new DisposeAmlAlertUseCase(repo, new InMemoryAuditTrail());
    await expect(
      useCase.execute({
        matchId: 'nonexistent',
        disposition: 'CLEARED',
        justification: 'short',
        ...actorFields,
      }),
    ).rejects.toBeInstanceOf(JustificationTooShortError); // not AmlMatchNotFoundError
  });

  it('persists the disposition with the acting officer and justification', async () => {
    const repo = new FakeAmlMatchRepo();
    repo.seed({
      matchId: 'match-001',
      customerId: 'cust-001',
      matchedName: 'Test',
      matchConfidence: 90,
    });
    const useCase = new DisposeAmlAlertUseCase(repo, new InMemoryAuditTrail());
    await useCase.execute({
      matchId: 'match-001',
      disposition: 'CLEARED',
      justification: validJustification,
      ...actorFields,
    });
    expect(repo.dispositions).toHaveLength(1);
    expect(repo.dispositions[0]).toMatchObject({
      dispositionBy: 'compliance-officer-001',
      justification: validJustification,
    });
  });

  it('records an AmlAlertCleared audit event for CLEARED', async () => {
    const repo = new FakeAmlMatchRepo();
    repo.seed({
      matchId: 'match-001',
      customerId: 'cust-001',
      matchedName: 'Test',
      matchConfidence: 90,
    });
    const auditTrail = new InMemoryAuditTrail();
    const useCase = new DisposeAmlAlertUseCase(repo, auditTrail);
    await useCase.execute({
      matchId: 'match-001',
      disposition: 'CLEARED',
      justification: validJustification,
      ...actorFields,
    });
    const events = auditTrail.getEventsForCustomer('cust-001');
    expect(events[0].toProps().eventType).toBe('AmlAlertCleared');
  });

  it('records an AmlAlertEscalated audit event for ESCALATED, with full justification preserved', async () => {
    const repo = new FakeAmlMatchRepo();
    repo.seed({
      matchId: 'match-001',
      customerId: 'cust-001',
      matchedName: 'Test',
      matchConfidence: 96,
    });
    const auditTrail = new InMemoryAuditTrail();
    const useCase = new DisposeAmlAlertUseCase(repo, auditTrail);
    await useCase.execute({
      matchId: 'match-001',
      disposition: 'ESCALATED',
      justification: validJustification,
      ...actorFields,
    });
    const events = auditTrail.getEventsForCustomer('cust-001');
    expect(events[0].toProps().eventType).toBe('AmlAlertEscalated');
    expect(events[0].toProps().eventPayload.justification).toBe(validJustification);
  });
});
