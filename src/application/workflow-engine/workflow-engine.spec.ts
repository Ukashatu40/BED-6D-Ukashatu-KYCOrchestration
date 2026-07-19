// src/application/workflow-engine/workflow-engine.spec.ts
import { WorkflowEngine } from './workflow-engine';
import { WorkflowConfigYaml, WorkflowStepYaml } from './workflow-config.schema';
import { WorkflowExecutionContext, WorkflowStepExecutor } from './workflow-engine.types';
import { VendorType } from '../ports/kyc-vendor.port';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { DocumentType } from '../../domain/value-objects/document-type.enum';
import { describe, expect, it } from '@jest/globals';

function makeStep(overrides: Partial<WorkflowStepYaml>): WorkflowStepYaml {
  return {
    stepName: 'test-step',
    vendorType: VendorType.DIGILOCKER,
    order: 1,
    parallelGroup: null,
    guardExpression: null,
    timeoutSeconds: 30,
    ...overrides,
  };
}

function makeConfig(steps: WorkflowStepYaml[]): WorkflowConfigYaml {
  return {
    tier: KycTier.MINIMUM,
    description: 'test',
    targetCompletionMinutes: 5,
    approvalAuthority: 'AUTOMATED',
    requiredDocuments: [{ documentType: DocumentType.AADHAAR, mandatory: true }],
    steps,
    ckycUpload: { timing: 'DEFERRED', deadlineDays: 10 },
    reVerification: { frequency: 'ANNUAL' },
    documentRetentionYears: 5,
    ongoingMonitoring: false,
  };
}

function makeContext(overrides: Partial<WorkflowExecutionContext> = {}): WorkflowExecutionContext {
  return { customerId: 'cust-001', requestId: 'req-001', flags: {}, metadata: {}, ...overrides };
}

