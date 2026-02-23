require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ClobClient } = require('@polymarket/clob-client');
const { Wallet } = require('@ethersproject/wallet');
const { ethers } = require('ethers');

// ============================================
// CONFIGURATION (tout via env vars pour Railway)
// ============================================
const CONFIG = {
    CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL, 10) || 2000,
    MIN_TRADE_USD: parseFloat(process.env.MIN_TRADE_USD) || 0,
    FETCH_TIMEOUT: parseInt(process.env.FETCH_TIMEOUT, 10) || 8000,
    SLIPPAGE_MAX_PCT: parseFloat(process.env.SLIPPAGE_MAX_PCT) || 25,
    CLOB_HOST: 'https://clob.polymarket.com',
    CHAIN_ID: 137,
};

// Vérification des variables requises au démarrage
if (!process.env.WALLETS) {
    console.error('❌ WALLETS est requis (format: 0xaddr1:Label1,0xaddr2:Label2)');
    process.exit(1);
}
if (!process.env.POLYMARKET_PRIVATE_KEY) {
    console.error('❌ POLYMARKET_PRIVATE_KEY est requis pour le copy-trading');
    process.exit(1);
}
if (!process.env.POLYMARKET_FUNDER_ADDRESS) {
    console.warn('⚠️ POLYMARKET_FUNDER_ADDRESS non défini - le proxy wallet sera auto-résolu (moins fiable)');
}

let isRunning = false;
let knownTrades = new Map();
let dailyTrades = [];
let lastDailyReset = new Date().toDateString();

// ============================================
// PERSISTANCE D'ÉTAT (survit aux redémarrages Railway)
// ============================================
const STATE_FILE = path.join(__dirname, '.bot-state.json');

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            console.log(`💾 État restauré depuis ${STATE_FILE}`);
            return data;
        }
    } catch (e) {
        console.error('State load error:', e.message);
    }
    return { lastSeenTimestamps: {}, lastTradeIds: {} };
}

function saveState() {
    try {
        const state = { lastSeenTimestamps: {}, lastTradeIds: {} };
        for (const [addr, trades] of knownTrades.entries()) {
            const arr = [...trades];
            state.lastTradeIds[addr] = arr.slice(-50);
        }
        for (const [addr, ts] of Object.entries(walletLastTimestamp)) {
            state.lastSeenTimestamps[addr] = ts;
        }
        fs.writeFileSync(STATE_FILE, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
        console.error('State save error:', e.message);
    }
}

const walletLastTimestamp = {};

let stateSaveInterval = null;
function startStateSave() {
    if (stateSaveInterval) return;
    stateSaveInterval = setInterval(saveState, 60000);
}

// Graceful shutdown
function setupGracefulShutdown() {
    const shutdown = (signal) => {
        console.log(`\n🛑 ${signal} reçu, arrêt propre...`);
        isRunning = false;
        saveState();
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

// ============================================
// COPY-TRADING STATE
// ============================================
let copyTradingEnabled = true; // Activé par défaut
let clobClient = null;
let traderPrivateKey = null;
let traderFunderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || null;
let signatureType = parseInt(process.env.SIGNATURE_TYPE, 10) || 0;
let copyMultiplier = parseFloat(process.env.COPY_MULTIPLIER) || 1.0;
let maxCopyUSD = parseFloat(process.env.MAX_COPY_USD) || 500;
let copiedTrades = [];
let proportionalMode = (process.env.PROPORTIONAL_MODE || 'true').toLowerCase() === 'true';

// Anti-doublon: cooldown par tokenId
const copyCooldowns = new Map();
const COPY_COOLDOWN_MS = 30000;

// ============================================
// USDC BALANCE (Polygon on-chain)
// ============================================
const POLYGON_RPC = process.env.POLYGON_RPC || 'https://polygon-rpc.com';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];

let rpcProvider = null;
let usdcContract = null;
function getProvider() {
    if (!rpcProvider) {
        rpcProvider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
        usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, rpcProvider);
    }
    return { provider: rpcProvider, usdc: usdcContract };
}

const balanceCache = new Map();
const BALANCE_CACHE_TTL = 60000;

const marketInfoCache = new Map();
const tickSizeCache = new Map();
const MAX_CACHE_SIZE = 500;

// Circuit breaker
const circuitBreaker = {
    failures: 0,
    lastFailure: 0,
    threshold: 5,
    cooldown: 30000,
    isOpen() {
        if (this.failures < this.threshold) return false;
        if (Date.now() - this.lastFailure > this.cooldown) {
            this.failures = 0;
            return false;
        }
        return true;
    },
    recordFailure() {
        this.failures++;
        this.lastFailure = Date.now();
        if (this.failures === this.threshold) {
            console.error(`🔴 Circuit breaker OUVERT (${this.threshold} erreurs) - pause ${this.cooldown / 1000}s`);
        }
    },
    recordSuccess() { this.failures = 0; },
};

function maskAddr(addr) {
    if (!addr || addr.length < 12) return addr || '???';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// Fetch avec timeout
async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timeout);
    }
}

