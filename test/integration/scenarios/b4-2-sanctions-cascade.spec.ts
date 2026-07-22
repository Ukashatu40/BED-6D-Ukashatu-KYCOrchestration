// test/integration/scenarios/b4-2-sanctions-cascade.spec.ts
import {
  DisposeAmlAlertUseCase,
  AmlMatchRepositoryPort,
} from '../../../src/application/use-cases/dispose-aml-alert.use-case';
import { InMemoryAuditTrail } from '../../../src/infrastructure/audit/in-memory-audit-trail';
import { AuditActorType } from '../../../src/domain/entities/audit-event.entity';
import { describe, it, expect } from '@jest/globals';

class InMemoryAmlMatchRepo implements AmlMatchRepositoryPort {
  private matches = new Map<
    string,
    { matchId: string; customerId: string; matchedName: string; matchConfidence: number }
  >();
  public dispositions: Array<{
    matchId: string;
    disposition: string;
    dispositionBy: string;
    justification: string;
  }> = [];
  seed(m: { matchId: string; customerId: string; matchedName: string; matchConfidence: number }) {
    this.matches.set(m.matchId, m);
  }
  async findMatchById(matchId: string) {
    return this.matches.get(matchId) ?? null;
  }
  async saveDisposition(params: any) {
    this.dispositions.push(params);
  }
}

/**
 * Models Section B4.2: 47 AML matches (42 false positives, 4 true
 * matches, 1 ambiguous). What's proven here: individual match disposition
 * with mandatory justification works correctly and is fully audit-logged
 * — the DisposeAmlAlertUseCase piece, exercised for a representative
 * false-positive and a representative true-match case.
 *
 * NOT yet built (explicitly flagged rather than glossed over): the
 * BATCH-level orchestration the spec actually asks for — automatic
 * classification of all 42 false positives with system-generated
 * justification text, automatic account freezing + STR draft generation
 * for the 4 true matches, and routing the 1 ambiguous match to a
 * structured investigation queue. That's a ClassifyAmlBatchUseCase this
 * project's Day 5/6 timeline hasn't reached — this test demonstrates the
 * disposition primitive it would be built on, not the cascade itself.
 */
describe('Scenario B4.2 — Sanctions Alert Cascade (partial: disposition primitive only)', () => {
  const actorFields = {
    actorId: 'compliance-officer-001',
    actorType: AuditActorType.USER,
    correlationId: 'corr-b42',
  };

  it('classifies and disposes a false-positive match (confidence below threshold) with system-generated-style justification', async () => {
    const repo = new InMemoryAmlMatchRepo();
    repo.seed({
      matchId: 'match-fp-001',
      customerId: 'cust-fp-001',
      matchedName: 'Common Name',
      matchConfidence: 32,
    });
    const auditTrail = new InMemoryAuditTrail();
    const useCase = new DisposeAmlAlertUseCase(repo, auditTrail);

    await useCase.execute({
      matchId: 'match-fp-001',
      disposition: 'CLEARED',
      justification:
        'Match confidence 32% below configured threshold of 80%; no corroborating attributes (DOB, nationality) match.',
      ...actorFields,
    });

    const events = auditTrail.getEventsForCustomer('cust-fp-001');
    expect(events[0].toProps().eventType).toBe('AmlAlertCleared');
    expect(repo.dispositions[0].disposition).toBe('CLEARED');
  });

  it('escalates a true match (confidence > 95%) requiring immediate compliance attention', async () => {
    const repo = new InMemoryAmlMatchRepo();
    repo.seed({
      matchId: 'match-true-001',
      customerId: 'cust-true-001',
      matchedName: 'Exact Match Name',
      matchConfidence: 96,
    });
    const auditTrail = new InMemoryAuditTrail();
    const useCase = new DisposeAmlAlertUseCase(repo, auditTrail);

    await useCase.execute({
      matchId: 'match-true-001',
      disposition: 'ESCALATED',
      justification:
        'Match confidence 96% exceeds threshold; name, date of birth, and nationality all corroborate — true match confirmed.',
      ...actorFields,
    });

    const events = auditTrail.getEventsForCustomer('cust-true-001');
    expect(events[0].toProps().eventType).toBe('AmlAlertEscalated');
  });

  it('rejects a disposition attempt with an insufficiently substantive justification, even under cascade time pressure', async () => {
    const repo = new InMemoryAmlMatchRepo();
    repo.seed({
      matchId: 'match-rushed-001',
      customerId: 'cust-rushed-001',
      matchedName: 'X',
      matchConfidence: 40,
    });
    const useCase = new DisposeAmlAlertUseCase(repo, new InMemoryAuditTrail());
    await expect(
      useCase.execute({
        matchId: 'match-rushed-001',
        disposition: 'CLEARED',
        justification: 'low conf',
        ...actorFields,
      }),
    ).rejects.toThrow(/at least 50 characters/);
  });
});
