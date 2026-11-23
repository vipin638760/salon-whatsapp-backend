import { Global, Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';

// Global: every write path goes through prepare → confirm → post.
@Global()
@Module({
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
