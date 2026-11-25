// Pump.fun Bot Sprint — original entry.
//
// Strategy (measured on the kit's dev window with an offline harness replica,
// then confirmed with the kit's own grade-local):
//
//   What does NOT work here: sniping every new coin the moment its real SOL
//   reserves reach 1 SOL. The fill lands 2 slots after the decision, by
//   which time the early spike is usually over (median peak from the fill
//   price is only +8% while the median trough is -27%), and 77% of the coins
//   that ever complete do so in a single-slot burst the bot can never buy.
//   An unconditional snipe-and-scalp bot lost -1.6 SOL on the dev window.
//
//   What DOES work: riding steady grinds. The coins that complete rise
//   slowly and steadily (one dev completer went 1.00x -> 2.24x -> 2.7x ->
//   3.5x -> 4.0x over ~1500 slots with only ~10% pullbacks). So this bot:
//     * ENTRY — a coin qualifies as a grinder when, over the last 200 slots,
//       its mark price rose at least +50% while never drawing down more than
//       25% from its running peak, with real SOL reserves >= 2 SOL (liquid
//       enough for a meaningful buy). One buy per episode; after a position
//       closes the coin may qualify again if it grinds up a fresh leg.
//     * EXIT — sell when the grind reverses: the mark price falls below its
//       own value 200 slots ago minus 10%. Backstops: stop-loss -30% from
//       the filled buy price, and a time exit after 5000 slots (~35 min).
//       No fixed take-profit: grinders are held while the trend holds.
//     * SIZE — min(0.05 SOL, the 1%-of-real-reserves size cap), at most 5
//       open positions, so at most 0.25 SOL is ever at risk. Fees are
//       ~1.25% per side plus 105,000 lamports per order.
//   On the dev window this scores roughly break-even to slightly positive
//   (offline replica: about +0.05 SOL over ~93 round trips), versus -1.6 SOL
//   for the naive snipe — the edge is selection, not exit timing.
//
// Deterministic: every decision comes from hello/batch state and slot
// numbers only. No clock, no randomness, no network, no files.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- strategy parameters (coarse, chosen from dev-window evidence) ----
const LOOKBACK_SLOTS = 200; // grind window, in slots (~80 s)
const RISE_BPS = 5000; // +50% over the lookback window
const MAX_DD_BPS = 2500; // never more than -25% from the running peak inside the window
const MIN_REAL_SOL = 2n * SOL; // need real reserves >= 2 SOL to enter
const STAKE_LAMPORTS = SOL / 20n; // 0.05 SOL per coin
const MIN_BUY_LAMPORTS = SOL / 100n; // 0.01 SOL: smallest buy that counts as a round trip
const BUY_SLIPPAGE_BPS = 500; // refuse a buy if the fill is >5% worse than decision-time reserves
const SELL_SLIPPAGE_BPS = 10000; // exits must land even in a fast fall
const STOP_LOSS_BPS = 3000; // -30% under the filled buy price
const MAX_HOLD_SLOTS = 5000; // ~35 minutes: sell whatever is left
const EXIT_LOOKBACK_SLOTS = 200; // trend exit compares against the price this far back
const EXIT_DROP_BPS = 1000; // exit when the mark is 10% below that older price

const SCALE = 1_000_000_000_000n; // price scale for integer math

interface Entry {
  /** Lamports per token actually paid (quote / tokens on the buy fill). */
  price: bigint;
  /** Slot of the batch the buy was decided on. */
  slot: number;
}

interface PricePoint {
  slot: number;
  /** Mark price scaled by SCALE. */
  price: bigint;
}

/** Coins with a buy decided (one buy per episode; cleared when the position closes). */
const decided = new Set<string>();
/** Live positions with their filled entry price, by mint. */
const entries = new Map<string, Entry>();
/** Mints with a buy still in flight (fill not yet reported). */
const buying = new Set<string>();
/** Mints with a sell still in flight. */
const selling = new Set<string>();
/** Mark-price history per mint, sampled once per batch it appears in. */
const history = new Map<string, PricePoint[]>();

/** Mark price in lamports per token, scaled by SCALE. */
function markPriceScaled(virtualQuote: bigint, virtualTokens: bigint): bigint {
  if (virtualTokens === 0n) return 0n;
  return (virtualQuote * SCALE) / virtualTokens;
}

