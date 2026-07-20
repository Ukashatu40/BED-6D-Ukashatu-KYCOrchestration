// src/application/ports/customer-repository.port.ts
import { Customer } from '../../domain/entities/customer.entity';

export interface CustomerRepositoryPort {
  save(customer: Customer): Promise<void>;
  findById(customerId: string): Promise<Customer | null>;
  findByExternalId(externalId: string): Promise<Customer | null>;
  findByCkycKin(kin: string): Promise<Customer | null>;
  findDueForReVerification(asOf: Date): Promise<Customer[]>;
}
