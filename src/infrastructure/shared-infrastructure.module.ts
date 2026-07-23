// src/infrastructure/shared-infrastructure.module.ts
import { Global, Module } from '@nestjs/common';
import { InMemoryNotification } from './notification/in-memory-notification';
import { InMemoryTimerRepository } from './persistence/in-memory-timer-repository';
import { InMemoryWebhookDeduplication } from './vendors/in-memory-webhook-deduplication';
import { TimerService } from '../application/workflow-engine/timer.service';
import { VendorAdapterFactory } from './vendors/vendor-adapter.factory';
import { loadVendorsConfig } from './vendors/vendor-config.loader';
import { VendorClientRegistry } from './vendors/vendor-client-registry.interface';
import { WorkflowConfigProvider } from '../application/use-cases/initiate-kyc.use-case';
import { loadWorkflowConfig } from '../application/workflow-engine/workflow-config.loader';
import { KycTier } from '../domain/value-objects/kyc-tier.enum';
import { WorkflowConfigYaml } from '../application/workflow-engine/workflow-config.schema';
import {
  NOTIFICATION_PORT,
  TIMER_SERVICE,
  VENDOR_FACTORY,
  WORKFLOW_CONFIG_PROVIDER,
} from '../api/shared.tokens';
import { WebhookDeduplicationPort } from '../application/ports/webhook-deduplication.port';

/**
 * NOTE ON VENDOR CLIENTS: real Digilocker/CKYC/SigniVision/GlobalWatch
 * sandbox HTTP/SOAP clients were never built (see Day 2 status notes —
 * the *Adapter classes are fully complete and tested against mocked
 * clients, but the actual live-sandbox client implementations are Day 2+
 * integration work outside this timeline). This factory wires
 * *placeholder* clients that throw on every call, so the app boots
 * correctly and every code path up to "an adapter method was invoked" is
 * real, but no e2e test can exercise an actual vendor round-trip — only
 * up to the adapter boundary. Flagged explicitly rather than silently
 * stubbing success responses, which would be misleading in a demo.
 */
function buildPlaceholderVendorClients(): VendorClientRegistry {
  const notImplemented = (method: string) => () => {
    throw new Error(
      `${method}: real vendor sandbox client not implemented — see shared-infrastructure.module.ts note`,
    );
  };
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return {
    digilocker: {
      exchangeAuthCode: notImplemented('digilocker.exchangeAuthCode'),
      refreshAccessToken: notImplemented('digilocker.refreshAccessToken'),
      revokeToken: notImplemented('digilocker.revokeToken'),
      fetchDocument: notImplemented('digilocker.fetchDocument'),
      getConsentStatus: notImplemented('digilocker.getConsentStatus'),
    },
    ckyc: {
      search: notImplemented('ckyc.search'),
      download: notImplemented('ckyc.download'),
      upload: notImplemented('ckyc.upload'),
      uploadBatch: notImplemented('ckyc.uploadBatch'),
    },
    videoKyc: {
      createSession: notImplemented('videoKyc.createSession'),
      fetchRecordingUrl: notImplemented('videoKyc.fetchRecordingUrl'),
    },
    amlScreening: {
      screenRealTime: notImplemented('amlScreening.screenRealTime'),
      screenBatch: notImplemented('amlScreening.screenBatch'),
      registerOngoingMonitoring: notImplemented('amlScreening.registerOngoingMonitoring'),
    },
  } as unknown as VendorClientRegistry;
}

function buildWorkflowConfigProvider(): WorkflowConfigProvider {
  const cache = new Map<KycTier, WorkflowConfigYaml>();
  const pathByTier: Record<KycTier, string> = {
    [KycTier.MINIMUM]: 'config/workflows/minimum-kyc.yml',
    [KycTier.FULL]: 'config/workflows/full-kyc.yml',
    [KycTier.EDD]: 'config/workflows/edd.yml',
  };
  return {
    getConfig(tier: KycTier): WorkflowConfigYaml {
      const cached = cache.get(tier);
      if (cached) return cached;
      const loaded = loadWorkflowConfig(pathByTier[tier]);
      cache.set(tier, loaded);
      return loaded;
    },
  };
}

@Global()
@Module({
  providers: [
    { provide: NOTIFICATION_PORT, useClass: InMemoryNotification },
    { provide: TIMER_SERVICE, useFactory: () => new TimerService(new InMemoryTimerRepository()) },
    { provide: WORKFLOW_CONFIG_PROVIDER, useFactory: buildWorkflowConfigProvider },
    {
      provide: VENDOR_FACTORY,
      useFactory: () => {
        const config = loadVendorsConfig('config/vendors/vendors.yml');
        const clients = buildPlaceholderVendorClients();
        const dedup: WebhookDeduplicationPort = new InMemoryWebhookDeduplication();
        return new VendorAdapterFactory(config, clients, dedup);
      },
    },
  ],
  exports: [NOTIFICATION_PORT, TIMER_SERVICE, WORKFLOW_CONFIG_PROVIDER, VENDOR_FACTORY],
})
export class SharedInfrastructureModule {}
