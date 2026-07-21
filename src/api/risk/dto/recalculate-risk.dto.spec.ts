// src/api/risk/dto/recalculate-risk.dto.spec.ts
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RecalculateRiskRequestDto } from './recalculate-risk.dto';
import { describe, it, expect } from '@jest/globals';

describe('RecalculateRiskRequestDto validation', () => {
  it('passes validation for a well-formed FULL_RECALCULATION request', async () => {
    const dto = plainToInstance(RecalculateRiskRequestDto, {
      kind: 'FULL_RECALCULATION',
      factors: {
        productType: 50,
        transactionAnomaly: 50,
        jurisdictionalRisk: 50,
        pepStatus: 50,
        amlResults: 50,
      },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('fails validation when kind=FULL_RECALCULATION but factors is missing', async () => {
    const dto = plainToInstance(RecalculateRiskRequestDto, { kind: 'FULL_RECALCULATION' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'factors')).toBe(true);
  });

  it('passes validation for a well-formed DELTA_APPLICATION request', async () => {
    const dto = plainToInstance(RecalculateRiskRequestDto, {
      kind: 'DELTA_APPLICATION',
      deltas: [{ reason: 'Sufficiently long reason text', points: 10 }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('fails validation when kind=DELTA_APPLICATION but deltas is missing', async () => {
    const dto = plainToInstance(RecalculateRiskRequestDto, { kind: 'DELTA_APPLICATION' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'deltas')).toBe(true);
  });

  it('fails validation when a delta reason is too short (<10 chars)', async () => {
    const dto = plainToInstance(RecalculateRiskRequestDto, {
      kind: 'DELTA_APPLICATION',
      deltas: [{ reason: 'short', points: 5 }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails validation for an invalid kind value', async () => {
    const dto = plainToInstance(RecalculateRiskRequestDto, { kind: 'NOT_A_REAL_KIND' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'kind')).toBe(true);
  });
});
