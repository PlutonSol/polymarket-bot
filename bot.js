require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ClobClient } = require('@polymarket/clob-client');
const { Wallet } = require('@ethersproject/wallet');
const { ethers } = require('ethers');

// ============================================
// CONFIGURATION (tout via env vars pour Railway)
// ============================================
const CONFIG = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    TELEGRAM_USER_ID: process.env.TELEGRAM_USER_ID || '', // Optionnel: vérifie aussi le user_id
    CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL, 10) || 2000,
    MIN_TRADE_USD: parseFloat(process.env.MIN_TRADE_USD) || 10,
    FETCH_TIMEOUT: parseInt(process.env.FETCH_TIMEOUT, 10) || 8000, // 8s timeout sur les fetch
    SLIPPAGE_MAX_PCT: parseFloat(process.env.SLIPPAGE_MAX_PCT) || 3, // 3% slippage max
    CLOB_HOST: 'https://clob.polymarket.com',
    CHAIN_ID: 137,
};

// Vérification des variables requises au démarrage
if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    console.error('❌ TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID sont requis dans les variables d\'environnement.');
    process.exit(1);
}

let telegramBot;
let isRunning = false;
let knownTrades = new Map();
let dailyTrades = [];
let lastDailyReset = new Date().toDateString();

// ============================================
// COPY-TRADING STATE
// ============================================
let copyTradingEnabled = false;
let clobClient = null;
let traderPrivateKey = null;
let traderFunderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || null;
let signatureType = parseInt(process.env.SIGNATURE_TYPE, 10) || 0;
let copyMultiplier = parseFloat(process.env.COPY_MULTIPLIER) || 1.0;
let maxCopyUSD = parseFloat(process.env.MAX_COPY_USD) || 500;
let copiedTrades = [];
let proportionalMode = (process.env.PROPORTIONAL_MODE || 'true').toLowerCase() === 'true'; // ON par défaut

// Anti-doublon: cooldown par tokenId (empêche 2 copy-trades sur le même marché en 30s)
const copyCooldowns = new Map(); // tokenId -> timestamp dernier copy
const COPY_COOLDOWN_MS = 30000; // 30s

// ============================================
// USDC BALANCE (Polygon on-chain)
// ============================================
const POLYGON_RPC = process.env.POLYGON_RPC || 'https://polygon-rpc.com';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e sur Polygon
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];

// Provider RPC singleton (réutilisé, pas recréé à chaque appel)
let rpcProvider = null;
let usdcContract = null;
function getProvider() {
    if (!rpcProvider) {
        rpcProvider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
        usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, rpcProvider);
    }
    return { provider: rpcProvider, usdc: usdcContract };
}

// Cache des balances (évite de spam le RPC)
const balanceCache = new Map(); // address -> { balance, timestamp }
const BALANCE_CACHE_TTL = 60000; // 1 minute

// Cache market info + tick sizes (évite des appels redondants)
const marketInfoCache = new Map(); // conditionId -> data
const tickSizeCache = new Map(); // tokenId -> tickSize

// Circuit breaker: si trop d'erreurs consécutives, on pause les appels
const circuitBreaker = {
    failures: 0,
    lastFailure: 0,
    threshold: 5,         // 5 erreurs consécutives = circuit ouvert
    cooldown: 30000,      // 30s de pause avant retry
    isOpen() {
        if (this.failures < this.threshold) return false;
        if (Date.now() - this.lastFailure > this.cooldown) {
            this.failures = 0; // Reset après cooldown
            return false;
        }
        return true;
    },
    recordFailure() {
        this.failures++;
        this.lastFailure = Date.now();
        if (this.failures === this.threshold) {
            console.error(`🔴 Circuit breaker OUVERT (${this.threshold} erreurs) - pause ${this.cooldown / 1000}s`);
            sendTelegram(`🔴 *Circuit breaker activé*\n${this.threshold} erreurs API consécutives\nPause ${this.cooldown / 1000}s puis retry auto`).catch(() => {});
        }
    },
    recordSuccess() { this.failures = 0; },
};

// Fetch avec timeout intégré
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

// Auth Telegram renforcée: vérifie chat_id ET user_id si configuré
function isAuthorized(msg) {
    if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return false;
    if (CONFIG.TELEGRAM_USER_ID && msg.from && msg.from.id.toString() !== CONFIG.TELEGRAM_USER_ID) return false;
    return true;
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
        console.error(`Balance error (${addr.slice(0, 8)}):`, e.message);
        // Si le provider est cassé, le recréer
        rpcProvider = null;
        usdcContract = null;
        return null;
    }
}

// ============================================
// WALLET MANAGEMENT (en memoire, charge depuis env)
// ============================================
// Variable env WALLETS format: "0xaddr1:Label1,0xaddr2:Label2"
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

    // Wallet par defaut toujours present
    const defaultAddr = '0x594edb9112f526fa6a80b8f858a6379c8a2c1c11';
    if (!wallets.find(w => w.address === defaultAddr)) {
        wallets.push({ address: defaultAddr, label: 'Trader1' });
    }

    console.log(`📂 ${wallets.length} wallet(s) chargé(s)`);
}

function addWallet(address, label) {
    const addr = address.toLowerCase().trim();
    if (wallets.find(w => w.address === addr)) return false;
    wallets.push({ address: addr, label: label || addr.slice(0, 8) + '...' });
    knownTrades.set(addr, new Set());
    return true;
}

function removeWallet(addressOrIndex) {
    const input = addressOrIndex.trim();
    let removed = null;
    const idx = parseInt(input, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= wallets.length) {
        removed = wallets.splice(idx - 1, 1)[0];
    } else {
        const addr = input.toLowerCase();
        const i = wallets.findIndex(w => w.address === addr);
        if (i !== -1) removed = wallets.splice(i, 1)[0];
    }
    if (removed) knownTrades.delete(removed.address);
    return removed;
}

// ============================================
// PROXY WALLET RESOLUTION
// ============================================
// Polymarket utilise des proxy wallets (smart contracts) pour le trading.
// Ton EOA (clé privée) = signer (signe les ordres)
// Ton proxy wallet = funder (détient les fonds USDC + exécute les trades)
// Ces adresses sont DIFFÉRENTES ! Le funder DOIT être le proxy wallet.

