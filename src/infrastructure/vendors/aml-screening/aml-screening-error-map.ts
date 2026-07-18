// src/infrastructure/vendors/aml-screening/aml-screening-error-map.ts
import { InternalErrorCategory } from '../../../application/ports/kyc-vendor.port';

interface VendorErrorMapping {
  category: InternalErrorCategory;
  retryable: boolean;
  action: string;
}

/** Per Vendor Error Mapping table (spec p.41). 8 more codes exist per Section A2.4's "12 error codes" but aren't individually enumerated in the source document. */
export const GLOBALWATCH_ERROR_MAP: Record<string, VendorErrorMapping> = {
  'quota-exceeded': {
    category: InternalErrorCategory.RATE_LIMITED,
    retryable: true,
    action: 'Queue for next available batch slot',
  },
  'invalid-entity': {
    category: InternalErrorCategory.VALIDATION_ERROR,
    retryable: false,
    action: 'Fix entity format and re-screen',
  },
  'service-degraded': {
    category: InternalErrorCategory.VENDOR_UNAVAILABLE,
    retryable: true,
    action: 'Switch to real-time mode if batch fails',
  },
  'list-update-in-progress': {
    category: InternalErrorCategory.VENDOR_UNAVAILABLE,
    retryable: true,
    action: 'Retry shortly — sanctions list is mid-refresh',
  },
};

export const GLOBALWATCH_DEFAULT_MAPPING: VendorErrorMapping = {
  category: InternalErrorCategory.VENDOR_ERROR,
  retryable: false,
  action: 'Log and escalate — unmapped GlobalWatch error code',
};

export function mapGlobalWatchError(vendorCode: string): VendorErrorMapping {
  return GLOBALWATCH_ERROR_MAP[vendorCode] ?? GLOBALWATCH_DEFAULT_MAPPING;
}
