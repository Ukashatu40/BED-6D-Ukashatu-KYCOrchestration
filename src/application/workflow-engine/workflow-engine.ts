// src/application/workflow-engine/workflow-engine.ts
import { WorkflowConfigYaml, WorkflowStepYaml } from './workflow-config.schema';
import { evaluateGuardExpression } from './guard-expression.evaluator';
import {
  StepExecutionResult,
  WorkflowExecutionContext,
  WorkflowExecutionResult,
  WorkflowStepExecutor,
} from './workflow-engine.types';

/**
 * Executes a tier's declarative YAML workflow. Supports sequential steps
 * (default), parallel groups (steps sharing a parallelGroup name run
 * concurrently via Promise.all), and conditional steps (guardExpression
 * evaluated against the running context's flags before execution).
 *
 * Deliberately holds ZERO vendor-specific logic — every vendor call is
 * delegated to the injected WorkflowStepExecutor (Day 5 wires this to
 * VendorAdapterFactory). This is what makes "add a fourth tier = new YAML
 * file + new strategy class, zero engine changes" (Section A3.3) literally
 * true rather than aspirational.
 */
export class WorkflowEngine {
  constructor(private readonly stepExecutor: WorkflowStepExecutor) {}

  async executeWorkflow(
    config: WorkflowConfigYaml,
    initialContext: WorkflowExecutionContext,
  ): Promise<WorkflowExecutionResult> {
    const context = { ...initialContext, flags: { ...initialContext.flags } };
    const orderedSteps = [...config.steps].sort((a, b) => a.order - b.order);
    const groups = this.groupSteps(orderedSteps);

    const stepResults: StepExecutionResult[] = [];
    let awaitingManualStep = false;
    let allStepsSucceeded = true;

    for (const group of groups) {
      if (awaitingManualStep) {
        // A prior manual step halted the workflow — remaining steps are not
        // attempted this pass. The caller (Day 5's use case) re-invokes
        // executeWorkflow later once complianceApproved flips true.
        for (const step of group) {
          stepResults.push({
            stepName: step.stepName,
            vendorType: step.vendorType,
            succeeded: false,
            skipped: true,
            isManualStep: Boolean(step.isManualStep),
          });
        }
        continue;
      }

      const groupResults = await this.executeGroup(group, context);
      stepResults.push(...groupResults);

      for (const result of groupResults) {
        if (result.isManualStep && !result.skipped) {
          awaitingManualStep = true;
        }
        if (!result.skipped && !result.succeeded) {
          allStepsSucceeded = false;
        }
      }

      if (!allStepsSucceeded) {
        // A non-manual step failed outright — stop executing further groups.
        // (Manual-step pausing is handled above and is not a failure.)
        break;
      }
    }

    return {
      tier: config.tier,
      allStepsSucceeded: allStepsSucceeded && !awaitingManualStep,
      awaitingManualStep,
      stepResults,
    };
  }

  /** Groups consecutive steps sharing a parallelGroup name so they execute together via Promise.all; ungrouped steps form their own single-step group. */
  private groupSteps(orderedSteps: WorkflowStepYaml[]): WorkflowStepYaml[][] {
    const groups: WorkflowStepYaml[][] = [];
    let currentGroupName: string | null = null;
    let currentGroup: WorkflowStepYaml[] = [];

    for (const step of orderedSteps) {
      if (step.parallelGroup && step.parallelGroup === currentGroupName) {
        currentGroup.push(step);
        continue;
      }
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [step];
      currentGroupName = step.parallelGroup;
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    return groups;
  }

  private async executeGroup(
    group: WorkflowStepYaml[],
    context: WorkflowExecutionContext,
  ): Promise<StepExecutionResult[]> {
    return Promise.all(group.map((step) => this.executeStep(step, context)));
  }

  private async executeStep(
    step: WorkflowStepYaml,
    context: WorkflowExecutionContext,
  ): Promise<StepExecutionResult> {
    const shouldRun = evaluateGuardExpression(step.guardExpression, context.flags);
    if (!shouldRun) {
      return {
        stepName: step.stepName,
        vendorType: step.vendorType,
        succeeded: true, // a guarded-off step is not a failure, it's correctly skipped
        skipped: true,
        isManualStep: Boolean(step.isManualStep),
      };
    }

    if (step.isManualStep) {
      // Manual steps never call a vendor — they represent a human-in-the-loop
      // pause (compliance officer review). The workflow halts here until an
      // external event (Day 5's use case setting complianceApproved) resumes it.
      return {
        stepName: step.stepName,
        vendorType: null,
        succeeded: true,
        skipped: false,
        isManualStep: true,
      };
    }

    try {
      const vendorResult = await this.stepExecutor.executeVendorStep(step, context);
      // Successful steps can set flags for subsequent guard expressions —
      // e.g. a CKYC search step setting ckycRecordFound based on its result.
      this.applyResultToFlags(step, vendorResult, context);
      return {
        stepName: step.stepName,
        vendorType: step.vendorType,
        succeeded: vendorResult.success,
        skipped: false,
        isManualStep: false,
        vendorResult,
      };
    } catch (err) {
      return {
        stepName: step.stepName,
        vendorType: step.vendorType,
        succeeded: false,
        skipped: false,
        isManualStep: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Minimal, explicit flag-derivation rule: a CKYC search-family step whose
   * result carries a "source" of CKYC_EXISTING_RECORD sets ckycRecordFound.
   * Kept intentionally narrow rather than a generic reflection-based rule —
   * an explicit allowlist here is easier to audit than "any vendor result
   * field automatically becomes a guard flag."
   */
  private applyResultToFlags(
    step: WorkflowStepYaml,
    vendorResult: { success: boolean; normalisedData: Record<string, unknown> },
    context: WorkflowExecutionContext,
  ): void {
    if (step.stepName === 'ckyc-search' && vendorResult.success) {
      context.flags.ckycRecordFound = vendorResult.normalisedData.source === 'CKYC_EXISTING_RECORD';
    }
  }
}
