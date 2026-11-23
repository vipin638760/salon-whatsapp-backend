import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * Validates Meta's X-Hub-Signature-256 over the RAW request body using the
 * app secret. Without this, anyone could POST fake bookings/payments.
 * Relies on main.ts capturing req.rawBody.
 */
@Injectable()
export class MetaSignatureGuard implements CanActivate {
  private readonly logger = new Logger(MetaSignatureGuard.name);

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const secret = process.env.WHATSAPP_APP_SECRET;
    const header = req.header('x-hub-signature-256');

    if (!secret || !header || !req.rawBody) {
      this.logger.warn('Missing app secret, signature header, or raw body.');
      return false;
    }

    const expected = 'sha256=' + createHmac('sha256', secret).update(req.rawBody).digest('hex');
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