async function getUSDCBalance(address) {
    const addr = address.toLowerCase();
    const cached = balanceCache.get(addr);
    if (cached && Date.now() - cached.timestamp < BALANCE_CACHE_TTL) {
        return cached.balance;
    }
    try {
        const { usdc } = getProvider();
        const raw = await usdc.balanceOf(addr);
        const balance = parseFloat(ethers.utils.formatUnits(raw, 6));
        balanceCache.set(addr, { balance, timestamp: Date.now() });
        return balance;
    } catch (e) {
        console.error(`Balance error (${maskAddr(addr)}):`, e.message);
        rpcProvider = null;
        usdcContract = null;
        return null;
    }
}

// ============================================
// WALLET MANAGEMENT (charge depuis env)
// ============================================
let wallets = [];

function loadWalletsFromEnv() {
    const envWallets = process.env.WALLETS || '';
    if (envWallets) {
        wallets = envWallets.split(',').map(entry => {
            const [address, ...labelParts] = entry.trim().split(':');
            const label = labelParts.join(':') || address.slice(0, 8) + '...';
            return { address: address.toLowerCase().trim(), label: label.trim() };
        }).filter(w => /^0x[a-fA-F0-9]{40}$/.test(w.address));
    }
    console.log(`📂 ${wallets.length} wallet(s) chargé(s)`);
}

// ============================================
// PROXY WALLET RESOLUTION
// ============================================
async function resolveProxyAddress(address) {
    const addr = address.toLowerCase();
    try {
        const res = await fetchWithTimeout(`https://gamma-api.polymarket.com/profiles/${addr}`);
        if (res.ok) {
            const data = await res.json();
            if (data && data.proxyWallet) return data.proxyWallet.toLowerCase();
        }
    } catch (e) {
        console.log('Proxy resolve (profiles):', e.message);
    }
    try {
        const res = await fetchWithTimeout(`https://data-api.polymarket.com/activity?user=${addr}&limit=1`);
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0 && data[0].proxyWallet) {
                return data[0].proxyWallet.toLowerCase();
            }
        }
    } catch (e) {
        console.log('Proxy resolve (activity):', e.message);
    }
    return null;
}

