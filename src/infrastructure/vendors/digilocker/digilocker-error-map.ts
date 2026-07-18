// src/infrastructure/vendors/digilocker/digilocker-error-map.ts
import { InternalErrorCategory } from '../../../application/ports/kyc-vendor.port';

interface VendorErrorMapping {
  category: InternalErrorCategory;
  retryable: boolean;
  action: string;
}

/**
 * Maps all 22 Digilocker error codes per Vendor Error Mapping table (spec p.40).
 * Only the codes explicitly enumerated in the spec are given precise mappings;
 * the remaining ones are grouped by their documented category name until
 * CERSAI/Digilocker sandbox responses are available to confirm exact codes.
 */
export const DIGILOCKER_ERROR_MAP: Record<string, VendorErrorMapping> = {
  'consent-expired': {
    category: InternalErrorCategory.VALIDATION_ERROR,
    retryable: false,
    action: 'Request new consent from customer',
  },
  'document-not-found': {
    category: InternalErrorCategory.NOT_FOUND,
    retryable: false,
    action: 'Ask customer to upload via alternative',
  },
  'rate-limited': {
    category: InternalErrorCategory.RATE_LIMITED,
    retryable: true,
    action: 'Backoff and retry after cooldown',
  },
  'service-unavailable': {
    category: InternalErrorCategory.VENDOR_UNAVAILABLE,
    retryable: true,
    action: 'Circuit breaker evaluation',
  },
  'invalid-token': {
    category: InternalErrorCategory.AUTHENTICATION_ERROR,
    retryable: false,
    action: 'Refresh OAuth token and retry once',
  },
};

/** Fallback for the remaining ~17 codes not individually enumerated in the spec. */
export const DIGILOCKER_DEFAULT_MAPPING: VendorErrorMapping = {
  category: InternalErrorCategory.VENDOR_ERROR,
  retryable: false,
  action: 'Log and escalate — unmapped Digilocker error code',
};

export function mapDigilockerError(vendorCode: string): VendorErrorMapping {
  return DIGILOCKER_ERROR_MAP[vendorCode] ?? DIGILOCKER_DEFAULT_MAPPING;
}