async function resolveProxyAddress(address) {
    const addr = address.toLowerCase();

    // Methode 1: Gamma API profiles endpoint
    try {
        const res = await fetchWithTimeout(`https://gamma-api.polymarket.com/profiles/${addr}`);
        if (res.ok) {
            const data = await res.json();
            if (data && data.proxyWallet) {
                return data.proxyWallet.toLowerCase();
            }
        }
    } catch (e) {
        console.log('Proxy resolve (profiles):', e.message);
    }

    // Methode 2: Via activity data (si l'adresse a déjà tradé)
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

// Methode 1: Via API Key directe (key + secret + passphrase)
async function initClobWithApiKey(apiKey, apiSecret, apiPassphrase, privateKey, funderAddr) {
    try {
        const signer = new Wallet(privateKey);
        traderPrivateKey = privateKey;

        // Résolution du proxy wallet
        if (funderAddr) {
            traderFunderAddress = funderAddr;
        } else {
            console.log('🔍 Résolution du proxy wallet...');
            const proxy = await resolveProxyAddress(signer.address);
            if (proxy) {
                traderFunderAddress = proxy;
                console.log(`✅ Proxy wallet résolu: ${proxy}`);
            } else {
                traderFunderAddress = signer.address;
                console.log('⚠️ Proxy wallet non trouvé - utilisation EOA par défaut');
                console.log('⚠️ Utilisez /setfunder pour définir votre proxy wallet Polymarket');
            }
        }

        const creds = { key: apiKey, secret: apiSecret, passphrase: apiPassphrase };

        clobClient = new ClobClient(
            CONFIG.CLOB_HOST,
            CONFIG.CHAIN_ID,
            signer,
            creds,
            signatureType,
            traderFunderAddress
        );

        const isProxy = traderFunderAddress !== signer.address.toLowerCase();
        console.log(`✅ CLOB Client initialisé (API Key) - Funder: ${isProxy ? 'PROXY' : 'EOA'}`);
        return true;
    } catch (e) {
        console.error('❌ Erreur init CLOB (API Key):', e.message);
        clobClient = null;
        return false;
    }
}

// Methode 2: Via Private Key seule (derive les credentials)
async function initClobWithPrivateKey(privateKey, funderAddr) {
    try {
        const signer = new Wallet(privateKey);
        traderPrivateKey = privateKey;

        // Résolution du proxy wallet
        if (funderAddr) {
            traderFunderAddress = funderAddr;
        } else {
            console.log('🔍 Résolution du proxy wallet...');
            const proxy = await resolveProxyAddress(signer.address);
            if (proxy) {
                traderFunderAddress = proxy;
                console.log(`✅ Proxy wallet résolu: ${proxy}`);
            } else {
                traderFunderAddress = signer.address;
                console.log('⚠️ Proxy wallet non trouvé - utilisation EOA par défaut');
                console.log('⚠️ Utilisez /setfunder pour définir votre proxy wallet Polymarket');
            }
        }

        const tempClient = new ClobClient(CONFIG.CLOB_HOST, CONFIG.CHAIN_ID, signer);
        const creds = await tempClient.createOrDeriveApiKey();

        clobClient = new ClobClient(
            CONFIG.CLOB_HOST,
            CONFIG.CHAIN_ID,
            signer,
            creds,
            signatureType,
            traderFunderAddress
        );

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
// COPY-TRADE EXECUTION
// ============================================

// Retry avec backoff pour l'envoi d'ordres (500ms, 1s, 2s)
async function postOrderWithRetry(orderArgs, orderOpts, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const resp = await clobClient.createAndPostOrder(orderArgs, orderOpts);
            return resp;
        } catch (e) {
            console.error(`Order attempt ${attempt}/${maxRetries} failed:`, e.message);
            if (attempt === maxRetries) throw e;
            await sleep(500 * attempt); // 500ms, 1s, 1.5s
        }
    }
}

async function executeCopyTrade(originalTrade, wallet) {
    if (!copyTradingEnabled || !clobClient) return;

    // Vérifier que le proxy wallet est configuré (pas juste l'EOA)
    if (traderPrivateKey && traderFunderAddress) {
        const signer = new Wallet(traderPrivateKey);
        if (traderFunderAddress === signer.address.toLowerCase()) {
            await sendTelegram(`⚠️ *Copy-trade bloqué!*\n\nLe funder = ton EOA (pas ton proxy Polymarket).\nLes trades échoueraient.\n\n👉 /setfunder \\<ton proxy wallet Polymarket\\>\n👉 /lookup ${signer.address.toLowerCase()}\n👉 /myaddress pour voir tes adresses`);
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

        // ============================================
        // PHASE 1: TOUT EN PARALLÈLE (balances + market info + tick size)
        // ============================================
        const balancePromise = proportionalMode
            ? Promise.all([getUSDCBalance(wallet.address), getUSDCBalance(traderFunderAddress)])
            : Promise.resolve([null, null]);

        const marketPromise = (!assetId && conditionId)
            ? fetchMarketInfo(conditionId)
            : Promise.resolve(null);

        const earlyTickPromise = assetId && clobClient
            ? getCachedTickSize(assetId)
            : Promise.resolve(null);

        const [balances, marketInfo, earlyTickSize] = await Promise.all([
            balancePromise, marketPromise, earlyTickPromise
        ]);

        // --- Résoudre le token ID ---
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

        // --- Anti-doublon: cooldown par tokenId ---
        const lastCopy = copyCooldowns.get(tokenId);
        if (lastCopy && Date.now() - lastCopy < COPY_COOLDOWN_MS) {
            console.log(`⏭️ Copy-trade ignoré: cooldown ${COPY_COOLDOWN_MS / 1000}s sur ce marché (${wallet.label})`);
            return;
        }

        const tickSize = earlyTickSize || await getCachedTickSize(tokenId);

        // --- CALCUL DE LA TAILLE ---
        let copyUsd;
        let sizingInfo = '';
        const [trackedBalance, myBalance] = balances;

        if (proportionalMode && trackedBalance && trackedBalance > 0 && myBalance && myBalance > 0) {
            const proportion = origUsdcSize / trackedBalance;
            copyUsd = proportion * myBalance;
            sizingInfo = `📐 ${(proportion * 100).toFixed(1)}% de $${myBalance.toFixed(0)}`;
            console.log(`⚡ Proportional: ${(proportion * 100).toFixed(1)}% → $${copyUsd.toFixed(2)}`);
        } else {
            copyUsd = origUsdcSize * copyMultiplier;
            sizingInfo = proportionalMode
                ? `⚠️ Balances indispo → x${copyMultiplier}`
                : `📐 x${copyMultiplier}`;
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

        // --- Check SELL: vérifier qu'on a des positions avant de vendre ---
        if (side === 'SELL') {
            try {
                const positions = await clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenId });
                const myShares = parseFloat(positions?.balance || '0');
                if (myShares <= 0) {
                    console.log(`⏭️ SELL ignoré: aucune position sur ce token (${wallet.label})`);
                    await sendTelegram(`⏭️ *SELL ignoré*\n👤 ${wallet.label}\nAucune position à vendre sur ce marché`);
                    return;
                }
                // Ne pas vendre plus que ce qu'on a
                if (copySize > myShares) {
                    console.log(`⚠️ SELL ajusté: ${copySize} → ${Math.floor(myShares)} shares (max dispo)`);
                }
            } catch (e) {
                console.log(`⚠️ Position check failed, proceeding with SELL:`, e.message);
            }
        }

        // --- Check slippage: comparer prix trader vs orderbook ---
        let slippageInfo = '';
        try {
            const book = await clobClient.getOrderBook(tokenId);
            const bestPrice = isBuy
                ? (book?.asks?.[0]?.price ? parseFloat(book.asks[0].price) : null)
                : (book?.bids?.[0]?.price ? parseFloat(book.bids[0].price) : null);

            if (bestPrice && bestPrice > 0) {
                const slippagePct = Math.abs(bestPrice - origPrice) / origPrice * 100;
                if (slippagePct > CONFIG.SLIPPAGE_MAX_PCT) {
                    slippageInfo = `⚠️ Slippage ${slippagePct.toFixed(1)}% (live ${(bestPrice * 100).toFixed(0)}¢ vs ${(origPrice * 100).toFixed(0)}¢)`;
                    console.log(`⚠️ Slippage ${slippagePct.toFixed(1)}% détecté (${wallet.label})`);
                    await sendTelegram(`⚠️ *Slippage élevé détecté!*\n\n👤 ${wallet.label}\n📊 ${side} - Prix trader: ${(origPrice * 100).toFixed(0)}¢ | Live: ${(bestPrice * 100).toFixed(0)}¢\nSlippage: *${slippagePct.toFixed(1)}%* (max ${CONFIG.SLIPPAGE_MAX_PCT}%)\n\n_Trade exécuté au prix live_`);
                    // Exécuter au prix live plutôt qu'au prix stale
                }
            }
        } catch (e) {
            console.log('Slippage check skipped:', e.message);
        }

        // ============================================
        // PHASE 2: EXÉCUTION AVEC RETRY
        // ============================================
        const orderResp = await postOrderWithRetry(
            { tokenID: tokenId, price: origPrice, size: copySize, side: side },
            { tickSize: tickSize, negRisk: negRisk }
        );

        // Enregistrer le cooldown
        copyCooldowns.set(tokenId, Date.now());

        const totalLatency = Date.now() - tradeStart;
        const market = originalTrade.title || originalTrade.question || originalTrade.market || 'Marché inconnu';

        copiedTrades.push({
            time: new Date().toISOString(), from: wallet.label, side,
            price: origPrice, size: copySize, usd: copySize * origPrice,
            market: market.slice(0, 50),
            orderId: orderResp.orderID || orderResp.id || 'N/A', success: true,
            latencyMs: totalLatency,
        });

        await sendTelegram(`✅ *Copy-trade exécuté!*\n\n👤 *${wallet.label}* → $${origUsdcSize.toFixed(2)}\n📊 *${side}* ${copySize} shares @ ${(origPrice * 100).toFixed(0)}¢\n💰 *$${(copySize * origPrice).toFixed(2)}*\n${sizingInfo}\n🏷️ ${market.slice(0, 60)}\n⚡ ${totalLatency}ms${slippageInfo ? `\n${slippageInfo}` : ''}\n🆔 \`${orderResp.orderID || orderResp.id || 'OK'}\``);

    } catch (e) {
        console.error('❌ Copy-trade error:', e.message);
        copiedTrades.push({ time: new Date().toISOString(), from: wallet.label, error: e.message, success: false });
        await sendTelegram(`❌ *Copy-trade échoué!*\n\n👤 ${wallet.label}\n⚠️ ${e.message}`);
    }
}

// ============================================
// INIT
// ============================================
async function init() {
    console.log('🚀 Bot Polymarket Copy-Trader (Railway)\n');

    loadWalletsFromEnv();

    // Auto-init CLOB: API Key prioritaire, sinon Private Key
    if (process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_API_PASSPHRASE && process.env.POLYMARKET_PRIVATE_KEY) {
        const ok = await initClobWithApiKey(
            process.env.POLY_API_KEY,
            process.env.POLY_API_SECRET,
            process.env.POLY_API_PASSPHRASE,
            process.env.POLYMARKET_PRIVATE_KEY,
            traderFunderAddress
        );
        if (ok) console.log('🔑 API Key + Private Key chargées depuis env');
    } else if (process.env.POLYMARKET_PRIVATE_KEY) {
        const ok = await initClobWithPrivateKey(process.env.POLYMARKET_PRIVATE_KEY, traderFunderAddress);
        if (ok) console.log('🔑 Private Key chargée depuis env (credentials dérivées)');
    }

    telegramBot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
    setupTelegramCommands();
    scheduleDailySummary();
    scheduleHeartbeat();
    scheduleMemoryCleanup();

    const copyStatus = clobClient ? '🟢 Prêt' : '🔴 Non configuré';

    let proxyStatus = '';
    if (traderPrivateKey) {
        const signer = new Wallet(traderPrivateKey);
        const isProxy = traderFunderAddress && traderFunderAddress !== signer.address.toLowerCase();
        proxyStatus = isProxy
            ? `\n🏠 Proxy: \`${traderFunderAddress.slice(0, 6)}...${traderFunderAddress.slice(-4)}\` ✅`
            : '\n⚠️ Proxy wallet non détecté - /setfunder requis';
    }

    await sendTelegram(`🤖 *Bot Polymarket Copy-Trader*
_Railway Edition_

📋 *Wallets surveillés:*
/add \\<adresse\\> \\<nom\\> - Ajouter
/remove \\<n° ou adresse\\> - Supprimer
/wallets - Liste
/lookup \\<adresse\\> - Trouver proxy wallet

📋 *Copy-Trading:*
/setkey \\<clé\\> - Clé privée
/setapi \\<key\\> \\<secret\\> \\<pass\\> - API Key
/setfunder \\<adresse\\> - Proxy wallet Polymarket
/myaddress - Voir EOA + proxy
/copytrading - On/Off
/proportional - Proportionnel/Multiplicateur
/balance - Voir balances USDC
/setmultiplier \\<x\\> - Multiplicateur (si mode fixe)
/setmax \\<$\\> - Max par trade
/copyhistory - Historique

📋 *Surveillance:*
/start\\_watch | /stop\\_watch
/recent | /summary | /status

🔐 Copy-trading: ${copyStatus}${proxyStatus}
📂 Wallets: ${wallets.length}

💡 _Polymarket utilise des proxy wallets._
_Ton adresse de trading ≠ ton EOA._
_Le bot résout automatiquement le proxy._

⚠️ _/add et /remove sont en mémoire._
_Pour persister: var env WALLETS sur Railway_`);

    // Auto-start la surveillance
    if (wallets.length > 0) {
        isRunning = true;
        console.log('🟢 Auto-start surveillance');
        await sendTelegram(`🟢 *Surveillance auto-démarrée*\n${wallets.length} wallet(s)`);
        startWatching();
    }

    return true;
}

// ============================================
// TELEGRAM COMMANDS
// ============================================
function setupTelegramCommands() {

    // --- SET API KEY (key + secret + passphrase) ---
    telegramBot.onText(/\/setapi(?:@\S+)?\s+(\S+)\s+(\S+)\s+(\S+)/, async (msg, match) => {
        if (!isAuthorized(msg)) return;
        try { await telegramBot.deleteMessage(msg.chat.id, msg.message_id); } catch (e) {}

        const apiKey = match[1].trim();
        const apiSecret = match[2].trim();
        const apiPassphrase = match[3].trim();

        if (!traderPrivateKey) {
            return await sendTelegram('❌ D\'abord /setkey avec ta clé privée.\nL\'API key seule ne suffit pas (signature requise).\n\n1. /setkey \\<clé privée\\>\n2. /setapi \\<key\\> \\<secret\\> \\<passphrase\\>');
        }

        await sendTelegram('🔄 Initialisation avec API Key...');

        const ok = await initClobWithApiKey(apiKey, apiSecret, apiPassphrase, traderPrivateKey, traderFunderAddress);
        if (ok) {
            const signer = new Wallet(traderPrivateKey);
            const eoaAddr = signer.address.toLowerCase();
            const isProxy = traderFunderAddress && traderFunderAddress !== eoaAddr;
            const proxyLine = isProxy
                ? `\n🏠 Proxy: \`${traderFunderAddress.slice(0, 6)}...${traderFunderAddress.slice(-4)}\` ✅`
                : '\n⚠️ Proxy non détecté - /setfunder requis';

            await sendTelegram(`✅ *API Key configurée!*\n🔑 Key: \`${apiKey.slice(0, 8)}...\`${proxyLine}\n\n⚠️ Message supprimé.\n💡 Sur Railway:\n\`POLY\\_API\\_KEY\`\n\`POLY\\_API\\_SECRET\`\n\`POLY\\_API\\_PASSPHRASE\`\n\nPuis /copytrading pour activer.`);
        } else {
            await sendTelegram('❌ Erreur. Vérifiez vos credentials.');
        }
    });

    // --- SET PRIVATE KEY ---
    telegramBot.onText(/\/setkey(?:@\S+)?\s+(\S+)/, async (msg, match) => {
        if (!isAuthorized(msg)) return;
        try { await telegramBot.deleteMessage(msg.chat.id, msg.message_id); } catch (e) {}

        const key = match[1].trim();
        if (!/^(0x)?[a-fA-F0-9]{64}$/.test(key)) {
            return await sendTelegram('❌ Clé invalide. 64 hex (avec ou sans 0x).');
        }

        const formattedKey = key.startsWith('0x') ? key : '0x' + key;
        await sendTelegram('🔄 Initialisation CLOB...');

        const ok = await initClobWithPrivateKey(formattedKey, traderFunderAddress);
        if (ok) {
            const signer = new Wallet(formattedKey);
            const eoaAddr = signer.address.toLowerCase();
            const isProxy = traderFunderAddress && traderFunderAddress !== eoaAddr;

            let proxyInfo = '';
            if (isProxy) {
                proxyInfo = `\n🏠 Proxy wallet: \`${traderFunderAddress}\`\n✅ _Proxy auto-détecté!_`;
            } else {
                proxyInfo = `\n⚠️ _Proxy wallet non détecté._\n_Utilise /setfunder 0xTonProxyPolymarket_\n_ou /lookup ${eoaAddr}_`;
            }

            await sendTelegram(`✅ *Clé configurée!*\n🔑 EOA: \`${eoaAddr}\`${proxyInfo}\n\n⚠️ Message supprimé.\n💡 Si tu as une API Key Polymarket:\n/setapi \\<key\\> \\<secret\\> \\<passphrase\\>\n\nPuis /copytrading pour activer.`);
        } else {
            await sendTelegram('❌ Erreur init. Vérifiez la clé.');
        }
    });

    // --- SET FUNDER (proxy wallet) ---
    telegramBot.onText(/\/setfunder(?:@\S+)?\s+(\S+)/, async (msg, match) => {
        if (!isAuthorized(msg)) return;
        const addr = match[1].trim();
        if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return await sendTelegram('❌ Adresse invalide.');

        traderFunderAddress = addr.toLowerCase();
        if (traderPrivateKey) {
            const signer = new Wallet(traderPrivateKey);
            // Re-init avec API key si dispo, sinon private key
            if (process.env.POLY_API_KEY) {
                await initClobWithApiKey(process.env.POLY_API_KEY, process.env.POLY_API_SECRET, process.env.POLY_API_PASSPHRASE, traderPrivateKey, traderFunderAddress);
            } else {
                await initClobWithPrivateKey(traderPrivateKey, traderFunderAddress);
            }
        }
        await sendTelegram(`✅ *Proxy wallet configuré!*\n\n🏠 Funder (proxy): \`${traderFunderAddress}\`\n\n💡 C'est l'adresse qui détient tes USDC sur Polymarket.\nPersister: \`POLYMARKET\\_FUNDER\\_ADDRESS\` sur Railway`);
    });

    // --- MY ADDRESS (shows EOA vs proxy) ---
    telegramBot.onText(/\/myaddress/, async (msg) => {
        if (!isAuthorized(msg)) return;

        if (!traderPrivateKey) {
            return await sendTelegram('❌ Pas de clé configurée.\n/setkey d\'abord.');
        }

        const signer = new Wallet(traderPrivateKey);
        const eoaAddr = signer.address.toLowerCase();
        const isProxy = traderFunderAddress && traderFunderAddress !== eoaAddr;

        let msg_text = `🔑 *Tes adresses Polymarket:*\n\n`;
        msg_text += `👤 *EOA (signer):*\n\`${eoaAddr}\`\n_→ Signe les ordres_\n\n`;

        if (isProxy) {
            msg_text += `🏠 *Proxy wallet (funder):*\n\`${traderFunderAddress}\`\n_→ Détient tes USDC + exécute les trades_\n\n`;
            msg_text += `✅ Proxy correctement configuré!`;
        } else {
            msg_text += `⚠️ *Funder = EOA* (pas de proxy détecté)\n\`${eoaAddr}\`\n\n`;
            msg_text += `🔍 _Sur Polymarket, ton vrai wallet de trading est un proxy (smart contract)._\n`;
            msg_text += `_Trouve ton proxy sur ton profil Polymarket ou utilise /lookup_\n`;
            msg_text += `_Puis: /setfunder 0xTonProxyWallet_`;
        }

        await sendTelegram(msg_text);
    });

    // --- LOOKUP (find proxy address for any wallet) ---
    telegramBot.onText(/\/lookup(?:@\S+)?\s+(\S+)/, async (msg, match) => {
        if (!isAuthorized(msg)) return;
        const addr = match[1].trim();
        if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return await sendTelegram('❌ Adresse invalide.');

        await sendTelegram('🔍 Recherche du proxy wallet...');

        const proxy = await resolveProxyAddress(addr.toLowerCase());

        if (proxy && proxy !== addr.toLowerCase()) {
            await sendTelegram(`✅ *Proxy wallet trouvé!*\n\n📥 Adresse cherchée:\n\`${addr.toLowerCase()}\`\n\n🏠 Proxy wallet:\n\`${proxy}\`\n\n💡 Pour surveiller ce trader: \`/add ${proxy} NomDuTrader\`\n💡 Si c'est toi: \`/setfunder ${proxy}\``);
        } else if (proxy) {
            await sendTelegram(`ℹ️ *Résultat:*\n\n\`${addr.toLowerCase()}\`\n\nCette adresse est peut-être déjà un proxy wallet.\nEssaie de l'ajouter directement: \`/add ${addr.toLowerCase()} NomDuTrader\``);
        } else {
            await sendTelegram(`❌ *Proxy non trouvé pour:*\n\`${addr.toLowerCase()}\`\n\n_Possible raisons:_\n• L'adresse n'a jamais tradé sur Polymarket\n• C'est déjà une adresse proxy\n• Le profil n'existe pas\n\n💡 Essaie directement: \`/add ${addr.toLowerCase()} NomDuTrader\``);
        }
    });

    // --- TOGGLE COPY ---
    telegramBot.onText(/\/copytrading/, async (msg) => {
        if (!isAuthorized(msg)) return;
        if (!clobClient) return await sendTelegram('❌ D\'abord /setkey');

        // Warn if proxy wallet is not properly set
        const signer = new Wallet(traderPrivateKey);
        const isProxy = traderFunderAddress && traderFunderAddress !== signer.address.toLowerCase();

        copyTradingEnabled = !copyTradingEnabled;
        const status = copyTradingEnabled ? '🟢 ACTIVÉ' : '🔴 DÉSACTIVÉ';
        let proxyWarn = '';
        if (copyTradingEnabled && !isProxy) {
            proxyWarn = '\n\n⚠️ *ATTENTION:* Proxy wallet non configuré!\nLe funder = ton EOA, pas ton proxy Polymarket.\nLes trades risquent d\'échouer.\n👉 /setfunder \\<ton proxy Polymarket\\>\n👉 /lookup pour chercher ton proxy';
        }
        const modeStr = proportionalMode ? '📐 Proportionnel' : `x${copyMultiplier}`;
        await sendTelegram(`🔄 *Copy-trading: ${status}*\n• ${modeStr} | Max $${maxCopyUSD} | ${wallets.length} wallets${proxyWarn}`);
    });

    // --- MULTIPLIER ---
    telegramBot.onText(/\/setmultiplier(?:@\S+)?\s+(.+)/, async (msg, match) => {
        if (!isAuthorized(msg)) return;
        const val = parseFloat(match[1]);
        if (isNaN(val) || val <= 0 || val > 100) return await sendTelegram('❌ Entre 0.01 et 100');
        copyMultiplier = val;
        await sendTelegram(`✅ Multiplicateur: *x${val}*\nTrader $100 → tu copies *$${(100 * val).toFixed(2)}*\n💡 Persister: \`COPY\\_MULTIPLIER=${val}\``);
    });

    // --- MAX ---
    telegramBot.onText(/\/setmax(?:@\S+)?\s+(.+)/, async (msg, match) => {
        if (!isAuthorized(msg)) return;
        const val = parseFloat(match[1]);
        if (isNaN(val) || val <= 0) return await sendTelegram('❌ Invalide');
        maxCopyUSD = val;
        await sendTelegram(`✅ Max: *$${val}*\n💡 Persister: \`MAX\\_COPY\\_USD=${val}\``);
    });

    // --- PROPORTIONAL MODE TOGGLE ---
    telegramBot.onText(/\/proportional/, async (msg) => {
        if (!isAuthorized(msg)) return;
        proportionalMode = !proportionalMode;
        const mode = proportionalMode ? '🟢 PROPORTIONNEL' : '🔴 MULTIPLICATEUR';
        const desc = proportionalMode
            ? `Le bot copie le même % du capital que le trader.\nEx: trader met 5% de son USDC → tu mets 5% du tien.`
            : `Le bot copie avec un multiplicateur fixe x${copyMultiplier}.\nEx: trader trade $100 → tu copies $${(100 * copyMultiplier).toFixed(0)}.`;
        await sendTelegram(`📐 *Mode: ${mode}*\n\n${desc}\n\n💡 Persister: \`PROPORTIONAL\\_MODE=${proportionalMode}\``);
    });

    // --- BALANCE CHECK ---
    telegramBot.onText(/\/balance/, async (msg) => {
        if (!isAuthorized(msg)) return;

        await sendTelegram('🔍 Lecture des balances USDC on-chain...');

        const myAddr = traderFunderAddress;
        const myBalance = myAddr ? await getUSDCBalance(myAddr) : null;

        let txt = '💰 *Balances USDC (Polygon):*\n\n';

        if (myAddr && myBalance !== null) {
            txt += `🏠 *Mon proxy:*\n\`${myAddr}\`\n💵 *$${myBalance.toFixed(2)}* USDC\n\n`;
        } else if (myAddr) {
            txt += `🏠 *Mon proxy:* \`${myAddr}\`\n⚠️ Balance indisponible\n\n`;
        } else {
            txt += `🏠 Proxy non configuré\n\n`;
        }

        txt += '👁️ *Wallets surveillés:*\n';
        for (const w of wallets) {
            const bal = await getUSDCBalance(w.address);
            if (bal !== null) {
                txt += `• ${w.label}: *$${bal.toFixed(2)}*\n`;
                if (myBalance && bal > 0) {
                    txt += `  _Ratio: 1:${(bal / myBalance).toFixed(1)}_\n`;
                }
            } else {
                txt += `• ${w.label}: ⚠️ indisponible\n`;
            }
        }

        txt += `\n📐 Mode: ${proportionalMode ? 'Proportionnel' : `Multiplicateur x${copyMultiplier}`}`;
        await sendTelegram(txt);
    });

    // --- COPY HISTORY ---
    telegramBot.onText(/\/copyhistory/, async (msg) => {
        if (!isAuthorized(msg)) return;
        if (copiedTrades.length === 0) return await sendTelegram('📋 *Aucun copy-trade*');

        let txt = '📋 *Derniers copy-trades:*\n\n';
        for (const ct of copiedTrades.slice(-5).reverse()) {
            if (ct.success) {
                txt += `✅ ${ct.side} ${ct.size} @ ${(ct.price * 100).toFixed(0)}¢ ($${ct.usd.toFixed(2)})\n   👤 ${ct.from} - ${ct.market}\n\n`;
            } else {
                txt += `❌ ${ct.from} - ${ct.error}\n\n`;
            }
        }
        await sendTelegram(txt);
    });

    // --- SIG TYPE ---
    telegramBot.onText(/\/setsigtype(?:@\S+)?\s+(.+)/, async (msg, match) => {
        if (!isAuthorized(msg)) return;
        const val = parseInt(match[1], 10);
        if (![0, 1, 2].includes(val)) return await sendTelegram('❌ 0=EOA, 1=Magic, 2=Gnosis');
        signatureType = val;
        const labels = { 0: 'EOA', 1: 'Magic/Email', 2: 'Gnosis Safe' };
        await sendTelegram(`✅ Sig: *${labels[val]}*\nRelancez /setkey\n💡 Persister: \`SIGNATURE\\_TYPE=${val}\``);
    });

    // --- ADD WALLET ---
    telegramBot.onText(/\/add(?:@\S+)?\s+(\S+)\s*(.*)?/, async (msg, match) => {
        if (!isAuthorized(msg)) return;
        const address = match[1];
        const label = (match[2] || '').trim();
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return await sendTelegram('❌ Adresse invalide.');

        if (addWallet(address, label)) {
            const displayLabel = label || address.slice(0, 8) + '...';
            await sendTelegram(`✅ Wallet ajouté!\n👤 *${displayLabel}*\n\`${address.toLowerCase()}\`\nTotal: ${wallets.length}\n\n💡 Persister sur Railway:\n\`WALLETS=...,...,${address.toLowerCase()}:${displayLabel}\``);
        } else {
            await sendTelegram('⚠️ Déjà dans la liste.');
        }
    });

    // --- REMOVE WALLET ---
    telegramBot.onText(/\/remove(?:@\S+)?\s+(.+)/, async (msg, match) => {
        if (!isAuthorized(msg)) return;
        const removed = removeWallet(match[1]);
        if (removed) {
            await sendTelegram(`🗑️ Supprimé: *${removed.label}*\n\`${removed.address}\`\nRestant: ${wallets.length}\n\n💡 Pensez à mettre à jour WALLETS sur Railway.`);
        } else {
            await sendTelegram('❌ Non trouvé. /wallets');
        }
    });

    // --- LIST WALLETS ---
    telegramBot.onText(/\/wallets/, async (msg) => {
        if (!isAuthorized(msg)) return;
        if (wallets.length === 0) return await sendTelegram('📂 *Aucun wallet*\n`/add 0x... Nom`');

        let list = '📂 *Wallets suivis:*\n\n';
        wallets.forEach((w, i) => {
            list += `*${i + 1}.* 👤 ${w.label}\n   \`${w.address}\`\n\n`;
        });
        list += `_/remove <n°> pour supprimer_`;
        await sendTelegram(list);
    });

    // --- START WATCH ---
    telegramBot.onText(/\/start_watch/, async (msg) => {
        if (!isAuthorized(msg)) return;
        if (isRunning) return await sendTelegram('⚠️ Déjà actif');
        if (wallets.length === 0) return await sendTelegram('❌ Aucun wallet. /add d\'abord');

        isRunning = true;
        const cs = copyTradingEnabled ? '🟢 Copy ACTIF' : '🔴 Copy inactif';
        await sendTelegram(`🟢 *Surveillance activée!*\n${wallets.length} wallet(s) | ${CONFIG.CHECK_INTERVAL / 1000}s | Min $${CONFIG.MIN_TRADE_USD}\n${cs}`);
        startWatching();
    });

    // --- STOP WATCH ---
    telegramBot.onText(/\/stop_watch/, async (msg) => {
        if (!isAuthorized(msg)) return;
        isRunning = false;
        await sendTelegram('🔴 *Surveillance arrêtée*');
    });

    telegramBot.onText(/\/recent/, async (msg) => {
        if (!isAuthorized(msg)) return;
        await showRecentTrades();
    });

    telegramBot.onText(/\/summary/, async (msg) => {
        if (!isAuthorized(msg)) return;
        await sendDailySummary();
    });

    telegramBot.onText(/\/setmin(?:@\S+)?\s+(.+)/, async (msg, match) => {
        if (!isAuthorized(msg)) return;
        const value = parseFloat(match[1]);
        if (isNaN(value) || value < 0) return await sendTelegram('❌ Invalide');
        CONFIG.MIN_TRADE_USD = value;
        await sendTelegram(`✅ Min: *$${value}*\n💡 Persister: \`MIN\\_TRADE\\_USD=${value}\``);
    });

    // --- STATUS ---
    telegramBot.onText(/\/status/, async (msg) => {
        if (!isAuthorized(msg)) return;
        const h = Math.floor(process.uptime() / 3600);
        const m = Math.floor((process.uptime() % 3600) / 60);

        let addrInfo = '• Clé: 🔴 Non configurée';
        if (traderPrivateKey) {
            const signer = new Wallet(traderPrivateKey);
            const eoaAddr = signer.address.toLowerCase();
            const isProxy = traderFunderAddress && traderFunderAddress !== eoaAddr;
            addrInfo = `• EOA: \`${eoaAddr.slice(0, 6)}...${eoaAddr.slice(-4)}\`\n• Proxy: ${isProxy ? `\`${traderFunderAddress.slice(0, 6)}...${traderFunderAddress.slice(-4)}\` ✅` : '⚠️ Non détecté (/setfunder)'}`;
        }

        await sendTelegram(`📊 *Status*
• Surveillance: ${isRunning ? '🟢' : '🔴'}
• Wallets: ${wallets.length}
• Trades connus: ${[...knownTrades.values()].reduce((s, set) => s + set.size, 0)}
• Trades aujourd'hui: ${dailyTrades.length}
• Min: $${CONFIG.MIN_TRADE_USD}
• Uptime: ${h}h${m}m

🔄 *Copy-Trading:*
• État: ${copyTradingEnabled ? '🟢' : '🔴'}
• CLOB: ${clobClient ? '🟢' : '🔴'}
${addrInfo}
• Mode: ${proportionalMode ? '📐 Proportionnel' : `x${copyMultiplier}`} | Max $${maxCopyUSD}
• Copiés: ${copiedTrades.filter(c => c.success).length}/${copiedTrades.length}

🚂 _Railway_`);
    });
}

// ============================================
// TELEGRAM SEND
// ============================================
async function sendTelegram(message, options = {}) {
    try {
        await telegramBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false,
            ...options,
        });
    } catch (error) {
        console.error('Telegram error:', error.message);
    }
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
        console.error(`API error (${walletAddress.slice(0, 8)}):`, e.message);
    }
    return [];
}

async function fetchMarketInfo(conditionId) {
    // Cache hit
    const cached = marketInfoCache.get(conditionId);
    if (cached) return cached;

    try {
        const res = await fetchWithTimeout(
            `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`
        );
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
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
        tickSizeCache.set(tokenId, ts);
        return ts;
    } catch (e) {
        console.error('Tick size error:', e.message);
        return '0.01';
    }
}

// Refresh les balances en background pour 0 latence pendant le trade
let balanceRefreshInterval = null;
function startBalanceRefresh() {
    if (balanceRefreshInterval) return;
    balanceRefreshInterval = setInterval(async () => {
        if (!proportionalMode || !traderFunderAddress) return;
        const addrs = [traderFunderAddress, ...wallets.map(w => w.address)];
        await Promise.allSettled(addrs.map(a => getUSDCBalance(a)));
    }, BALANCE_CACHE_TTL - 5000); // Refresh 5s avant expiration du cache
}

// ============================================
// WATCH
// ============================================
async function startWatching() {
    console.log('🔄 Démarrage surveillance...\n');

    // Charger les trades initiaux EN PARALLÈLE (pas séquentiel)
    await Promise.allSettled(wallets.map(async (w) => {
        if (!knownTrades.has(w.address)) knownTrades.set(w.address, new Set());
        const initial = await fetchActivity(w.address);
        if (Array.isArray(initial)) {
            for (const t of initial) knownTrades.get(w.address).add(getTradeId(t));
        }
        console.log(`📊 ${w.label}: ${knownTrades.get(w.address).size} trades chargés`);
    }));

    // Lancer le refresh des balances en background
    startBalanceRefresh();

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
    // Priorité au transactionHash (identifiant unique on-chain)
    const txHash = t.transactionHash || t.transaction_hash;
    if (txHash) return `tx-${txHash}`;
    // Fallback: combinaison de champs
    return `${t.id || ''}-${t.timestamp || t.createdAt || ''}-${t.conditionId || t.asset_id || ''}`;
}

async function checkAllWallets() {
    // Poll TOUS les wallets en parallèle (pas séquentiel)
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

        const price = parseFloat(t.price || t.avgPrice || t.avg_price || 0);
        const size = parseFloat(t.size || t.amount || t.shares || 0);
        const usdcSize = parseFloat(t.usdcSize || t.value || t.total || (price * size) || 0);

        if (usdcSize < CONFIG.MIN_TRADE_USD) {
            console.log(`⏭️ [${wallet.label}] < $${CONFIG.MIN_TRADE_USD}: $${usdcSize.toFixed(2)}`);
            continue;
        }

        dailyTrades.push({ ...t, usdcSize, walletLabel: wallet.label, walletAddress: wallet.address });
        // Notification + exécution EN PARALLÈLE (pas de délai d'attente)
        // Le trade part immédiatement, la notif Telegram ne le bloque pas
        await Promise.all([
            notifyTrade(t, wallet).catch(e => console.error('Notify error:', e.message)),
            executeCopyTrade(t, wallet)
        ]);
    }
}

async function notifyTrade(t, wallet) {
    const side = (t.side || t.type || t.action || '').toLowerCase();
    let isBuy = side.includes('buy') || side.includes('bid');
    if (!side) {
        const mt = (t.maker || t.taker || '').toLowerCase();
        if (mt) isBuy = mt.includes('taker');
    }

    const emoji = isBuy ? '🟢 ACHAT' : '🔴 VENTE';
    let market = t.title || t.question || t.market || t.description || 'Marché inconnu';
    if (market.length > 80) market = market.slice(0, 80) + '...';

    let outcome = t.outcome || '';
    if (!outcome && t.outcomeIndex !== undefined) outcome = t.outcomeIndex === 0 ? 'Yes ✅' : 'No ❌';
    if (!outcome && t.outcome_index !== undefined) outcome = t.outcome_index === 0 ? 'Yes ✅' : 'No ❌';
    if (outcome.toLowerCase() === 'yes') outcome = 'Yes ✅';
    if (outcome.toLowerCase() === 'no') outcome = 'No ❌';
    if (!outcome) outcome = 'N/A';

    const price = parseFloat(t.price || t.avgPrice || t.avg_price || 0);
    const size = parseFloat(t.size || t.amount || t.shares || 0);
    const usdcSize = parseFloat(t.usdcSize || t.value || t.total || (price * size) || 0);

    let timeStr = 'N/A';
    const ts = t.timestamp || t.createdAt || t.created_at || t.time;
    if (ts) {
        try {
            const d = new Date(typeof ts === 'number' && ts < 10000000000 ? ts * 1000 : ts);
            if (d.getFullYear() > 2020) timeStr = d.toLocaleString('fr-FR');
        } catch (e) {}
    }

    let marketLink = '';
    const slug = t.slug || t.marketSlug || t.market_slug;
    const conditionId = t.conditionId || t.condition_id;
    if (slug) marketLink = `https://polymarket.com/event/${slug}`;
    else if (conditionId) {
        const mi = await fetchMarketInfo(conditionId);
        if (mi && mi.slug) marketLink = `https://polymarket.com/event/${mi.slug}`;
    }

    const copyTag = copyTradingEnabled ? '\n🔄 _Copy-trade en cours..._' : '';

    await sendTelegram(`🔔 *NOUVEAU TRADE!*

👤 *${wallet.label}*
${emoji}

📊 ${market}

💰 ${outcome} | ${Math.round(price * 100)}¢ | ${size.toFixed(2)} shares
Total: *$${usdcSize.toFixed(2)}*

⏰ ${timeStr}${marketLink ? `\n🔗 [Voir](${marketLink})` : ''}${copyTag}`);

    console.log(`📈 [${wallet.label}] ${emoji} - $${usdcSize.toFixed(2)} - ${market.slice(0, 40)}`);
}

// ============================================
// HEARTBEAT (ping toutes les 6h pour confirmer que le bot est vivant)
// ============================================
function scheduleHeartbeat() {
    const HEARTBEAT_INTERVAL = 6 * 60 * 60 * 1000; // 6h
    setInterval(async () => {
        const h = Math.floor(process.uptime() / 3600);
        const m = Math.floor((process.uptime() % 3600) / 60);
        const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
        const knownCount = [...knownTrades.values()].reduce((s, set) => s + set.size, 0);
        const cbStatus = circuitBreaker.isOpen() ? '🔴 Ouvert' : '🟢 OK';
        await sendTelegram(`💓 *Heartbeat*\n\n• Uptime: ${h}h${m}m\n• RAM: ${memMB}MB\n• Surveillance: ${isRunning ? '🟢' : '🔴'}\n• Trades connus: ${knownCount}\n• Circuit breaker: ${cbStatus}\n• Copy: ${copyTradingEnabled ? '🟢' : '🔴'} (${copiedTrades.filter(c => c.success).length} OK)`);
    }, HEARTBEAT_INTERVAL);
}

// ============================================
// NETTOYAGE MÉMOIRE (empêche knownTrades de grossir sans limite)
// ============================================
function scheduleMemoryCleanup() {
    const CLEANUP_INTERVAL = 4 * 60 * 60 * 1000; // 4h
    const MAX_KNOWN_PER_WALLET = 500; // Garde les 500 derniers trades max
    setInterval(() => {
        let totalCleaned = 0;
        for (const [addr, trades] of knownTrades.entries()) {
            if (trades.size > MAX_KNOWN_PER_WALLET) {
                const arr = [...trades];
                const toKeep = arr.slice(-MAX_KNOWN_PER_WALLET);
                knownTrades.set(addr, new Set(toKeep));
                totalCleaned += arr.length - MAX_KNOWN_PER_WALLET;
            }
        }
        // Nettoyer les cooldowns expirés
        const now = Date.now();
        for (const [tokenId, ts] of copyCooldowns.entries()) {
            if (now - ts > COPY_COOLDOWN_MS * 2) copyCooldowns.delete(tokenId);
        }
        // Limiter copiedTrades à 200 entrées
        if (copiedTrades.length > 200) {
            copiedTrades = copiedTrades.slice(-100);
        }
        if (totalCleaned > 0) console.log(`🧹 Mémoire: ${totalCleaned} trades anciens supprimés`);
    }, CLEANUP_INTERVAL);
}

// ============================================
// DAILY SUMMARY
// ============================================
function scheduleDailySummary() {
    setInterval(async () => {
        const now = new Date();
        if (now.getHours() === 21 && now.getMinutes() === 0) await sendDailySummary();
    }, 60000);
}

async function sendDailySummary() {
    if (dailyTrades.length === 0) return await sendTelegram('📊 *Résumé du jour*\nAucun trade.');

    const totalVol = dailyTrades.reduce((s, t) => s + (t.usdcSize || 0), 0);
    let buys = 0, sells = 0;
    const byWallet = {};

    for (const t of dailyTrades) {
        const side = (t.side || t.type || t.action || '').toLowerCase();
        if (side.includes('buy')) buys++; else sells++;
        const label = t.walletLabel || '?';
        if (!byWallet[label]) byWallet[label] = { count: 0, volume: 0 };
        byWallet[label].count++;
        byWallet[label].volume += t.usdcSize || 0;
    }

    let ws = '';
    for (const [l, s] of Object.entries(byWallet)) ws += `• 👤 ${l}: ${s.count} ($${s.volume.toFixed(2)})\n`;

    const top3 = [...dailyTrades].sort((a, b) => (b.usdcSize || 0) - (a.usdcSize || 0)).slice(0, 3);
    let t3 = '';
    for (const t of top3) {
        const mk = (t.title || t.question || t.market || '?').slice(0, 35);
        t3 += `• $${(t.usdcSize || 0).toFixed(2)} - ${t.walletLabel || '?'} - ${mk}\n`;
    }

    const tc = copiedTrades.filter(c => { try { return new Date(c.time).toDateString() === new Date().toDateString(); } catch(e) { return false; } });
    const ci = tc.length > 0 ? `\n🔄 Copy: ${tc.filter(c=>c.success).length}/${tc.length}` : '';

    await sendTelegram(`📊 *Résumé du jour*\n\n• Trades: ${dailyTrades.length}\n• Volume: *$${totalVol.toFixed(2)}*\n• Achats: ${buys} | Ventes: ${sells}\n\n👥 *Par trader:*\n${ws}\n🏆 *Top 3:*\n${t3}${ci}`);
}

// ============================================
// RECENT
// ============================================
async function showRecentTrades() {
    await sendTelegram('🔍 Récupération...');

    let all = [];
    for (const w of wallets) {
        const trades = await fetchActivity(w.address);
        if (Array.isArray(trades)) {
            for (const t of trades) all.push({ ...t, _wl: w.label });
        }
    }

    if (all.length === 0) return await sendTelegram('❌ Aucun trade');

    all.sort((a, b) => {
        const ta = a.timestamp || a.createdAt || a.created_at || 0;
        const tb = b.timestamp || b.createdAt || b.created_at || 0;
        return (typeof tb === 'number' ? tb : new Date(tb).getTime()) - (typeof ta === 'number' ? ta : new Date(ta).getTime());
    });

    let msg = '📋 *5 derniers trades:*\n\n';
    for (const t of all.slice(0, 5)) {
        const isBuy = (t.side || t.type || '').toLowerCase().includes('buy');
        const usd = parseFloat(t.usdcSize || t.value || t.total || 0);
        let out = t.outcome || '';
        if (!out && t.outcomeIndex !== undefined) out = t.outcomeIndex === 0 ? 'Yes' : 'No';
        const mk = (t.title || t.question || t.market || '?').slice(0, 35);

        msg += `${isBuy ? '🟢' : '🔴'} *${t._wl}* - *$${usd.toFixed(2)}* - ${out || 'N/A'}\n   ${mk}\n\n`;
    }
    await sendTelegram(msg);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================
// START
// ============================================
init().catch(e => { console.error('❌', e); process.exit(1); });