// ============================================
// CLOB CLIENT INIT
// ============================================
async function initClobWithApiKey(apiKey, apiSecret, apiPassphrase, privateKey, funderAddr) {
    try {
        const signer = new Wallet(privateKey);
        traderPrivateKey = privateKey;
        if (funderAddr) {
            traderFunderAddress = funderAddr;
        } else {
            console.log('🔍 Résolution du proxy wallet...');
            const proxy = await resolveProxyAddress(signer.address);
            if (proxy) {
                traderFunderAddress = proxy;
                console.log(`✅ Proxy wallet résolu: ${maskAddr(proxy)}`);
            } else {
                traderFunderAddress = signer.address;
                console.log('⚠️ Proxy wallet non trouvé - utilisation EOA par défaut');
                console.log('⚠️ Définissez POLYMARKET_FUNDER_ADDRESS dans les env vars');
            }
        }
        const creds = { key: apiKey, secret: apiSecret, passphrase: apiPassphrase };
        clobClient = new ClobClient(CONFIG.CLOB_HOST, CONFIG.CHAIN_ID, signer, creds, signatureType, traderFunderAddress);
        const isProxy = traderFunderAddress !== signer.address.toLowerCase();
        console.log(`✅ CLOB Client initialisé (API Key) - Funder: ${isProxy ? 'PROXY' : 'EOA'}`);
        return true;
    } catch (e) {
        console.error('❌ Erreur init CLOB (API Key):', e.message);
        clobClient = null;
        return false;
    }
}

async function initClobWithPrivateKey(privateKey, funderAddr) {
    try {
        const signer = new Wallet(privateKey);
        traderPrivateKey = privateKey;
        if (funderAddr) {
            traderFunderAddress = funderAddr;
        } else {
            console.log('🔍 Résolution du proxy wallet...');
            const proxy = await resolveProxyAddress(signer.address);
            if (proxy) {
                traderFunderAddress = proxy;
                console.log(`✅ Proxy wallet résolu: ${maskAddr(proxy)}`);
            } else {
                traderFunderAddress = signer.address;
                console.log('⚠️ Proxy wallet non trouvé - utilisation EOA par défaut');
                console.log('⚠️ Définissez POLYMARKET_FUNDER_ADDRESS dans les env vars');
            }
        }
        const tempClient = new ClobClient(CONFIG.CLOB_HOST, CONFIG.CHAIN_ID, signer);
        const creds = await tempClient.createOrDeriveApiKey();
        clobClient = new ClobClient(CONFIG.CLOB_HOST, CONFIG.CHAIN_ID, signer, creds, signatureType, traderFunderAddress);
        const isProxy = traderFunderAddress !== signer.address.toLowerCase();
        console.log(`✅ CLOB Client initialisé (Private Key) - Funder: ${isProxy ? 'PROXY' : 'EOA'}`);
        return true;
    } catch (e) {
        console.error('❌ Erreur init CLOB:', e.message);
        clobClient = null;
        return false;
    }
}

// ============================================
// ORDER FILL VERIFICATION
// ============================================
const FILL_CHECK_DELAYS = [3000, 10000, 30000];

async function checkOrderFill(orderId, tradeInfo) {
    if (!orderId || !clobClient) return;
    for (const delay of FILL_CHECK_DELAYS) {
        await sleep(delay);
        try {
            const order = await clobClient.getOrder(orderId);
            if (!order) continue;
            const status = (order.status || '').toUpperCase();
            const filledSize = parseFloat(order.size_matched || order.filledSize || order.matched || '0');
            const totalSize = parseFloat(order.original_size || order.size || tradeInfo.size || '0');
            if (status === 'MATCHED' || status === 'FILLED') {
                const ct = copiedTrades.find(c => c.orderId === orderId);
                if (ct) ct.fillStatus = 'FILLED';
                console.log(`✅ Order ${orderId.slice(0, 8)} FILLED (${filledSize}/${totalSize})`);
                return;
            }
            if (status === 'CANCELLED' || status === 'CANCELED' || status === 'EXPIRED') {
                const ct = copiedTrades.find(c => c.orderId === orderId);
                if (ct) { ct.fillStatus = status; ct.success = false; }
                console.log(`❌ Order ${orderId.slice(0, 8)} ${status} - ${tradeInfo.wallet} ${tradeInfo.side} ${tradeInfo.size} @ ${(tradeInfo.price * 100).toFixed(0)}¢`);
                return;
            }
            if (filledSize > 0 && filledSize < totalSize) {
                console.log(`⏳ Order ${orderId.slice(0, 8)} partial: ${filledSize}/${totalSize}`);
            }
        } catch (e) {
            console.log(`Fill check error (${orderId.slice(0, 8)}):`, e.message);
        }
    }
    try {
        const order = await clobClient.getOrder(orderId);
        const status = (order?.status || '').toUpperCase();
        const filledSize = parseFloat(order?.size_matched || order?.filledSize || '0');
        if (status === 'LIVE' || status === 'OPEN') {
            const ct = copiedTrades.find(c => c.orderId === orderId);
            if (ct) ct.fillStatus = 'PENDING';
            console.log(`⏳ Order ${orderId.slice(0, 8)} toujours en attente après 30s (filled: ${filledSize}/${tradeInfo.size})`);
        } else if (status === 'MATCHED' || status === 'FILLED') {
            const ct = copiedTrades.find(c => c.orderId === orderId);
            if (ct) ct.fillStatus = 'FILLED';
        }
    } catch (e) {
        console.log(`Final fill check error:`, e.message);
    }
}

