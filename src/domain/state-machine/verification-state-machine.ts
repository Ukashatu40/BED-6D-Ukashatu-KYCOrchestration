// src/domain/state-machine/verification-state-machine.ts
import { VerificationStatus } from '../value-objects/verification-status.enum';

export enum VerificationEvent {
  KYC_INITIATED = 'kyc.initiated',
  DOCS_REQUESTED = 'docs.requested',
  DOC_UPLOADED = 'doc.uploaded',
  TIMER_48H = 'timer.48h',
  VERIFY_START = 'verify.start',
  VENDOR_ASYNC = 'vendor.async',
  CALLBACK_RECEIVED = 'callback.rcvd',
  TIMER_72H = 'timer.72h',
  STEP_PASSED = 'step.passed',
  ALL_PASSED = 'all.passed',
  STEP_FAILED = 'step.failed',
  STEP_RETRY = 'step.retry',
  RISK_ELEVATED = 'risk.elevated',
  RISK_CHANGED = 'risk.changed',
  REG_UPDATE = 'reg.update',
  REVERIFY_INIT = 'reverify.init',
  COMPLIANCE_FREEZE = 'compliance.freeze',
  COMPLIANCE_LIFT = 'compliance.lift',
}

/**
 * Every field a guard might need, across all 18 transitions. Optional
 * throughout — a transition's guard only reads the fields relevant to it;
 * callers only need to populate what's relevant to the event being applied.
 */
export interface TransitionGuardContext {
  validCustomerAndTierAssigned?: boolean;
  workflowHasDocumentSteps?: boolean;
  documentValidNotExpired?: boolean;
  hoursSinceDocumentRequest?: number;
  allRequiredDocumentsPresent?: boolean;
  isAsyncVendorStep?: boolean;
  webhookSignatureValid?: boolean;
  hoursSinceVendorCall?: number;
  moreStepsRemain?: boolean;
  allStepsPassed?: boolean;
  stepFailureNonRecoverable?: boolean;
  retriesRemaining?: boolean;
  riskScoreExceedsEddThreshold?: boolean;
  reVerificationTriggered?: boolean;
  newRegulatoryRequirement?: boolean;
  withinGracePeriod?: boolean;
  hasLegalOrRegulatoryOrder?: boolean;
  freezeOrderLifted?: boolean;
}

/** Sentinel target for compliance.lift — resolved at apply-time to whatever state preceded the SUSPENDED freeze, not a fixed state. */
const PREVIOUS_STATE = Symbol('PREVIOUS_STATE');
type TransitionTarget = VerificationStatus | typeof PREVIOUS_STATE;

interface TransitionDefinition {
  event: VerificationEvent;
  from: VerificationStatus | 'ANY';
  to: TransitionTarget;
  guardDescription: string;
  guard: (ctx: TransitionGuardContext) => boolean;
  /** Symbolic identifier only — actual side-effect execution (audit write, notification, workflow trigger) is delegated to the injected SideEffectHandler. The state machine has zero infrastructure dependencies, per ADR-001. */
  sideEffect: string;
}

/**
 * The complete 18-row transition table from the spec's State Machine Formal
 * Specification. This array IS the state machine's behaviour — there is no
 * other path to a state change anywhere in this class.
 */
