// src/application/workflow-engine/workflow-config.loader.ts
import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { WorkflowConfigYaml } from './workflow-config.schema';

/**
 * Loads and structurally validates a single workflow YAML file. Fails loudly
 * at load time (typically application bootstrap) rather than deep inside
 * WorkflowEngine.executeWorkflow — a malformed config for a tier no one has
 * exercised yet should never lie dormant until the first live customer hits
 * that tier in production.
 */
export function loadWorkflowConfig(filePath: string): WorkflowConfigYaml {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = load(raw) as WorkflowConfigYaml;

  if (!parsed || !parsed.tier) {
    throw new Error(`Invalid workflow config at ${filePath}: missing "tier"`);
  }
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error(
      `Invalid workflow config for tier ${parsed.tier}: "steps" must be a non-empty array`,
    );
  }
  if (!Array.isArray(parsed.requiredDocuments)) {
    throw new Error(
      `Invalid workflow config for tier ${parsed.tier}: "requiredDocuments" must be an array`,
    );
  }

  const orders = parsed.steps.map((s) => s.order);
  const uniqueOrders = new Set(orders);
  if (uniqueOrders.size !== orders.length) {
    throw new Error(
      `Invalid workflow config for tier ${parsed.tier}: duplicate step "order" values found`,
    );
  }

  for (const step of parsed.steps) {
    if (!step.stepName || typeof step.order !== 'number') {
      throw new Error(
        `Invalid workflow config for tier ${parsed.tier}: every step needs a "stepName" and numeric "order"`,
      );
    }
    if (!step.isManualStep && !step.vendorType) {
      throw new Error(
        `Invalid workflow config for tier ${parsed.tier}, step "${step.stepName}": vendorType is required unless isManualStep is true`,
      );
    }
  }

  return parsed;
}
