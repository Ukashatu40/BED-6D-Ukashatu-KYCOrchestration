// src/api/auth/public.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Marks an endpoint as exempt from JwtAuthGuard — used for /health and webhook endpoints (which authenticate via HMAC, not JWT). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
