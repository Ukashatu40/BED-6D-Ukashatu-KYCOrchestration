// src/application/workflow-engine/vendor-step.executor.spec.ts
import { VendorStepExecutor } from './vendor-step.executor';
import { VendorAdapterFactory } from '../../infrastructure/vendors/vendor-adapter.factory';
import { VendorType } from '../ports/kyc-vendor.port';
import { WorkflowStepYaml } from './workflow-config.schema';
import { it, expect, describe } from '@jest/globals';

function makeFactory(
  overrides: {
    initiateVerification?: jest.Mock;
    fetchResult?: jest.Mock;
  } = {},
) {
  const adapter = {
    initiateVerification: overrides.initiateVerification ?? jest.fn(),
    fetchResult: overrides.fetchResult ?? jest.fn(),
    checkStatus: jest.fn(),
    handleCallback: jest.fn(),
    getHealthStatus: jest.fn(),
  };
  const factory = {
    getAdapter: jest.fn().mockReturnValue(adapter),
  } as unknown as VendorAdapterFactory;
  return { factory, adapter };
}

const context = { customerId: 'cust-001', requestId: 'req-001', flags: {}, metadata: {} };

describe('VendorStepExecutor', () => {
  it('throws when given a manual step (no vendorType)', async () => {
    const { factory } = makeFactory();
    const executor = new VendorStepExecutor(factory);
    const manualStep = {
      stepName: 'review',
      vendorType: null,
      order: 1,
      parallelGroup: null,
      guardExpression: null,
      timeoutSeconds: null,
      isManualStep: true,
    } as WorkflowStepYaml;
    await expect(executor.executeVendorStep(manualStep, context)).rejects.toThrow(
      /manual steps must never reach/,
    );
  });

  it('calls initiateVerification then fetchResult for a synchronous vendor step', async () => {
    const { factory, adapter } = makeFactory({
      initiateVerification: jest
        .fn()
        .mockResolvedValue({ vendorReferenceId: 'ref-001', isAsync: false }),
      fetchResult: jest
        .fn()
        .mockResolvedValue({ vendorReferenceId: 'ref-001', success: true, normalisedData: {} }),
    });
    const executor = new VendorStepExecutor(factory);
    const step = {
      stepName: 'ckyc-search',
      vendorType: VendorType.CKYC,
      order: 1,
      parallelGroup: null,
      guardExpression: null,
      timeoutSeconds: 30,
    } as WorkflowStepYaml;
    const result = await executor.executeVendorStep(step, context);
    expect(result.success).toBe(true);
    expect(adapter.fetchResult).toHaveBeenCalledWith('ref-001');
  });

  it('signals awaitingCallback and does not call fetchResult for an async step', async () => {
    const { factory, adapter } = makeFactory({
      initiateVerification: jest
        .fn()
        .mockResolvedValue({ vendorReferenceId: 'sess-001', isAsync: true }),
    });
    const executor = new VendorStepExecutor(factory);
    const step = {
      stepName: 'video-kyc-session',
      vendorType: VendorType.VIDEO_KYC,
      order: 1,
      parallelGroup: null,
      guardExpression: null,
      timeoutSeconds: null,
      isAsync: true,
    } as WorkflowStepYaml;
    const result = await executor.executeVendorStep(step, context);
    expect(result.normalisedData.awaitingCallback).toBe(true);
    expect(adapter.fetchResult).not.toHaveBeenCalled();
  });
});