// Retry avec backoff
async function postOrderWithRetry(orderArgs, orderOpts, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await clobClient.createAndPostOrder(orderArgs, orderOpts);
        } catch (e) {
            console.error(`Order attempt ${attempt}/${maxRetries} failed:`, e.message);
            if (attempt === maxRetries) throw e;
            await sleep(500 * attempt);
        }
    }
}

// ============================================
// COPY-TRADE EXECUTION
// ============================================
async function executeCopyTrade(originalTrade, wallet) {
    if (!copyTradingEnabled || !clobClient) return;

    // Vérifier que le proxy wallet est configuré
    if (traderPrivateKey && traderFunderAddress) {
        const signer = new Wallet(traderPrivateKey);
        if (traderFunderAddress === signer.address.toLowerCase()) {
            console.error('⚠️ Copy-trade bloqué: funder = EOA (pas le proxy Polymarket). Définissez POLYMARKET_FUNDER_ADDRESS.');
            return;
        }
    }

    try {
        const tradeStart = Date.now();
        const sideStr = (originalTrade.side || originalTrade.type || originalTrade.action || '').toLowerCase();
        const isBuy = sideStr.includes('buy') || sideStr.includes('bid');
        const origPrice = parseFloat(originalTrade.price || originalTrade.avgPrice || originalTrade.avg_price || 0);
        const origSize = parseFloat(originalTrade.size || originalTrade.amount || originalTrade.shares || 0);
        const origUsdcSize = parseFloat(originalTrade.usdcSize || originalTrade.value || originalTrade.total || (origPrice * origSize) || 0);

        if (origPrice <= 0 || origSize <= 0) {
            console.log(`⏭️ Copy-trade ignoré: prix/taille invalide (${wallet.label})`);
            return;
        }

        const conditionId = originalTrade.conditionId || originalTrade.condition_id;
        const assetId = originalTrade.asset || originalTrade.asset_id || originalTrade.tokenId || originalTrade.token_id;

        // PHASE 1: TOUT EN PARALLÈLE
        const balancePromise = proportionalMode
            ? Promise.all([getUSDCBalance(wallet.address), getUSDCBalance(traderFunderAddress)])
            : Promise.resolve([null, null]);
        const marketPromise = (!assetId && conditionId) ? fetchMarketInfo(conditionId) : Promise.resolve(null);
        const earlyTickPromise = assetId && clobClient ? getCachedTickSize(assetId) : Promise.resolve(null);
        const [balances, marketInfo, earlyTickSize] = await Promise.all([balancePromise, marketPromise, earlyTickPromise]);

        let tokenId = assetId;
        let negRisk = false;
        if (!tokenId && marketInfo) {
            negRisk = marketInfo.negRisk || false;
            const tokenIds = JSON.parse(marketInfo.clobTokenIds || '[]');
            const outcomeIdx = originalTrade.outcomeIndex ?? originalTrade.outcome_index ?? 0;
            tokenId = tokenIds[outcomeIdx];
        }
        if (!tokenId) {
            console.log(`⚠️ Copy-trade échoué: token ID introuvable (${wallet.label})`);
            return;
        }

        // Anti-doublon
        const lastCopy = copyCooldowns.get(tokenId);
        if (lastCopy && Date.now() - lastCopy < COPY_COOLDOWN_MS) {
            console.log(`⏭️ Copy-trade ignoré: cooldown ${COPY_COOLDOWN_MS / 1000}s (${wallet.label})`);
            return;
        }

        const tickSize = earlyTickSize || await getCachedTickSize(tokenId);

        // CALCUL DE LA TAILLE
        let copyUsd;
        let sizingInfo = '';
        const [trackedBalance, myBalance] = balances;
        if (proportionalMode && trackedBalance > 0 && myBalance > 0) {
            const proportion = origUsdcSize / trackedBalance;
            copyUsd = proportion * myBalance;
            sizingInfo = `proportional ${(proportion * 100).toFixed(1)}% de $${myBalance.toFixed(0)}`;
            console.log(`⚡ Proportional: ${(proportion * 100).toFixed(1)}% → $${copyUsd.toFixed(2)}`);
        } else {
            copyUsd = origUsdcSize * copyMultiplier;
            sizingInfo = proportionalMode ? `balances indispo → x${copyMultiplier}` : `x${copyMultiplier}`;
        }
        if (copyUsd > maxCopyUSD) {
            sizingInfo += ` (cap $${maxCopyUSD})`;
            copyUsd = maxCopyUSD;
        }
        const copySize = Math.floor(copyUsd / origPrice);
        if (copySize <= 0) {
            console.log(`⏭️ Copy-trade ignoré: taille trop petite (${wallet.label})`);
            return;
        }

        const side = isBuy ? 'BUY' : 'SELL';

        // Check SELL: vérifier positions
        if (side === 'SELL') {
            try {
                const positions = await clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenId });
                const myShares = parseFloat(positions?.balance || '0');
                if (myShares <= 0) {
                    console.log(`⏭️ SELL ignoré: aucune position (${wallet.label})`);
                    return;
                }
                if (copySize > myShares) {
                    console.log(`⚠️ SELL ajusté: ${copySize} → ${Math.floor(myShares)} shares`);
                }
            } catch (e) {
                console.log(`⚠️ Position check failed:`, e.message);
            }
        }

        // Check slippage
        let slippageInfo = '';
        let executionPrice = origPrice;
        try {
            const book = await clobClient.getOrderBook(tokenId);
            const bestPrice = isBuy
                ? (book?.asks?.[0]?.price ? parseFloat(book.asks[0].price) : null)
                : (book?.bids?.[0]?.price ? parseFloat(book.bids[0].price) : null);
            if (bestPrice && bestPrice > 0) {
                const slippagePct = Math.abs(bestPrice - origPrice) / origPrice * 100;
                if (slippagePct > CONFIG.SLIPPAGE_MAX_PCT) {
                    slippageInfo = `slippage ${slippagePct.toFixed(1)}% (live ${(bestPrice * 100).toFixed(0)}¢ vs trader ${(origPrice * 100).toFixed(0)}¢)`;
                    console.log(`⚠️ Slippage ${slippagePct.toFixed(1)}% détecté (${wallet.label}) → prix live utilisé`);
                    executionPrice = bestPrice;
                }
            }
        } catch (e) {
            console.log('Slippage check skipped:', e.message);
        }

        // EXÉCUTION
        const orderResp = await postOrderWithRetry(
            { tokenID: tokenId, price: executionPrice, size: copySize, side: side },
            { tickSize: tickSize, negRisk: negRisk }
        );

        copyCooldowns.set(tokenId, Date.now());
        const totalLatency = Date.now() - tradeStart;
        const market = originalTrade.title || originalTrade.question || originalTrade.market || 'Marché inconnu';

        copiedTrades.push({
            time: new Date().toISOString(), from: wallet.label, side,
            price: executionPrice, size: copySize, usd: copySize * executionPrice,
            market: market.slice(0, 50),
            orderId: orderResp.orderID || orderResp.id || 'N/A', success: true,
            latencyMs: totalLatency,
        });

        console.log(`✅ COPY-TRADE: ${wallet.label} → ${side} ${copySize} @ ${(executionPrice * 100).toFixed(0)}¢ = $${(copySize * executionPrice).toFixed(2)} | ${sizingInfo} | ${totalLatency}ms | ${market.slice(0, 50)}${slippageInfo ? ` | ${slippageInfo}` : ''}`);

        // Fill check en background
        const oid = orderResp.orderID || orderResp.id;
        if (oid) {
            checkOrderFill(oid, { wallet: wallet.label, side, size: copySize, price: origPrice }).catch(e =>
                console.error('Fill check error:', e.message)
            );
        }

    } catch (e) {
        console.error(`❌ Copy-trade error (${wallet.label}):`, e.message);
        copiedTrades.push({ time: new Date().toISOString(), from: wallet.label, error: e.message, success: false });
    }
}

