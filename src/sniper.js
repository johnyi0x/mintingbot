import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  WebSocketProvider,
  ZeroAddress,
  formatEther,
} from "ethers";
import {
  FEE_RECIPIENT,
  NFT,
  NFT_ABI,
  PUBLIC_RPC,
  SEADROP,
  SEADROP_ABI,
  SEQUENCER_RPC,
  alchemyHttp,
  alchemyWs,
} from "./config.js";

const QUANTITY = 1n;
const GAS_LIMIT = 210000n;
const GWEI = 1_000_000_000n;
const KEY_NAMES = [
  "RF_GENESIS_KEY",
  "RF_GENESIS_KEY2",
  "RF_GENESIS_KEY3",
  "RF_GENESIS_KEY4",
  "RF_GENESIS_KEY5",
  "RF_GENESIS_KEY6",
  "RF_GENESIS_KEY7",
];
const DRY_RUN = (process.env.RF_GENESIS_DRY_RUN || "").trim() === "1";
const LIVE_RETRY_MS = 8;
const GO_WINDOW_MS = 250;
const FIRE_LEAD_MS = 4;
const ARM_MS = 60 * 60 * 1000;
const HOT_MS = 120_000;
const IDLE_CHECK_MS = 60_000;
const FETCH_MS = 2_500;
const SEQ_FETCH_MS = 1_500;
/** During GO: short abort so a hung RPC frees the slot and the next wave can shoot. */
const GO_SEQ_MS = 450;
const GO_BACKUP_MS = 700;
const MAX_INFLIGHT_BACKUP = 1;
const HOT_ARM_MS = 8_000;

const mintIface = new Interface(SEADROP_ABI);
const mintData = mintIface.encodeFunctionData("mintPublic", [
  NFT,
  FEE_RECIPIENT,
  ZeroAddress,
  QUANTITY,
]);

let live = false;

function env(name) {
  return (process.env[name] || "").trim();
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  if (live) return;
  try {
    mkdirSync("logs", { recursive: true });
    appendFileSync("logs/sniper.log", line + "\n");
  } catch {
    /* never die on log IO */
  }
}

function fail(msg) {
  log("NOT READY:", msg);
  process.exit(1);
}

function bindRenderPort() {
  const port = Number(process.env.PORT);
  if (!Number.isFinite(port) || port <= 0) return;
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("sniper running\n");
  });
  server.listen(port, "0.0.0.0", () => {
    log("health server on port", String(port));
  });
}

function unique(urls) {
  return [...new Set(urls.filter(Boolean))];
}

function readUrls() {
  const extra = [];
  if (env("ALCHEMY_API_KEY")) extra.push(alchemyHttp(env("ALCHEMY_API_KEY")));
  if (env("RPC_URL")) extra.push(env("RPC_URL"));
  return unique([...extra, PUBLIC_RPC]);
}

function cdt(unix) {
  return new Date(Number(unix) * 1000).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function eta(ms) {
  if (ms <= 0) return "NOW";
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function intervalFor(msUntil) {
  if (msUntil > 15 * 60_000) return 5 * 60_000;
  if (msUntil > 120_000) return 60_000;
  if (msUntil > 15_000) return 1_000;
  if (msUntil > 2_000) return 40;
  return LIVE_RETRY_MS;
}

function feesFor(balance) {
  const dust = 80_000_000_000_000n;
  const spendable = balance > dust ? balance - dust : (balance * 85n) / 100n;
  let maxFee = spendable / (GAS_LIMIT * 2n);
  if (maxFee < 1n) maxFee = 1n;
  let prio = (maxFee * 75n) / 100n;
  if (prio < 1n) prio = 1n;
  if (prio > maxFee) prio = maxFee;
  return { maxFee, prio };
}

function rpcLabel(url) {
  if (/sequencer/i.test(url)) return "sequencer";
  return url.split("/v2/")[0];
}

const keys = [];
for (const name of KEY_NAMES) {
  const value = env(name);
  if (!value) continue;
  if (value.split(/\s+/).length > 2) fail(`${name} looks like a seed phrase. Use a private key only.`);
  keys.push({ name, value });
}

if (!keys.length) {
  console.error(`
Missing wallet keys.

Set RF_GENESIS_KEY plus optional RF_GENESIS_KEY2 … RF_GENESIS_KEY7.
These are account private keys (0x hex), not Secret Recovery Phrases.
`);
  process.exit(1);
}

const urls = readUrls();
const sendUrls = unique([SEQUENCER_RPC, ...urls]);
const sequencerUrl = sendUrls.find((u) => /sequencer/i.test(u)) || SEQUENCER_RPC;
const backupUrls = sendUrls.filter((u) => u !== sequencerUrl);
const providers = urls.map((url) => ({
  url,
  p: new JsonRpcProvider(url, 4663, { staticNetwork: true }),
}));
const primary = providers[0].p;
const publicProvider = new JsonRpcProvider(PUBLIC_RPC, 4663, { staticNetwork: true });
const nft = new Contract(NFT, NFT_ABI, primary);
const seaDrop = new Contract(SEADROP, SEADROP_ABI, primary);
const watchNft = new Contract(NFT, NFT_ABI, publicProvider);
const watchSeaDrop = new Contract(SEADROP, SEADROP_ABI, publicProvider);

let ws = null;
let startMs = 0;
let endMs = 0;
let maxSupply = 1024n;
let maxPerWallet = 1n;
let mintPrice = 0n;
let soldOut = false;
let clockOffsetMs = 0;
/** Once true: never resign / never await RPC on the fire path. Fire engine owns minting. */
let goMode = false;
let fireTimer = null;
const gunners = [];
const chainIdBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "eth_chainId",
  params: [],
});

