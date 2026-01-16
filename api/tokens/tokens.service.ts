import { Injectable } from '@nestjs/common';
import { PgService } from '../db/pg.service';
import { QueryResultRow } from 'pg';

type Bucket = '30m'|'1h'|'4h'|'24h';
type PriceSource = 'best'|'uzig'|'pool'|'all';
type DominantSide = 'base'|'quote'|'auto';

@Injectable()
export class TokensService {
  constructor(private readonly pg: PgService) {}

  // --------------------------- helpers ---------------------------

  private async resolveTokenId(idOrDenomOrSymbol: string): Promise<{
    token_id: number;
    denom: string;
    symbol: string | null;
    name: string | null;
    exponent: number | null;
    type?: string | null;
  } | null> {
    const sql = `
      WITH inp AS (SELECT $1::text AS q)
      SELECT token_id, denom, symbol, name, exponent, type
      FROM tokens t
      WHERE t.denom = (SELECT q FROM inp)
         OR lower(t.denom) = lower((SELECT q FROM inp))
         OR t.symbol = (SELECT q FROM inp)
         OR lower(t.symbol) = lower((SELECT q FROM inp))
         OR t.name ILIKE (SELECT q FROM inp)
         OR t.token_id::text = (SELECT q FROM inp)
      ORDER BY
        CASE WHEN t.denom = (SELECT q FROM inp) THEN 0 ELSE 1 END,
        CASE WHEN lower(t.denom) = lower((SELECT q FROM inp)) THEN 0 ELSE 1 END,
        CASE WHEN lower(t.symbol) = lower((SELECT q FROM inp)) THEN 0 ELSE 1 END,
        t.token_id DESC
      LIMIT 1`;
    const r = await this.pg.query<{
      token_id: number;
      denom: string;
      symbol: string | null;
      name: string | null;
      exponent: number | null;
    }>(sql, [idOrDenomOrSymbol]);
    return r.rows[0] ?? null;
  }

  private async zigUsd(): Promise<number> {
    const r = await this.pg.query(`SELECT zig_usd FROM exchange_rates ORDER BY ts DESC LIMIT 1`);
    return r.rows[0]?.zig_usd ? Number(r.rows[0].zig_usd) : 0;
  }

  private isUzigToken(tok: { denom?: string | null; symbol?: string | null } | string) {
    const raw = typeof tok === 'string' ? tok : (tok?.denom || tok?.symbol || '');
    const v = String(raw || '').toLowerCase();
    return v === 'uzig' || v === 'zig';
  }

  private async hasUzigPools(tokenId: number): Promise<boolean> {
    const r = await this.pg.query(
      `SELECT 1 FROM pools WHERE base_token_id=$1 AND is_uzig_quote=TRUE LIMIT 1`,
      [tokenId]
    );
    return r.rows.length > 0;
  }

  private async resolveDominantSide(tokenId: number, dominant?: DominantSide): Promise<'base'|'quote'> {
    const want = (dominant || 'base') as DominantSide;
    if (want !== 'auto') return want;
    if (await this.hasUzigPools(tokenId)) return 'base';
    const r = await this.pg.query(`SELECT 1 FROM pools WHERE quote_token_id=$1 LIMIT 1`, [tokenId]);
    return r.rows.length > 0 ? 'quote' : 'base';
  }

  private async latestTokenPriceInZig(tokenId: number): Promise<number|null> {
    const r = await this.pg.query(
      `SELECT price_in_zig FROM prices WHERE token_id=$1 ORDER BY updated_at DESC LIMIT 1`,
      [tokenId]
    );
    return r.rows[0]?.price_in_zig != null ? Number(r.rows[0].price_in_zig) : null;
  }