// ============================================
// INIT
// ============================================
async function init() {
    console.log('🚀 Bot Polymarket Copy-Trader (Railway)\n');

    setupGracefulShutdown();
    loadWalletsFromEnv();

    if (wallets.length === 0) {
        console.error('❌ Aucun wallet valide dans WALLETS');
        process.exit(1);
    }

    // Auto-init CLOB
    if (process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_API_PASSPHRASE && process.env.POLYMARKET_PRIVATE_KEY) {
        const ok = await initClobWithApiKey(
            process.env.POLY_API_KEY, process.env.POLY_API_SECRET, process.env.POLY_API_PASSPHRASE,
            process.env.POLYMARKET_PRIVATE_KEY, traderFunderAddress
        );
        if (ok) console.log('🔑 API Key + Private Key chargées depuis env');
    } else if (process.env.POLYMARKET_PRIVATE_KEY) {
        const ok = await initClobWithPrivateKey(process.env.POLYMARKET_PRIVATE_KEY, traderFunderAddress);
        if (ok) console.log('🔑 Private Key chargée depuis env (credentials dérivées)');
    }

    if (!clobClient) {
        console.error('❌ CLOB Client non initialisé - vérifiez POLYMARKET_PRIVATE_KEY');
        process.exit(1);
    }

    scheduleMemoryCleanup();
    scheduleHeartbeat();

    // Vérifier proxy wallet
    if (traderPrivateKey) {
        const signer = new Wallet(traderPrivateKey);
        const isProxy = traderFunderAddress && traderFunderAddress !== signer.address.toLowerCase();
        console.log(`🔐 EOA: ${maskAddr(signer.address.toLowerCase())} | Proxy: ${isProxy ? maskAddr(traderFunderAddress) + ' ✅' : '⚠️ NON CONFIGURÉ'}`);
        console.log(`📐 Mode: ${proportionalMode ? 'Proportionnel' : `Multiplicateur x${copyMultiplier}`} | Max $${maxCopyUSD}`);
    }

    // Démarrage immédiat
    isRunning = true;
    copyTradingEnabled = true;
    console.log(`\n🟢 Surveillance + copy-trading ACTIFS`);
    console.log(`📂 ${wallets.length} wallet(s) surveillé(s)`);
    console.log(`⏱️  Intervalle: ${CONFIG.CHECK_INTERVAL / 1000}s | Min: $${CONFIG.MIN_TRADE_USD} | Slippage max: ${CONFIG.SLIPPAGE_MAX_PCT}%\n`);

    startWatching();
    return true;
}

