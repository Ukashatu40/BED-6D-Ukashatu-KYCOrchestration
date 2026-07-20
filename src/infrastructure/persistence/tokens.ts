// src/infrastructure/persistence/tokens.ts
/** DI injection tokens for port interfaces — TypeScript interfaces have no runtime representation, so NestJS needs a string/symbol token to bind an interface type to a concrete provider. */
export const KMS_PORT = Symbol('KMS_PORT');
export const CUSTOMER_REPOSITORY = Symbol('CUSTOMER_REPOSITORY');
export const VERIFICATION_REQUEST_REPOSITORY = Symbol('VERIFICATION_REQUEST_REPOSITORY');
export const DOCUMENT_REPOSITORY = Symbol('DOCUMENT_REPOSITORY');
export const AUDIT_TRAIL_PORT = Symbol('AUDIT_TRAIL_PORT');
