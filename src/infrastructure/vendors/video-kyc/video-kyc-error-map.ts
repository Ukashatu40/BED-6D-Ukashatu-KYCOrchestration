// src/infrastructure/vendors/video-kyc/video-kyc-error-map.ts
import { InternalErrorCategory } from '../../../application/ports/kyc-vendor.port';

interface VendorErrorMapping {
  category: InternalErrorCategory;
  retryable: boolean;
  action: string;
}

/** Per Vendor Error Mapping table (spec p.40-41). 15 more codes exist per Section A2.3's "18 error codes" but aren't individually enumerated in the source document. */
export const SIGNIVISION_ERROR_MAP: Record<string, VendorErrorMapping> = {
  'liveness-failed': {
    category: InternalErrorCategory.VALIDATION_ERROR,
    retryable: true,
    action: 'Allow customer to retry session (max 3)',
  },
  'face-mismatch': {
    category: InternalErrorCategory.VALIDATION_ERROR,
    retryable: true,
    action: 'Allow retry; escalate after 3 failures',
  },
  'session-expired': {
    category: InternalErrorCategory.VENDOR_ERROR,
    retryable: true,
    action: 'Create new session',
  },
  'poor-connectivity': {
    category: InternalErrorCategory.VENDOR_ERROR,
    retryable: true,
    action: 'Suggest customer improve connection',
  },
  'concurrent-session-limit-reached': {
    category: InternalErrorCategory.RATE_LIMITED,
    retryable: true,
    action: 'Queue session creation and retry after backoff',
  },
};

export const SIGNIVISION_DEFAULT_MAPPING: VendorErrorMapping = {
  category: InternalErrorCategory.VENDOR_ERROR,
  retryable: false,
  action: 'Log and escalate — unmapped SigniVision error code',
};

export function mapSigniVisionError(vendorCode: string): VendorErrorMapping {
  return SIGNIVISION_ERROR_MAP[vendorCode] ?? SIGNIVISION_DEFAULT_MAPPING;
}