function nowMs() {
  return Date.now() + Math.max(0, clockOffsetMs);
}

function allMinted() {
  return gunners.length > 0 && gunners.every((g) => g.success);
}

function pendingGunners() {
  return gunners.filter((g) => !g.success);
}

async function postRpc(url, body, timeoutMs = FETCH_MS) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

async function syncClock() {
  const t0 = Date.now();
  const block = await withTimeout(primary.getBlock("latest"), FETCH_MS, "syncClock");
  const t1 = Date.now();
  const chainMs = Number(block.timestamp) * 1000 + (t1 - t0) / 2;
  clockOffsetMs = Math.round(chainMs - t1);
  log("clock vs chain", clockOffsetMs, "ms (positive = this PC is behind the chain)");
}

async function warmSequencer() {
  try {
    await postRpc(sequencerUrl, chainIdBody, SEQ_FETCH_MS);
  } catch {
    /* keep-alive only */
  }
}

async function warmSenders() {
  await Promise.allSettled(sendUrls.map((url) => postRpc(url, chainIdBody, FETCH_MS)));
}

async function sendRaw(url, raw, timeoutMs = FETCH_MS) {
  const json = await postRpc(
    url,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [raw],
    }),
    timeoutMs,
  );
  if (json.error) {
    const err = new Error(json.error.message || "rpc error");
    err.code = json.error.code;
    throw err;
  }
  return json.result;
}

function isQueued(msg) {
  return /already known|known transaction|nonce too low/i.test(msg || "");
}

/** Always POST sequencer every wave (void). Never await. Never skip a shot because RPC is slow. */
function shootRaw(g, raw) {
  const targets = [sequencerUrl, ...backupUrls];
  for (let i = 0; i < targets.length; i++) {
    const url = targets[i];
    const isSeq = i === 0;
    // Backups every 3rd wave — sequencer fires EVERY wave.
    if (!isSeq && (g.waveCount % 3) !== 0) continue;

    // Only throttle backups. Sequencer never skips — max send rate until close.
    if (!isSeq) {
      const inflight = g.inflight.get(url) || 0;
      if (inflight >= MAX_INFLIGHT_BACKUP) continue;
      g.inflight.set(url, inflight + 1);
    }

    const timeoutMs = goMode
      ? isSeq
        ? GO_SEQ_MS
        : GO_BACKUP_MS
      : isSeq
        ? SEQ_FETCH_MS
        : FETCH_MS;

    void sendRaw(url, raw, timeoutMs)
      .then(
        (hash) => {
          if (hash) {
            g.lastHash = hash;
            g.queued = true;
            if (!goMode || !g.lastHashLog || Date.now() - g.lastHashLog > 150) {
              log(g.tag, rpcLabel(url), hash);
              g.lastHashLog = Date.now();
            }
            if (!g.watching) {
              g.watching = true;
              void watchReceipt(g, hash).finally(() => {
                g.watching = false;
              });
            }
          }
        },
        (err) => {
          const msg = err.shortMessage || err.message || String(err);
          if (isQueued(msg)) {
            g.queued = true;
            if (!goMode || !g.lastHashLog || Date.now() - g.lastHashLog > 200) {
              log(g.tag, rpcLabel(url), "already queued");
              g.lastHashLog = Date.now();
            }
          } else if (/exceeds max supply|MintQuantityExceedsMaxSupply/i.test(msg)) {
            soldOut = true;
            log("sold out — stopping sends");
            stopFireEngine();
          } else if (!/timeout/i.test(msg)) {
            if (!goMode || !g.lastErrLog || Date.now() - g.lastErrLog > 300) {
              log(g.tag, rpcLabel(url), "rpc error", msg);
              g.lastErrLog = Date.now();
            }
          }
        },
      )
      .finally(() => {
        if (!isSeq) {
          g.inflight.set(url, Math.max(0, (g.inflight.get(url) || 1) - 1));
        }
      });
  }
  g.waveCount = (g.waveCount || 0) + 1;
}

