// src/application/ports/internal-error.ts
import { InternalErrorCategory } from './kyc-vendor.port';

/**
 * Canonical internal error shape every adapter must normalise vendor errors
 * into. Never leaks vendor-specific codes or raw messages past this boundary
 * — see Error Response Envelope spec and the PII-in-logs pitfall.
 */
export class VendorNormalisedError extends Error {
  constructor(
    public readonly category: InternalErrorCategory,
    public readonly retryable: boolean,
    public readonly vendorErrorCode: string,
    public readonly vendorType: string,
    message: string,
  ) {
    super(message);
    this.name = 'VendorNormalisedError';
  }
}

export const HTTP_STATUS_BY_CATEGORY: Record<InternalErrorCategory, number> = {
  [InternalErrorCategory.VALIDATION_ERROR]: 400,
  [InternalErrorCategory.AUTHENTICATION_ERROR]: 401,
  [InternalErrorCategory.AUTHORISATION_ERROR]: 403,
  [InternalErrorCategory.NOT_FOUND]: 404,
  [InternalErrorCategory.CONFLICT]: 409,
  [InternalErrorCategory.RATE_LIMITED]: 429,
  [InternalErrorCategory.VENDOR_ERROR]: 502,
  [InternalErrorCategory.VENDOR_UNAVAILABLE]: 503,
  [InternalErrorCategory.INTERNAL_ERROR]: 500,
};

export const RETRYABLE_BY_CATEGORY: Record<InternalErrorCategory, boolean> = {
  [InternalErrorCategory.VALIDATION_ERROR]: false,
  [InternalErrorCategory.AUTHENTICATION_ERROR]: false,
  [InternalErrorCategory.AUTHORISATION_ERROR]: false,
  [InternalErrorCategory.NOT_FOUND]: false,
  [InternalErrorCategory.CONFLICT]: false,
  [InternalErrorCategory.RATE_LIMITED]: true,
  [InternalErrorCategory.VENDOR_ERROR]: true, // conditional — checked per vendor code
  [InternalErrorCategory.VENDOR_UNAVAILABLE]: true,
  [InternalErrorCategory.INTERNAL_ERROR]: false,
};