// ============================================
// API
// ============================================
async function fetchActivity(walletAddress) {
    if (circuitBreaker.isOpen()) return [];
    try {
        const res = await fetchWithTimeout(
            `https://data-api.polymarket.com/activity?user=${walletAddress.toLowerCase()}&limit=30`
        );
        if (res.ok) {
            circuitBreaker.recordSuccess();
            return await res.json();
        }
        circuitBreaker.recordFailure();
    } catch (e) {
        circuitBreaker.recordFailure();
        console.error(`API error (${maskAddr(walletAddress)}):`, e.message);
    }
    return [];
}

async function fetchMarketInfo(conditionId) {
    const cached = marketInfoCache.get(conditionId);
    if (cached) return cached;
    try {
        const res = await fetchWithTimeout(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
                if (marketInfoCache.size >= MAX_CACHE_SIZE) {
                    const oldest = marketInfoCache.keys().next().value;
                    marketInfoCache.delete(oldest);
                }
                marketInfoCache.set(conditionId, data[0]);
                return data[0];
            }
        }
    } catch (e) {
        console.error('Market info error:', e.message);
    }
    return null;
}

async function getCachedTickSize(tokenId) {
    const cached = tickSizeCache.get(tokenId);
    if (cached) return cached;
    try {
        const ts = await clobClient.getTickSize(tokenId);
        if (tickSizeCache.size >= MAX_CACHE_SIZE) {
            const oldest = tickSizeCache.keys().next().value;
            tickSizeCache.delete(oldest);
        }
        tickSizeCache.set(tokenId, ts);
        return ts;
    } catch (e) {
        console.error('Tick size error:', e.message);
        return '0.01';
    }
}

