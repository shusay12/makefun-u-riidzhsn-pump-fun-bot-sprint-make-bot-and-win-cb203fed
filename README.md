# Pump.fun Bot Sprint — Grind Rider

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/shusay12/makefun-u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/shusay12/makefun-u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A deterministic Solana trading bot for the make.fun bounty
"Pump.fun Bot Sprint: Make Bot And Win"
(u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed). It trades paper
money on a replay of pump.fun bonding-curve events, ranked on net PnL.

## Strategy: ride the grinds, skip the snipes

Sniping every new coin the moment its real SOL reserves reach 1 SOL does not
work here: the fill lands 2 slots after the decision, by which time the early
spike is usually over, and most coins that ever complete do so in a single-slot
burst the bot can never buy. Instead this bot rides steady grinds:

- **Entry** — a coin qualifies as a grinder when, over the last 200 slots, its
  mark price rose at least +50% while never drawing down more than 25% from
  its running peak, with real SOL reserves >= 2 SOL. One buy per episode; after
  a position closes the coin may qualify again if it grinds up a fresh leg.
- **Exit** — sell when the grind reverses: the mark price falls below its own
  value 200 slots ago minus 10%. Backstops: stop-loss -30% from the filled buy
  price, and a time exit after 5000 slots (~35 min). No fixed take-profit:
  grinders are held while the trend holds.
- **Size** — min(0.05 SOL, the 1%-of-real-reserves size cap), at most 5 open
  positions, so at most 0.25 SOL is ever at risk.

The bot is fully deterministic: every decision is a pure function of the
events seen so far, so two runs on the same replay produce byte-identical
action logs.

## Files

- `main.ts` — the bot (Node 22, TypeScript run as-is, no dependencies).
- `vendor/makefun-bot.ts` — the kit's replay harness SDK, vendored.
- `README.md`, `LICENSE` (MIT).

---
ref=susay21
