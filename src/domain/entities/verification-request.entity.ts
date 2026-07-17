// src/domain/entities/verification-request.entity.ts
import { KycTier } from '../value-objects/kyc-tier.enum';
import { VerificationStatus } from '../value-objects/verification-status.enum';

export interface VerificationRequestProps {
  requestId: string;
  customerId: string;
  tier: KycTier;
  workflowConfigVersion: string;
  currentStep: string | null;
  status: VerificationStatus;
  initiatedBy: string;
  createdAt: Date;
  completedAt?: Date | null;
  expiresAt: Date;
  retryOf?: string | null;
}

export class VerificationRequest {
  private props: VerificationRequestProps;

  private constructor(props: VerificationRequestProps) {
    this.props = props;
  }

  static create(
    props: Omit<VerificationRequestProps, 'createdAt' | 'status' | 'currentStep'>,
  ): VerificationRequest {
    if (props.expiresAt <= new Date()) {
      throw new Error('VerificationRequest.expiresAt must be in the future');
    }
    return new VerificationRequest({
      ...props,
      currentStep: null,
      status: VerificationStatus.NOT_STARTED,
      createdAt: new Date(),
    });
  }

  static reconstitute(props: VerificationRequestProps): VerificationRequest {
    return new VerificationRequest(props);
  }

  get requestId(): string {
    return this.props.requestId;
  }

  get status(): VerificationStatus {
    return this.props.status;
  }

  get currentStep(): string | null {
    return this.props.currentStep;
  }

  get isExpired(): boolean {
    return !this.props.completedAt && this.props.expiresAt <= new Date();
  }

  advanceToStep(stepName: string): void {
    if (this.props.completedAt) {
      throw new Error('Cannot advance a completed verification request');
    }
    this.props.currentStep = stepName;
  }

  markCompleted(finalStatus: VerificationStatus.VERIFIED | VerificationStatus.REJECTED): void {
    this.props.status = finalStatus;
    this.props.completedAt = new Date();
  }

  toProps(): Readonly<VerificationRequestProps> {
    return { ...this.props };
  }
}