  private async latestPoolPriceInQuote(poolId: number): Promise<number|null> {
    const t = await this.pg.query(
      `SELECT price_in_quote
         FROM trades
        WHERE pool_id=$1 AND price_in_quote IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [poolId]
    );
    if (t.rows[0]?.price_in_quote != null) return Number(t.rows[0].price_in_quote);

    const o = await this.pg.query(
      `SELECT close FROM ohlcv_1m WHERE pool_id=$1 ORDER BY bucket_start DESC LIMIT 1`,
      [poolId]
    );
    if (o.rows[0]?.close != null) return Number(o.rows[0].close);

    const r = await this.pg.query(
      `SELECT ps.reserve_base_base, ps.reserve_quote_base, b.exponent AS base_exp, q.exponent AS quote_exp
         FROM pool_state ps
         JOIN pools p ON p.pool_id=ps.pool_id
         JOIN tokens b ON b.token_id=p.base_token_id
         JOIN tokens q ON q.token_id=p.quote_token_id
        WHERE ps.pool_id=$1`,
      [poolId]
    );
    const row = r.rows[0];
    if (!row) return null;
    const baseExp = row.base_exp != null ? Number(row.base_exp) : 6;
    const quoteExp = row.quote_exp != null ? Number(row.quote_exp) : 6;
    const baseDisp = Number(row.reserve_base_base || 0) / Math.pow(10, baseExp);
    const quoteDisp = Number(row.reserve_quote_base || 0) / Math.pow(10, quoteExp);
    if (baseDisp > 0 && quoteDisp > 0) return quoteDisp / baseDisp;
    return null;
  }

  private async baseUsdForPool(poolId: number, zigUsd: number): Promise<number|null> {
    const r = await this.pg.query(
      `SELECT b.token_id, b.denom
         FROM pools p
         JOIN tokens b ON b.token_id=p.base_token_id
        WHERE p.pool_id=$1`,
      [poolId]
    );
    const row = r.rows[0];
    if (!row) return null;
    if (this.isUzigToken(row.denom)) return zigUsd || null;
    const basePriceZig = await this.latestTokenPriceInZig(Number(row.token_id));
    if (basePriceZig == null || !zigUsd) return null;
    return basePriceZig * zigUsd;
  }

  private async resolveUsdcToken() {
    const picks = ['USDC', 'usdc', 'uusdc'];
    for (const p of picks) {
      const t = await this.resolveTokenId(p);
      if (t) return t;
    }
    return null;
  }

  private async pickUsdcZigPool(usdcId: number, uzigId: number): Promise<number|null> {
    const r = await this.pg.query<{ pool_id: number }>(`
      WITH cps AS (
        SELECT pool_id
        FROM pools
        WHERE base_token_id=$1 AND quote_token_id=$2
      ),
      act AS (
        SELECT cp.pool_id, MAX(o.bucket_start) AS last_bar
        FROM cps cp
        LEFT JOIN ohlcv_1m o ON o.pool_id=cp.pool_id
        GROUP BY cp.pool_id
      )
      SELECT pool_id FROM act ORDER BY last_bar DESC NULLS LAST LIMIT 1
    `, [usdcId, uzigId]);
    return r.rows[0]?.pool_id ?? null;
  }

  private async usdcPriceInZig(poolId: number, usdcId: number): Promise<number|null> {
    const pr = await this.pg.query(
      `SELECT price_in_zig FROM prices WHERE token_id=$1 AND pool_id=$2 ORDER BY updated_at DESC LIMIT 1`,
      [usdcId, poolId]
    );
    if (pr.rows[0]?.price_in_zig != null) return Number(pr.rows[0].price_in_zig);
    const o = await this.pg.query(
      `SELECT close FROM ohlcv_1m WHERE pool_id=$1 ORDER BY bucket_start DESC LIMIT 1`,
      [poolId]
    );
    return o.rows[0]?.close != null ? Number(o.rows[0].close) : null;
  }

  private async zigChangeFromUsdcPool(poolId: number, minutes: number): Promise<number|null> {
    const q = `
      WITH last AS (
        SELECT close FROM ohlcv_1m WHERE pool_id=$1 ORDER BY bucket_start DESC LIMIT 1
      ),
      prev AS (
        SELECT close FROM ohlcv_1m
        WHERE pool_id=$1 AND bucket_start <= now() - ($2 || ' minutes')::interval
        ORDER BY bucket_start DESC LIMIT 1
      )
      SELECT last.close AS last_close, prev.close AS prev_close
      FROM last, prev
    `;
    const r = await this.pg.query<{ last_close: number|null; prev_close: number|null }>(q, [poolId, minutes]);
    const last = r.rows[0]?.last_close != null ? Number(r.rows[0].last_close) : null;
    const prev = r.rows[0]?.prev_close != null ? Number(r.rows[0].prev_close) : null;
    if (!last || !prev) return null;
    const nowInv = 1 / last;
    const prevInv = 1 / prev;
    return ((nowInv - prevInv) / prevInv) * 100;
  }

  // Swap-like helpers for best pool selection (mirrors Express)
  private pairFee(pairType: string | null): number {
    if (!pairType) return 0.003;
    const t = String(pairType).toLowerCase();
    if (t === 'xyk') return 0.0001;
    if (t === 'concentrated') return 0.01;
    const m = t.match(/xyk[_-](\d+)/);
    if (m) {
      const bps = Number(m[1]);
      if (Number.isFinite(bps)) return bps / 10_000;
    }
    return 0.003;
  }

  private simulateXYK({ fromIsZig, amountIn, Rz, Rt, fee }: { fromIsZig: boolean; amountIn: number; Rz: number; Rt: number; fee: number; }) {
    if (!(Rz > 0 && Rt > 0) || !(amountIn > 0)) {
      return { out: 0, price: 0, impact: 0 };
    }
    const mid = Rz / Rt;
    const xin = amountIn * (1 - fee);
    if (fromIsZig) {
      const outToken = (xin * Rt) / (Rz + xin);
      const effZigPerToken = amountIn / Math.max(outToken, 1e-18);
      const impact = mid > 0 ? (effZigPerToken / mid) - 1 : 0;
      return { out: outToken, price: effZigPerToken, impact };
    } else {
      const outZig = (xin * Rz) / (Rt + xin);
      const effZigPerToken = outZig / amountIn;
      const impact = mid > 0 ? (mid / Math.max(effZigPerToken, 1e-18)) - 1 : 0;
      return { out: outZig, price: effZigPerToken, impact };
    }
  }

  private async loadUzigPoolsForToken(tokenId: number): Promise<any[]> {
    const { rows } = await this.pg.query(
      `
      SELECT
        p.pool_id,
        p.pair_contract,
        p.pair_type,
        pr.price_in_zig,
        ps.reserve_base_base   AS res_base_base,
        ps.reserve_quote_base  AS res_quote_base,
        tb.exponent            AS base_exp,
        tq.exponent            AS quote_exp,
        COALESCE(pm.tvl_zig,0) AS tvl_zig
      FROM pools p
      JOIN prices pr           ON pr.pool_id = p.pool_id AND pr.token_id = $1
      LEFT JOIN pool_state ps  ON ps.pool_id = p.pool_id
      JOIN tokens tb           ON tb.token_id = p.base_token_id
      JOIN tokens tq           ON tq.token_id = p.quote_token_id
      LEFT JOIN pool_matrix pm ON pm.pool_id = p.pool_id AND pm.bucket = '24h'
      WHERE p.is_uzig_quote = TRUE
      `,
      [tokenId]
    );

    return rows
      .map((r: any) => {
        const Rt = Number(r.res_base_base  || 0) / Math.pow(10, Number(r.base_exp  || 0));
        const Rz = Number(r.res_quote_base || 0) / Math.pow(10, Number(r.quote_exp || 0));
        return {
          poolId:       Number(r.pool_id),
          pairContract: r.pair_contract,
          pairType:     r.pair_type,
          priceInZig:   Number(r.price_in_zig || 0),
          tokenReserve: Rt,
          zigReserve:   Rz,
          tvlZig:       Number(r.tvl_zig || 0),
        };
      });
  }

  private pickBySimulation(pools: any[], fromIsZig: boolean, amountIn: number) {
    let best: any = null;
    for (const p of pools) {
      const fee = this.pairFee(p.pairType);
      const hasRes = p.zigReserve > 0 && p.tokenReserve > 0;
      const sim = hasRes
        ? this.simulateXYK({ fromIsZig, amountIn, Rz: p.zigReserve, Rt: p.tokenReserve, fee })
        : null;
      const score = sim ? sim.out : 0;
      const cand = { ...p, fee, sim, score };
      if (!best || cand.score > best.score) best = cand;
    }
    return best;
  }

  private defaultAmount(side: 'buy'|'sell', zigUsd: number, pools: any[]) {
    const targetUsd = 100;
    const zigAmt = targetUsd / Math.max(zigUsd, 1e-9);
    if (side === 'buy') return zigAmt;
    const avgMid = pools.length
      ? pools.reduce((s, p) => s + (p.priceInZig || 0), 0) / pools.length
      : 1;
    return zigAmt / Math.max(avgMid, 1e-12);
  }

  private async bestSellPool(tokenId: number, { amountIn, minTvlZig = 0, zigUsd }: { amountIn?: number; minTvlZig?: number; zigUsd: number; }) {
    const pools = (await this.loadUzigPoolsForToken(tokenId)).filter(p => p.tvlZig >= minTvlZig);
    if (!pools.length) return null;
    const amt = Number.isFinite(amountIn) ? Number(amountIn) : this.defaultAmount('sell', zigUsd, pools);
    const pick = this.pickBySimulation(pools, false, amt);
    if (!pick) return null;
    return { ...pick, amtUsed: amt };
  }

  private async changePctForMinutes(poolId: number, minutes: number, invert = false): Promise<number|null> {
    const q = `
      WITH last AS (
        SELECT close FROM ohlcv_1m WHERE pool_id=$1 ORDER BY bucket_start DESC LIMIT 1
      ),
      prev AS (
        SELECT close FROM ohlcv_1m
        WHERE pool_id=$1 AND bucket_start <= now() - ($2 || ' minutes')::interval
        ORDER BY bucket_start DESC LIMIT 1
      )
      SELECT last.close AS last_close, prev.close AS prev_close
      FROM last, prev
    `;
    const r = await this.pg.query<{ last_close: number|null; prev_close: number|null }>(q, [poolId, minutes]);
    const lastRaw = r.rows[0]?.last_close != null ? Number(r.rows[0].last_close) : null;
    const prevRaw = r.rows[0]?.prev_close != null ? Number(r.rows[0].prev_close) : null;
    if (!lastRaw || !prevRaw) return null;
    const last = invert ? (1 / lastRaw) : lastRaw;
    const prev = invert ? (1 / prevRaw) : prevRaw;
    if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return null;
    return ((last - prev) / prev) * 100;
  }

  private async pickPoolBySide(tokenId: number, side: 'base'|'quote', onlyUzig = false): Promise<number|null> {
    const col = side === 'quote' ? 'quote_token_id' : 'base_token_id';
    const q = `
      WITH cps AS (
        SELECT p.pool_id
        FROM pools p
        WHERE p.${col}=$1 ${onlyUzig ? 'AND p.is_uzig_quote=TRUE' : ''}
      ),
      act AS (
        SELECT cp.pool_id, MAX(o.bucket_start) AS last_bar
        FROM cps cp
        LEFT JOIN ohlcv_1m o ON o.pool_id = cp.pool_id
        GROUP BY cp.pool_id
      )
      SELECT pool_id
      FROM act
      ORDER BY last_bar DESC NULLS LAST
      LIMIT 1;
    `;
    const r = await this.pg.query<{ pool_id: number }>(q, [tokenId]);
    return r.rows[0]?.pool_id ?? null;
  }

  private toNum(x: any): number|null {
    return x == null ? null : Number(x);
  }

  // --------------------------- endpoints ---------------------------

  async listTokens(params: {
    search?: string;
    sort: 'mcap'|'price'|'fdv'|'vol'|'tx'|'created';
    dir: 'asc'|'desc';
    priceSource: PriceSource; // reserved, you can extend list logic later
    bucket: Bucket;
    includeChange: boolean;
    includeBest: boolean;
    minBestTvl: number;
    amt?: number;
    limit: number;
    offset: number;
  }) {
    const { search, sort, dir, bucket, includeChange, includeBest, minBestTvl, amt, limit, offset } = params;

    const orderBy =
      sort === 'price'   ? `COALESCE(tm.price_in_zig,0) ${dir.toUpperCase()}` :
      sort === 'fdv'     ? `COALESCE(tm.fdv_zig,0) ${dir.toUpperCase()}` :
      sort === 'vol'     ? `COALESCE(a.vol_zig,0) ${dir.toUpperCase()}` :
      sort === 'tx'      ? `COALESCE(a.tx,0) ${dir.toUpperCase()}` :
      sort === 'created' ? `t.created_at ${dir.toUpperCase()}` :
                           `COALESCE(tm.mcap_zig,0) ${dir.toUpperCase()}`;

    const args: any[] = [bucket];
    let where = '1=1';
    if (search) {
      args.push(`%${search}%`);
      where = `(t.symbol ILIKE $${args.length} OR t.name ILIKE $${args.length} OR t.denom ILIKE $${args.length})`;
    }
    args.push(limit, offset);

    const sql = `
      WITH agg AS (
        SELECT p.base_token_id AS token_id,
               SUM(pm.vol_buy_zig + pm.vol_sell_zig) AS vol_zig,
               SUM(pm.tx_buy + pm.tx_sell) AS tx
        FROM pool_matrix pm
        JOIN pools p ON p.pool_id=pm.pool_id
        WHERE pm.bucket=$1
        GROUP BY p.base_token_id
      )
      SELECT
        t.token_id, t.denom, t.symbol, t.name, t.image_uri, t.created_at,
        tm.price_in_zig, tm.mcap_zig, tm.fdv_zig, tm.holders,
        a.vol_zig, a.tx
      FROM tokens t
      LEFT JOIN token_matrix tm ON tm.token_id=t.token_id AND tm.bucket=$1
      LEFT JOIN agg a ON a.token_id=t.token_id
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT $${args.length - 1} OFFSET $${args.length};
    `;

    const { rows } = await this.pg.query(sql, args);
    const zigUsd = await this.zigUsd();
    let changeMap = new Map<string, number|null>();
    if (includeChange) {
      const changes: [string, number|null][] = [];
      for (const r of rows) {
        const best = await this.bestSellPool(Number(r.token_id), { zigUsd });
        const poolId = best?.poolId ?? best?.pool_id ?? null;
        const pct = poolId ? await this.changePctForMinutes(poolId, 1440) : null;
        changes.push([String(r.token_id), pct]);
      }
      changeMap = new Map(changes);
    }

    const bestMap = new Map<string, any>();
    if (includeBest) {
      const picks = await Promise.all(rows.map(async (r: any) => {
        const pick = await this.bestSellPool(Number(r.token_id), { amountIn: amt, minTvlZig: minBestTvl, zigUsd });
        return { id: r.token_id, pick };
      }));
      for (const x of picks) bestMap.set(String(x.id), x.pick);
    }

    const data = rows.map((r: any) => {
      const priceN = this.toNum(r.price_in_zig);
      const mcapN  = this.toNum(r.mcap_zig);
      const fdvN   = this.toNum(r.fdv_zig);
      const volN   = this.toNum(r.vol_zig) ?? 0;
      return {
        tokenId: String(r.token_id),
        denom: r.denom,
        symbol: r.symbol,
        name: r.name,
        imageUri: r.image_uri,
        createdAt: r.created_at,
        priceNative: priceN,
        priceUsd: priceN != null ? priceN * zigUsd : null,
        mcapNative: mcapN,
        mcapUsd: mcapN != null ? mcapN * zigUsd : null,
        fdvNative: fdvN,
        fdvUsd: fdvN != null ? fdvN * zigUsd : null,
        holders: r.holders != null ? Number(r.holders) : 0,
        volNative: volN,
        volUsd: volN * zigUsd,
        tx: r.tx != null ? Number(r.tx) : 0,
        ...(includeChange ? { change24hPct: changeMap.get(String(r.token_id)) ?? null } : {}),
        ...(includeBest ? { bestPool: (bestMap.get(String(r.token_id)) ? {
          poolId: bestMap.get(String(r.token_id))?.poolId ?? null,
          pairContract: bestMap.get(String(r.token_id))?.pairContract ?? null,
          pairType: bestMap.get(String(r.token_id))?.pairType ?? null,
          fee: bestMap.get(String(r.token_id))?.fee ?? null,
          priceNativeMid: bestMap.get(String(r.token_id))?.priceInZig ?? null,
          tvlNative: bestMap.get(String(r.token_id))?.tvlZig ?? null,
          reserves: bestMap.get(String(r.token_id)) ? { zig: bestMap.get(String(r.token_id))?.zigReserve, token: bestMap.get(String(r.token_id))?.tokenReserve } : null,
          sim: bestMap.get(String(r.token_id))?.sim ?? null,
          amtUsed: bestMap.get(String(r.token_id))?.amtUsed ?? null
        } : null) } : {})
      };
    });

    return { success: true, data };
  }

  private async getUzigSummary(
    tok: { token_id: number; denom: string; symbol: string | null; name: string | null },
    s: any,
    exp: number,
    circ: number | null,
    max: number | null,
    zigUsd: number,
    ibcStats: any
  ) {
    const usdc = await this.resolveUsdcToken();
    const poolId = usdc ? await this.pickUsdcZigPool(usdc.token_id, tok.token_id) : null;
    const usdcPriceZig = poolId && usdc ? await this.usdcPriceInZig(poolId, usdc.token_id) : null;
    const priceUsd = usdcPriceZig && usdcPriceZig > 0 ? (1 / usdcPriceZig) : (zigUsd || null);
    const priceNative = 1;
    const priceSource = poolId ? 'usdc_invert' : 'fx';

    const changeFor = async (minutes: number) => {
      if (!poolId) return null;
      return await this.zigChangeFromUsdcPool(poolId, minutes);
    };
    const priceChange = {
      '30m': await changeFor(30),
      '1h' : await changeFor(60),
      '4h' : await changeFor(240),
      '24h': await changeFor(1440),
    };

    const buckets = ['30m','1h','4h','24h'] as const;
    const agg = await this.pg.query(`
      SELECT pm.bucket,
             COALESCE(SUM(pm.vol_buy_zig),0)    AS vbuy,
             COALESCE(SUM(pm.vol_sell_zig),0)   AS vsell,
             COALESCE(SUM(pm.tx_buy),0)         AS tbuy,
             COALESCE(SUM(pm.tx_sell),0)        AS tsell,
             COALESCE(SUM(pm.unique_traders),0) AS uniq,
             COALESCE(SUM(pm.tvl_zig),0)        AS tvl
        FROM pools p
        JOIN pool_matrix pm ON pm.pool_id=p.pool_id
       WHERE (p.base_token_id=$1 OR p.quote_token_id=$1)
         AND pm.bucket = ANY($2)
       GROUP BY pm.bucket
    `, [tok.token_id, buckets]);

    const map = new Map<string, any>(agg.rows.map((r: any) => [r.bucket, {
      vbuy: Number(r.vbuy || 0),
      vsell: Number(r.vsell || 0),
      tbuy: Number(r.tbuy || 0),
      tsell: Number(r.tsell || 0),
      uniq: Number(r.uniq || 0),
      tvl:  Number(r.tvl  || 0),
    }]));

    const fx = priceUsd ?? zigUsd ?? 0;
    const vol: Record<string, number> = {};
    const volUSD: Record<string, number> = {};
    const txBuckets: Record<string, number> = {};
    for (const b of buckets) {
      const r = map.get(b) || { vbuy:0, vsell:0, tbuy:0, tsell:0, uniq:0, tvl:0 };
      const v = r.vbuy + r.vsell;
      vol[b] = v;
      volUSD[b] = v * fx;
      txBuckets[b] = r.tbuy + r.tsell;
    }
    const r24 = map.get('24h') || { vbuy:0, vsell:0, tbuy:0, tsell:0, uniq:0, tvl:0 };

    const mcNative  = (priceNative != null && circ != null) ? circ * priceNative : null;
    const fdvNative = (priceNative != null && max  != null) ? max  * priceNative : null;
    const mcNativeAdj = mcNative != null ? mcNative
      : (ibcStats?.marketCapUsd != null && fx > 0 ? ibcStats.marketCapUsd / fx : null);

    const poolsCount = Number((await this.pg.query(
      `SELECT COUNT(*)::int AS c FROM pools WHERE base_token_id=$1 OR quote_token_id=$1`, [tok.token_id]
    )).rows[0]?.c || 0);

    const holders = Number((await this.pg.query(
      `SELECT holders_count FROM token_holders_stats WHERE token_id=$1`, [tok.token_id]
    )).rows[0]?.holders_count || 0);

    const creation = (await this.pg.query(
      `SELECT MIN(created_at) AS first_ts FROM pools WHERE base_token_id=$1 OR quote_token_id=$1`, [tok.token_id]
    )).rows[0]?.first_ts || null;

    const tw = await this.pg.query(`
      SELECT handle, user_id, name, is_blue_verified, verified_type, profile_picture, cover_picture,
             followers, following, created_at_twitter, last_refreshed
        FROM token_twitter WHERE token_id=$1
    `, [tok.token_id]);

    return {
      success: true,
      data: {
        token: {
          tokenId: String(tok.token_id),
          denom: tok.denom,
          symbol: tok.symbol,
          name: tok.name,
          display: tok.denom,
          exponent: exp,
          imageUri: s.image_uri,
          website: s.website,
          twitter: s.twitter,
          telegram: s.telegram,
          createdAt: s.created_at,
          description: s.description,
        },

        price: {
          source: priceSource,
          poolId: poolId ? String(poolId) : null,
          native: priceNative,
          usd: priceUsd,
          changePct: priceChange
        },

        mcapDetail: { native: mcNativeAdj, usd: mcNativeAdj != null ? mcNativeAdj * fx : ibcStats?.marketCapUsd ?? null },
        fdvDetail:  { native: fdvNative, usd:  fdvNative != null ? fdvNative  * fx : null },
        supply:     { circulating: circ, max },

        priceInNative: priceNative,
        priceInUsd:    priceUsd,
        priceSource:   priceSource,
        poolId:        poolId ? String(poolId) : null,
        pools:         poolsCount,
        holder:        holders,
        creationTime:  creation,
        circulatingSupply: circ,
        fdvNative,
        fdv:           fdvNative != null ? fdvNative * fx : null,
        mcNative:      mcNativeAdj,
        mc:            mcNativeAdj != null ? mcNativeAdj * fx : ibcStats?.marketCapUsd ?? null,

        priceChange,
        volume:    vol,
        volumeUSD: volUSD,
        txBuckets,
        uniqueTraders: r24.uniq,
        trade: r24.tbuy + r24.tsell,
        sell:  r24.tsell,
        buy:   r24.tbuy,
        v:     r24.vbuy + r24.vsell,
        vBuy:  r24.vbuy,
        vSell: r24.vsell,
        vUSD:  (r24.vbuy + r24.vsell) * fx,
        vBuyUSD:  r24.vbuy * fx,
        vSellUSD: r24.vsell * fx,

        liquidity:        r24.tvl * fx,
        liquidityNative:  r24.tvl,
        ...(ibcStats ? { ibcStats } : {})
      },
      twitter: tw.rows[0] ? {
        handle: tw.rows[0].handle,
        userId: tw.rows[0].user_id,
        name: tw.rows[0].name,
        isBlueVerified: !!tw.rows[0].is_blue_verified,
        verifiedType: tw.rows[0].verified_type,
        profilePicture: tw.rows[0].profile_picture,
        coverPicture: tw.rows[0].cover_picture,
        followers: tw.rows[0].followers != null ? Number(tw.rows[0].followers) : null,
        following: tw.rows[0].following != null ? Number(tw.rows[0].following) : null,
        createdAtTwitter: tw.rows[0].created_at_twitter,
        lastRefreshed: tw.rows[0].last_refreshed,
      } : null,
    };
  }

  async gainersOrLosers(board: 'gainers'|'losers', priceSource: PriceSource, bucket: Bucket, limit: number, offset: number, amt?: number, minBestTvl: number = 0) {
    const zigUsd = await this.zigUsd();
    const FETCH_LIMIT = 1000;

    const rows = await this.pg.query(`
      WITH agg AS (
        SELECT p.base_token_id AS token_id,
               SUM(pm.vol_buy_zig + pm.vol_sell_zig) AS vol_zig,
               SUM(pm.tx_buy + pm.tx_sell) AS tx
        FROM pool_matrix pm
        JOIN pools p ON p.pool_id=pm.pool_id
        WHERE pm.bucket=$1
        GROUP BY p.base_token_id
      ),
      base AS (
        SELECT t.token_id, t.denom, t.symbol, t.name, t.image_uri, t.created_at,
               tm.price_in_zig, tm.mcap_zig, tm.fdv_zig, tm.holders,
               a.vol_zig, a.tx
        FROM tokens t
        LEFT JOIN token_matrix tm ON tm.token_id=t.token_id AND tm.bucket=$1
        LEFT JOIN agg a ON a.token_id=t.token_id
      )
      SELECT * FROM base
      LIMIT $2 OFFSET 0
    `, [bucket, FETCH_LIMIT]);

    const changeMap = new Map<string, number|null>();
    for (const r of rows.rows) {
      const best = await this.bestSellPool(Number(r.token_id), { amountIn: amt, zigUsd, minTvlZig: minBestTvl });
      const poolId = best?.poolId ?? best?.pool_id ?? null;
      if (!poolId) { changeMap.set(String(r.token_id), null); continue; }
      const pct = await this.changePctForMinutes(poolId, 1440);
      changeMap.set(String(r.token_id), pct);
    }

    const data = rows.rows.map((r: any) => {
      const priceN = this.toNum(r.price_in_zig);
      const volN   = this.toNum(r.vol_zig) ?? 0;
      const mcapN  = this.toNum(r.mcap_zig);
      const fdvN   = this.toNum(r.fdv_zig);
      return {
        tokenId: r.token_id,
        denom: r.denom,
        symbol: r.symbol,
        name: r.name,
        imageUri: r.image_uri,
        createdAt: r.created_at,
        priceNative: priceN,
        priceUsd: priceN != null ? priceN * zigUsd : null,
        mcapNative: mcapN, mcapUsd: mcapN != null ? mcapN * zigUsd : null,
        fdvNative: fdvN,  fdvUsd:  fdvN  != null ? fdvN  * zigUsd : null,
        holders: Number(r.holders || 0),
        volNative: volN, volUsd: volN * zigUsd,
        tx: Number(r.tx || 0),
        change24hPct: changeMap.get(String(r.token_id))
      };
    });

    const filtered = data.filter(x => x.change24hPct != null);
    const sorted = filtered.sort((a,b) =>
      board === 'gainers' ? (b.change24hPct! - a.change24hPct!) : (a.change24hPct! - b.change24hPct!)
    );
    const total = sorted.length;
    const pageItems = sorted.slice(offset, offset + limit);

    return {
      success: true,
      data: pageItems,
      meta: { board, bucket, priceSource, limit, offset, total }
    };
  }

  async swapList(params: { bucket: Bucket; limit: number; offset: number }) {
    const { bucket, limit, offset } = params;
    const zigUsd = await this.zigUsd();
    const args = [bucket, limit, offset];
    const sql = `
      WITH agg AS (
        SELECT p.base_token_id AS token_id,
               SUM(pm.vol_buy_zig + pm.vol_sell_zig) AS vol_zig,
               SUM(pm.tx_buy + pm.tx_sell) AS tx,
               SUM(pm.tvl_zig) AS tvl_zig
        FROM pool_matrix pm
        JOIN pools p ON p.pool_id=pm.pool_id
        WHERE pm.bucket=$1
        GROUP BY p.base_token_id
      )
      SELECT t.token_id, t.symbol, t.name, t.denom, t.image_uri, t.exponent,
             tm.price_in_zig, tm.mcap_zig, tm.fdv_zig,
             a.vol_zig, a.tx, a.tvl_zig
      FROM tokens t
      LEFT JOIN token_matrix tm ON tm.token_id=t.token_id AND tm.bucket=$1
      LEFT JOIN agg a ON a.token_id=t.token_id
      ORDER BY COALESCE(a.vol_zig,0) DESC NULLS LAST
      LIMIT $2 OFFSET $3
    `;
    const { rows } = await this.pg.query(sql, args);
    const data = rows.map((r: any) => {
      const priceN = this.toNum(r.price_in_zig);
      const mcapN  = this.toNum(r.mcap_zig);
      const fdvN   = this.toNum(r.fdv_zig);
      const volN   = this.toNum(r.vol_zig) ?? 0;
      const tvlN   = this.toNum(r.tvl_zig) ?? 0;
      return {
        tokenId: r.token_id,
        symbol: r.symbol,
        exponent:r.exponent,
        name: r.name,
        denom: r.denom,
        imageUri: r.image_uri,
        priceNative: priceN,
        priceUsd: priceN != null ? priceN * zigUsd : null,
        mcapNative: mcapN,
        mcapUsd: mcapN != null ? mcapN * zigUsd : null,
        fdvNative: fdvN,
        fdvUsd: fdvN != null ? fdvN * zigUsd : null,
        volNative: volN,
        volUsd: volN * zigUsd,
        tvlNative: tvlN,
        tvlUsd: tvlN * zigUsd,
        tx: Number(r.tx || 0),
      };
    });
    return { success: true, data };
  }

  async getOne(id: string, opts?: { priceSource?: PriceSource; poolId?: string; dominant?: DominantSide; view?: 'base'|'quote' }) {
    const tok = await this.resolveTokenId(id);
    if (!tok) return { success: false, error: 'token not found' };

    let priceSource: PriceSource = opts?.priceSource ?? 'best';
    const poolIdParam = opts?.poolId;

    const zigUsd = await this.zigUsd();

    // IBC stats fallback
    const ibcStatsRow = (await this.pg.query(
      `SELECT price_usd, market_cap_usd, circulating_supply, total_supply, last_updated
         FROM ibc_token_stats WHERE token_id=$1`,
      [tok.token_id]
    )).rows[0] || null;
    const ibcStats = ibcStatsRow ? {
      priceUsd: ibcStatsRow.price_usd != null ? Number(ibcStatsRow.price_usd) : null,
      marketCapUsd: ibcStatsRow.market_cap_usd != null ? Number(ibcStatsRow.market_cap_usd) : null,
      circSupply: ibcStatsRow.circulating_supply != null ? Number(ibcStatsRow.circulating_supply) : null,
      totalSupply: ibcStatsRow.total_supply != null ? Number(ibcStatsRow.total_supply) : null,
      lastUpdated: ibcStatsRow.last_updated || null,
    } : null;

    const srow = await this.pg.query(`
      SELECT total_supply_base, max_supply_base, exponent, image_uri, website, twitter, telegram, description, created_at
      FROM tokens WHERE token_id=$1
    `, [tok.token_id]);
    const s: any = srow.rows[0] || {};
    const exp = s.exponent != null ? Number(s.exponent) : 6;
    const disp = (base: any, e: number) => (base == null ? null : Number(base) / (10 ** (e || 0)));
    const circBase = disp(s.total_supply_base, exp);
    const maxBase  = disp(s.max_supply_base,   exp);
    const circ = circBase != null ? circBase : ibcStats?.circSupply ?? null;
    const max  = maxBase  != null ? maxBase  : ibcStats?.totalSupply ?? null;

    if (this.isUzigToken(tok)) {
      return this.getUzigSummary(tok, s, exp, circ, max, zigUsd, ibcStats);
    }

    const dominantSide = await this.resolveDominantSide(tok.token_id, opts?.dominant);
    const pairView = (opts?.view || 'base') as 'base'|'quote';

    // pool selection (prefer UZIG pools; fallback to most active for non-UZIG)
    let selectedPoolId: number | null = null;
    let selectedBest: any = null;
    if (priceSource === 'pool' && poolIdParam) {
      const pr = await this.pg.query<{ pool_id: number }>(
        `SELECT pool_id
           FROM pools
          WHERE (pool_id::text=$1 OR pair_contract=$1) AND ${dominantSide === 'quote' ? 'quote_token_id' : 'base_token_id'}=$2
          LIMIT 1`,
        [poolIdParam, tok.token_id]
      );
      selectedPoolId = pr.rows[0]?.pool_id ?? null;
    } else if (dominantSide === 'base' && priceSource === 'uzig') {
      selectedPoolId = await this.pickPoolBySide(tok.token_id, 'base', true);
    } else if (dominantSide === 'base') {
      const best = await this.bestSellPool(tok.token_id, { zigUsd });
      selectedBest = best;
      selectedPoolId = best?.poolId ?? null;
      if (!selectedPoolId) {
        selectedPoolId = await this.pickPoolBySide(tok.token_id, 'base', false);
      }
      priceSource = 'best';
    } else {
      selectedPoolId = await this.pickPoolBySide(tok.token_id, 'quote', false);
      priceSource = 'best';
    }

    // current price
    let priceNative: number | null = null;
    if (selectedPoolId && dominantSide === 'base') {
      const pr = await this.pg.query(
        `SELECT price_in_zig FROM prices WHERE token_id=$1 AND pool_id=$2 ORDER BY updated_at DESC LIMIT 1`,
        [tok.token_id, selectedPoolId]
      );
      priceNative = pr.rows[0]?.price_in_zig != null ? Number(pr.rows[0].price_in_zig) : null;
    }
    let priceUsd: number | null = null;
    if (dominantSide === 'quote') {
      if (selectedPoolId) {
        priceNative = await this.latestPoolPriceInQuote(selectedPoolId);
        if (priceNative != null && pairView === 'quote' && priceNative > 0) {
          priceNative = 1 / priceNative;
        }
        priceUsd = await this.baseUsdForPool(selectedPoolId, zigUsd);
      }
    } else if (priceNative == null && selectedBest?.priceInZig != null) {
      priceNative = Number(selectedBest.priceInZig);
    }

    let liquidityNativeZig = 0;
    if (dominantSide === 'quote') {
      const lr = await this.pg.query(
        `SELECT COALESCE(SUM(ps.tvl_zig),0) AS tvl_zig
           FROM pool_state ps
           JOIN pools p ON p.pool_id=ps.pool_id
          WHERE p.quote_token_id=$1`,
        [tok.token_id]
      );
      liquidityNativeZig = Number(lr.rows[0]?.tvl_zig || 0);
    } else {
      const live = await this.pg.query(`
        SELECT
          p.pool_id,
          ps.reserve_base_base   AS res_base_base,
          ps.reserve_quote_base  AS res_quote_base,
          tb.exponent            AS base_exp,
          tq.exponent            AS quote_exp,
          ( SELECT price_in_zig
              FROM prices pr
             WHERE pr.pool_id = p.pool_id AND pr.token_id = p.base_token_id
             ORDER BY pr.updated_at DESC LIMIT 1
          ) AS price_in_zig
        FROM pools p
        LEFT JOIN pool_state ps   ON ps.pool_id   = p.pool_id
        JOIN tokens tb            ON tb.token_id  = p.base_token_id
        JOIN tokens tq            ON tq.token_id  = p.quote_token_id
        WHERE p.base_token_id = $1
      `, [tok.token_id]);

      let tvlZigSum = 0;
      for (const r of live.rows as any[]) {
        const Rt = Number(r.res_base_base  || 0) / Math.pow(10, Number(r.base_exp  ?? 0));
        const Rz = Number(r.res_quote_base || 0) / Math.pow(10, Number(r.quote_exp ?? 0));
        const midZig = Number(r.price_in_zig || 0);
        const tvlZigPool = (Rt * midZig) + Rz;
        if (Number.isFinite(tvlZigPool)) tvlZigSum += tvlZigPool;
      }
      liquidityNativeZig = tvlZigSum;
    }
    const liquidityUSD = liquidityNativeZig * zigUsd;

    // aggregates
    const buckets = ['30m','1h','4h','24h'] as const;
    const agg = await this.pg.query(`
      SELECT pm.bucket,
             COALESCE(SUM(pm.vol_buy_zig),0)    AS vbuy,
             COALESCE(SUM(pm.vol_sell_zig),0)   AS vsell,
             COALESCE(SUM(pm.tx_buy),0)         AS tbuy,
             COALESCE(SUM(pm.tx_sell),0)        AS tsell,
             COALESCE(SUM(pm.unique_traders),0) AS uniq,
             COALESCE(SUM(pm.tvl_zig),0)        AS tvl
        FROM pools p
        JOIN pool_matrix pm ON pm.pool_id=p.pool_id
       WHERE p.${dominantSide === 'quote' ? 'quote_token_id' : 'base_token_id'}=$1
         AND pm.bucket = ANY($2)
       GROUP BY pm.bucket
    `, [tok.token_id, buckets]);

    const map = new Map<string, any>(agg.rows.map((r: any) => [r.bucket, {
      vbuy: Number(r.vbuy || 0),
      vsell: Number(r.vsell || 0),
      tbuy: Number(r.tbuy || 0),
      tsell: Number(r.tsell || 0),
      uniq: Number(r.uniq || 0),
      tvl:  Number(r.tvl  || 0),
    }]));

    const vol: Record<string, number> = {};
    const volUSD: Record<string, number> = {};
    const txBuckets: Record<string, number> = {};
    for (const b of buckets) {
      const r = map.get(b) || { vbuy:0, vsell:0, tbuy:0, tsell:0, uniq:0, tvl:0 };
      const v = r.vbuy + r.vsell;
      vol[b] = v;
      volUSD[b] = v * zigUsd;
      txBuckets[b] = r.tbuy + r.tsell;
    }
    const r24 = map.get('24h') || { vbuy:0, vsell:0, tbuy:0, tsell:0, uniq:0, tvl:0 };

    const changeFor = async (minutes: number) => {
      if (!selectedPoolId) return null;
      const invert = dominantSide === 'quote' && pairView === 'quote';
      const r = await this.changePctForMinutes(selectedPoolId, minutes, invert);
      return r ?? null;
    };
    const priceChange = {
      '30m': await changeFor(30),
      '1h' : await changeFor(60),
      '4h' : await changeFor(240),
      '24h': await changeFor(1440),
    };

    const mcNative  = (priceNative != null && circ != null) ? circ * priceNative : null;
    const fdvNative = (priceNative != null && max  != null) ? max  * priceNative : null;
    const mcNativeAdj = mcNative != null ? mcNative
      : (ibcStats?.marketCapUsd != null && zigUsd > 0 ? ibcStats.marketCapUsd / zigUsd : null);

    const poolsCount = Number((await this.pg.query(
      `SELECT COUNT(*)::int AS c FROM pools WHERE ${dominantSide === 'quote' ? 'quote_token_id' : 'base_token_id'}=$1`,
      [tok.token_id]
    )).rows[0]?.c || 0);

    const holders = Number((await this.pg.query(
      `SELECT holders_count FROM token_holders_stats WHERE token_id=$1`, [tok.token_id]
    )).rows[0]?.holders_count || 0);

    const creation = (await this.pg.query(
      `SELECT MIN(created_at) AS first_ts FROM pools WHERE ${dominantSide === 'quote' ? 'quote_token_id' : 'base_token_id'}=$1`,
      [tok.token_id]
    )).rows[0]?.first_ts || null;

    const tw = await this.pg.query(`
      SELECT handle, user_id, name, is_blue_verified, verified_type, profile_picture, cover_picture,
             followers, following, created_at_twitter, last_refreshed
        FROM token_twitter WHERE token_id=$1
    `, [tok.token_id]);

    return {
      success: true,
      data: {
        token: {
          tokenId: String(tok.token_id),
          denom: tok.denom,
          symbol: tok.symbol,
          name: tok.name,
          display: tok.denom,
          exponent: exp,
          imageUri: s.image_uri,
          website: s.website,
          twitter: s.twitter,
          telegram: s.telegram,
          createdAt: s.created_at,
          description: s.description,
        },

        price: {
          source: priceSource,
          poolId: selectedPoolId ? String(selectedPoolId) : null,
          native: priceNative ?? (ibcStats?.priceUsd != null && zigUsd > 0 ? ibcStats.priceUsd / zigUsd : null),
          usd: priceUsd != null
            ? priceUsd
            : (priceNative != null ? priceNative * zigUsd : ibcStats?.priceUsd ?? null),
          changePct: priceChange
        },

        // renamed to avoid duplicate names with flat fields
        mcapDetail: { native: mcNativeAdj, usd: mcNativeAdj != null ? mcNativeAdj * zigUsd : ibcStats?.marketCapUsd ?? null },
        fdvDetail:  { native: fdvNative, usd:  fdvNative != null ? fdvNative  * zigUsd : null },
        supply:     { circulating: circ, max },

        // flat legacy-friendly keys
        priceInNative: priceNative ?? (ibcStats?.priceUsd != null && zigUsd > 0 ? ibcStats.priceUsd / zigUsd : null),
        priceInUsd:    priceUsd != null ? priceUsd : (priceNative != null ? priceNative * zigUsd : ibcStats?.priceUsd ?? null),
        priceSource:   priceSource,
        dominant:      dominantSide,
        pairView:      pairView,
        poolId:        selectedPoolId ? String(selectedPoolId) : null,
        pools:         poolsCount,
        holder:        holders,
        creationTime:  creation,
        circulatingSupply: circ,
        fdvNative,
        fdv:           fdvNative != null ? fdvNative * zigUsd : null,
        mcNative:      mcNativeAdj,
        mc:            mcNativeAdj != null ? mcNativeAdj * zigUsd : ibcStats?.marketCapUsd ?? null,

        priceChange,
        volume:    vol,
        volumeUSD: volUSD,
        txBuckets,
        uniqueTraders: r24.uniq,
        trade: r24.tbuy + r24.tsell,
        sell:  r24.tsell,
        buy:   r24.tbuy,
        v:     r24.vbuy + r24.vsell,
        vBuy:  r24.vbuy,
        vSell: r24.vsell,
        vUSD:  (r24.vbuy + r24.vsell) * zigUsd,
        vBuyUSD:  r24.vbuy * zigUsd,
        vSellUSD: r24.vsell * zigUsd,

        liquidity:        liquidityUSD,
        liquidityNative:  liquidityNativeZig,
        ...(ibcStats ? { ibcStats } : {})
      },
      twitter: tw.rows[0] ? {
        handle: tw.rows[0].handle,
        userId: tw.rows[0].user_id,
        name: tw.rows[0].name,
        isBlueVerified: !!tw.rows[0].is_blue_verified,
        verifiedType: tw.rows[0].verified_type,
        profilePicture: tw.rows[0].profile_picture,
        coverPicture: tw.rows[0].cover_picture,
        followers: tw.rows[0].followers != null ? Number(tw.rows[0].followers) : null,
        following: tw.rows[0].following != null ? Number(tw.rows[0].following) : null,
        createdAtTwitter: tw.rows[0].created_at_twitter,
        lastRefreshed: tw.rows[0].last_refreshed,
      } : null,
    };
  }

  async poolsForToken(id: string, bucket: Bucket, limit: number, offset: number, includeCaps = false, dominant?: DominantSide) {
    const tok = await this.resolveTokenId(id);
    if (!tok) return { success: false, error: 'token not found' };
    const zigUsd = await this.zigUsd();
    const isUzig = this.isUzigToken(tok);
    const dominantSide = isUzig ? 'base' : await this.resolveDominantSide(tok.token_id, dominant);
    const tokenPrice = (!isUzig && dominantSide === 'quote')
      ? await this.latestTokenPriceInZig(tok.token_id)
      : null;

    const header = await this.pg.query(
      `SELECT token_id, symbol, denom, image_uri, total_supply_base, max_supply_base, exponent FROM tokens WHERE token_id=$1`,
      [tok.token_id]
    );
    const h = header.rows[0] as any;
    const exp = h?.exponent != null ? Number(h.exponent) : 6;
    const disp = (base: any, e: number) => (base == null ? null : Number(base) / (10 ** (e || 0)));
    const circ = disp(h?.total_supply_base, exp);
    const max  = disp(h?.max_supply_base,   exp);

      const args = [tok.token_id, bucket, limit, offset];
      const sql = `
        SELECT
          p.pool_id, p.pair_contract, p.base_token_id, p.quote_token_id, p.is_uzig_quote, p.created_at,
        b.symbol AS base_symbol, b.denom AS base_denom, b.exponent AS base_exp,
        q.symbol AS quote_symbol, q.denom AS quote_denom, q.exponent AS quote_exp,
        COALESCE(pm.tvl_zig,0) AS tvl_zig,
        COALESCE(pm.vol_buy_zig,0) + COALESCE(pm.vol_sell_zig,0) AS vol_zig,
        COALESCE(pm.tx_buy,0) + COALESCE(pm.tx_sell,0) AS tx,
        COALESCE(pm.unique_traders,0) AS unique_traders,
        pr.price_in_zig
      FROM pools p
      JOIN tokens b ON b.token_id=p.base_token_id
      JOIN tokens q ON q.token_id=p.quote_token_id
      LEFT JOIN pool_matrix pm ON pm.pool_id=p.pool_id AND pm.bucket=$2
        LEFT JOIN LATERAL (
          SELECT price_in_zig FROM prices WHERE pool_id=p.pool_id AND token_id=p.base_token_id
          ORDER BY updated_at DESC LIMIT 1
        ) pr ON TRUE
        WHERE ${isUzig ? '(p.base_token_id=$1 OR p.quote_token_id=$1)' : `p.${dominantSide === 'quote' ? 'quote_token_id' : 'base_token_id'}=$1`}
        ORDER BY p.created_at ASC
      `;
    const { rows } = await this.pg.query(sql, args);
    const data = rows.map((r: any) => {
      const priceN = (dominantSide === 'quote' && tokenPrice != null)
        ? tokenPrice
        : this.toNum(r.price_in_zig);
      const tvlN   = this.toNum(r.tvl_zig) ?? 0;
      const volN   = this.toNum(r.vol_zig) ?? 0;
      const mcapN  = includeCaps && priceN != null && circ != null ? priceN * circ : null;
      const fdvN   = includeCaps && priceN != null && max  != null ? priceN * max  : null;
      return {
        pairContract: r.pair_contract,
        base: { tokenId: r.base_token_id, symbol: r.base_symbol, denom: r.base_denom, exponent: Number(r.base_exp) },
        quote:{ tokenId: r.quote_token_id, symbol: r.quote_symbol, denom: r.quote_denom, exponent: Number(r.quote_exp) },
        isUzigQuote: r.is_uzig_quote === true,
        createdAt: r.created_at,
        priceNative: priceN,
        priceUsd: priceN != null ? priceN * zigUsd : null,
        tvlNative: tvlN, tvlUsd: tvlN * zigUsd,
        volumeNative: volN, volumeUsd: volN * zigUsd,
        tx: Number(r.tx || 0),
        uniqueTraders: Number(r.unique_traders || 0),
        ...(includeCaps ? {
          mcapNative: mcapN, mcapUsd: mcapN != null ? mcapN * zigUsd : null,
          fdvNative: fdvN,   fdvUsd:  fdvN  != null ? fdvN  * zigUsd : null
        } : {})
      };
    });

    return {
      success: true,
      token: { tokenId: h?.token_id, symbol: h?.symbol, denom: h?.denom, imageUri: h?.image_uri },
      data,
      meta: { bucket, includeCaps: includeCaps ? 1 : 0, dominant: dominantSide }
    };
  }

  async holders(id: string, limit: number, offset: number) {
    const tok = await this.resolveTokenId(id);
    if (!tok) return { success: false, error: 'token not found' };

    const sup = await this.pg.query(
      `SELECT max_supply_base, total_supply_base, exponent FROM tokens WHERE token_id=$1`,
      [tok.token_id]
    );
    const exp = sup.rows[0]?.exponent != null ? Number(sup.rows[0]?.exponent) : 6;
    const maxBase = Number(sup.rows[0]?.max_supply_base || 0);
    const totBase = Number(sup.rows[0]?.total_supply_base || 0);

    const totalRow = await this.pg.query(
      `SELECT COUNT(*)::bigint AS total FROM holders WHERE token_id=$1 AND balance_base::numeric > 0`,
      [tok.token_id]
    );
    const total = Number(totalRow.rows[0]?.total || 0);

    const { rows } = await this.pg.query(
      `SELECT address, balance_base::numeric AS bal
       FROM holders
       WHERE token_id=$1 AND balance_base::numeric > 0
       ORDER BY bal DESC
       LIMIT $2 OFFSET $3`,
      [tok.token_id, limit, offset]
    );

    const holders = rows.map((r: any) => {
      const balDisp = Number(r.bal) / (10 ** exp);
      const pctMax  = maxBase > 0 ? (Number(r.bal) / maxBase) * 100 : null;
      const pctTot  = totBase > 0 ? (Number(r.bal) / totBase) * 100 : null;
      return { address: r.address, balance: balDisp, pctOfMax: pctMax, pctOfTotal: pctTot };
    });

    const top10 = rows.slice(0, 10).reduce((a, r) => a + Number(r.bal), 0);
    const pctTop10Max = maxBase > 0 ? (top10 / maxBase) * 100 : null;

    return {
      success: true,
      data: holders,
      meta: { limit, offset, totalHolders: total, top10PctOfMax: pctTop10Max }
    };
  }

  async security(id: string) {
    const tok = await this.resolveTokenId(id);
    if (!tok) return { success: false, error: 'token not found' };

    const sq = await this.pg.query(`
      SELECT
        token_id,
        denom,
        is_mintable,
        can_change_minting_cap,
        max_supply_base,
        total_supply_base,
        creator_address,
        creator_balance_base,
        creator_pct_of_max,
        top10_pct_of_max,
        holders_count,
        first_seen_at,
        checked_at
      FROM public.token_security
      WHERE token_id=$1
      LIMIT 1
    `, [tok.token_id]);
    const s = sq.rows[0] as any || null;

    const tq = await this.pg.query(
      `SELECT exponent, created_at FROM public.tokens WHERE token_id=$1`,
      [tok.token_id]
    );
    const exp = tq.rows[0]?.exponent != null ? Number(tq.rows[0]?.exponent) : 6;
    const toDisp = (v: any) => v == null ? null : Number(v) / 10 ** exp;
    const num = (v: any, d = 0) => v == null ? d : Number(v);

    const maxSupplyDisp   = toDisp(s?.max_supply_base);
    const totalSupplyDisp = toDisp(s?.total_supply_base);
    const creatorBalDisp  = toDisp(s?.creator_balance_base);

    const creatorPctOfMax = num(s?.creator_pct_of_max, 0);
    const top10PctOfMax   = num(s?.top10_pct_of_max, 0);
    const holdersCount    = num(s?.holders_count, 0);

    const penalties: {k:string;pts:number}[] = [];
    const bonuses:   {k:string;pts:number}[] = [];

    if (s?.is_mintable === true) penalties.push({k:'is_mintable', pts:12});
    else                         bonuses.push({k:'not_mintable', pts:4});
    if (s?.can_change_minting_cap === true) penalties.push({k:'can_change_minting_cap', pts:8});

    if (top10PctOfMax >= 75) penalties.push({k:'top10>=75%', pts:20});
    else if (top10PctOfMax >= 50) penalties.push({k:'top10>=50%', pts:12});
    else if (top10PctOfMax >= 30) penalties.push({k:'top10>=30%', pts:6});
    else bonuses.push({k:'top10<30%', pts:4});

    if (creatorPctOfMax >= 25) penalties.push({k:'creator>=25%', pts:18});
    else if (creatorPctOfMax >= 10) penalties.push({k:'creator>=10%', pts:10});
    else if (creatorPctOfMax > 0)   bonuses.push({k:'creator<10%', pts:3});

    if (holdersCount < 100) penalties.push({k:'holders<100', pts:8});
    else if (holdersCount < 1000) penalties.push({k:'holders<1k', pts:4});
    else if (holdersCount >= 10000) bonuses.push({k:'holders>=10k', pts:5});
    else if (holdersCount >= 50000) bonuses.push({k:'holders>=50k', pts:10});

    if (s?.is_mintable === false && s?.max_supply_base != null && s?.total_supply_base != null) {
      if (String(s.max_supply_base) === String(s.total_supply_base)) {
        bonuses.push({k:'fully_minted_equals_max', pts:4});
      }
    }

    const firstSeen = s?.first_seen_at ? new Date(s.first_seen_at) : null;
    if (firstSeen) {
      const daysAlive = (Date.now() - firstSeen.getTime()) / (1000*60*60*24);
      if (daysAlive >= 180) bonuses.push({k:'age>=180d', pts:6});
      else if (daysAlive >= 90) bonuses.push({k:'age>=90d', pts:4});
      else if (daysAlive >= 30) bonuses.push({k:'age>=30d', pts:2});
    }

    let score = 100;
    for (const p of penalties) score -= p.pts;
    for (const b of bonuses)   score += b.pts;
    score = Math.max(1, Math.min(99, Math.round(score)));

    const checks = {
      isMintable: !!(s?.is_mintable),
      canChangeMintingCap: !!(s?.can_change_minting_cap),
      maxSupply: maxSupplyDisp,
      totalSupply: totalSupplyDisp,
      top10PctOfMax: Number(top10PctOfMax.toFixed(4)),
      creatorPctOfMax: Number(creatorPctOfMax.toFixed(4)),
      holdersCount: holdersCount
    };

    const dev = {
      tokenTotalSupply: totalSupplyDisp,
      creatorAddress: s?.creator_address || null,
      creatorBalance: creatorBalDisp,
      creatorPctOfMax: Number(creatorPctOfMax.toFixed(4)),
      topHoldersPctOfMax: Number(top10PctOfMax.toFixed(4)),
      holdersCount: holdersCount,
      firstSeenAt: s?.first_seen_at || null
    };

    const categories = {
      supply: {
        isMintable: !!(s?.is_mintable),
        canChangeMintingCap: !!(s?.can_change_minting_cap),
        maxSupply: maxSupplyDisp,
        totalSupply: totalSupplyDisp
      },
      distribution: {
        top10PctOfMax: Number(top10PctOfMax.toFixed(4)),
        creatorPctOfMax: Number(creatorPctOfMax.toFixed(4))
      },
      adoption: {
        holdersCount: holdersCount,
        firstSeenAt: s?.first_seen_at || null
      }
    };

    return {
      success: true,
      data: {
        score, penalties, bonuses, categories, checks, dev,
        lastUpdated: s?.checked_at || null,
        source: 'token_security'
      }
    };
  }

  // ---- Advanced OHLCV (full behavior) ----
  private tfToSec(tf?: string): number {
    const map: Record<string, number> = {
      '1m':60, '5m':300, '15m':900, '30m':1800,
      '1h':3600, '2h':7200, '4h':14400, '8h':28800, '12h':43200,
      '1d':86400, '3d':259200, '5d':432000, '1w':604800,
      '1M':2592000, '3M':7776000
    };
    if (tf && map[tf]) return map[tf];
    const g = /^(\d+)([mhdwM])$/.exec(tf || '');
    const unit: any = { m:60, h:3600, d:86400, w:604800, M:2592000 };
    if (!g) return 60;
    return Number(g[1]) * (unit[g[2]] || 60);
  }

  private async ohlcvUzigFromUsdc(
    tok: { token_id: number },
    opts: {
      tf: string;
      stepSec: number;
      mode: 'price' | 'mcap';
      unit: 'native' | 'usd';
      fill: 'prev' | 'zero' | 'none';
      fromIso: string;
      toIso: string;
    }
  ) {
    const { tf, stepSec, mode, unit, fill, fromIso, toIso } = opts;
    const usdc = await this.resolveUsdcToken();
    const poolId = usdc ? await this.pickUsdcZigPool(usdc.token_id, tok.token_id) : null;

    const start = Math.floor(new Date(fromIso).getTime() / 1000 / stepSec) * stepSec;
    const end   = Math.floor(new Date(toIso).getTime()   / 1000 / stepSec) * stepSec;

    if (!poolId) {
      return {
        success: true,
        data: [],
        meta: {
          tf, mode, unit, fill, priceSource: 'usdc_invert',
          stepSec,
          alignedFromSec: start,
          alignedToSecExclusive: end + stepSec,
          prevCloseSeed: null
        }
      };
    }

    const prev = await this.pg.query(
      `SELECT close FROM ohlcv_1m WHERE pool_id=$1 AND bucket_start < $2::timestamptz
       ORDER BY bucket_start DESC LIMIT 1`,
      [poolId, fromIso]
    );
    const seedPrevClose = prev.rows[0]?.close != null ? Number(prev.rows[0].close) : null;

    const { rows } = await this.pg.query(`
      WITH src AS (
        SELECT o.bucket_start, o.open, o.high, o.low, o.close, o.volume_zig, o.trade_count
        FROM ohlcv_1m o
        WHERE o.pool_id=$1
          AND o.bucket_start >= $2::timestamptz AND o.bucket_start < $3::timestamptz
      ),
      tagged AS (
        SELECT
          bucket_start, open, high, low, close, volume_zig, trade_count,
          to_timestamp(floor(extract(epoch from bucket_start)/$4)*$4) AT TIME ZONE 'UTC' AS bucket_ts
        FROM src
      ),
      sums AS (
        SELECT bucket_ts,
               MIN(low)  AS low,
               MAX(high) AS high,
               SUM(volume_zig)  AS volume_native,
               SUM(trade_count) AS trades
        FROM tagged
        GROUP BY bucket_ts
      ),
      firsts AS (
        SELECT DISTINCT ON (bucket_ts) bucket_ts, open
        FROM tagged
        ORDER BY bucket_ts, bucket_start ASC
      ),
      lasts AS (
        SELECT DISTINCT ON (bucket_ts) bucket_ts, close
        FROM tagged
        ORDER BY bucket_ts, bucket_start DESC
      )
      SELECT EXTRACT(EPOCH FROM s.bucket_ts)::bigint AS ts_sec,
             f.open, s.high, s.low, l.close, s.volume_native, s.trades
      FROM sums s
      LEFT JOIN firsts f USING (bucket_ts)
      LEFT JOIN lasts  l USING (bucket_ts)
      ORDER BY ts_sec ASC
    `, [poolId, fromIso, toIso, stepSec]);

    const bySec = new Map<number, any>(
      rows.map((r: any) => [Number(r.ts_sec), {
        sec: Number(r.ts_sec),
        open: Number(r.open),
        high: Number(r.high),
        low:  Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume_native),
        trades: Number(r.trades)
      }])
    );

    let prevClose = (fill === 'prev' && Number.isFinite(seedPrevClose)) ? Number(seedPrevClose) : null;
    const out: any[] = [];

    for (let ts = start; ts <= end; ts += stepSec) {
      const r = bySec.get(ts);
      if (r) {
        const openAdj = (prevClose != null) ? prevClose : r.open;
        const highAdj = Math.max(r.high, openAdj);
        const lowAdj  = Math.min(r.low,  openAdj);
        const base = { ts_sec: ts, open: openAdj, high: highAdj, low: lowAdj, close: r.close, volume: r.volume, trades: r.trades };
        out.push(base);
        prevClose = base.close;
      } else if (fill !== 'none') {
        if (fill === 'prev' && prevClose != null) {
          out.push({ ts_sec: ts, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0, trades: 0 });
        } else if (fill === 'zero') {
          out.push({ ts_sec: ts, open: 0, high: 0, low: 0, close: 0, volume: 0, trades: 0 });
          prevClose = 0;
        }
      }
    }

    const ss = await this.pg.query(`SELECT total_supply_base, exponent FROM tokens WHERE token_id=$1`, [tok.token_id]);
    const exp = ss.rows[0]?.exponent != null ? Number(ss.rows[0].exponent) : 6;
    const circ = ss.rows[0]?.total_supply_base != null ? Number(ss.rows[0].total_supply_base) / 10 ** exp : null;

    const invert = (v: number) => (v > 0 ? 1 / v : 0);
    const converted = out.map((b: any) => {
      let open = invert(b.open);
      let close = invert(b.close);
      let high = invert(b.low);
      let low = invert(b.high);
      let volume = unit === 'usd' ? (b.volume ?? 0) * close : b.volume;
      if (mode === 'mcap' && circ != null) {
        open *= circ; high *= circ; low *= circ; close *= circ;
      }
      return { ts_sec: b.ts_sec, open, high, low, close, volume, trades: b.trades };
    });

    const prevCloseSeed = Number.isFinite(seedPrevClose) ? invert(seedPrevClose) : null;

    return {
      success: true,
      data: converted,
      meta: {
        tf, mode, unit, fill, priceSource: 'usdc_invert',
        stepSec,
        alignedFromSec: start,
        alignedToSecExclusive: end + stepSec,
        prevCloseSeed
      }
    };
  }

  async ohlcvAdvanced(
    id: string,
    q: {
      tf?: string, mode?: 'price'|'mcap', unit?: 'native'|'usd',
      priceSource?: PriceSource, poolId?: string, pair?: string,
      fill?: 'prev'|'zero'|'none', from?: string, to?: string, span?: string, window?: number,
      dominant?: DominantSide,
      view?: 'base'|'quote'
    }
  ) {
    const tok = await this.resolveTokenId(id);
    if (!tok) return { success: false, error: 'token not found' };

    const dominantSide = this.isUzigToken(tok)
      ? 'base'
      : await this.resolveDominantSide(tok.token_id, (q as any).dominant as DominantSide);
    const pairView = ((q as any).view || 'base') as 'base'|'quote';

    const tf = q.tf || '1m';
    const stepSec = this.tfToSec(tf);
    const mode = q.mode || 'price';
    const unit = q.unit || 'native';
    const priceSource: PriceSource = q.priceSource || 'best';
    const poolIdParam = q.poolId;
    const pairParam = q.pair;
    const fill = q.fill || 'none';
    const useUsdTable = unit === 'usd';
    const tableName = useUsdTable ? 'ohlcv_1m_usd' : 'ohlcv_1m';
    const volumeCol = useUsdTable ? 'volume_usd' : 'volume_zig';
    const sideCol = dominantSide === 'quote' ? 'quote_token_id' : 'base_token_id';
    const restrictUzig = priceSource === 'uzig' && dominantSide === 'base';

    const now = new Date();
    let toIso = q.to || now.toISOString();
    let fromIso = q.from || null;

      if (!fromIso) {
        if (q.span) {
          const spanSec = this.tfToSec(q.span);
          const to = new Date(toIso);
          fromIso = new Date(to.getTime() - spanSec*1000).toISOString();
        } else if (q.window) {
          const bars = Math.max(1, Math.min(q.window, 5000));
          const to = new Date(toIso);
          fromIso = new Date(to.getTime() - bars*stepSec*1000).toISOString();
        } else {
          const bars = tf === '1m' ? 1440 : 300;
          const to = new Date(toIso);
          fromIso = new Date(to.getTime() - bars*stepSec*1000).toISOString();
        }
      }

      if (this.isUzigToken(tok)) {
        return this.ohlcvUzigFromUsdc(tok, {
          tf,
          stepSec,
          mode,
          unit,
          fill,
          fromIso: fromIso!,
          toIso,
        });
      }

      const zigUsd = await this.zigUsd();
    const ss = await this.pg.query(`SELECT total_supply_base, max_supply_base, exponent FROM tokens WHERE token_id=$1`, [tok.token_id]);
    const exp = ss.rows[0]?.exponent != null ? Number(ss.rows[0]?.exponent) : 6;
    const circBase = ss.rows[0]?.total_supply_base != null ? Number(ss.rows[0].total_supply_base) / 10**exp : null;
    const ibcStats = (await this.pg.query(
      `SELECT circulating_supply, total_supply FROM ibc_token_stats WHERE token_id=$1`,
      [tok.token_id]
    )).rows[0] || null;
    const circ = circBase != null ? circBase : (ibcStats?.circulating_supply != null ? Number(ibcStats.circulating_supply) : null);

    let headerSQL = ``;
    let params: any[] = [];
    let seedPrevClose: number | null = null;

    if (priceSource === 'all') {
      params = [tok.token_id, fromIso, toIso, stepSec];
      headerSQL = `
        WITH src AS (
          SELECT o.pool_id, o.bucket_start, o.open, o.high, o.low, o.close, o.${volumeCol}, o.trade_count
          FROM ${tableName} o
          JOIN pools p ON p.pool_id=o.pool_id
          WHERE p.${sideCol}=$1 ${restrictUzig ? 'AND p.is_uzig_quote=TRUE' : ''}
            AND o.bucket_start >= $2::timestamptz AND o.bucket_start < $3::timestamptz
        ),
      `;
      const prev = await this.pg.query(`
        SELECT o.close FROM ${tableName} o
        JOIN pools p ON p.pool_id=o.pool_id
        WHERE p.${sideCol}=$1 ${restrictUzig ? 'AND p.is_uzig_quote=TRUE' : ''} AND o.bucket_start < $2::timestamptz
        ORDER BY o.bucket_start DESC LIMIT 1
      `, [tok.token_id, fromIso]);
      seedPrevClose = prev.rows[0]?.close != null ? Number(prev.rows[0].close) : null;
    } else {
      let poolRow: { pool_id: number } | null = null;
      if (priceSource === 'pool' && (poolIdParam || pairParam)) {
        const r = await this.pg.query<{ pool_id: number }>(
          `SELECT pool_id FROM pools WHERE (pool_id::text=$1 OR pair_contract=$1) AND ${sideCol}=$2 LIMIT 1`,
          [poolIdParam || pairParam, tok.token_id]
        );
        poolRow = r.rows[0] ?? null;
      }
      if (!poolRow && dominantSide === 'base' && priceSource !== 'pool') {
        const best = await this.bestSellPool(tok.token_id, { zigUsd });
        if (best?.poolId) poolRow = { pool_id: best.poolId };
      }
      if (!poolRow) {
        const r = await this.pg.query<{ pool_id: number }>(`
          WITH cps AS (
            SELECT p.pool_id
            FROM pools p
            WHERE p.${sideCol}=$1 ${restrictUzig ? 'AND p.is_uzig_quote=TRUE' : ''}
          ),
          act AS (
            SELECT cp.pool_id, MAX(o.bucket_start) AS last_bar
            FROM cps cp
            LEFT JOIN ${tableName} o ON o.pool_id=cp.pool_id
            GROUP BY cp.pool_id
          )
          SELECT pool_id FROM act ORDER BY last_bar DESC NULLS LAST LIMIT 1
        `, [tok.token_id]);
        poolRow = r.rows[0] ?? null;
      }
      if (!poolRow?.pool_id) {
        return { success:true, data: [], meta:{ tf, mode, unit, fill, priceSource, poolId:null } };
      }
      params = [poolRow.pool_id, fromIso, toIso, stepSec];
      headerSQL = `
        WITH src AS (
          SELECT o.pool_id, o.bucket_start, o.open, o.high, o.low, o.close, o.${volumeCol}, o.trade_count
          FROM ${tableName} o
          WHERE o.pool_id=$1
            AND o.bucket_start >= $2::timestamptz AND o.bucket_start < $3::timestamptz
        ),
      `;
      const prev = await this.pg.query(`
        SELECT close FROM ${tableName} WHERE pool_id=$1 AND bucket_start < $2::timestamptz
        ORDER BY bucket_start DESC LIMIT 1
      `, [poolRow.pool_id, fromIso]);
      seedPrevClose = prev.rows[0]?.close != null ? Number(prev.rows[0].close) : null;
    }

    const { rows } = await this.pg.query(`
      ${headerSQL}
      tagged AS (
        SELECT
          bucket_start, open, high, low, close, ${volumeCol} AS volume_zig, trade_count,
          to_timestamp(floor(extract(epoch from bucket_start)/$4)*$4) AT TIME ZONE 'UTC' AS bucket_ts
        FROM src
      ),
      sums AS (
        SELECT bucket_ts,
               MIN(low)  AS low,
               MAX(high) AS high,
               SUM(volume_zig)  AS volume_native,
               SUM(trade_count) AS trades
        FROM tagged
        GROUP BY bucket_ts
      ),
      firsts AS (
        SELECT DISTINCT ON (bucket_ts) bucket_ts, open
        FROM tagged
        ORDER BY bucket_ts, bucket_start ASC
      ),
      lasts AS (
        SELECT DISTINCT ON (bucket_ts) bucket_ts, close
        FROM tagged
        ORDER BY bucket_ts, bucket_start DESC
      )
      SELECT EXTRACT(EPOCH FROM s.bucket_ts)::bigint AS ts_sec,
             f.open, s.high, s.low, l.close, s.volume_native, s.trades
      FROM sums s
      LEFT JOIN firsts f USING (bucket_ts)
      LEFT JOIN lasts  l USING (bucket_ts)
      ORDER BY ts_sec ASC
    `, params);

    const start = Math.floor(new Date(fromIso!).getTime() / 1000 / stepSec) * stepSec;
    const end   = Math.floor(new Date(toIso).getTime()   / 1000 / stepSec) * stepSec;

    const bySec = new Map<number, any>(
      rows.map((r: any) => [Number(r.ts_sec), {
        sec: Number(r.ts_sec),
        open: Number(r.open),
        high: Number(r.high),
        low:  Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume_native),
        trades: Number(r.trades)
      }])
    );

    let prevClose = (fill === 'prev' && Number.isFinite(seedPrevClose)) ? Number(seedPrevClose) : null;
    const out: any[] = [];

    for (let ts = start; ts <= end; ts += stepSec) {
      const r = bySec.get(ts);
      if (r) {
        const openAdj = (prevClose != null) ? prevClose : r.open;
        const highAdj = Math.max(r.high, openAdj);
        const lowAdj  = Math.min(r.low,  openAdj);
        const base = { ts_sec: ts, open: openAdj, high: highAdj, low: lowAdj, close: r.close, volume: r.volume, trades: r.trades };
        out.push(base);
        prevClose = base.close;
      } else if (fill !== 'none') {
        if (fill === 'prev' && prevClose != null) {
          out.push({ ts_sec: ts, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0, trades: 0 });
        } else if (fill === 'zero') {
          out.push({ ts_sec: ts, open: 0, high: 0, low: 0, close: 0, volume: 0, trades: 0 });
          prevClose = 0;
        }
      }
    }

    const invert = (v: number) => (v > 0 ? 1 / v : 0);
    const outAdj = (dominantSide === 'quote' && pairView === 'quote')
      ? out.map((b: any) => ({
          ...b,
          open: invert(b.open),
          close: invert(b.close),
          high: invert(b.low),
          low: invert(b.high),
        }))
      : out;

    const zigUsdFactor = unit === 'usd' ? (useUsdTable ? 1 : zigUsd) : 1;
    const convert = (b: any) => {
      const x = { ...b };
      if (mode === 'mcap' && circ != null) {
        x.open  = x.open  * circ;
        x.high  = x.high  * circ;
        x.low   = x.low   * circ;
        x.close = x.close * circ;
      }
      x.open  *= zigUsdFactor;
      x.high  *= zigUsdFactor;
      x.low   *= zigUsdFactor;
      x.close *= zigUsdFactor;
      x.volume*= zigUsdFactor;
      return x;
    };

    return {
      success: true,
      data: outAdj.map(convert),
      meta: {
        tf, mode, unit, fill, priceSource,
        stepSec,
        alignedFromSec: start,
        alignedToSecExclusive: end + stepSec,
        dominant: dominantSide,
        pairView,
        prevCloseSeed: Number.isFinite(seedPrevClose)
          ? ((dominantSide === 'quote' && pairView === 'quote') ? invert(seedPrevClose) : seedPrevClose)
          : null
      }
    };
  }

  async getBestPool(idOrDenom: string, opts: { amt?: number; minBestTvl?: number }) {
    const tok = await this.resolveTokenId(idOrDenom);
    if (!tok) return { success: false, error: 'token not found' };

    const zigUsd = await this.zigUsd();
    const best = await this.bestSellPool(tok.token_id, {
      amountIn: opts?.amt,
      minTvlZig: opts?.minBestTvl ?? 0,
      zigUsd,
    });

    return { success: true, data: best ? { ...best, tokenId: tok.token_id } : null };
  }
}