describe('WorkflowEngine', () => {
  describe('sequential execution', () => {
    it('executes steps in ascending order', async () => {
      const callOrder: string[] = [];
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest.fn(async (step: WorkflowStepYaml) => {
          callOrder.push(step.stepName);
          return { vendorReferenceId: 'x', success: true, normalisedData: {} };
        }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([
        makeStep({ stepName: 'second', order: 2 }),
        makeStep({ stepName: 'first', order: 1 }),
      ]);
      await engine.executeWorkflow(config, makeContext());
      expect(callOrder).toEqual(['first', 'second']);
    });

    it('reports allStepsSucceeded=true when every step succeeds', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest
          .fn()
          .mockResolvedValue({ vendorReferenceId: 'x', success: true, normalisedData: {} }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([
        makeStep({ order: 1 }),
        makeStep({ order: 2, stepName: 'step-2' }),
      ]);
      const result = await engine.executeWorkflow(config, makeContext());
      expect(result.allStepsSucceeded).toBe(true);
      expect(result.stepResults).toHaveLength(2);
    });

    it('stops executing subsequent steps after a failure', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest
          .fn()
          .mockResolvedValueOnce({ vendorReferenceId: 'x', success: false, normalisedData: {} }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([
        makeStep({ stepName: 'fails', order: 1 }),
        makeStep({ stepName: 'never-runs', order: 2 }),
      ]);
      const result = await engine.executeWorkflow(config, makeContext());
      expect(result.allStepsSucceeded).toBe(false);
      expect(result.stepResults).toHaveLength(1); // second step never attempted
    });

    it('records a step-level error without throwing out of executeWorkflow', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest.fn().mockRejectedValue(new Error('vendor exploded')),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([makeStep({ order: 1 })]);
      const result = await engine.executeWorkflow(config, makeContext());
      expect(result.stepResults[0].succeeded).toBe(false);
      expect(result.stepResults[0].error).toContain('vendor exploded');
    });
  });

  describe('parallel execution', () => {
    it('executes steps in the same parallelGroup concurrently', async () => {
      const startTimes: number[] = [];
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest.fn(async () => {
          startTimes.push(Date.now());
          await new Promise((r) => setTimeout(r, 20));
          return { vendorReferenceId: 'x', success: true, normalisedData: {} };
        }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([
        makeStep({ stepName: 'a', order: 1, parallelGroup: 'grp' }),
        makeStep({ stepName: 'b', order: 2, parallelGroup: 'grp' }),
      ]);
      const start = Date.now();
      await engine.executeWorkflow(config, makeContext());
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(35); // both ran concurrently, not 20+20=40ms sequentially
      expect(startTimes[1] - startTimes[0]).toBeLessThan(10); // started nearly simultaneously
    });

    it('aggregates results from all steps in a parallel group', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest
          .fn()
          .mockResolvedValue({ vendorReferenceId: 'x', success: true, normalisedData: {} }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([
        makeStep({ stepName: 'a', order: 1, parallelGroup: 'grp' }),
        makeStep({ stepName: 'b', order: 2, parallelGroup: 'grp' }),
      ]);
      const result = await engine.executeWorkflow(config, makeContext());
      expect(result.stepResults).toHaveLength(2);
      expect(result.stepResults.every((r) => r.succeeded)).toBe(true);
    });

    it('does not merge non-adjacent steps into the same group even if named identically', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest
          .fn()
          .mockResolvedValue({ vendorReferenceId: 'x', success: true, normalisedData: {} }),
      };
      const engine = new WorkflowEngine(executor);
      // 'a' and 'c' share group name "grp" but 'b' (ungrouped) sits between them —
      // they should form two separate single-item groups, not one group of two.
      const config = makeConfig([
        makeStep({ stepName: 'a', order: 1, parallelGroup: 'grp' }),
        makeStep({ stepName: 'b', order: 2, parallelGroup: null }),
        makeStep({ stepName: 'c', order: 3, parallelGroup: 'grp' }),
      ]);
      const result = await engine.executeWorkflow(config, makeContext());
      expect(result.stepResults.map((r) => r.stepName)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('conditional execution (guard expressions)', () => {
    it('skips a step whose guard expression evaluates to false', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest
          .fn()
          .mockResolvedValue({ vendorReferenceId: 'x', success: true, normalisedData: {} }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([makeStep({ order: 1, guardExpression: 'skipMe' })]);
      const result = await engine.executeWorkflow(
        config,
        makeContext({ flags: { skipMe: false } }),
      );
      expect(result.stepResults[0].skipped).toBe(true);
      expect(executor.executeVendorStep).not.toHaveBeenCalled();
    });

    it('runs a step whose guard expression evaluates to true', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest
          .fn()
          .mockResolvedValue({ vendorReferenceId: 'x', success: true, normalisedData: {} }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([makeStep({ order: 1, guardExpression: 'runMe' })]);
      const result = await engine.executeWorkflow(config, makeContext({ flags: { runMe: true } }));
      expect(result.stepResults[0].skipped).toBe(false);
      expect(executor.executeVendorStep).toHaveBeenCalledTimes(1);
    });

    it('a skipped step does not count as a failure', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest
          .fn()
          .mockResolvedValue({ vendorReferenceId: 'x', success: true, normalisedData: {} }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([
        makeStep({ stepName: 'skipped', order: 1, guardExpression: 'skipMe' }),
        makeStep({ stepName: 'runs', order: 2 }),
      ]);
      const result = await engine.executeWorkflow(
        config,
        makeContext({ flags: { skipMe: false } }),
      );
      expect(result.allStepsSucceeded).toBe(true);
    });

    it('CKYC search setting ckycRecordFound correctly guards the subsequent Digilocker fetch step', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest.fn(async (step: WorkflowStepYaml) => {
          if (step.stepName === 'ckyc-search') {
            return {
              vendorReferenceId: 'x',
              success: true,
              normalisedData: { source: 'CKYC_EXISTING_RECORD' },
            };
          }
          return { vendorReferenceId: 'x', success: true, normalisedData: {} };
        }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([
        makeStep({ stepName: 'ckyc-search', order: 1, vendorType: VendorType.CKYC }),
        makeStep({ stepName: 'digilocker-fetch', order: 2, guardExpression: '!ckycRecordFound' }),
      ]);
      const result = await engine.executeWorkflow(config, makeContext());
      const fetchResult = result.stepResults.find((r) => r.stepName === 'digilocker-fetch');
      expect(fetchResult?.skipped).toBe(true); // record WAS found, so Digilocker fetch is correctly skipped
    });
  });

  describe('manual steps', () => {
    it('halts the workflow at a manual step without calling a vendor', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest
          .fn()
          .mockResolvedValue({ vendorReferenceId: 'x', success: true, normalisedData: {} }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([
        makeStep({ stepName: 'auto-1', order: 1 }),
        makeStep({ stepName: 'review', order: 2, isManualStep: true, vendorType: null }),
        makeStep({ stepName: 'post-review', order: 3 }),
      ]);
      const result = await engine.executeWorkflow(config, makeContext());
      expect(result.awaitingManualStep).toBe(true);
      expect(result.allStepsSucceeded).toBe(false);
      const postReview = result.stepResults.find((r) => r.stepName === 'post-review');
      expect(postReview?.skipped).toBe(true);
    });

    it('resumes and completes remaining steps once complianceApproved is set on a subsequent invocation', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest
          .fn()
          .mockResolvedValue({ vendorReferenceId: 'x', success: true, normalisedData: {} }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([
        makeStep({ stepName: 'review', order: 1, isManualStep: true, vendorType: null }),
        makeStep({ stepName: 'ckyc-upload', order: 2, guardExpression: 'complianceApproved' }),
      ]);
      // First pass: halts at the manual step.
      const firstPass = await engine.executeWorkflow(config, makeContext());
      expect(firstPass.awaitingManualStep).toBe(true);

      // Second pass, simulating the use case re-invoking after approval:
      // the manual step is still present in config but complianceApproved is now true.
      const secondPass = await engine.executeWorkflow(
        config,
        makeContext({ flags: { complianceApproved: true } }),
      );
      const uploadResult = secondPass.stepResults.find((r) => r.stepName === 'ckyc-upload');
      expect(uploadResult?.skipped).toBe(false);
      expect(uploadResult?.succeeded).toBe(true);
    });
  });

  describe('full happy-path flows per tier', () => {
    it('completes a MINIMUM-shaped workflow end to end with all steps succeeding', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest
          .fn()
          .mockResolvedValue({ vendorReferenceId: 'x', success: true, normalisedData: {} }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([
        makeStep({ stepName: 'aadhaar-otp-fetch', order: 1, vendorType: VendorType.DIGILOCKER }),
        makeStep({ stepName: 'basic-name-screen', order: 2, vendorType: VendorType.AML_SCREENING }),
      ]);
      const result = await engine.executeWorkflow(config, makeContext());
      expect(result.allStepsSucceeded).toBe(true);
      expect(result.stepResults).toHaveLength(2);
    });

    it('completes a FULL-shaped workflow with a parallel group and a conditional CKYC upload', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest.fn(async (step: WorkflowStepYaml) => {
          if (step.stepName === 'ckyc-search') {
            return {
              vendorReferenceId: 'x',
              success: true,
              normalisedData: { source: 'CKYC_FRESH_UPLOAD' },
            };
          }
          return { vendorReferenceId: 'x', success: true, normalisedData: {} };
        }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([
        makeStep({ stepName: 'ckyc-search', order: 1, vendorType: VendorType.CKYC }),
        makeStep({
          stepName: 'digilocker-fetch',
          order: 2,
          vendorType: VendorType.DIGILOCKER,
          parallelGroup: 'docs',
          guardExpression: '!ckycRecordFound',
        }),
        makeStep({ stepName: 'full-aml-screen', order: 3, vendorType: VendorType.AML_SCREENING }),
        makeStep({
          stepName: 'ckyc-upload',
          order: 4,
          vendorType: VendorType.CKYC,
          guardExpression: '!ckycRecordFound',
        }),
      ]);
      const result = await engine.executeWorkflow(config, makeContext());
      expect(result.allStepsSucceeded).toBe(true);
      const digilockerStep = result.stepResults.find((r) => r.stepName === 'digilocker-fetch');
      const uploadStep = result.stepResults.find((r) => r.stepName === 'ckyc-upload');
      expect(digilockerStep?.skipped).toBe(false); // no existing record -> fetch runs
      expect(uploadStep?.skipped).toBe(false); // no existing record -> upload runs
    });

    it('completes an EDD-shaped workflow that pauses for compliance review then resumes', async () => {
      const executor: WorkflowStepExecutor = {
        executeVendorStep: jest
          .fn()
          .mockResolvedValue({ vendorReferenceId: 'x', success: true, normalisedData: {} }),
      };
      const engine = new WorkflowEngine(executor);
      const config = makeConfig([
        makeStep({ stepName: 'video-kyc-session', order: 1, vendorType: VendorType.VIDEO_KYC }),
        makeStep({
          stepName: 'full-aml-screen-adverse-media',
          order: 2,
          vendorType: VendorType.AML_SCREENING,
        }),
        makeStep({
          stepName: 'compliance-officer-review',
          order: 3,
          isManualStep: true,
          vendorType: null,
        }),
        makeStep({
          stepName: 'ckyc-upload',
          order: 4,
          vendorType: VendorType.CKYC,
          guardExpression: 'complianceApproved',
        }),
      ]);
      const firstPass = await engine.executeWorkflow(config, makeContext());
      expect(firstPass.awaitingManualStep).toBe(true);
      expect(firstPass.stepResults.find((r) => r.stepName === 'ckyc-upload')?.skipped).toBe(true);

      const secondPass = await engine.executeWorkflow(
        config,
        makeContext({ flags: { complianceApproved: true } }),
      );
      expect(secondPass.allStepsSucceeded).toBe(true);
    });
  });
});