async function signAtNonce(g, nonce) {
  return g.signer.signTransaction({
    to: SEADROP,
    data: mintData,
    chainId: 4663n,
    nonce,
    value: mintPrice * QUANTITY,
    gasLimit: GAS_LIMIT,
    maxFeePerGas: g.maxFee,
    maxPriorityFeePerGas: g.prio,
    type: 2,
  });
}

async function refreshFees(g) {
  if (goMode) return;
  const balance = await withTimeout(primary.getBalance(g.address), FETCH_MS, "balance");
  const { maxFee, prio } = feesFor(balance);
  g.maxFee = maxFee;
  g.prio = prio;
}

async function signGunner(g) {
  if (goMode) return;
  g.queued = false;
  g.backupSent = false;
  g.nonce = await withTimeout(primary.getTransactionCount(g.address, "pending"), FETCH_MS, "nonce");
  g.signedRaw = await signAtNonce(g, g.nonce);
  g.signedNext = await signAtNonce(g, g.nonce + 1);
  log(
    g.tag,
    "pre-signed nonce",
    g.nonce,
    "+",
    g.nonce + 1,
    "maxFee",
    `${g.maxFee / GWEI} gwei`,
    "tip",
    `${g.prio / GWEI} gwei`,
  );
}

async function promoteBackup(g, why) {
  if (soldOut || g.success) return;
  log(g.tag, why);
  g.queued = false;
  g.backupSent = false;
  g.watching = false;
  g.inFlight = false;
  try {
    if (g.signedNext) {
      g.signedRaw = g.signedNext;
      g.nonce += 1;
      // Do not await fresh sign during GO — fire engine keeps blasting swapped raw.
      if (!goMode) {
        g.signedNext = await signAtNonce(g, g.nonce + 1);
      } else {
        void signAtNonce(g, g.nonce + 1)
          .then((raw) => {
            if (!g.success) g.signedNext = raw;
          })
          .catch(() => {});
      }
    } else if (!goMode) {
      await withTimeout(signGunner(g), FETCH_MS * 3, "promoteBackup sign");
    }
  } catch (err) {
    log(g.tag, "promoteBackup error", err.message || err);
    return;
  }
  blast(g, "backup-nonce");
}

async function watchReceipt(g, hash) {
  if (!hash || g.success) return;
  try {
    const rec = await withTimeout(primary.waitForTransaction(hash, 1, 8_000), 10_000, "receipt");
    if (g.success || soldOut) return;
    if (rec?.status === 1) {
      g.success = true;
      try {
        const stats = await withTimeout(nft.getMintStats(g.address), FETCH_MS, "mintStats");
        log(g.tag, "MINTED block", rec.blockNumber, `supply ${stats.currentTotalSupply}/${stats.maxSupply}`);
      } catch {
        log(g.tag, "MINTED block", rec.blockNumber);
      }
      if (allMinted()) stopFireEngine();
      return;
    }
    if (rec?.status === 0) {
      void promoteBackup(g, "reverted — firing backup nonce immediately");
      return;
    }
  } catch (err) {
    if (!goMode) log(g.tag, "receipt wait", err.message || err);
  }

  try {
    const stats = await withTimeout(nft.getMintStats(g.address), FETCH_MS, "mintStats2");
    if (stats.minterNumMinted > 0n) {
      g.success = true;
      log(g.tag, "MINTED (confirmed via balance)");
      if (allMinted()) stopFireEngine();
      return;
    }
  } catch {
    /* ignore */
  }

  try {
    const late = await withTimeout(primary.waitForTransaction(hash, 1, 12_000), 14_000, "receipt2");
    if (g.success || soldOut) return;
    if (late?.status === 1) {
      g.success = true;
      log(g.tag, "MINTED block", late.blockNumber);
      if (allMinted()) stopFireEngine();
      return;
    }
    if (late?.status === 0) {
      void promoteBackup(g, "reverted — firing backup nonce immediately");
    }
  } catch (err) {
    if (!goMode) log(g.tag, "late receipt", err.message || err);
    g.queued = false;
    g.inFlight = false;
  }
}

