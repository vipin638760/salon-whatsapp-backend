import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Body,
  UseGuards,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { MetaSignatureGuard } from './meta-signature.guard';
import { MessageRouterService } from './message-router.service';

/**
 * The only inbound surface Meta talks to.
 *  GET  /webhooks/whatsapp  → verification handshake
 *  POST /webhooks/whatsapp  → message delivery (signature-guarded, idempotent)
 */
@Controller('webhooks/whatsapp')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(private readonly router: MessageRouterService) {}

  // Meta verification handshake — echo hub.challenge when the token matches.
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return challenge;
    }
    return 'forbidden';
  }

  // Always 200 fast so Meta does not retry-storm; processing is async & idempotent.
  @Post()
  @HttpCode(200)
  @UseGuards(MetaSignatureGuard)
  async receive(@Req() req: Request, @Body() body: any): Promise<string> {
    // Fire-and-forget: router dedups by message id, so Meta redelivery is safe.
    this.router.handleWebhook(body).catch((e) =>
      this.logger.error(`webhook processing failed: ${e?.message}`, e?.stack),
    );
    return 'EVENT_RECEIVED';
  }
}
