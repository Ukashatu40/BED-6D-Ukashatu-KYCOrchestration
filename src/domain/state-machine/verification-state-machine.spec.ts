// src/domain/state-machine/verification-state-machine.spec.ts
import {
  InvalidTransitionError,
  SideEffectHandler,
  VerificationEvent,
  VerificationStateMachine,
} from './verification-state-machine';
import { VerificationStatus } from '../value-objects/verification-status.enum';
import { describe, it, expect, jest } from '@jest/globals';
import { fail } from 'assert';

function noopSideEffects(): SideEffectHandler {
  return jest.fn(async () => {});
}

describe('VerificationStateMachine — valid transitions (all 18 from the spec table)', () => {
  const cases: Array<{
    name: string;
    from: VerificationStatus;
    event: VerificationEvent;
    guardContext: Record<string, unknown>;
    to: VerificationStatus;
  }> = [
    {
      name: 'kyc.initiated',
      from: VerificationStatus.NOT_STARTED,
      event: VerificationEvent.KYC_INITIATED,
      guardContext: { validCustomerAndTierAssigned: true },
      to: VerificationStatus.INITIATED,
    },
    {
      name: 'docs.requested',
      from: VerificationStatus.INITIATED,
      event: VerificationEvent.DOCS_REQUESTED,
      guardContext: { workflowHasDocumentSteps: true },
      to: VerificationStatus.DOCUMENTS_PENDING,
    },
    {
      name: 'doc.uploaded',
      from: VerificationStatus.DOCUMENTS_PENDING,
      event: VerificationEvent.DOC_UPLOADED,
      guardContext: { documentValidNotExpired: true },
      to: VerificationStatus.DOCUMENTS_RECEIVED,
    },
    {
      name: 'timer.48h',
      from: VerificationStatus.DOCUMENTS_PENDING,
      event: VerificationEvent.TIMER_48H,
      guardContext: { hoursSinceDocumentRequest: 48 },
      to: VerificationStatus.EXPIRED,
    },
    {
      name: 'verify.start',
      from: VerificationStatus.DOCUMENTS_RECEIVED,
      event: VerificationEvent.VERIFY_START,
      guardContext: { allRequiredDocumentsPresent: true },
      to: VerificationStatus.VERIFICATION_IN_PROGRESS,
    },
    {
      name: 'vendor.async',
      from: VerificationStatus.VERIFICATION_IN_PROGRESS,
      event: VerificationEvent.VENDOR_ASYNC,
      guardContext: { isAsyncVendorStep: true },
      to: VerificationStatus.VENDOR_CALLBACK_AWAITED,
    },
    {
      name: 'callback.rcvd',
      from: VerificationStatus.VENDOR_CALLBACK_AWAITED,
      event: VerificationEvent.CALLBACK_RECEIVED,
      guardContext: { webhookSignatureValid: true },
      to: VerificationStatus.VERIFICATION_IN_PROGRESS,
    },
    {
      name: 'timer.72h',
      from: VerificationStatus.VENDOR_CALLBACK_AWAITED,
      event: VerificationEvent.TIMER_72H,
      guardContext: { hoursSinceVendorCall: 72 },
      to: VerificationStatus.ESCALATED_TO_MANUAL,
    },
    {
      name: 'step.passed',
      from: VerificationStatus.VERIFICATION_IN_PROGRESS,
      event: VerificationEvent.STEP_PASSED,
      guardContext: { moreStepsRemain: true },
      to: VerificationStatus.VERIFICATION_IN_PROGRESS,
    },
    {
      name: 'all.passed',
      from: VerificationStatus.VERIFICATION_IN_PROGRESS,
      event: VerificationEvent.ALL_PASSED,
      guardContext: { allStepsPassed: true },
      to: VerificationStatus.VERIFIED,
    },
    {
      name: 'step.failed',
      from: VerificationStatus.VERIFICATION_IN_PROGRESS,
      event: VerificationEvent.STEP_FAILED,
      guardContext: { stepFailureNonRecoverable: true },
      to: VerificationStatus.REJECTED,
    },
    {
      name: 'step.retry',
      from: VerificationStatus.VERIFICATION_IN_PROGRESS,
      event: VerificationEvent.STEP_RETRY,
      guardContext: { retriesRemaining: true },
      to: VerificationStatus.VERIFICATION_IN_PROGRESS,
    },
    {
      name: 'risk.elevated',
      from: VerificationStatus.VERIFICATION_IN_PROGRESS,
      event: VerificationEvent.RISK_ELEVATED,
      guardContext: { riskScoreExceedsEddThreshold: true },
      to: VerificationStatus.ESCALATED_TO_MANUAL,
    },
    {
      name: 'risk.changed',
      from: VerificationStatus.VERIFIED,
      event: VerificationEvent.RISK_CHANGED,
      guardContext: { reVerificationTriggered: true },
      to: VerificationStatus.RE_VERIFICATION_REQUIRED,
    },
    {
      name: 'reg.update',
      from: VerificationStatus.VERIFIED,
      event: VerificationEvent.REG_UPDATE,
      guardContext: { newRegulatoryRequirement: true },
      to: VerificationStatus.RE_VERIFICATION_REQUIRED,
    },
    {
      name: 'reverify.init',
      from: VerificationStatus.RE_VERIFICATION_REQUIRED,
      event: VerificationEvent.REVERIFY_INIT,
      guardContext: { withinGracePeriod: true },
      to: VerificationStatus.INITIATED,
    },
    {
      name: 'compliance.freeze (from VERIFICATION_IN_PROGRESS)',
      from: VerificationStatus.VERIFICATION_IN_PROGRESS,
      event: VerificationEvent.COMPLIANCE_FREEZE,
      guardContext: { hasLegalOrRegulatoryOrder: true },
      to: VerificationStatus.SUSPENDED,
    },
  ];

  it.each(cases)('$name: $from -> $to', async ({ from, event, guardContext, to }) => {
    const sideEffects = noopSideEffects();
    const sm = new VerificationStateMachine(from, sideEffects);
    const result = await sm.apply(event, guardContext);
    expect(result).toBe(to);
    expect(sm.getCurrentState()).toBe(to);
    expect(sideEffects).toHaveBeenCalledTimes(1);
    expect(sideEffects).toHaveBeenCalledWith(
      expect.objectContaining({ event, fromState: from, toState: to }),
    );
  });

  // 18th transition (compliance.lift) has a dynamic target and is covered
  // separately below since it needs a freeze to precede it.
  it('compliance.lift: SUSPENDED -> whatever state preceded the freeze', async () => {
    const sideEffects = noopSideEffects();
    const sm = new VerificationStateMachine(
      VerificationStatus.VERIFICATION_IN_PROGRESS,
      sideEffects,
    );
    await sm.apply(VerificationEvent.COMPLIANCE_FREEZE, { hasLegalOrRegulatoryOrder: true });
    expect(sm.getCurrentState()).toBe(VerificationStatus.SUSPENDED);

    const result = await sm.apply(VerificationEvent.COMPLIANCE_LIFT, { freezeOrderLifted: true });
    expect(result).toBe(VerificationStatus.VERIFICATION_IN_PROGRESS);
  });
});

