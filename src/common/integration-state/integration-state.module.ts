import { Global, Module } from '@nestjs/common';
import { IntegrationStateService } from './integration-state.service';

/** Global: the gateway factory, the AI provider and the health probe all need it. */
@Global()
@Module({
  providers: [IntegrationStateService],
  exports: [IntegrationStateService],
})
export class IntegrationStateModule {}