function blast(g, reason) {
  if (g.success || !g.signedRaw || soldOut) return;
  if (!g.lastFireLog || Date.now() - g.lastFireLog > 200) {
    log("FIRE", g.tag, reason);
    g.lastFireLog = Date.now();
  }
  shootRaw(g, g.signedRaw);
}

function fireWave(reason) {
  for (const g of gunners) {
    if (g.success || !g.signedRaw || soldOut) continue;
    blast(g, reason);
  }
}

/** Independent mint engine: setInterval only. Never awaits RPC. CCA waited on receipt — we never do. */
function startFireEngine(reason) {
  if (soldOut || allMinted()) return;
  if (fireTimer) return;
  goMode = true;
  live = true;
  log("FIRE ENGINE ON —", reason, "— sequencer POST every", String(LIVE_RETRY_MS) + "ms until mint/soldout/close, never await");
  fireWave(reason);
  fireTimer = setInterval(() => {
    if (soldOut || allMinted() || nowMs() > endMs + 12_000) {
      stopFireEngine();
      return;
    }
    fireWave("retry");
  }, LIVE_RETRY_MS);
}

function stopFireEngine() {
  if (fireTimer) {
    clearInterval(fireTimer);
    fireTimer = null;
  }
}

async function checkSoldOut() {
  if (soldOut) return;
  try {
    const minted = await withTimeout(nft.totalMinted(), FETCH_MS, "totalMinted");
    if (minted >= maxSupply) {
      soldOut = true;
      stopFireEngine();
      log("sold out");
    }
  } catch (err) {
    if (!goMode) log("supply check", err.shortMessage || err.message);
  }
}

async function parkForever(why) {
  stopFireEngine();
  log(why);
  log("PARK — no more sends, no more RPC. leftover ETH stays in the wallets. health server stays up so Render does not restart.");
  if (ws) {
    try {
      await ws.destroy();
    } catch {
      /* already closed */
    }
    ws = null;
  }
  for (const { p } of providers) {
    try {
      p.destroy();
    } catch {
      /* already closed */
    }
  }
  try {
    publicProvider.destroy();
  } catch {
    /* already closed */
  }
  for (;;) await sleep(3_600_000);
}

async function simulate(dropStartMs) {
  try {
    await seaDrop.mintPublic.staticCall(NFT, FEE_RECIPIENT, ZeroAddress, QUANTITY, {
      from: gunners[0].address,
      value: 0n,
    });
    return { ok: true, reason: "eth_call succeeded — mint would land on current state" };
  } catch (err) {
    const name = err.revert?.name || "";
    const reason = err.shortMessage || err.message || String(err);
    const beforeStart = Date.now() < dropStartMs;
    const expected =
      name === "NotActive" ||
      /not active|NotActive|before start|inactive/i.test(reason) ||
      (beforeStart && /unknown custom error|execution reverted/i.test(reason));
    return { ok: false, expected, reason: name ? `${name}: ${reason}` : reason };
  }
}

