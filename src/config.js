export const CHAIN_ID = 4663;

export const NFT = "0x116EaA62241751E0c98dA43d458600c6C17cD361";
export const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
export const FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
export const COLLECTION_SLUG = "rare-friends-genesis";

export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const SEQUENCER_RPC = "https://sequencer.mainnet.chain.robinhood.com";
export const SEQUENCER_FEED = "wss://feed.mainnet.chain.robinhood.com";
export const EXPLORER_TX = "https://robin.etherscan.io/tx/";
export const BLOCKSCOUT_TX = "https://robinhoodchain.blockscout.com/tx/";

export const NFT_ABI = [
  "function totalMinted() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function getMintStats(address minter) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)",
];

export const SEADROP_ABI = [
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
  "function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
  "function getAllowListMerkleRoot(address nftContract) view returns (bytes32)",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantity, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)",
  "error NotActive(uint256 currentTimestamp, uint256 startTimestamp, uint256 endTimestamp)",
  "error MintQuantityCannotBeZero()",
  "error MintQuantityExceedsMaxSupply(uint256 total, uint256 maxSupply)",
  "error MintQuantityExceedsMaxTokenSupplyForStage(uint256 total, uint256 maxTokenSupplyForStage)",
  "error MintQuantityExceedsMaxMintedPerWallet(uint256 total, uint256 maxPerWallet)",
  "error IncorrectPayment(uint256 got, uint256 want)",
  "error FeeRecipientCannotBeZeroAddress()",
  "error FeeRecipientNotAllowed()",
  "error PayerNotAllowed()",
];

export function alchemyHttp(apiKey) {
  return `https://robinhood-mainnet.g.alchemy.com/v2/${apiKey}`;
}

export function alchemyWs(apiKey) {
  return `wss://robinhood-mainnet.g.alchemy.com/v2/${apiKey}`;
}
