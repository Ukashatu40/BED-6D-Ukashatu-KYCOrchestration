// src/api/auth/roles.guard.spec.ts
import { RolesGuard } from './roles.guard';
import { Reflector } from '@nestjs/core';
import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { it, expect, describe, jest } from '@jest/globals';

function makeContext(
  roles: string[] | undefined,
  userRoles: string[],
): { context: ExecutionContext; reflector: Reflector } {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ user: { roles: userRoles } }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
  return { context, reflector };
}

describe('RolesGuard', () => {
  it('allows access when no @Roles() is declared on the route', () => {
    const { context, reflector } = makeContext(undefined, []);
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows access when the user has one of the required roles', () => {
    const { context, reflector } = makeContext(
      ['ops_admin', 'compliance_officer'],
      ['compliance_officer'],
    );
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects access when the user has none of the required roles', () => {
    const { context, reflector } = makeContext(['compliance_officer'], ['customer']);
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
