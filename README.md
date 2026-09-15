# Rare Friends Genesis mint sniper

Robinhood Chain drop for [Rare Friends Genesis](https://opensea.io/collection/rare-friends-genesis/overview).
Contract: [`0x116EaA62241751E0c98dA43d458600c6C17cD361`](https://robin.etherscan.io/address/0x116eaa62241751e0c98da43d458600c6c17cd361)

## What this project is

This is a **your-wallet** mint bot. It watches the OpenSea SeaDrop contract and submits `mintPublic` the moment the on-chain public window is valid. It does not bypass allowlists, exploit the contract, or mint more than the contract allows.

## On-chain facts (checked 2026-09-15 00:39 UTC)

| Field | Value |
| --- | --- |
| Chain | Robinhood Chain, id `4663` |
| Mint router | OpenSea SeaDrop `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5` |
| Max supply | **1024** |
| Already minted (whitelist FCFS) | **790** → **234** left for public |
| Public price | **0 ETH (free)** |
| Max per wallet | **1, lifetime** (whitelist + public share this cap) |
| Public start | **2026-09-15 11:00:20 AM CDT** (`1789488020`) |
| Public end | **2026-09-15 12:00:20 PM CDT** (`1789491620`) — **one hour only** |
| Allowlist merkle | empty when checked (whitelist stage was already winding down) |
| Required fee recipient | `0x0000a26b00c1F0DF003000390027140000fAa719` |

Verified OpenSea collection. Floor was ~0.83 ETH / ~$2,091 while whitelist was live. Team is presented as Doodles-adjacent (Poopie / Doodles co-founder). That is marketing, not a guarantee of value.

If this wallet **already minted during whitelist**, public mint will revert. SeaDrop counts every mint against `maxTotalMintableByWallet`.

## Keys and APIs — do not use a seed phrase

**Do not put a 12/24-word mnemonic in this bot, in chat, or in `.env`.** If that phrase is leaked, the whole wallet tree is drained.

Use a **new hot wallet** that only holds a little Robinhood Chain ETH for gas:

1. Create a fresh wallet in MetaMask / Rabby.
2. Add Robinhood Chain: RPC `https://rpc.mainnet.chain.robinhood.com`, chain id `4663`, symbol `ETH`.
3. Bridge a small amount of ETH (a few dollars is enough; gas here is tiny).
4. Account details → export **private key** (hex), not the Secret Recovery Phrase.
5. Put that key in a **Windows user environment variable** named `RF_GENESIS_KEY` (not `PRIVATE_KEY`, not a seed phrase). Then open a **new** terminal.

For this terminal only:

```powershell
$env:RF_GENESIS_KEY = "0xYOUR_HOT_WALLET_PRIVATE_KEY"
```

Permanent (Settings → Environment variables, or):

```powershell
setx RF_GENESIS_KEY "0xYOUR_HOT_WALLET_PRIVATE_KEY"
```

`setx` does not apply until you close and reopen the terminal.

| Secret | Required? | Why |
| --- | --- | --- |
| `RF_GENESIS_KEY` … `RF_GENESIS_KEY7` | At least KEY; 2–7 optional | Account private keys (hex). Not the mnemonic. |
| `ALCHEMY_API_KEY` | Optional, faster | Low-latency HTTP + WebSocket. [dashboard.alchemy.com](https://dashboard.alchemy.com) |

You do **not** need an Etherscan key, OpenSea key, or `.env` file. RPC and sequencer URLs are built in.

## Setup

```powershell
cd C:\Users\oldca\Downloads\rare-friends-mint-bot
npm install
$env:RF_GENESIS_KEY = "0xYOUR_HOT_WALLET_PRIVATE_KEY"
node src/sniper.js
```

That one script: preflight (wallet / gas / supply / can-mint) → 60s countdown → 1s then 50ms then a spin-fire at 11:00:20 AM CDT.

Optional: `npm run status` (read-only) and `npm run watch` (who minted at public time).

Dry-run preflight only: `$env:RF_GENESIS_DRY_RUN = "1"` then run the sniper.

## How the sniper is fast

Public mint is **not** called on the NFT contract. OpenSea's SeaDrop contract calls `mintSeaDrop` after `mintPublic`:

```text
your wallet
  -> SeaDrop.mintPublic(nft, feeRecipient, address(0), 1)
    -> NFT.mintSeaDrop(you, 1)
```

Speed tactics used here:

- One Windows secret only (`RF_GENESIS_KEY`). RPC + sequencer URLs are built in.
- Preflight proves gas, nonce, remaining supply, lifetime mint cap, and fee recipient before waiting.
- Minute checks until T-2 minutes, 1s until T-15s, 40ms then 8ms, then a busy-wait so Ohio sequencer send hits at ~T-1ms.
- Pre-sign `mintPublic` (nonce + type-2 fees). Go-live is sequencer-first `eth_sendRawTransaction`; Alchemy/public RPC fan out without blocking W1–W7.
- All funded wallets fire at the same instant (no stagger). Same-nonce rebroadcast every ~8ms; backup nonce only after an on-chain revert.
- Optional Alchemy websocket for `newHeads` if `ALCHEMY_API_KEY` is set.
- If the first tx reverts (included a hair too early), resign the next nonce and retry while supply remains.

1 second in the last second is too slow for this drop. The 1s loop is only for the T-2m to T-15s window.

A bot cannot invent whitelist eligibility. If you are not on the merkle tree, `mintAllowList` reverts.

## Sequencer ping

```powershell
npm run ping
```

`npm start` / Render / Railway now run the **sniper**, not the ping.

On Render (Ohio): Environment → paste hex private keys as `RF_GENESIS_KEY` … `RF_GENESIS_KEY7`. Do **not** click Generate. Optional: `ALCHEMY_API_KEY`. Then Save, rebuild, and deploy. Logs should show `READY` and all seven wallets. Ping remains `npm run ping`.

## After public: did anyone mint?

```powershell
npm run watch
```

That writes `logs/public-mints.jsonl` with every `SeaDropMint` for this collection. Public stage uses `dropStageIndex = 0`. Filter `isPublicStage` / `inPublicWindow` to see who got in during 11:00–12:00 CDT.

## Risks

- 234 free mints, 1 per wallet, one hour: expect it to fill in seconds.
- Owner can change `startTime` with `multiConfigure` before go-live; the bot re-reads `getPublicDrop` while waiting.
- Never share `RF_GENESIS_KEY`. Never use your main seed phrase.
- NFT mints can go to zero. This is not financial advice.
