// ============================================================
// DEEPFUN INDEXER
// Watches Launchpad + PoolManager on Base mainnet via Alchemy,
// computes real on-chain stats (price, MC, liquidity, volume,
// holders), and keeps Supabase updated so the frontend can serve
// data with a single fast query instead of dozens of live chain
// calls per page load.
//
// All math here is ported directly from what the frontend already
// proved correct - same tick-based pricing, same getAmountsForLiquidity
// logic for pooled amounts, same Swap-event-based volume/buy-sell
// counting. This script is just where that work now happens
// continuously, in the background, instead of in the browser.
// ============================================================

import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

// ---- Config - fill in your own values via environment variables ----
const ALCHEMY_URL = process.env.ALCHEMY_URL || 'https://base-mainnet.g.alchemy.com/v2/alch_rypQSixJs31hPzSbFylGB';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sgzxsuvzwaezisdyavzw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_qX57faHzp4268dvbwYop8g_cupl5dkD';
const POLL_INTERVAL_MS = 30_000; // recompute stats every 30 seconds

const ADDRESSES = {
  poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  weth: '0x4200000000000000000000000000000000000006',
  launchpad: '0x2094Bdb307c379Bb2363cb7B5b546d9CD45c4453',
  hook: '0x8614079d0B847AE0CA251Cc763546c4e045600C4',
  stateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
  ethUsdFeed: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'
};
const LAUNCHPAD_DEPLOY_BLOCK = 49633178;
const POOL_FEE = 3000;
const TICK_SPACING = 60;

const ABI = {
  launchpad: [
    'function launchedTokenCount() view returns (uint256)',
    'function getLaunchedTokens(uint256 offset, uint256 limit) view returns (address[])',
    'function tokenImageURI(address) view returns (string)',
    'event TokenLaunched(address indexed token, address indexed creator, tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, int24 initTick, int24 tickLower, int24 tickUpper)'
  ],
  erc20: [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function balanceOf(address) view returns (uint256)'
  ],
  stateView: [
    'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
    'function getLiquidity(bytes32 poolId) view returns (uint128)'
  ],
  poolManager: [
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)'
  ],
  chainlink: [
    'function latestRoundData() view returns (uint80, int256 answer, uint256, uint256, uint80)',
    'function decimals() view returns (uint8)'
  ]
};

const provider = new ethers.JsonRpcProvider(ALCHEMY_URL);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let cachedEthPrice = null;
let cachedEthPriceAt = 0;

async function getEthUsdPrice() {
  if (cachedEthPrice && Date.now() - cachedEthPriceAt < 60_000) return cachedEthPrice;
  const feed = new ethers.Contract(ADDRESSES.ethUsdFeed, ABI.chainlink, provider);
  const [, answer] = await feed.latestRoundData();
  const dec = await feed.decimals();
  cachedEthPrice = Number(answer) / (10 ** Number(dec));
  cachedEthPriceAt = Date.now();
  return cachedEthPrice;
}

function tokenIsCurrency0(tokenAddr) {
  return tokenAddr.toLowerCase() < ADDRESSES.weth.toLowerCase();
}

function buildPoolKey(tokenAddr) {
  const isC0 = tokenIsCurrency0(tokenAddr);
  return {
    currency0: isC0 ? tokenAddr : ADDRESSES.weth,
    currency1: isC0 ? ADDRESSES.weth : tokenAddr,
    fee: POOL_FEE,
    tickSpacing: TICK_SPACING,
    hooks: ADDRESSES.hook
  };
}

function computePoolId(key) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
  );
  return ethers.keccak256(encoded);
}

async function getTokenPriceUsd(tokenAddr) {
  const key = buildPoolKey(tokenAddr);
  const poolId = computePoolId(key);
  const stateView = new ethers.Contract(ADDRESSES.stateView, ABI.stateView, provider);
  const [, tick] = await stateView.getSlot0(poolId);
  const ethUsd = await getEthUsdPrice();
  const priceRatio = Math.pow(1.0001, Number(tick));
  const isC0 = tokenIsCurrency0(tokenAddr);
  const tokenPriceInWeth = isC0 ? priceRatio : (1 / priceRatio);
  return tokenPriceInWeth * ethUsd;
}

async function queryLogsChunked(contract, filter, fromBlock, toBlock, chunkSize = 2000) {
  const latestBlock = toBlock === 'latest' ? await provider.getBlockNumber() : toBlock;
  let allLogs = [];
  for (let start = fromBlock; start <= latestBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, latestBlock);
    try {
      const chunkLogs = await contract.queryFilter(filter, start, end);
      allLogs = allLogs.concat(chunkLogs);
    } catch (e) {
      console.error('Log chunk failed', start, end, e.message);
    }
  }
  return allLogs;
}