/** Earliest price at or before (slot - lookback), or null when unknown. */
function priceAt(mint: string, slot: number, lookback: number): bigint | null {
  const points = history.get(mint);
  if (points === undefined) return null;
  let old: bigint | null = null;
  for (const p of points) {
    if (p.slot <= slot - lookback) old = p.price;
    else break;
  }
  return old;
}

/** Largest drawdown, in bps, from the running peak inside [slot - lookback, slot]. */
function maxDrawdownBps(mint: string, slot: number, lookback: number, startPrice: bigint): number {
  const points = history.get(mint);
  if (points === undefined) return 0;
  let peak = startPrice;
  let worst = 0;
  for (const p of points) {
    if (p.slot < slot - lookback) continue;
    if (p.price > peak) peak = p.price;
    if (peak > 0n) {
      const dd = Number(((peak - p.price) * 10000n) / peak);
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const orders: Array<BuyInput | SellInput> = [];

    // Sample this batch's mark prices into the history (events and marks).
    const seen = new Set<string>();
    for (const e of batch.events) {
      const curve = state.curves.get(e.mint);
      if (curve === undefined || seen.has(e.mint)) continue;
      seen.add(e.mint);
      const price = markPriceScaled(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price === 0n) continue;
      const points = history.get(e.mint) ?? [];
      points.push({ slot: batch.slot, price });
      while (points.length > 0 && points[0].slot < batch.slot - LOOKBACK_SLOTS - 100) points.shift();
      history.set(e.mint, points);
    }
    for (const m of batch.marks) {
      if (seen.has(m.mint)) continue;
      seen.add(m.mint);
      const price = markPriceScaled(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves));
      if (price === 0n) continue;
      const points = history.get(m.mint) ?? [];
      points.push({ slot: batch.slot, price });
      while (points.length > 0 && points[0].slot < batch.slot - LOOKBACK_SLOTS - 100) points.shift();
      history.set(m.mint, points);
    }

    // Fold this batch's fills into our own books: a buy fill sets the entry
    // price, a sell fill closes the position (and frees the coin for a fresh
    // episode if it grinds up again).
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') {
        if (fill.side === 'buy') buying.delete(fill.mint);
        if (fill.side === 'sell') selling.delete(fill.mint);
        continue;
      }
      if (fill.side === 'buy') {
        buying.delete(fill.mint);
        const tokens = BigInt(fill.token_amount);
        const quote = BigInt(fill.quote_lamports);
        if (tokens > 0n) {
          entries.set(fill.mint, { price: (quote * SCALE) / tokens, slot: fill.decided_slot });
        }
      } else {
        selling.delete(fill.mint);
        entries.delete(fill.mint);
        decided.delete(fill.mint);
      }
    }

    // Exits first: free the position slots before deciding new entries.
    for (const [mint, entry] of entries) {
      if (selling.has(mint)) continue;
      const curve = state.curves.get(mint);
      const holding = state.positions.get(mint);
      if (curve === undefined || curve.complete || holding === undefined) {
        entries.delete(mint);
        decided.delete(mint);
        continue;
      }
      const mark = markPriceScaled(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (mark === 0n) continue;
      const gainBps = Number(((mark - entry.price) * 10000n) / entry.price);
      const heldTooLong = batch.slot - entry.slot > MAX_HOLD_SLOTS;
      let exit = gainBps <= -STOP_LOSS_BPS || heldTooLong;
      if (!exit) {
        const old = priceAt(mint, batch.slot, EXIT_LOOKBACK_SLOTS);
        // Trend reversal: the grind is over when the price falls 10% below
        // where it was 200 slots ago.
        if (old !== null && mark < (old * BigInt(10000 - EXIT_DROP_BPS)) / 10000n) exit = true;
      }
      if (exit) {
        if (orders.length >= caps.max_orders_per_batch) break;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        selling.add(mint);
      }
    }

    // Entries: steady grinders only, decided once per episode.
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
      const mint = e.mint;
      if (decided.has(mint) || entries.has(mint) || buying.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const old = priceAt(mint, batch.slot, LOOKBACK_SLOTS);
      if (old === null) continue;
      const now = markPriceScaled(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (now === 0n) continue;
      // Rose at least +50% over the lookback window...
      if (now < (old * BigInt(10000 + RISE_BPS)) / 10000n) continue;
      // ...without ever drawing down more than 25% from its running peak.
      if (maxDrawdownBps(mint, batch.slot, LOOKBACK_SLOTS, old) > MAX_DD_BPS) continue;
      decided.add(mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (slots <= 0 || free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      buying.add(mint);
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  },
});
