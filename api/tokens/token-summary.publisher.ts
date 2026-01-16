import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TokensService } from './tokens.service';
import { newRedisSubscriber, publishJson } from '../../lib/redis.js';

const DIRTY_CHANNEL = process.env.RT_TOKEN_DIRTY_CHANNEL || 'rt:token:dirty';
const SUMMARY_CHANNEL = process.env.RT_TOKEN_SUMMARY_CHANNEL || 'rt:token:summary';
const MIN_INTERVAL_MS = Number(process.env.RT_TOKEN_SUMMARY_MIN_MS || 1000);

@Injectable()
export class TokenSummaryPublisher implements OnModuleInit, OnModuleDestroy {
  private sub: any = null;
  private lastSent = new Map<string, number>();

  constructor(private readonly tokens: TokensService) {}

  async onModuleInit() {
    try {
      this.sub = await newRedisSubscriber();
      await this.sub.subscribe(DIRTY_CHANNEL);
      this.sub.on('message', (channel: string, message: string) => {
        if (channel !== DIRTY_CHANNEL) return;
        this.handleMessage(message).catch(() => {});
      });
    } catch {
      // If redis is down, skip publisher
    }
  }

  async onModuleDestroy() {
    try {
      if (this.sub) await this.sub.quit();
    } catch {}
    this.sub = null;
  }

  private async handleMessage(message: string) {
    let payload: any = null;
    try { payload = JSON.parse(message); } catch { return; }
    const tokenId = payload?.token_id != null ? String(payload.token_id) : null;
    if (!tokenId) return;

    const now = Date.now();
    const last = this.lastSent.get(tokenId) || 0;
    if (now - last < MIN_INTERVAL_MS) return;
    this.lastSent.set(tokenId, now);

    const summary = await this.tokens.getOne(tokenId, { priceSource: 'best' });
    if (!summary || summary.success !== true) return;

    const out = {
      type: 'token_summary',
      ts: new Date().toISOString(),
      token_id: tokenId,
      data: summary.data,
    };
    await publishJson(SUMMARY_CHANNEL, out);
  }
}
