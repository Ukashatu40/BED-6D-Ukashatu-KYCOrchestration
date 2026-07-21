// src/api/auth/jwt-auth.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { JwtPayload } from './jwt-payload.interface';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Verifies the Bearer JWT on every request per Day 5's "authenticate
 * (JWT)" requirement. Per the Error Taxonomy spec (p.39): "Return generic
 * auth error (do not leak details)" — this guard never surfaces WHY a
 * token was rejected (expired vs malformed vs missing) in the response,
 * only that it was. Attaches the decoded payload to request.user so
 * downstream guards/decorators (RolesGuard, @CurrentUser) can use it
 * without re-verifying.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : undefined;

    if (!token) {
      throw new UnauthorizedException({
        error: {
          code: 'AUTHENTICATION_ERROR',
          message: 'Missing or malformed Authorization header',
        },
      });
    }

    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      request.user = payload;
      return true;
    } catch {
      // Deliberately generic — never distinguishes "expired" from "invalid
      // signature" from "malformed" in the response, per the spec's
      // AUTHENTICATION_ERROR handling rule.
      throw new UnauthorizedException({
        error: { code: 'AUTHENTICATION_ERROR', message: 'Invalid or expired token' },
      });
    }
  }
}