async function getPooledAmounts(tokenAddr) {
  const launchpad = new ethers.Contract(ADDRESSES.launchpad, ABI.launchpad, provider);
  const filter = launchpad.filters.TokenLaunched(tokenAddr);
  const logs = await queryLogsChunked(launchpad, filter, LAUNCHPAD_DEPLOY_BLOCK, 'latest');
  if (logs.length === 0) return null;
  const { tickLower, tickUpper } = logs[0].args;

  const key = buildPoolKey(tokenAddr);
  const poolId = computePoolId(key);
  const stateView = new ethers.Contract(ADDRESSES.stateView, ABI.stateView, provider);
  const [, currentTick] = await stateView.getSlot0(poolId);
  const liquidity = await stateView.getLiquidity(poolId);

  const L = Number(liquidity);
  const sqrtCurrent = Math.pow(1.0001, Number(currentTick) / 2);
  const sqrtLower = Math.pow(1.0001, Number(tickLower) / 2);
  const sqrtUpper = Math.pow(1.0001, Number(tickUpper) / 2);

  let amount0, amount1;
  if (sqrtCurrent <= sqrtLower) {
    amount0 = L * (1 / sqrtLower - 1 / sqrtUpper);
    amount1 = 0;
  } else if (sqrtCurrent >= sqrtUpper) {
    amount0 = 0;
    amount1 = L * (sqrtUpper - sqrtLower);
  } else {
    amount0 = L * (1 / sqrtCurrent - 1 / sqrtUpper);
    amount1 = L * (sqrtCurrent - sqrtLower);
  }

  const isC0 = tokenIsCurrency0(tokenAddr);
  const rawTokenAmount = isC0 ? amount0 : amount1;
  const rawWethAmount = isC0 ? amount1 : amount0;
  const tokenAmount = rawTokenAmount / 1e18;
  const wethAmount = rawWethAmount / 1e18;

  const ethUsd = await getEthUsdPrice();
  const tokenPriceUsd = await getTokenPriceUsd(tokenAddr);

  return {
    tokenAmountUsd: tokenAmount * tokenPriceUsd,
    wethAmountUsd: wethAmount * ethUsd
  };
}

async function getPoolActivity(tokenAddr) {
  const key = buildPoolKey(tokenAddr);
  const poolId = computePoolId(key);
  const isC0 = tokenIsCurrency0(tokenAddr);
  const poolManager = new ethers.Contract(ADDRESSES.poolManager, ABI.poolManager, provider);

  const currentBlock = await provider.getBlockNumber();
  const blocksPerDay = Math.floor((24 * 60 * 60) / 2);
  const fromBlock = Math.max(0, currentBlock - blocksPerDay);

  const filter = poolManager.filters.Swap(poolId);
  const logs = await queryLogsChunked(poolManager, filter, fromBlock, 'latest');
  const ethUsd = await getEthUsdPrice();

  let volume24h = 0, buys24h = 0, sells24h = 0;
  const pricePoints = [];

  for (const log of logs) {
    const { amount0, amount1, tick } = log.args;
    const wethDelta = isC0 ? amount1 : amount0;
    const wethAmountAbs = Math.abs(Number(wethDelta)) / 1e18;
    volume24h += wethAmountAbs * ethUsd;
    if (wethDelta > 0n) buys24h++; else sells24h++;
    const priceRatio = Math.pow(1.0001, Number(tick));
    const tokenPriceInWeth = isC0 ? priceRatio : (1 / priceRatio);
    pricePoints.push({ block: log.blockNumber, priceUsd: tokenPriceInWeth * ethUsd });
  }

  pricePoints.sort((a, b) => a.block - b.block);
  let priceChange24h = null;
  if (pricePoints.length >= 2) {
    const first = pricePoints[0].priceUsd;
    const last = pricePoints[pricePoints.length - 1].priceUsd;
    if (first > 0) priceChange24h = ((last - first) / first) * 100;
  }

  return { volume24h, buys24h, sells24h, priceChange24h };
}