async function preflight() {
  log("read RPC", urls.join(" | "));
  log("broadcast", sequencerUrl, "first + backups parallel; all fetches time out");
  await Promise.all(providers.map(({ p }) => withTimeout(p.send("eth_blockNumber", []), FETCH_MS, "warmup")));
  await Promise.all([syncClock(), warmSenders()]);

  const [drop, block, fees, chainId, totalMinted] = await Promise.all([
    seaDrop.getPublicDrop(NFT),
    primary.getBlock("latest"),
    seaDrop.getAllowedFeeRecipients(NFT),
    primary.getNetwork(),
    nft.totalMinted(),
  ]);
  if (Number(chainId.chainId) !== 4663) fail(`wrong chain id ${chainId.chainId}, expected 4663`);

  startMs = Number(drop.startTime) * 1000;
  endMs = Number(drop.endTime) * 1000;
  try {
    maxSupply = await nft.maxSupply();
  } catch {
    maxSupply = 1024n;
  }
  maxPerWallet = drop.maxTotalMintableByWallet;
  mintPrice = drop.mintPrice;
  const remaining = maxSupply - totalMinted;

  const seen = new Set();
  const problems = [];
  console.log("");
  console.log("========== PREFLIGHT ==========");
  console.log("chain          ", "Robinhood 4663");
  console.log("minted/supply  ", `${totalMinted}/${maxSupply}   left ${remaining}`);
  console.log("public price   ", mintPrice === 0n ? "FREE" : `${formatEther(mintPrice)} ETH`);
  console.log("public start   ", cdt(drop.startTime), "CDT");
  console.log("public end     ", cdt(drop.endTime), "CDT");
  console.log("max / wallet   ", maxPerWallet.toString(), "(lifetime)");
  console.log("latest block   ", block.number, cdt(block.timestamp), "CDT");
  console.log("time until mint", eta(startMs - nowMs()));
  console.log("wallets loaded ", keys.length, "/ 7");

  for (let i = 0; i < keys.length; i++) {
    const tag = `W${i + 1}`;
    const signer = new Wallet(keys[i].value, primary);
    const address = signer.address;
    if (seen.has(address.toLowerCase())) {
      log(tag, "SKIP duplicate of", address);
      continue;
    }
    seen.add(address.toLowerCase());
    const [stats, balance, nonce] = await Promise.all([
      nft.getMintStats(address),
      primary.getBalance(address),
      primary.getTransactionCount(address, "pending"),
    ]);
    const { maxFee, prio } = feesFor(balance);
    const worst = maxFee * GAS_LIMIT;
    console.log("");
    console.log(`${tag} ${keys[i].name}`);
    console.log("  wallet       ", address);
    console.log("  ETH          ", formatEther(balance));
    console.log("  nonce        ", nonce);
    console.log("  already mint ", `${stats.minterNumMinted} / ${maxPerWallet}`);
    console.log("  fee cap      ", `${formatEther(worst)} ETH  (${maxFee / GWEI} gwei / ${prio / GWEI} gwei tip)`);

    if (balance === 0n) {
      problems.push(`${tag} has 0 ETH`);
      continue;
    }
    if (stats.minterNumMinted >= maxPerWallet && maxPerWallet > 0n) {
      problems.push(`${tag} already minted lifetime max`);
      continue;
    }
    gunners.push({
      tag,
      name: keys[i].name,
      signer,
      address,
      nonce,
      signedRaw: null,
      signedNext: null,
      lastHash: null,
      maxFee,
      prio,
      queued: false,
      backupSent: false,
      success: false,
      inFlight: false,
      watching: false,
      lastFireLog: 0,
      lastHashLog: 0,
      lastErrLog: 0,
      waveCount: 0,
      inflight: new Map(),
    });
  }

  const sim = await simulate(startMs);
  console.log("");
  console.log("simulation     ", sim.ok ? sim.reason : sim.reason);
  console.log("armed wallets  ", gunners.map((g) => g.tag).join(", ") || "(none)");
  console.log("fire plan      ", "independent fire engine @8ms; never await send/receipt; inflight-capped; idle until T-1h");
  console.log("================================");
  console.log("");

  if (!drop.startTime) problems.push("public startTime is not configured");
  if (Date.now() > endMs) problems.push("public window already ended");
  if (remaining <= 0n) problems.push("collection is fully minted");
  const feeOk = fees.some((a) => a.toLowerCase() === FEE_RECIPIENT.toLowerCase());
  if (drop.restrictFeeRecipients && !feeOk) problems.push("OpenSea fee recipient is not allowed on-chain");
  if (!sim.ok && !sim.expected) problems.push(`mint simulation failed: ${sim.reason}`);
  if (!gunners.length) problems.push("no wallet is fundable and eligible");

  if (problems.length) {
    for (const p of problems) log("NOT READY:", p);
    process.exit(1);
  }

  log(
    "PREFLIGHT OK:",
    gunners.length,
    "wallet(s). Public start",
    cdt(drop.startTime),
    "CDT. Fire:",
    gunners.map((g) => g.tag).join(", "),
  );

  if (DRY_RUN) {
    log("RF_GENESIS_DRY_RUN=1 — preflight only");
    process.exit(0);
  }
}

