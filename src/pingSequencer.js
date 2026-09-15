import { lookup } from "node:dns/promises";
import { hostname } from "node:os";
import { PUBLIC_RPC, SEQUENCER_RPC, alchemyHttp } from "./config.js";

const ROUNDS = Number(process.env.PING_ROUNDS || 12);
const LOOP =
  Boolean(process.env.RAILWAY_ENVIRONMENT) ||
  Boolean(process.env.RAILWAY_REPLICA_ID) ||
  process.env.PING_LOOP === "1";
const PAUSE_MS = Number(process.env.PING_EVERY_MS || 30000);

const TARGETS = [
  ["sequencer (this is the one that matters)", SEQUENCER_RPC],
  ["public RPC", PUBLIC_RPC],
];
if (process.env.ALCHEMY_API_KEY) {
  TARGETS.push(["alchemy HTTP", alchemyHttp(process.env.ALCHEMY_API_KEY.trim())]);
}

const body = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "eth_chainId",
  params: [],
});

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    min: s[0],
    p50: s[Math.floor(s.length / 2)],
    avg: Math.round(sum / s.length),
    max: s[s.length - 1],
  };
}

async function pingOnce(url) {
  const t0 = performance.now();
  let status = 0;
  let err = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    await res.text();
    status = res.status;
  } catch (e) {
    err = e.message;
  }
  return { ms: Math.round(performance.now() - t0), status, err };
}

async function runOnce() {
  const host = hostname();
  const region =
    process.env.RAILWAY_REPLICA_REGION ||
    process.env.RAILWAY_REGION ||
    process.env.FLY_REGION ||
    process.env.AWS_REGION ||
    process.env.VERCEL_REGION ||
    "(unknown — this is wherever this process is running)";

  console.log("============================================================");
  console.log(new Date().toISOString());
  console.log("host  ", host);
  console.log("region", region);
  console.log("rounds", ROUNDS);
  console.log("");

  for (const [label, url] of TARGETS) {
    const u = new URL(url);
    let ip = "?";
    try {
      const r = await lookup(u.hostname);
      ip = r.address;
    } catch (e) {
      ip = e.message;
    }
    console.log(`== ${label}`);
    console.log(`   ${u.hostname}  ->  ${ip}`);

    const samples = [];
    for (let i = 0; i < ROUNDS; i++) {
      const r = await pingOnce(url);
      samples.push(r.ms);
      const note = r.err ? r.err : `HTTP ${r.status}`;
      console.log(`   #${String(i + 1).padStart(2, "0")}  ${r.ms} ms   ${note}`);
    }
    const s = stats(samples);
    console.log(`   MIN ${s.min}   P50 ${s.p50}   AVG ${s.avg}   MAX ${s.max}  ms`);
    console.log("");
  }

  console.log("Compare MIN on sequencer. Lowest MIN wins.");
  console.log("JSON-RPC errors are fine — we only measure HTTP RTT.");
}

await runOnce();
if (LOOP) {
  console.log(`Railway/loop mode: repeating every ${PAUSE_MS}ms. Watch deploy logs.`);
  for (;;) {
    await new Promise((r) => setTimeout(r, PAUSE_MS));
    await runOnce();
  }
}
