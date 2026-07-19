// src/application/workflow-engine/guard-expression.evaluator.ts
/**
 * Evaluates the small guard-expression language used in workflow YAML
 * (e.g. "!ckycRecordFound", "complianceApproved"). Deliberately NOT a full
 * expression language / eval() — that would be an injection risk given
 * these expressions live in version-controlled config files that could in
 * principle be edited by someone other than a developer (e.g. a compliance
 * reviewer proposing a workflow change via PR). Supports only boolean flag
 * lookup and negation, which is sufficient for every guard in the three
 * shipped workflow configs.
 */
export function evaluateGuardExpression(
  expression: string | null | undefined,
  context: Record<string, boolean>,
): boolean {
  if (!expression) return true; // no guard = always execute

  const trimmed = expression.trim();
  const negated = trimmed.startsWith('!');
  const flagName = negated ? trimmed.slice(1) : trimmed;

  if (!(flagName in context)) {
    throw new Error(
      `Guard expression "${expression}" references unknown context flag "${flagName}". ` +
        `Available flags: ${Object.keys(context).join(', ') || '(none)'}`,
    );
  }

  const flagValue = context[flagName];
  return negated ? !flagValue : flagValue;
}
