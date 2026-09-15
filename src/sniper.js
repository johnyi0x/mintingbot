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
  mkdirSync("logs", { recursive: true });
  appendFileSync("logs/sniper.log", line + "\n");
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

function intervalFor(msUntil) {
  if (msUntil > 120_000) return 60_000;
  if (msUntil > 15_000) return 1_000;
  if (msUntil > 2_000) return 40;
  return LIVE_RETRY_MS;
}

function feesFor(balance) {
  const cap = 1_700_000_000_000_000n;
  const dust = 50_000_000_000_000n;
  const leftover = balance > dust ? balance - dust : (balance * 90n) / 100n;
  const spend = leftover < cap ? leftover : cap;
  let maxFee = spend / GAS_LIMIT;
  if (maxFee < 4n * GWEI) maxFee = 4n * GWEI;
  if (maxFee * GAS_LIMIT > leftover && leftover > 0n) maxFee = leftover / GAS_LIMIT;
  if (maxFee > 100n * GWEI) maxFee = 100n * GWEI;
  let prio = (maxFee * 80n) / 100n;
  if (prio < 3n * GWEI) prio = 3n * GWEI;
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
const nft = new Contract(NFT, NFT_ABI, primary);
const seaDrop = new Contract(SEADROP, SEADROP_ABI, primary);

let ws = null;
let startMs = 0;
let endMs = 0;
let maxSupply = 1024n;
let maxPerWallet = 1n;
let mintPrice = 0n;
let soldOut = false;
let clockOffsetMs = 0;
const gunners = [];
const chainIdBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "eth_chainId",
  params: [],
});

function nowMs() {
  // Negative offset = last block is behind wall clock. Using it would fire early and revert.
  return Date.now() + Math.max(0, clockOffsetMs);
}

function allMinted() {
  return gunners.length > 0 && gunners.every((g) => g.success);
}

function pendingGunners() {
  return gunners.filter((g) => !g.success);
}

async function postRpc(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return res.json();
}

async function syncClock() {
  const t0 = Date.now();
  const block = await primary.getBlock("latest");
  const t1 = Date.now();
  const chainMs = Number(block.timestamp) * 1000 + (t1 - t0) / 2;
  clockOffsetMs = Math.round(chainMs - t1);
  log("clock vs chain", clockOffsetMs, "ms (positive = this PC is behind the chain)");
}

async function warmSequencer() {
  try {
    await postRpc(sequencerUrl, chainIdBody);
  } catch {
    /* keep-alive only */
  }
}

async function warmSenders() {
  await Promise.allSettled(sendUrls.map((url) => postRpc(url, chainIdBody)));
}

async function sendRaw(url, raw) {
  const json = await postRpc(
    url,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [raw],
    }),
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

function fanoutBackups(g, raw) {
  if (g.backupSent) return;
  g.backupSent = true;
  for (const url of backupUrls) {
    void sendRaw(url, raw).then(
      (hash) => {
        if (hash) g.lastHash = hash;
        log(g.tag, rpcLabel(url), hash);
      },
      (err) => {
        const msg = err.shortMessage || err.message || String(err);
        if (isQueued(msg)) log(g.tag, rpcLabel(url), "already queued");
        else log(g.tag, rpcLabel(url), "rpc error", msg);
      },
    );
  }
}

async function broadcast(g) {
  const raw = g.signedRaw;
  try {
    const hash = await sendRaw(sequencerUrl, raw);
    g.lastHash = hash;
    g.queued = true;
    log(g.tag, "sequencer", hash);
    fanoutBackups(g, raw);
    return hash;
  } catch (err) {
    const msg = err.shortMessage || err.message || String(err);
    if (isQueued(msg)) {
      g.queued = true;
      log(g.tag, "sequencer already queued");
      fanoutBackups(g, raw);
      return g.lastHash;
    }
    log(g.tag, "sequencer error", msg);
    const results = await Promise.allSettled(
      backupUrls.map((url) => sendRaw(url, raw).then((hash) => ({ url, hash }))),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        g.lastHash = r.value.hash;
        g.queued = true;
        g.backupSent = true;
        log(g.tag, rpcLabel(r.value.url), r.value.hash);
        return r.value.hash;
      }
      const m = r.reason?.shortMessage || r.reason?.message || String(r.reason);
      if (isQueued(m)) {
        g.queued = true;
        g.backupSent = true;
        log(g.tag, "backup already queued");
      } else log(g.tag, "backup rpc error", m);
    }
    return g.lastHash;
  }
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

async function signGunner(g) {
  g.queued = false;
  g.backupSent = false;
  g.nonce = await primary.getTransactionCount(g.address, "pending");
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
  log(g.tag, why);
  g.queued = false;
  g.backupSent = false;
  g.watching = false;
  g.inFlight = false;
  if (g.signedNext) {
    g.signedRaw = g.signedNext;
    g.nonce += 1;
    g.signedNext = await signAtNonce(g, g.nonce + 1);
  } else {
    await signGunner(g);
  }
  void blast(g, "backup-nonce");
}

async function watchReceipt(g, hash) {
  if (!hash || g.success) return;
  const rec = await primary.waitForTransaction(hash, 1, 8_000);
  if (g.success || soldOut) return;
  if (rec?.status === 1) {
    g.success = true;
    const stats = await nft.getMintStats(g.address);
    log(g.tag, "MINTED block", rec.blockNumber, `supply ${stats.currentTotalSupply}/${stats.maxSupply}`);
    return;
  }
  if (rec?.status === 0) {
    await promoteBackup(g, "reverted — firing backup nonce immediately");
    return;
  }
  const stats = await nft.getMintStats(g.address);
  if (stats.minterNumMinted > 0n) {
    g.success = true;
    log(g.tag, "MINTED (confirmed via balanceOf path)");
    return;
  }
  const late = await primary.waitForTransaction(hash, 1, 12_000);
  if (g.success || soldOut) return;
  if (late?.status === 1) {
    g.success = true;
    log(g.tag, "MINTED block", late.blockNumber);
    return;
  }
  if (late?.status === 0) {
    await promoteBackup(g, "reverted — firing backup nonce immediately");
  }
}