async function armAlchemyWs() {
  if (ws || !env("ALCHEMY_API_KEY")) return;
  ws = new WebSocketProvider(alchemyWs(env("ALCHEMY_API_KEY")), 4663);
  ws.on("block", (n) => {
    if (allMinted() || soldOut) return;
    if (nowMs() >= startMs) startFireEngine(`ws-head-${n}`);
  });
  log("Alchemy websocket armed");
}

async function idleUntilArm() {
  if (startMs - nowMs() <= ARM_MS) return;
  log(
    "IDLE — no Alchemy WS, no sequencer warm, no resign. Public RPC re-reads startTime every 60s until T-1h. Mint",
    cdt(Math.floor(startMs / 1000)),
    "CDT",
  );
  while (!soldOut && nowMs() < endMs) {
    const until = startMs - nowMs();
    if (until <= ARM_MS) break;
    const sleepFor = Math.max(5_000, Math.min(until - ARM_MS, IDLE_CHECK_MS));
    log(`IDLE T-${eta(until)} — sleep ${eta(sleepFor)}`);
    await sleep(sleepFor);
    try {
      const [drop, minted] = await Promise.all([
        withTimeout(watchSeaDrop.getPublicDrop(NFT), FETCH_MS, "idle drop"),
        withTimeout(watchNft.totalMinted(), FETCH_MS, "idle minted"),
      ]);
      startMs = Number(drop.startTime) * 1000;
      endMs = Number(drop.endTime) * 1000;
      mintPrice = drop.mintPrice;
      if (minted >= maxSupply) {
        soldOut = true;
        log("sold out during idle");
        return;
      }
      if (nowMs() > endMs) fail("public window already ended");
      log(
        `IDLE check start ${cdt(drop.startTime)} CDT  left ${maxSupply - minted}/${maxSupply}  T-${eta(startMs - nowMs())}`,
      );
    } catch (err) {
      log("IDLE check", err.shortMessage || err.message);
    }
  }
}

async function armReady() {
  log("READY T-1h — public RPC watch. Alchemy + sequencer warm start at T-2m.");
  await Promise.all(
    gunners.map(async (g) => {
      await refreshFees(g);
      await signGunner(g);
    }),
  );
}

async function hotArm() {
  if (goMode) return;
  log("HOT T-2m — Alchemy WS + sequencer keep-alive + resign (time-boxed)");
  try {
    await withTimeout(armAlchemyWs(), 3_000, "alchemy ws");
  } catch (err) {
    log("alchemy arm skip", err.message || err);
  }
  if (goMode) return;
  try {
    await withTimeout(
      Promise.all([
        syncClock().catch((e) => log("clock skip", e.message)),
        warmSenders(),
        ...pendingGunners().map(async (g) => {
          if (goMode) return;
          await refreshFees(g);
          await signGunner(g);
        }),
      ]),
      HOT_ARM_MS,
      "hot resign",
    );
  } catch (err) {
    log("hot arm partial/skip — will still fire with existing pre-signs", err.message || err);
  }
}

