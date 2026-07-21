// src/application/use-cases/get-risk-score.use-case.ts
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { CustomerNotFoundError } from './recalculate-risk-score.use-case';

export class GetRiskScoreUseCase {
  constructor(private readonly customerRepository: CustomerRepositoryPort) {}

  async execute(customerId: string) {
    const customer = await this.customerRepository.findById(customerId);
    if (!customer) {
      throw new CustomerNotFoundError(customerId);
    }
    const props = customer.toProps();
    return {
      customerId: props.customerId,
      riskScore: props.riskScore.getValue(),
      riskFactors: props.riskFactors,
      exceedsEddThreshold: props.riskScore.exceedsEddThreshold(),
    };
  }
}
