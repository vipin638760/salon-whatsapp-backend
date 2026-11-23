import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/** Thin wrapper over the Meta Graph send-message endpoint. */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  private get base() {
    const v = process.env.WHATSAPP_GRAPH_VERSION ?? 'v21.0';
    const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
    return `https://graph.facebook.com/${v}/${id}/messages`;
  }

  async sendText(to: string, body: string): Promise<void> {
    await this.post({ messaging_product: 'whatsapp', to, type: 'text', text: { body } });
  }

  /** Business-initiated messages (reminders, owner summaries) need an approved template. */
  async sendTemplate(to: string, template: string, lang = 'en', components: unknown[] = []): Promise<void> {
    await this.post({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: template, language: { code: lang }, components },
    });
  }

  private async post(payload: Record<string, unknown>): Promise<void> {
    try {
      await axios.post(this.base, payload, {
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
      });
    } catch (e: any) {
      this.logger.error(`send failed: ${e?.response?.data?.error?.message ?? e.message}`);
      throw e;
    }
  }
}