async function waitLoop() {
  let lastResign = 0;
  let lastLog = 0;
  let lastSupply = 0;
  let lastWarm = 0;
  let hotArmed = false;
  let goLogged = false;
  let goScheduled = false;

  while (!allMinted() && !soldOut && nowMs() < endMs + 12_000) {
    const until = startMs - nowMs();

    // Never block the loop on hot arm — kick it off once, continue.
    if (until <= HOT_MS && !hotArmed) {
      hotArmed = true;
      void hotArm();
    }

    if (until <= 15_000) live = true;

    // === MINT PATH: schedule / run fire engine. No busy-spin. No await on send/receipt. ===
    if (until <= GO_WINDOW_MS) {
      if (!goLogged) {
        log("GO WINDOW — schedule fire engine (sleep yields; no CPU spin; no RPC await)");
        goLogged = true;
      }

      if (!goScheduled) {
        goScheduled = true;
        const delay = Math.max(0, startMs - FIRE_LEAD_MS - nowMs());
        if (delay > 0 && delay < GO_WINDOW_MS + 100) {
          // Yields event loop (unlike busy-spin). Exact wake near T-4ms.
          setTimeout(() => startFireEngine("go"), delay);
        } else {
          startFireEngine(until > 0 ? "go" : "late-go");
        }
      } else if (!fireTimer && !soldOut && !allMinted()) {
        // Watchdog: if schedule missed or timer died, force engine on.
        startFireEngine("watchdog");
      }

      if (Date.now() - lastSupply > 500) {
        lastSupply = Date.now();
        void checkSoldOut();
      }
      await sleep(40);
      continue;
    }

    const wait = Math.min(intervalFor(until), Math.max(1, until - GO_WINDOW_MS));

    if (until <= 15_000 && Date.now() - lastWarm > 80) {
      lastWarm = Date.now();
      void warmSequencer();
    }

    // Last 12s: do NOT await multi-wallet resign (CCA froze waiting on RPC before fire).
    if (!goMode && until <= 12_000 && until > GO_WINDOW_MS && Date.now() - lastResign > 3_000) {
      lastResign = Date.now();
      void (async () => {
        try {
          const drop = await withTimeout(seaDrop.getPublicDrop(NFT), FETCH_MS, "go drop");
          if (goMode) return;
          startMs = Number(drop.startTime) * 1000;
          endMs = Number(drop.endTime) * 1000;
          mintPrice = drop.mintPrice;
        } catch (err) {
          log("resign/drop skip", err.message || err);
        }
      })();
    }

    if (wait >= 1_000) {
      try {
        const hot = until <= HOT_MS;
        const readerNft = hot ? nft : watchNft;
        const readerDrop = hot ? seaDrop : watchSeaDrop;
        const readerBlock = hot ? primary : publicProvider;
        const [minted, drop, block] = await withTimeout(
          Promise.all([
            readerNft.totalMinted(),
            readerDrop.getPublicDrop(NFT),
            readerBlock.getBlock("latest"),
          ]),
          FETCH_MS * 2,
          "watch tick",
        );
        if (goMode) {
          await sleep(wait);
          continue;
        }
        startMs = Number(drop.startTime) * 1000;
        endMs = Number(drop.endTime) * 1000;
        mintPrice = drop.mintPrice;
        const left = maxSupply - minted;
        const next = intervalFor(startMs - nowMs());
        log(
          `T-${eta(startMs - nowMs())}  left ${left}/${maxSupply}  block ${block.number}  wallets ${gunners.map((g) => (g.success ? g.tag + "✓" : g.tag)).join(",")}  next ${next >= 1000 ? next / 1000 + "s" : next + "ms"}`,
        );
        if (left <= 0n) {
          soldOut = true;
          log("sold out while waiting");
          return;
        }
        if (hot) {
          void syncClock().catch(() => {});
          void warmSenders();
        }
      } catch (err) {
        log("watch error", err.shortMessage || err.message);
      }
    } else if (Date.now() - lastLog > 1000) {
      log(`T-${eta(startMs - nowMs())} armed — ${pendingGunners().length} wallet(s) ready`);
      lastLog = Date.now();
    }

    await sleep(wait);
  }
  stopFireEngine();
}

bindRenderPort();
await preflight();
await idleUntilArm();
if (soldOut) {
  await parkForever("sold out before public");
}
try {
  await withTimeout(armReady(), 30_000, "armReady");
} catch (err) {
  log("armReady error — continuing with whatever is signed", err.message || err);
}
log(
  "watching — idle→T-1h→T-2m hot(non-blocking)→GO fire-engine(8ms, no await, inflight-capped). CCA-style receipt waits removed from fire path.",
);
try {
  await waitLoop();
} catch (err) {
  log("waitLoop crash", err.message || err);
}

for (const g of gunners) {
  log(g.tag, g.success ? "OK minted" : "did not mint");
}
if (soldOut) {
  await parkForever("collection minted out");
}
if (allMinted()) {
  await parkForever("all our wallets minted");
}
await parkForever("public window over — stopping so leftover ETH is not spent");
