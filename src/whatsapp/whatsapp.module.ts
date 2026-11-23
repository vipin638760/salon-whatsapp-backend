import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { MessageRouterService } from './message-router.service';
import { AuthModule } from '../auth/auth.module';
import { AccountingModule } from '../accounting/accounting.module';
import { ReportingModule } from '../reporting/reporting.module';

@Module({
  imports: [AuthModule, AccountingModule, ReportingModule],
  controllers: [WhatsappController],
  providers: [WhatsappService, MessageRouterService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