const TRANSITIONS: TransitionDefinition[] = [
  {
    event: VerificationEvent.KYC_INITIATED,
    from: VerificationStatus.NOT_STARTED,
    to: VerificationStatus.INITIATED,
    guardDescription: 'valid customer, tier assigned',
    guard: (ctx) => ctx.validCustomerAndTierAssigned === true,
    sideEffect: 'AUDIT_EVENT_AND_START_WORKFLOW',
  },
  {
    event: VerificationEvent.DOCS_REQUESTED,
    from: VerificationStatus.INITIATED,
    to: VerificationStatus.DOCUMENTS_PENDING,
    guardDescription: 'workflow has doc steps',
    guard: (ctx) => ctx.workflowHasDocumentSteps === true,
    sideEffect: 'NOTIFY_CUSTOMER',
  },
  {
    event: VerificationEvent.DOC_UPLOADED,
    from: VerificationStatus.DOCUMENTS_PENDING,
    to: VerificationStatus.DOCUMENTS_RECEIVED,
    guardDescription: 'doc valid, not expired',
    guard: (ctx) => ctx.documentValidNotExpired === true,
    sideEffect: 'ENCRYPT_STORE_AUDIT',
  },
  {
    event: VerificationEvent.TIMER_48H,
    from: VerificationStatus.DOCUMENTS_PENDING,
    to: VerificationStatus.EXPIRED,
    guardDescription: '48h since request',
    guard: (ctx) => (ctx.hoursSinceDocumentRequest ?? 0) >= 48,
    sideEffect: 'CANCEL_NOTIFY_CUSTOMER',
  },
  {
    event: VerificationEvent.VERIFY_START,
    from: VerificationStatus.DOCUMENTS_RECEIVED,
    to: VerificationStatus.VERIFICATION_IN_PROGRESS,
    guardDescription: 'all required docs present',
    guard: (ctx) => ctx.allRequiredDocumentsPresent === true,
    sideEffect: 'INVOKE_VENDOR_ADAPTER',
  },
  {
    event: VerificationEvent.VENDOR_ASYNC,
    from: VerificationStatus.VERIFICATION_IN_PROGRESS,
    to: VerificationStatus.VENDOR_CALLBACK_AWAITED,
    guardDescription: 'async vendor (video KYC)',
    guard: (ctx) => ctx.isAsyncVendorStep === true,
    sideEffect: 'SET_72H_TIMEOUT_TIMER',
  },
  {
    event: VerificationEvent.CALLBACK_RECEIVED,
    from: VerificationStatus.VENDOR_CALLBACK_AWAITED,
    to: VerificationStatus.VERIFICATION_IN_PROGRESS,
    guardDescription: 'signature valid',
    guard: (ctx) => ctx.webhookSignatureValid === true,
    sideEffect: 'PROCESS_RESULT_NEXT_STEP',
  },
  {
    event: VerificationEvent.TIMER_72H,
    from: VerificationStatus.VENDOR_CALLBACK_AWAITED,
    to: VerificationStatus.ESCALATED_TO_MANUAL,
    guardDescription: '72h since vendor call',
    guard: (ctx) => (ctx.hoursSinceVendorCall ?? 0) >= 72,
    sideEffect: 'ALERT_COMPLIANCE',
  },
  {
    event: VerificationEvent.STEP_PASSED,
    from: VerificationStatus.VERIFICATION_IN_PROGRESS,
    to: VerificationStatus.VERIFICATION_IN_PROGRESS,
    guardDescription: 'more steps remain',
    guard: (ctx) => ctx.moreStepsRemain === true,
    sideEffect: 'EXECUTE_NEXT_STEP',
  },
  {
    event: VerificationEvent.ALL_PASSED,
    from: VerificationStatus.VERIFICATION_IN_PROGRESS,
    to: VerificationStatus.VERIFIED,
    guardDescription: 'all steps passed',
    guard: (ctx) => ctx.allStepsPassed === true,
    sideEffect: 'UPDATE_CKYC_NOTIFY',
  },
  {
    event: VerificationEvent.STEP_FAILED,
    from: VerificationStatus.VERIFICATION_IN_PROGRESS,
    to: VerificationStatus.REJECTED,
    guardDescription: 'non-recoverable',
    guard: (ctx) => ctx.stepFailureNonRecoverable === true,
    sideEffect: 'RECORD_REASON_NOTIFY',
  },
  {
    event: VerificationEvent.STEP_RETRY,
    from: VerificationStatus.VERIFICATION_IN_PROGRESS,
    to: VerificationStatus.VERIFICATION_IN_PROGRESS,
    guardDescription: 'retries remaining',
    guard: (ctx) => ctx.retriesRemaining === true,
    sideEffect: 'RETRY_WITH_BACKOFF',
  },
  {
    event: VerificationEvent.RISK_ELEVATED,
    from: VerificationStatus.VERIFICATION_IN_PROGRESS,
    to: VerificationStatus.ESCALATED_TO_MANUAL,
    guardDescription: 'score > EDD threshold',
    guard: (ctx) => ctx.riskScoreExceedsEddThreshold === true,
    sideEffect: 'UPGRADE_TIER_NOTIFY',
  },
  {
    event: VerificationEvent.RISK_CHANGED,
    from: VerificationStatus.VERIFIED,
    to: VerificationStatus.RE_VERIFICATION_REQUIRED,
    guardDescription: 're-verification trigger',
    guard: (ctx) => ctx.reVerificationTriggered === true,
    sideEffect: 'INITIATE_REVERIFY',
  },
  {
    event: VerificationEvent.REG_UPDATE,
    from: VerificationStatus.VERIFIED,
    to: VerificationStatus.RE_VERIFICATION_REQUIRED,
    guardDescription: 'new requirement',
    guard: (ctx) => ctx.newRegulatoryRequirement === true,
    sideEffect: 'QUEUE_BATCH_REVERIFY',
  },
  {
    event: VerificationEvent.REVERIFY_INIT,
    from: VerificationStatus.RE_VERIFICATION_REQUIRED,
    to: VerificationStatus.INITIATED,
    guardDescription: 'within grace period',
    guard: (ctx) => ctx.withinGracePeriod === true,
    sideEffect: 'NEW_WORKFLOW_RETAIN_HISTORY',
  },
  {
    event: VerificationEvent.COMPLIANCE_FREEZE,
    from: 'ANY',
    to: VerificationStatus.SUSPENDED,
    guardDescription: 'legal/regulatory order',
    guard: (ctx) => ctx.hasLegalOrRegulatoryOrder === true,
    sideEffect: 'FREEZE_ACCOUNT_ALERT_LEGAL',
  },
  {
    event: VerificationEvent.COMPLIANCE_LIFT,
    from: VerificationStatus.SUSPENDED,
    to: PREVIOUS_STATE,
    guardDescription: 'freeze order lifted',
    guard: (ctx) => ctx.freezeOrderLifted === true,
    sideEffect: 'RESTORE_AUDIT_NOTIFY',
  },
];