async function getHolderCount(tokenAddr) {
  try {
    const transfers = await provider.send('alchemy_getAssetTransfers', [{
      fromBlock: '0x' + LAUNCHPAD_DEPLOY_BLOCK.toString(16),
      toBlock: 'latest',
      contractAddresses: [tokenAddr],
      category: ['erc20'],
      withMetadata: false,
      maxCount: '0x3e8'
    }]);
    if (!transfers?.transfers) return null;

    const uniqueAddrs = new Set();
    for (const t of transfers.transfers) {
      if (t.to && t.to !== '0x0000000000000000000000000000000000000000') {
        uniqueAddrs.add(t.to.toLowerCase());
      }
    }
    uniqueAddrs.delete(ADDRESSES.poolManager.toLowerCase());
    uniqueAddrs.delete(ADDRESSES.launchpad.toLowerCase());
    uniqueAddrs.delete(ADDRESSES.hook.toLowerCase());

    const sample = Array.from(uniqueAddrs).slice(0, 150);
    const erc20 = new ethers.Contract(tokenAddr, ABI.erc20, provider);
    const balances = await Promise.all(sample.map(a => erc20.balanceOf(a).catch(() => 0n)));
    return balances.filter(b => b > 0n).length;
  } catch (e) {
    console.error('getHolderCount failed', e.message);
    return null;
  }
}

// ---- Step 1: sync new token launches into the `tokens` table ----
async function syncNewTokens() {
  const launchpad = new ethers.Contract(ADDRESSES.launchpad, ABI.launchpad, provider);
  const count = Number(await launchpad.launchedTokenCount());
  if (count === 0) return [];

  const addrs = await launchpad.getLaunchedTokens(0, count);
  const { data: existing } = await supabase.from('tokens').select('address');
  const knownAddrs = new Set((existing || []).map(r => r.address.toLowerCase()));

  for (const addr of addrs) {
    if (knownAddrs.has(addr.toLowerCase())) continue;

    try {
      const erc20 = new ethers.Contract(addr, ABI.erc20, provider);
      const [name, symbol, image] = await Promise.all([
        erc20.name(), erc20.symbol(), launchpad.tokenImageURI(addr)
      ]);

      const filter = launchpad.filters.TokenLaunched(addr);
      const logs = await queryLogsChunked(launchpad, filter, LAUNCHPAD_DEPLOY_BLOCK, 'latest');
      let creator = null, launchedAt = new Date().toISOString();
      if (logs.length > 0) {
        creator = logs[0].args.creator;
        const block = await provider.getBlock(logs[0].blockNumber);
        if (block) launchedAt = new Date(block.timestamp * 1000).toISOString();
      }

      await supabase.from('tokens').insert({
        address: addr.toLowerCase(),
        name, symbol,
        image: image || null,
        creator: creator || 'unknown',
        launched_at: launchedAt
      });
      console.log('New token indexed:', symbol, addr);
    } catch (e) {
      console.error('Failed to index new token', addr, e.message);
    }
  }

  return addrs;
}

// ---- Step 2: recompute live stats for every known token ----
async function updateAllStats(addrs) {
  for (const addr of addrs) {
    try {
      const [priceUsd, pooled, activity, holderCount] = await Promise.all([
        getTokenPriceUsd(addr).catch(() => null),
        getPooledAmounts(addr).catch(() => null),
        getPoolActivity(addr).catch(() => null),
        getHolderCount(addr).catch(() => null)
      ]);

      const marketCap = priceUsd ? priceUsd * 1_000_000_000 : null;
      const liquidityUsd = pooled ? (pooled.tokenAmountUsd + pooled.wethAmountUsd) : null;

      await supabase.from('token_stats').upsert({
        address: addr.toLowerCase(),
        price_usd: priceUsd,
        market_cap: marketCap,
        liquidity_usd: liquidityUsd,
        volume_24h: activity?.volume24h ?? null,
        price_change_24h: activity?.priceChange24h ?? null,
        holder_count: holderCount,
        buys_24h: activity?.buys24h ?? null,
        sells_24h: activity?.sells24h ?? null,
        updated_at: new Date().toISOString()
      });

      console.log('Stats updated:', addr, marketCap ? `MC $${marketCap.toFixed(0)}` : 'no price yet');
    } catch (e) {
      console.error('Failed to update stats for', addr, e.message);
    }
  }
}

async function runCycle() {
  console.log('--- Indexer cycle starting ---', new Date().toISOString());
  try {
    const addrs = await syncNewTokens();
    if (addrs.length > 0) await updateAllStats(addrs);
    console.log('--- Cycle complete ---');
  } catch (e) {
    console.error('Cycle failed:', e.message);
  }
}

console.log('Deepfun indexer starting. Polling every', POLL_INTERVAL_MS / 1000, 'seconds.');
runCycle();
setInterval(runCycle, POLL_INTERVAL_MS);
