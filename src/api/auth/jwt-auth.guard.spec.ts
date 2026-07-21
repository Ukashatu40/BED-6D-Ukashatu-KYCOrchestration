// src/api/auth/jwt-auth.guard.spec.ts
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { describe, it, expect } from '@jest/globals';
import { fail } from 'assert';

function makeContext(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  it('rejects a request with no Authorization header', () => {
    const guard = new JwtAuthGuard(new JwtService({ secret: 'x' }), new Reflector());
    expect(() => guard.canActivate(makeContext({}))).toThrow(UnauthorizedException);
  });

  it('rejects a malformed (non-Bearer) Authorization header', () => {
    const guard = new JwtAuthGuard(new JwtService({ secret: 'x' }), new Reflector());
    expect(() => guard.canActivate(makeContext({ authorization: 'Basic abc123' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an invalid/expired token with a generic message', () => {
    const guard = new JwtAuthGuard(new JwtService({ secret: 'x' }), new Reflector());
    try {
      guard.canActivate(makeContext({ authorization: 'Bearer garbage-token' }));
      fail('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      const response = (err as UnauthorizedException).getResponse() as any;
      expect(response.error.message).toBe('Invalid or expired token'); // never leaks jwt.verify's specific error
    }
  });

  it('accepts a valid token and attaches the payload to the request', () => {
    const jwtService = new JwtService({ secret: 'test-secret' });
    const token = jwtService.sign({ sub: 'user-001', actorType: 'USER', roles: ['ops_admin'] });
    const guard = new JwtAuthGuard(jwtService, new Reflector());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request: any = { headers: { authorization: `Bearer ${token}` } };
    const context = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    expect(guard.canActivate(context)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(request.user?.sub).toBe('user-001');
  });
});