export class InvalidTransitionError extends Error {
  constructor(
    public readonly currentState: VerificationStatus,
    public readonly attemptedEvent: VerificationEvent,
    public readonly allowedEvents: VerificationEvent[],
    reason: string,
  ) {
    super(
      `Cannot apply event "${attemptedEvent}" from state "${currentState}": ${reason}. ` +
        `Allowed events from this state: ${allowedEvents.length > 0 ? allowedEvents.join(', ') : '(none)'}`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export interface SideEffectParams {
  event: VerificationEvent;
  fromState: VerificationStatus;
  toState: VerificationStatus;
  guardContext: TransitionGuardContext;
}

/** Injected by the caller — Day 5's use cases wire this to AuditTrailPort + NotificationPort + WorkflowEngine. Throwing here aborts the transition entirely (see apply()'s atomicity note). */
export type SideEffectHandler = (params: SideEffectParams) => Promise<void>;

/**
 * Formal state machine per Section A3.4. Every transition validates its
 * guard, executes its side effect, and only then commits the state change —
 * there is deliberately no other way to mutate `currentState`. This is the
 * fix for the "String-Based State Management" anti-pattern the spec
 * explicitly calls out (p.37-38): no code anywhere else in the system may
 * set a verification status directly.
 */
export class VerificationStateMachine {
  private currentState: VerificationStatus;
  private stateBeforeSuspension: VerificationStatus | null = null;

  constructor(
    initialState: VerificationStatus,
    private readonly sideEffectHandler: SideEffectHandler,
  ) {
    this.currentState = initialState;
  }

  getCurrentState(): VerificationStatus {
    return this.currentState;
  }

  getAllowedEvents(): VerificationEvent[] {
    return TRANSITIONS.filter((t) => t.from === 'ANY' || t.from === this.currentState).map(
      (t) => t.event,
    );
  }

  /**
   * Applies an event. Resolution order: (1) does a transition exist for
   * this event from the current state at all? (2) does its guard pass?
   * (3) resolve the target state (handling the PREVIOUS_STATE sentinel for
   * compliance.lift). (4) run the side effect — if it throws, the state is
   * NEVER mutated. (5) commit.
   */
  async apply(
    event: VerificationEvent,
    guardContext: TransitionGuardContext = {},
  ): Promise<VerificationStatus> {
    const candidates = TRANSITIONS.filter(
      (t) => t.event === event && (t.from === 'ANY' || t.from === this.currentState),
    );

    if (candidates.length === 0) {
      throw new InvalidTransitionError(
        this.currentState,
        event,
        this.getAllowedEvents(),
        `event "${event}" is not defined from state "${this.currentState}"`,
      );
    }

    // Design invariant: exactly one transition definition exists per
    // (event, from-state) pairing across the 18-row table. Defensive first().
    const transition = candidates[0];

    if (!transition.guard(guardContext)) {
      throw new InvalidTransitionError(
        this.currentState,
        event,
        this.getAllowedEvents(),
        `guard condition not met (${transition.guardDescription})`,
      );
    }

    const toState = transition.to === PREVIOUS_STATE ? this.resolvePreviousState() : transition.to;

    // Side effects run BEFORE state mutation. If sideEffectHandler throws,
    // execution never reaches the assignment below — the state machine is
    // left exactly as it was before apply() was called. True cross-resource
    // atomicity (state + audit + notification in one DB transaction) is a
    // Day 4/5 concern once persistence exists; this class guarantees
    // in-memory consistency contingent on the injected handler's own
    // guarantees.
    await this.sideEffectHandler({ event, fromState: this.currentState, toState, guardContext });

    if (event === VerificationEvent.COMPLIANCE_FREEZE) {
      this.stateBeforeSuspension = this.currentState;
    }
    if (event === VerificationEvent.COMPLIANCE_LIFT) {
      this.stateBeforeSuspension = null;
    }

    this.currentState = toState;
    return this.currentState;
  }

  private resolvePreviousState(): VerificationStatus {
    if (this.stateBeforeSuspension === null) {
      throw new Error(
        'Cannot resolve target state for compliance.lift — no suspension state was recorded. ' +
          'This indicates SUSPENDED was reached without going through COMPLIANCE_FREEZE, ' +
          'which should be structurally impossible given the transition table.',
      );
    }
    return this.stateBeforeSuspension;
  }
}