describe('VerificationStateMachine — guard condition rejections (10+ invalid attempts)', () => {
  it('rejects kyc.initiated when customer/tier not valid', async () => {
    const sm = new VerificationStateMachine(VerificationStatus.NOT_STARTED, noopSideEffects());
    await expect(
      sm.apply(VerificationEvent.KYC_INITIATED, { validCustomerAndTierAssigned: false }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects docs.requested when the workflow has no doc steps', async () => {
    const sm = new VerificationStateMachine(VerificationStatus.INITIATED, noopSideEffects());
    await expect(
      sm.apply(VerificationEvent.DOCS_REQUESTED, { workflowHasDocumentSteps: false }),
    ).rejects.toThrow(/guard condition not met/);
  });

  it('rejects doc.uploaded when the document is invalid or expired', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.DOCUMENTS_PENDING,
      noopSideEffects(),
    );
    await expect(
      sm.apply(VerificationEvent.DOC_UPLOADED, { documentValidNotExpired: false }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects timer.48h when fewer than 48 hours have elapsed', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.DOCUMENTS_PENDING,
      noopSideEffects(),
    );
    await expect(
      sm.apply(VerificationEvent.TIMER_48H, { hoursSinceDocumentRequest: 10 }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects verify.start when required documents are missing', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.DOCUMENTS_RECEIVED,
      noopSideEffects(),
    );
    await expect(
      sm.apply(VerificationEvent.VERIFY_START, { allRequiredDocumentsPresent: false }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects callback.rcvd when the webhook signature is invalid', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.VENDOR_CALLBACK_AWAITED,
      noopSideEffects(),
    );
    await expect(
      sm.apply(VerificationEvent.CALLBACK_RECEIVED, { webhookSignatureValid: false }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects timer.72h when fewer than 72 hours have elapsed', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.VENDOR_CALLBACK_AWAITED,
      noopSideEffects(),
    );
    await expect(
      sm.apply(VerificationEvent.TIMER_72H, { hoursSinceVendorCall: 5 }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects all.passed when not every step has passed', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.VERIFICATION_IN_PROGRESS,
      noopSideEffects(),
    );
    await expect(sm.apply(VerificationEvent.ALL_PASSED, { allStepsPassed: false })).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  it('rejects step.failed when the failure is recoverable', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.VERIFICATION_IN_PROGRESS,
      noopSideEffects(),
    );
    await expect(
      sm.apply(VerificationEvent.STEP_FAILED, { stepFailureNonRecoverable: false }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects step.retry when no retries remain', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.VERIFICATION_IN_PROGRESS,
      noopSideEffects(),
    );
    await expect(
      sm.apply(VerificationEvent.STEP_RETRY, { retriesRemaining: false }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects risk.elevated when the score is at or below the EDD threshold', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.VERIFICATION_IN_PROGRESS,
      noopSideEffects(),
    );
    await expect(
      sm.apply(VerificationEvent.RISK_ELEVATED, { riskScoreExceedsEddThreshold: false }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects reverify.init when outside the grace period', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.RE_VERIFICATION_REQUIRED,
      noopSideEffects(),
    );
    await expect(
      sm.apply(VerificationEvent.REVERIFY_INIT, { withinGracePeriod: false }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects compliance.freeze without a legal/regulatory order', async () => {
    const sm = new VerificationStateMachine(VerificationStatus.VERIFIED, noopSideEffects());
    await expect(
      sm.apply(VerificationEvent.COMPLIANCE_FREEZE, { hasLegalOrRegulatoryOrder: false }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects compliance.lift when the freeze order has not been lifted', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.VERIFICATION_IN_PROGRESS,
      noopSideEffects(),
    );
    await sm.apply(VerificationEvent.COMPLIANCE_FREEZE, { hasLegalOrRegulatoryOrder: true });
    await expect(
      sm.apply(VerificationEvent.COMPLIANCE_LIFT, { freezeOrderLifted: false }),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

describe('VerificationStateMachine — structurally invalid transitions (wrong event for current state)', () => {
  it('rejects all.passed from NOT_STARTED (event not defined from this state at all)', async () => {
    const sm = new VerificationStateMachine(VerificationStatus.NOT_STARTED, noopSideEffects());
    await expect(sm.apply(VerificationEvent.ALL_PASSED, { allStepsPassed: true })).rejects.toThrow(
      /is not defined from state/,
    );
  });

  it('rejects doc.uploaded from VERIFIED', async () => {
    const sm = new VerificationStateMachine(VerificationStatus.VERIFIED, noopSideEffects());
    await expect(
      sm.apply(VerificationEvent.DOC_UPLOADED, { documentValidNotExpired: true }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('error message includes the currently allowed events for that state', async () => {
    const sm = new VerificationStateMachine(VerificationStatus.NOT_STARTED, noopSideEffects());
    try {
      await sm.apply(VerificationEvent.ALL_PASSED, {});
      fail('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const e = err as InvalidTransitionError;
      expect(e.allowedEvents).toContain(VerificationEvent.KYC_INITIATED);
      expect(e.allowedEvents).toContain(VerificationEvent.COMPLIANCE_FREEZE); // ANY-source event always allowed
    }
  });

  it('does not mutate state when a transition is rejected', async () => {
    const sm = new VerificationStateMachine(VerificationStatus.NOT_STARTED, noopSideEffects());
    await expect(sm.apply(VerificationEvent.ALL_PASSED, {})).rejects.toThrow();
    expect(sm.getCurrentState()).toBe(VerificationStatus.NOT_STARTED);
  });
});

describe('VerificationStateMachine — side effect execution and atomicity', () => {
  it('invokes the side effect exactly once per successful transition', async () => {
    const sideEffects = noopSideEffects();
    const sm = new VerificationStateMachine(VerificationStatus.NOT_STARTED, sideEffects);
    await sm.apply(VerificationEvent.KYC_INITIATED, { validCustomerAndTierAssigned: true });
    expect(sideEffects).toHaveBeenCalledTimes(1);
  });

  it('does NOT invoke the side effect when the guard rejects', async () => {
    const sideEffects = noopSideEffects();
    const sm = new VerificationStateMachine(VerificationStatus.NOT_STARTED, sideEffects);
    await expect(
      sm.apply(VerificationEvent.KYC_INITIATED, { validCustomerAndTierAssigned: false }),
    ).rejects.toThrow();
    expect(sideEffects).not.toHaveBeenCalled();
  });

  it('does NOT mutate state when the side effect handler throws (atomicity)', async () => {
    const failingSideEffects: SideEffectHandler = jest.fn(async () => {
      throw new Error('audit write failed');
    });
    const sm = new VerificationStateMachine(VerificationStatus.NOT_STARTED, failingSideEffects);
    await expect(
      sm.apply(VerificationEvent.KYC_INITIATED, { validCustomerAndTierAssigned: true }),
    ).rejects.toThrow('audit write failed');
    expect(sm.getCurrentState()).toBe(VerificationStatus.NOT_STARTED); // unchanged
  });

  it('passes the full guard context through to the side effect handler', async () => {
    const sideEffects = noopSideEffects();
    const sm = new VerificationStateMachine(VerificationStatus.NOT_STARTED, sideEffects);
    const ctx = { validCustomerAndTierAssigned: true };
    await sm.apply(VerificationEvent.KYC_INITIATED, ctx);
    expect(sideEffects).toHaveBeenCalledWith(expect.objectContaining({ guardContext: ctx }));
  });
});

describe('VerificationStateMachine — ANY-source compliance.freeze', () => {
  it.each([
    VerificationStatus.INITIATED,
    VerificationStatus.DOCUMENTS_PENDING,
    VerificationStatus.VERIFICATION_IN_PROGRESS,
    VerificationStatus.VERIFIED,
    VerificationStatus.ESCALATED_TO_MANUAL,
  ])('freezes to SUSPENDED from %s', async (fromState) => {
    const sm = new VerificationStateMachine(fromState, noopSideEffects());
    const result = await sm.apply(VerificationEvent.COMPLIANCE_FREEZE, {
      hasLegalOrRegulatoryOrder: true,
    });
    expect(result).toBe(VerificationStatus.SUSPENDED);
  });

  it('restores the exact pre-freeze state after lift, even for a non-default state', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.ESCALATED_TO_MANUAL,
      noopSideEffects(),
    );
    await sm.apply(VerificationEvent.COMPLIANCE_FREEZE, { hasLegalOrRegulatoryOrder: true });
    const restored = await sm.apply(VerificationEvent.COMPLIANCE_LIFT, { freezeOrderLifted: true });
    expect(restored).toBe(VerificationStatus.ESCALATED_TO_MANUAL);
  });

  it('throws if compliance.lift is somehow reached without a prior freeze having recorded a previous state', async () => {
    // Constructing directly into SUSPENDED bypasses COMPLIANCE_FREEZE, which
    // is the only legitimate path per the transition table — this simulates
    // that structurally-impossible-in-practice edge case defensively.
    const sm = new VerificationStateMachine(VerificationStatus.SUSPENDED, noopSideEffects());
    await expect(
      sm.apply(VerificationEvent.COMPLIANCE_LIFT, { freezeOrderLifted: true }),
    ).rejects.toThrow(/no suspension state was recorded/);
  });
});

describe('VerificationStateMachine — full happy-path flows per tier', () => {
  it('MINIMUM tier: NOT_STARTED through VERIFIED with a single vendor step', async () => {
    const sm = new VerificationStateMachine(VerificationStatus.NOT_STARTED, noopSideEffects());
    await sm.apply(VerificationEvent.KYC_INITIATED, { validCustomerAndTierAssigned: true });
    await sm.apply(VerificationEvent.DOCS_REQUESTED, { workflowHasDocumentSteps: true });
    await sm.apply(VerificationEvent.DOC_UPLOADED, { documentValidNotExpired: true });
    await sm.apply(VerificationEvent.VERIFY_START, { allRequiredDocumentsPresent: true });
    const final = await sm.apply(VerificationEvent.ALL_PASSED, { allStepsPassed: true });
    expect(final).toBe(VerificationStatus.VERIFIED);
  });

  it('FULL tier: includes a step.passed loop before reaching VERIFIED', async () => {
    const sm = new VerificationStateMachine(VerificationStatus.NOT_STARTED, noopSideEffects());
    await sm.apply(VerificationEvent.KYC_INITIATED, { validCustomerAndTierAssigned: true });
    await sm.apply(VerificationEvent.DOCS_REQUESTED, { workflowHasDocumentSteps: true });
    await sm.apply(VerificationEvent.DOC_UPLOADED, { documentValidNotExpired: true });
    await sm.apply(VerificationEvent.VERIFY_START, { allRequiredDocumentsPresent: true });
    await sm.apply(VerificationEvent.STEP_PASSED, { moreStepsRemain: true }); // step 1 of N done
    const final = await sm.apply(VerificationEvent.ALL_PASSED, { allStepsPassed: true }); // remaining steps done
    expect(final).toBe(VerificationStatus.VERIFIED);
  });

  it('EDD tier: async video KYC step, callback received, then mandatory compliance escalation path via risk.elevated', async () => {
    const sm = new VerificationStateMachine(VerificationStatus.NOT_STARTED, noopSideEffects());
    await sm.apply(VerificationEvent.KYC_INITIATED, { validCustomerAndTierAssigned: true });
    await sm.apply(VerificationEvent.DOCS_REQUESTED, { workflowHasDocumentSteps: true });
    await sm.apply(VerificationEvent.DOC_UPLOADED, { documentValidNotExpired: true });
    await sm.apply(VerificationEvent.VERIFY_START, { allRequiredDocumentsPresent: true });
    await sm.apply(VerificationEvent.VENDOR_ASYNC, { isAsyncVendorStep: true }); // video KYC session opens
    expect(sm.getCurrentState()).toBe(VerificationStatus.VENDOR_CALLBACK_AWAITED);
    await sm.apply(VerificationEvent.CALLBACK_RECEIVED, { webhookSignatureValid: true }); // session.completed webhook
    const escalated = await sm.apply(VerificationEvent.RISK_ELEVATED, {
      riskScoreExceedsEddThreshold: true,
    }); // EDD's mandatory manual review gate
    expect(escalated).toBe(VerificationStatus.ESCALATED_TO_MANUAL);
  });

  it('EDD tier: video KYC session timing out escalates to manual review via timer.72h', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.VENDOR_CALLBACK_AWAITED,
      noopSideEffects(),
    );
    const escalated = await sm.apply(VerificationEvent.TIMER_72H, { hoursSinceVendorCall: 72 });
    expect(escalated).toBe(VerificationStatus.ESCALATED_TO_MANUAL);
  });

  it('re-verification cascade: VERIFIED -> RE_VERIFICATION_REQUIRED -> back to INITIATED', async () => {
    const sm = new VerificationStateMachine(VerificationStatus.VERIFIED, noopSideEffects());
    await sm.apply(VerificationEvent.RISK_CHANGED, { reVerificationTriggered: true });
    expect(sm.getCurrentState()).toBe(VerificationStatus.RE_VERIFICATION_REQUIRED);
    const reInitiated = await sm.apply(VerificationEvent.REVERIFY_INIT, {
      withinGracePeriod: true,
    });
    expect(reInitiated).toBe(VerificationStatus.INITIATED);
  });

  it('document expiry path: DOCUMENTS_PENDING times out to EXPIRED', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.DOCUMENTS_PENDING,
      noopSideEffects(),
    );
    const expired = await sm.apply(VerificationEvent.TIMER_48H, { hoursSinceDocumentRequest: 50 });
    expect(expired).toBe(VerificationStatus.EXPIRED);
  });

  it('non-recoverable step failure path: VERIFICATION_IN_PROGRESS -> REJECTED', async () => {
    const sm = new VerificationStateMachine(
      VerificationStatus.VERIFICATION_IN_PROGRESS,
      noopSideEffects(),
    );
    const rejected = await sm.apply(VerificationEvent.STEP_FAILED, {
      stepFailureNonRecoverable: true,
    });
    expect(rejected).toBe(VerificationStatus.REJECTED);
  });
});