async function blast(g, reason) {
  if (g.success || g.inFlight || g.queued || !g.signedRaw || soldOut) return;
  g.inFlight = true;
  try {
    if (!g.lastFireLog || Date.now() - g.lastFireLog > 250) {
      log("FIRE", g.tag, reason);
      g.lastFireLog = Date.now();
    }
    const hash = await broadcast(g);
    if (hash && !g.watching) {
      g.watching = true;
      void watchReceipt(g, hash).finally(() => {
        g.watching = false;
      });
    }
  } catch (err) {
    log(g.tag, "fire error", err.shortMessage || err.message);
    try {
      await signGunner(g);
    } catch (e) {
      log(g.tag, "resign error", e.shortMessage || e.message);
    }
  } finally {
    g.inFlight = false;
  }
}

function fireWave(reason) {
  for (const g of gunners) {
    if (g.success || g.inFlight || g.queued || !g.signedRaw || soldOut) continue;
    void blast(g, reason);
  }
}

async function checkSoldOut() {
  try {
    const minted = await nft.totalMinted();
    if (minted >= maxSupply) {
      soldOut = true;
      log("sold out");
    }
  } catch (err) {
    log("supply check", err.shortMessage || err.message);
  }
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
  log("broadcast", sequencerUrl, "first, then", backupUrls.join(" | "));
  await Promise.all(providers.map(({ p }) => p.send("eth_blockNumber", [])));
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
    });
  }

  const sim = await simulate(startMs);
  console.log("");
  console.log("simulation     ", sim.ok ? sim.reason : sim.reason);
  console.log("armed wallets  ", gunners.map((g) => g.tag).join(", ") || "(none)");
  console.log("fire plan      ", "all wallets at once to Ohio sequencer; W1 is not delayed");
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
    "READY:",
    gunners.length,
    "wallet(s). Independent sequencer shots, no stagger. NotActive until start is expected. Fire:",
    gunners.map((g) => g.tag).join(", "),
  );

  await Promise.all(gunners.map((g) => signGunner(g)));

  if (env("ALCHEMY_API_KEY")) {
    ws = new WebSocketProvider(alchemyWs(env("ALCHEMY_API_KEY")), 4663);
    ws.on("block", async (n) => {
      if (allMinted() || soldOut) return;
      try {
        const b = await ws.getBlock(n);
        if (b && b.timestamp >= Math.floor(startMs / 1000)) fireWave(`ws-block-${n}`);
      } catch (err) {
        log("ws error", err.message);
      }
    });
    log("Alchemy websocket armed");
  }

  if (DRY_RUN) {
    log("RF_GENESIS_DRY_RUN=1 — preflight only");
    process.exit(0);
  }
}

async function waitLoop() {
  let lastResign = 0;
  let lastLog = 0;
  let lastSupply = 0;
  let lastWarm = 0;
  let opened = false;
  while (!allMinted() && !soldOut && nowMs() < endMs + 12_000) {
    const until = startMs - nowMs();

    if (until <= 15_000) live = true;

    if (until <= GO_WINDOW_MS) {
      if (until > 1) {
        const spinUntil = startMs - 1;
        while (nowMs() < spinUntil) {
          if (spinUntil - nowMs() > 8) await sleep(4);
        }
      }
      fireWave(opened ? "retry" : "go");
      opened = true;
      if (Date.now() - lastSupply > 200) {
        lastSupply = Date.now();
        void checkSoldOut();
      }
      await sleep(LIVE_RETRY_MS);
      continue;
    }

    const wait = Math.min(intervalFor(until), Math.max(1, until - GO_WINDOW_MS));

    if (until <= 15_000 && Date.now() - lastWarm > 80) {
      lastWarm = Date.now();
      void warmSequencer();
    }

    if (until <= 12_000 && until > GO_WINDOW_MS && Date.now() - lastResign > 2_000) {
      try {
        const drop = await seaDrop.getPublicDrop(NFT);
        startMs = Number(drop.startTime) * 1000;
        endMs = Number(drop.endTime) * 1000;
        mintPrice = drop.mintPrice;
        await Promise.all(pendingGunners().map((g) => signGunner(g)));
        lastResign = Date.now();
      } catch (err) {
        log("resign error", err.shortMessage || err.message);
      }
    }

    if (wait >= 1_000) {
      try {
        const [minted, drop, block] = await Promise.all([
          nft.totalMinted(),
          seaDrop.getPublicDrop(NFT),
          primary.getBlock("latest"),
        ]);
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
        await Promise.all([syncClock(), warmSenders()]);
        if (Date.now() - lastResign > 50_000) {
          await Promise.all(pendingGunners().map((g) => signGunner(g)));
          lastResign = Date.now();
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
}

bindRenderPort();
await preflight();
log(
  "waiting — 60s until T-2m, then 1s, then 40ms, then 8ms Ohio retry. All wallets fire together at startTime (sequencer-first, same-nonce rebroadcast, backup nonce only after revert).",
);
await waitLoop();

if (ws) await ws.destroy();
for (const { p } of providers) p.destroy();

for (const g of gunners) {
  log(g.tag, g.success ? "OK minted" : "did not mint");
}
if (!gunners.some((g) => g.success)) {
  log("no wallet minted");
  process.exit(1);
}
log("done");
