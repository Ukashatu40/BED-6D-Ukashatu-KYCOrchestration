// src/application/workflow-engine/workflow-engine-async.spec.ts
import { WorkflowEngine } from './workflow-engine';
import { WorkflowConfigYaml, WorkflowStepYaml } from './workflow-config.schema';
import { WorkflowExecutionContext, WorkflowStepExecutor } from './workflow-engine.types';
import { VendorType } from '../ports/kyc-vendor.port';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { DocumentType } from '../../domain/value-objects/document-type.enum';
import { expect, it, describe } from '@jest/globals';

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
    tier: KycTier.EDD,
    description: 't',
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
function makeContext(): WorkflowExecutionContext {
  return { customerId: 'cust-001', requestId: 'req-001', flags: {}, metadata: {} };
}

describe('WorkflowEngine — async vendor steps', () => {
  it('halts the workflow when an isAsync step signals awaitingCallback', async () => {
    const executor: WorkflowStepExecutor = {
      executeVendorStep: jest.fn().mockResolvedValue({
        vendorReferenceId: 'sess-001',
        success: true,
        normalisedData: { awaitingCallback: true },
      }),
    };
    const engine = new WorkflowEngine(executor);
    const config = makeConfig([
      makeStep({
        stepName: 'video-kyc-session',
        order: 1,
        vendorType: VendorType.VIDEO_KYC,
        isAsync: true,
      }),
      makeStep({ stepName: 'never-runs', order: 2 }),
    ]);
    const result = await engine.executeWorkflow(config, makeContext());
    expect(result.awaitingCallback).toBe(true);
    expect(result.allStepsSucceeded).toBe(false);
    expect(result.stepResults.find((r) => r.stepName === 'never-runs')?.skipped).toBe(true);
  });

  it('does not halt when an isAsync step resolves synchronously (executor returns no awaitingCallback marker)', async () => {
    const executor: WorkflowStepExecutor = {
      executeVendorStep: jest.fn().mockResolvedValue({
        vendorReferenceId: 'x',
        success: true,
        normalisedData: {},
      }),
    };
    const engine = new WorkflowEngine(executor);
    const config = makeConfig([
      makeStep({
        stepName: 'video-kyc-session',
        order: 1,
        vendorType: VendorType.VIDEO_KYC,
        isAsync: true,
      }),
      makeStep({ stepName: 'runs-fine', order: 2 }),
    ]);
    const result = await engine.executeWorkflow(config, makeContext());
    expect(result.awaitingCallback).toBe(false);
    expect(result.stepResults.find((r) => r.stepName === 'runs-fine')?.skipped).toBe(false);
  });
});