// Refresh balances en background
let balanceRefreshInterval = null;
function startBalanceRefresh() {
    if (balanceRefreshInterval) return;
    balanceRefreshInterval = setInterval(async () => {
        if (!proportionalMode || !traderFunderAddress) return;
        const addrs = [traderFunderAddress, ...wallets.map(w => w.address)];
        await Promise.allSettled(addrs.map(a => getUSDCBalance(a)));
    }, BALANCE_CACHE_TTL - 5000);
}

// ============================================
// WATCH
// ============================================
async function startWatching() {
    console.log('🔄 Démarrage surveillance...\n');

    const savedState = loadState();

    await Promise.allSettled(wallets.map(async (w) => {
        if (!knownTrades.has(w.address)) knownTrades.set(w.address, new Set());
        const known = knownTrades.get(w.address);
        const savedIds = savedState.lastTradeIds[w.address] || [];
        for (const id of savedIds) known.add(id);
        walletLastTimestamp[w.address] = savedState.lastSeenTimestamps[w.address] || 0;

        const initial = await fetchActivity(w.address);
        if (Array.isArray(initial)) {
            for (const t of initial) {
                known.add(getTradeId(t));
                const ts = getTradeTimestamp(t);
                if (ts > (walletLastTimestamp[w.address] || 0)) walletLastTimestamp[w.address] = ts;
            }
        }
        console.log(`📊 ${w.label}: ${known.size} trades connus (${savedIds.length} restaurés)`);
    }));

    startBalanceRefresh();
    startStateSave();

    while (isRunning) {
        try {
            const today = new Date().toDateString();
            if (today !== lastDailyReset) { dailyTrades = []; lastDailyReset = today; }
            await checkAllWallets();
        } catch (e) {
            console.error('Error:', e.message);
        }
        await sleep(CONFIG.CHECK_INTERVAL);
    }
}

function getTradeId(t) {
    const txHash = t.transactionHash || t.transaction_hash;
    if (txHash) return `tx-${txHash}`;
    return `${t.id || ''}-${t.timestamp || t.createdAt || ''}-${t.conditionId || t.asset_id || ''}`;
}

function getTradeTimestamp(t) {
    const ts = t.timestamp || t.createdAt || t.created_at || t.time || 0;
    if (typeof ts === 'number') return ts < 10000000000 ? ts * 1000 : ts;
    try { return new Date(ts).getTime() || 0; } catch (e) { return 0; }
}

async function checkAllWallets() {
    await Promise.allSettled(wallets.map(w => isRunning ? checkNewTrades(w) : null));
}

