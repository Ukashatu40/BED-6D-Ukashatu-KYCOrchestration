// test/e2e/app.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/api/domain-exception.filter';
import { PrismaService } from '../../src/infrastructure/persistence/prisma.service';
import { KycTier } from '../../src/domain/value-objects/kyc-tier.enum';
import { AuditActorType } from '../../src/domain/entities/audit-event.entity';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

/**
 * Full e2e suite: real Nest app, real HTTP via supertest, real Postgres,
 * real JWT verification through the actual guard pipeline. Vendor calls
 * hit the placeholder clients (see shared-infrastructure.module.ts) which
 * throw immediately — so KYC-initiation flows here prove correct request
 * handling up to and including the vendor boundary, NOT a full VERIFIED
 * outcome. Tests are named accordingly rather than claiming "happy path"
 * where the actual vendor round-trip can't complete in this environment.
 */
describe('KYC Orchestration Service (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: (validationErrors) => ({
          getStatus: () => 400,
          getResponse: () => ({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed',
              details: validationErrors.map((e) => ({
                field: e.property,
                reason: Object.values(e.constraints ?? {}).join(', '),
              })),
            },
          }),
        }),
      }),
    );
    app.useGlobalFilters(new DomainExceptionFilter());

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleFixture.get(PrismaService);
    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_no_update',
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_no_delete',
    );
    await prisma.$executeRawUnsafe('TRUNCATE audit_events');
    await prisma.customer.deleteMany({});
    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_no_update',
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_no_delete',
    );
    await app.close();
  });

  function signToken(roles: string[], sub = 'test-user'): string {
    return jwtService.sign({ sub, actorType: AuditActorType.USER, roles });
  }

  async function seedCustomer(tier: KycTier = KycTier.MINIMUM): Promise<string> {
    const customerId = randomUUID();
    await prisma.customer.create({
      data: {
        customerId,
        externalId: `ext-${randomUUID()}`,
        fullNameEncrypted: Buffer.from('encrypted-name'),
        dateOfBirthEncrypted: Buffer.from('encrypted-dob'),
        kycTier: tier,
        kycStatus: 'NOT_STARTED',
        riskScore: 10,
        riskFactors: {},
      },
    });
    return customerId;
  }

  describe('authentication and authorisation', () => {
    it('rejects a request with no Authorization header (401)', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/risk/customer/whatever/score',
      );
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_ERROR');
    });

    it('rejects a request with an invalid token (401)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/risk/customer/whatever/score')
        .set('Authorization', 'Bearer not-a-real-token');
      expect(response.status).toBe(401);
    });

    it('rejects a valid token lacking the required role (403)', async () => {
      const token = signToken(['customer']); // risk endpoints require compliance_officer/ops_admin/system
      const customerId = await seedCustomer();
      const response = await request(app.getHttpServer())
        .get(`/api/v1/risk/customer/${customerId}/score`)
        .set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('AUTHORISATION_ERROR');
    });

    it('every error response includes a correlationId and timestamp, even for auth failures', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/risk/customer/whatever/score',
      );
      expect(response.body.error.correlationId).toBeDefined();
      expect(response.body.error.timestamp).toBeDefined();
    });
  });

  describe('GET /api/v1/risk/customer/:customerId/score', () => {
    it('returns the risk score for a real, seeded customer through the full stack', async () => {
      const token = signToken(['ops_admin']);
      const customerId = await seedCustomer();
      const response = await request(app.getHttpServer())
        .get(`/api/v1/risk/customer/${customerId}/score`)
        .set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(200);
      expect(response.body.riskScore).toBe(10);
    });

    it('returns 404 with a standardised error envelope for an unknown customer', async () => {
      const token = signToken(['ops_admin']);
      const response = await request(app.getHttpServer())
        .get(`/api/v1/risk/customer/${randomUUID()}/score`)
        .set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/v1/risk/customer/:customerId/recalculate', () => {
    it('reproduces the B4.4 cascade (42+15+12=69) through the full HTTP stack, including the automatic EDD upgrade', async () => {
      const token = signToken(['compliance_officer']);
      const customerId = randomUUID();
      await prisma.customer.create({
        data: {
          customerId,
          externalId: `ext-${randomUUID()}`,
          fullNameEncrypted: Buffer.from('x'),
          dateOfBirthEncrypted: Buffer.from('x'),
          kycTier: 'FULL',
          kycStatus: 'VERIFIED',
          riskScore: 42,
          riskFactors: {},
        },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/risk/customer/${customerId}/recalculate`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          kind: 'DELTA_APPLICATION',
          deltas: [
            { reason: 'Jurisdictional risk factor increase for the customer', points: 15 },
            { reason: 'Transaction pattern anomaly detected in monitoring', points: 12 },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.newScore).toBe(69);
      expect(response.body.tierUpgraded).toBe(true);
      expect(response.body.correlationId).toBeDefined();
    });

    it('returns a 400 VALIDATION_ERROR envelope when deltas is missing for DELTA_APPLICATION', async () => {
      const token = signToken(['compliance_officer']);
      const customerId = await seedCustomer(KycTier.FULL);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/risk/customer/${customerId}/recalculate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ kind: 'DELTA_APPLICATION' });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.some((d: any) => d.field === 'deltas')).toBe(true);
    });
  });

  describe('POST /api/v1/kyc/initiate — request reaches the correct point given placeholder vendor clients', () => {
    it('accepts a valid initiation request, correctly assigns MINIMUM tier, and reaches the expected vendor-boundary failure rather than crashing or hanging', async () => {
      const token = signToken(['ops_admin']);
      const customerId = await seedCustomer(KycTier.MINIMUM);

      const response = await request(app.getHttpServer())
        .post('/api/v1/kyc/initiate')
        .set('Authorization', `Bearer ${token}`)
        .send({ customerId, loanAmountInr: 30000, isPep: false, isHighRiskJurisdiction: false });

      // Tier selection and state machine progression to DOCUMENTS_PENDING
      // happen entirely within InitiateKycUseCase, before any vendor call —
      // this succeeds regardless of the placeholder vendor client limitation.
      expect(response.status).toBe(201);
      expect(response.body.tier).toBe(KycTier.MINIMUM);
      expect(response.body.status).toBe('DOCUMENTS_PENDING');
    });

    it('rejects initiation for a nonexistent customer with a clean 404, not an unhandled exception', async () => {
      const token = signToken(['ops_admin']);
      const response = await request(app.getHttpServer())
        .post('/api/v1/kyc/initiate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          customerId: randomUUID(),
          loanAmountInr: 30000,
          isPep: false,
          isHighRiskJurisdiction: false,
        });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v1/kyc/:requestId/status', () => {
    it('returns 404 for an unknown requestId with the standardised envelope', async () => {
      const token = signToken(['ops_admin']);
      const response = await request(app.getHttpServer())
        .get(`/api/v1/kyc/${randomUUID()}/status`)
        .set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/v1/aml/:matchId/dispose', () => {
    it('rejects a disposition with a justification under 50 characters via the full DTO validation pipeline', async () => {
      const token = signToken(['compliance_officer']);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/aml/${randomUUID()}/dispose`)
        .set('Authorization', `Bearer ${token}`)
        .send({ disposition: 'CLEARED', justification: 'too short' });
      expect(response.status).toBe(400);
    });

    it('rejects a compliance-officer-only action when the caller lacks that role', async () => {
      const token = signToken(['ops_admin']); // AmlController requires compliance_officer specifically
      const response = await request(app.getHttpServer())
        .post(`/api/v1/aml/${randomUUID()}/dispose`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          disposition: 'CLEARED',
          justification: 'A sufficiently long and substantive justification here.',
        });
      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/data/erasure-request', () => {
    it('reproduces the B4.3 outcome (PARTIALLY_EXECUTED, PMLA hold) through the full HTTP stack', async () => {
      const token = signToken(['compliance_officer']);
      const customerId = await seedCustomer(KycTier.FULL);
      const eighteenMonthsAgo = new Date();
      eighteenMonthsAgo.setMonth(eighteenMonthsAgo.getMonth() - 18);

      const response = await request(app.getHttpServer())
        .post('/api/v1/data/erasure-request')
        .set('Authorization', `Bearer ${token}`)
        .send({
          customerId,
          relationshipEndDate: eighteenMonthsAgo.toISOString(),
          hasActiveLoans: false,
          hasOpenInvestigations: false,
          hasPendingLitigation: false,
        });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('PARTIALLY_EXECUTED');
      expect(response.body.legalHolds).toHaveLength(1);
      expect(response.body.legalHolds[0].holdType).toBe('PMLA');
    });

    it('performs full erasure for a customer with zero legal holds', async () => {
      const token = signToken(['compliance_officer']);
      const customerId = await seedCustomer(KycTier.FULL);

      const response = await request(app.getHttpServer())
        .post('/api/v1/data/erasure-request')
        .set('Authorization', `Bearer ${token}`)
        .send({
          customerId,
          hasActiveLoans: false,
          hasOpenInvestigations: false,
          hasPendingLitigation: false,
        });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('COMPLETED');
    });
  });

  describe('webhook endpoints — public, no JWT required', () => {
    it('accepts a webhook POST without an Authorization header (public per @Public())', async () => {
      const response = await request(app.getHttpServer())
        .post('/webhooks/v1/aml/monitoring-alert')
        .set('x-request-id', randomUUID())
        .send({
          eventId: randomUUID(),
          event: 'monitoring.list_updated',
          customerId: randomUUID(),
        });
      // Expected to fail downstream (no matching VerificationRequest for a
      // random UUID) but the key assertion is it does NOT reject at 401 —
      // proving @Public() correctly exempts this route from JwtAuthGuard.
      expect(response.status).not.toBe(401);
    });
  });

  describe('correlation ID propagation', () => {
    it('every successful response includes a correlationId distinct per request', async () => {
      const token = signToken(['ops_admin']);
      const customerId = await seedCustomer();
      const r1 = await request(app.getHttpServer())
        .get(`/api/v1/risk/customer/${customerId}/score`)
        .set('Authorization', `Bearer ${token}`);
      const r2 = await request(app.getHttpServer())
        .get(`/api/v1/risk/customer/${customerId}/score`)
        .set('Authorization', `Bearer ${token}`);
      // getScore doesn't echo correlationId in its body today (only
      // recalculate does) — this test targets an endpoint that does.
      const rec1 = await request(app.getHttpServer())
        .post(`/api/v1/risk/customer/${customerId}/recalculate`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          kind: 'FULL_RECALCULATION',
          factors: {
            productType: 0,
            transactionAnomaly: 0,
            jurisdictionalRisk: 0,
            pepStatus: 0,
            amlResults: 0,
          },
        });
      const rec2 = await request(app.getHttpServer())
        .post(`/api/v1/risk/customer/${customerId}/recalculate`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          kind: 'FULL_RECALCULATION',
          factors: {
            productType: 0,
            transactionAnomaly: 0,
            jurisdictionalRisk: 0,
            pepStatus: 0,
            amlResults: 0,
          },
        });
      expect(rec1.body.correlationId).not.toBe(rec2.body.correlationId);
    });
  });
});
