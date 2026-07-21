// src/api/auth/roles.guard.ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { JwtPayload } from './jwt-payload.interface';

/**
 * Enforces role-based access per Day 5's "authorise (role check)"
 * requirement and the spec's RBAC row in the Security Requirements
 * Checklist (p.45). Runs AFTER JwtAuthGuard (request.user must already be
 * populated) — Nest applies guards in array order, so route decorators
 * always list JwtAuthGuard before RolesGuard.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true; // no @Roles() = any authenticated actor

    const request = context.switchToHttp().getRequest();
    const user: JwtPayload | undefined = request.user;
    const hasRequiredRole = user?.roles?.some((role) => requiredRoles.includes(role));

    if (!hasRequiredRole) {
      // Per Error Taxonomy p.39: "Return generic forbidden. Log at WARN with actor ID."
      throw new ForbiddenException({
        error: { code: 'AUTHORISATION_ERROR', message: 'Insufficient role for this operation' },
      });
    }
    return true;
  }
}