async function checkNewTrades(wallet) {
    const trades = await fetchActivity(wallet.address);
    if (!Array.isArray(trades)) return;

    if (!knownTrades.has(wallet.address)) knownTrades.set(wallet.address, new Set());
    const known = knownTrades.get(wallet.address);

    for (const t of trades) {
        const id = getTradeId(t);
        if (known.has(id)) continue;
        known.add(id);

        const tradeTs = getTradeTimestamp(t);
        if (tradeTs > (walletLastTimestamp[wallet.address] || 0)) {
            walletLastTimestamp[wallet.address] = tradeTs;
        }

        const price = parseFloat(t.price || t.avgPrice || t.avg_price || 0);
        const size = parseFloat(t.size || t.amount || t.shares || 0);
        const usdcSize = parseFloat(t.usdcSize || t.value || t.total || (price * size) || 0);

        if (usdcSize < CONFIG.MIN_TRADE_USD) {
            console.log(`⏭️ [${wallet.label}] < $${CONFIG.MIN_TRADE_USD}: $${usdcSize.toFixed(2)}`);
            continue;
        }

        // Ignorer trades trop vieux (>5 min)
        if (tradeTs > 0 && Date.now() - tradeTs > 5 * 60 * 1000) {
            console.log(`⏭️ [${wallet.label}] Trade trop ancien (${Math.round((Date.now() - tradeTs) / 1000)}s): $${usdcSize.toFixed(2)}`);
            continue;
        }

        dailyTrades.push({ ...t, usdcSize, walletLabel: wallet.label, walletAddress: wallet.address });

        // Log + exécution
        const sideStr = (t.side || t.type || t.action || '').toLowerCase();
        const isBuy = sideStr.includes('buy') || sideStr.includes('bid');
        const market = (t.title || t.question || t.market || 'Marché inconnu').slice(0, 60);
        console.log(`🔔 [${wallet.label}] ${isBuy ? '🟢 BUY' : '🔴 SELL'} $${usdcSize.toFixed(2)} - ${market}`);

        await executeCopyTrade(t, wallet);
    }
}

// ============================================
// HEARTBEAT (log toutes les 6h)
// ============================================
function scheduleHeartbeat() {
    const HEARTBEAT_INTERVAL = 6 * 60 * 60 * 1000;
    setInterval(() => {
        const h = Math.floor(process.uptime() / 3600);
        const m = Math.floor((process.uptime() % 3600) / 60);
        const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
        const knownCount = [...knownTrades.values()].reduce((s, set) => s + set.size, 0);
        const cbStatus = circuitBreaker.isOpen() ? '🔴 Ouvert' : '🟢 OK';
        const successCount = copiedTrades.filter(c => c.success).length;
        console.log(`💓 Heartbeat | Uptime: ${h}h${m}m | RAM: ${memMB}MB | Trades connus: ${knownCount} | Circuit: ${cbStatus} | Copies: ${successCount}/${copiedTrades.length}`);
    }, HEARTBEAT_INTERVAL);
}

// ============================================
// NETTOYAGE MÉMOIRE
// ============================================
function scheduleMemoryCleanup() {
    const CLEANUP_INTERVAL = 4 * 60 * 60 * 1000;
    const MAX_KNOWN_PER_WALLET = 500;
    setInterval(() => {
        let totalCleaned = 0;
        for (const [addr, trades] of knownTrades.entries()) {
            if (trades.size > MAX_KNOWN_PER_WALLET) {
                const arr = [...trades];
                knownTrades.set(addr, new Set(arr.slice(-MAX_KNOWN_PER_WALLET)));
                totalCleaned += arr.length - MAX_KNOWN_PER_WALLET;
            }
        }
        const now = Date.now();
        for (const [tokenId, ts] of copyCooldowns.entries()) {
            if (now - ts > COPY_COOLDOWN_MS * 2) copyCooldowns.delete(tokenId);
        }
        if (copiedTrades.length > 200) copiedTrades = copiedTrades.slice(-100);
        if (totalCleaned > 0) console.log(`🧹 Mémoire: ${totalCleaned} trades anciens supprimés`);
    }, CLEANUP_INTERVAL);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================
// START
// ============================================
init().catch(e => { console.error('❌', e); process.exit(1); });
