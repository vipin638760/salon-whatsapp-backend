import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FirestoreModule } from './firestore/firestore.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { AccountingModule } from './accounting/accounting.module';
import { ReportingModule } from './reporting/reporting.module';
import { ApprovalsModule } from './approvals/approvals.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    FirestoreModule, // global — source of truth (same project as vcut-app)
    AuditModule, // global — immutable action log
    AuthModule, // phone → role (admin | accountant[+branch] | employee)
    ApprovalsModule, // prepare → confirm → post gate for every write
    AccountingModule, // captain draft accounting → existing `entries`
    ReportingModule, // owner read commands (cash movement + Full Net P&L)
    WhatsappModule, // Meta webhook in, messages out — wires everything
  ],
})
export class AppModule {}
