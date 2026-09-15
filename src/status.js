import { Contract, formatEther, JsonRpcProvider } from "ethers";
import {
  NFT,
  NFT_ABI,
  PUBLIC_RPC,
  SEADROP,
  SEADROP_ABI,
  alchemyHttp,
} from "./config.js";

function rpcUrl() {
  return process.env.ALCHEMY_API_KEY
    ? alchemyHttp(process.env.ALCHEMY_API_KEY)
    : PUBLIC_RPC;
}

function ts(unix) {
  if (!unix) return "unset";
  const d = new Date(Number(unix) * 1000);
  return `${d.toISOString()}  |  ${d.toLocaleString("en-US", { timeZone: "America/Chicago" })} CDT`;
}

const provider = new JsonRpcProvider(rpcUrl(), 4663);
const nft = new Contract(NFT, NFT_ABI, provider);
const seaDrop = new Contract(SEADROP, SEADROP_ABI, provider);

const [totalMinted, maxSupply, drop, merkle, block] = await Promise.all([
  nft.totalMinted(),
  nft.maxSupply(),
  seaDrop.getPublicDrop(NFT),
  seaDrop.getAllowListMerkleRoot(NFT),
  provider.getBlock("latest"),
]);

const remaining = maxSupply - totalMinted;
const now = Math.floor(Date.now() / 1000);
const start = Number(drop.startTime);
const end = Number(drop.endTime);
const publicLive = now >= start && now <= end && start > 0;

console.log("Rare Friends Genesis  —  on-chain status");
console.log("NFT          ", NFT);
console.log("SeaDrop      ", SEADROP);
console.log("Chain block  ", block.number, "  ts", ts(block.timestamp));
console.log("Minted       ", `${totalMinted}/${maxSupply}  (${remaining} left)`);
console.log("Public price ", drop.mintPrice === 0n ? "FREE" : `${formatEther(drop.mintPrice)} ETH`);
console.log("Max / wallet ", drop.maxTotalMintableByWallet.toString(), "(lifetime across all stages)");
console.log("Public start ", ts(start));
console.log("Public end   ", ts(end));
console.log("Public live  ", publicLive);
console.log("Allowlist root", merkle === 0n || merkle === "0x" + "0".repeat(64) ? "empty (whitelist mint not currently configured)" : merkle);
console.log("Seconds to go ", Math.max(0, start - now));
