// src/infrastructure/vendors/ckyc/ckyc-error-map.ts
import { InternalErrorCategory } from '../../../application/ports/kyc-vendor.port';

interface VendorErrorMapping {
  category: InternalErrorCategory;
  retryable: boolean;
  action: string;
}

/** All named CKYC codes per Vendor Error Mapping table (spec p.40). 11 more exist per Section A2.2's "15 specific error codes" but aren't individually enumerated in the source document. */
export const CKYC_ERROR_MAP: Record<string, VendorErrorMapping> = {
  'record-not-found': {
    category: InternalErrorCategory.NOT_FOUND,
    retryable: false,
    action: 'Proceed with fresh KYC, schedule upload',
  },
  'duplicate-upload': {
    category: InternalErrorCategory.CONFLICT,
    retryable: false,
    action: 'Link existing CKYC record instead',
  },
  'certificate-expired': {
    category: InternalErrorCategory.AUTHENTICATION_ERROR,
    retryable: false,
    action: 'Alert ops team for cert renewal',
  },
  timeout: {
    category: InternalErrorCategory.VENDOR_ERROR,
    retryable: true,
    action: 'Retry with extended timeout (2x)',
  },
  'schema-validation-failure': {
    category: InternalErrorCategory.VALIDATION_ERROR,
    retryable: false,
    action: 'Fix payload schema and resubmit — do not retry as-is',
  },
};

export const CKYC_DEFAULT_MAPPING: VendorErrorMapping = {
  category: InternalErrorCategory.VENDOR_ERROR,
  retryable: false,
  action: 'Log and escalate — unmapped CKYC error code',
};

export function mapCkycError(vendorCode: string): VendorErrorMapping {
  return CKYC_ERROR_MAP[vendorCode] ?? CKYC_DEFAULT_MAPPING;
}
