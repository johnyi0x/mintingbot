import "dotenv/config";
import { mkdirSync, appendFileSync } from "node:fs";
import { Contract, JsonRpcProvider } from "ethers";
import {
  NFT,
  SEADROP,
  SEADROP_ABI,
  PUBLIC_RPC,
  EXPLORER_TX,
  alchemyHttp,
} from "./config.js";

const PUBLIC_STAGE = 0n;
const OUT = "logs/public-mints.jsonl";

function rpcUrl() {
  return process.env.ALCHEMY_API_KEY
    ? alchemyHttp(process.env.ALCHEMY_API_KEY)
    : PUBLIC_RPC;
}

const provider = new JsonRpcProvider(rpcUrl(), 4663);
const seaDrop = new Contract(SEADROP, SEADROP_ABI, provider);
const drop = await seaDrop.getPublicDrop(NFT);

mkdirSync("logs", { recursive: true });
console.log("Watching SeaDropMint for", NFT);
console.log("Public window", new Date(Number(drop.startTime) * 1000).toISOString(), "->", new Date(Number(drop.endTime) * 1000).toISOString());
console.log("Writing", OUT);

const filter = seaDrop.filters.SeaDropMint(NFT);
const fromBlock = Math.max(0, (await provider.getBlockNumber()) - 50_000);

async function handle(minter, feeRecipient, eventOrLog) {
  const log = eventOrLog.log ?? eventOrLog;
  const parsed = seaDrop.interface.parseLog(log);
  const { payer, quantity, unitMintPrice, dropStageIndex } = parsed.args;
  const block = await provider.getBlock(log.blockNumber);
  const row = {
    tx: log.transactionHash,
    explorer: EXPLORER_TX + log.transactionHash,
    block: log.blockNumber,
    timestamp: block.timestamp,
    iso: new Date(block.timestamp * 1000).toISOString(),
    minter,
    payer,
    quantity: quantity.toString(),
    unitMintPrice: unitMintPrice.toString(),
    dropStageIndex: dropStageIndex.toString(),
    isPublicStage: dropStageIndex === PUBLIC_STAGE,
    inPublicWindow:
      block.timestamp >= Number(drop.startTime) &&
      block.timestamp <= Number(drop.endTime),
  };
  appendFileSync(OUT, JSON.stringify(row) + "\n");
  if (row.isPublicStage || row.inPublicWindow) {
    console.log("PUBLIC MINT", row.iso, row.minter, "qty", row.quantity, row.explorer);
  }
}

const history = await seaDrop.queryFilter(filter, fromBlock, "latest");
console.log("backfill", history.length, "SeaDropMint logs");
for (const ev of history) {
  await handle(ev.args.minter, ev.args.feeRecipient, ev);
}

seaDrop.on(filter, handle);
console.log("live listener attached — leave this running through the public hour");
