require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { ClobClient } = require('@polymarket/clob-client');
const { Wallet } = require('@ethersproject/wallet');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8525426243:AAHfQdqz1jUD4algSX15z2SHvsziOG0rxxs',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '410866851',
    CHECK_INTERVAL: 10000,
    MIN_TRADE_USD: 10,
    WALLETS_FILE: path.join(__dirname, 'wallets.json'),
    CONFIG_FILE: path.join(__dirname, 'config.json'),
    CLOB_HOST: 'https://clob.polymarket.com',
    CHAIN_ID: 137,
};

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
let traderFunderAddress = null;
let signatureType = 0; // 0 = EOA, 1 = Magic/email
let copyMultiplier = 1.0; // multiplier for trade size
let maxCopyUSD = 500; // max $ per copied trade
let copiedTrades = []; // history of copied trades

// ============================================
// WALLET MANAGEMENT (persistent)
// ============================================
let wallets = [];

function loadWallets() {
    try {
        if (fs.existsSync(CONFIG.WALLETS_FILE)) {
            const data = fs.readFileSync(CONFIG.WALLETS_FILE, 'utf-8');
            wallets = JSON.parse(data);
            console.log(`📂 ${wallets.length} wallet(s) chargé(s)`);
        }
    } catch (e) {
        console.error('Erreur lecture wallets.json:', e.message);
        wallets = [];
    }
}

function saveWallets() {
    try {
        fs.writeFileSync(CONFIG.WALLETS_FILE, JSON.stringify(wallets, null, 2), 'utf-8');
    } catch (e) {
        console.error('Erreur sauvegarde wallets.json:', e.message);
    }
}

// ============================================
// CONFIG PERSISTENCE (for copy-trading settings)
// ============================================
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG.CONFIG_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG.CONFIG_FILE, 'utf-8'));
            copyMultiplier = data.copyMultiplier || 1.0;
            maxCopyUSD = data.maxCopyUSD || 500;
            signatureType = data.signatureType || 0;
            traderFunderAddress = data.funderAddress || null;
            console.log('⚙️ Config chargée');
        }
    } catch (e) {
        console.error('Erreur lecture config.json:', e.message);
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG.CONFIG_FILE, JSON.stringify({
            copyMultiplier,
            maxCopyUSD,
            signatureType,
            funderAddress: traderFunderAddress,
        }, null, 2), 'utf-8');
    } catch (e) {
        console.error('Erreur sauvegarde config.json:', e.message);
    }
}

function addWallet(address, label) {
    const addr = address.toLowerCase().trim();
    if (wallets.find(w => w.address === addr)) return false;
    wallets.push({ address: addr, label: label || addr.slice(0, 8) + '...' });
    knownTrades.set(addr, new Set());
    saveWallets();
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
    if (removed) {
        knownTrades.delete(removed.address);
        saveWallets();
    }
    return removed;
}

// ============================================
// CLOB CLIENT INIT
// ============================================
async function initClobClient(privateKey, funderAddr) {
    try {
        const signer = new Wallet(privateKey);
        traderPrivateKey = privateKey;
        traderFunderAddress = funderAddr || signer.address;

        // Step 1: L1 client to derive API credentials
        const tempClient = new ClobClient(CONFIG.CLOB_HOST, CONFIG.CHAIN_ID, signer);
        const creds = await tempClient.createOrDeriveApiKey();

        // Step 2: Full L2 client with credentials
        clobClient = new ClobClient(
            CONFIG.CLOB_HOST,
            CONFIG.CHAIN_ID,
            signer,
            creds,
            signatureType,
            traderFunderAddress
        );

        saveConfig();
        console.log('✅ CLOB Client initialisé');
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
async function executeCopyTrade(originalTrade, wallet) {
    if (!copyTradingEnabled || !clobClient) return;

    try {
        // Determine side (BUY/SELL)
        const sideStr = (originalTrade.side || originalTrade.type || originalTrade.action || '').toLowerCase();
        const isBuy = sideStr.includes('buy') || sideStr.includes('bid');

        // Get price and size from the original trade
        const origPrice = parseFloat(originalTrade.price || originalTrade.avgPrice || originalTrade.avg_price || 0);
        const origSize = parseFloat(originalTrade.size || originalTrade.amount || originalTrade.shares || 0);
        const origUsdcSize = parseFloat(originalTrade.usdcSize || originalTrade.value || originalTrade.total || (origPrice * origSize) || 0);

        if (origPrice <= 0 || origSize <= 0) {
            await sendTelegram(`⚠️ *Copy-trade ignoré*\nPrix ou taille invalide pour le trade de ${wallet.label}`);
            return;
        }

        // Calculate copy size with multiplier and cap
        let copyUsd = origUsdcSize * copyMultiplier;
        if (copyUsd > maxCopyUSD) copyUsd = maxCopyUSD;
        const copySize = Math.floor(copyUsd / origPrice);

        if (copySize <= 0) {
            await sendTelegram(`⚠️ *Copy-trade ignoré*\nTaille trop petite après calcul`);
            return;
        }

        // Get token ID from Gamma API
        const conditionId = originalTrade.conditionId || originalTrade.condition_id;
        const assetId = originalTrade.asset || originalTrade.asset_id || originalTrade.tokenId || originalTrade.token_id;

        let tokenId = assetId;
        let negRisk = false;

        if (!tokenId && conditionId) {
            const marketInfo = await fetchMarketInfo(conditionId);
            if (marketInfo) {
                negRisk = marketInfo.negRisk || false;
                const tokenIds = JSON.parse(marketInfo.clobTokenIds || '[]');
                const outcomeIdx = originalTrade.outcomeIndex ?? originalTrade.outcome_index ?? 0;
                tokenId = tokenIds[outcomeIdx];
            }
        }

        if (!tokenId) {
            await sendTelegram(`⚠️ *Copy-trade échoué*\nImpossible de trouver le token ID pour le marché`);
            return;
        }

        // Get tick size
        let tickSize = '0.01';
        try {
            tickSize = await clobClient.getTickSize(tokenId);
        } catch (e) {
            console.error('Tick size error, using default 0.01:', e.message);
        }

        // Place order
        const side = isBuy ? 'BUY' : 'SELL';
        await sendTelegram(`🔄 *Copy-trade en cours...*\n👤 Copie de: ${wallet.label}\n📊 ${side} ${copySize} shares @ ${origPrice.toFixed(2)}\n💰 ~$${(copySize * origPrice).toFixed(2)}`);

        const orderResp = await clobClient.createAndPostOrder(
            {
                tokenID: tokenId,
                price: origPrice,
                size: copySize,
                side: side,
            },
            {
                tickSize: tickSize,
                negRisk: negRisk,
            }
        );

        const market = originalTrade.title || originalTrade.question || originalTrade.market || 'Marché inconnu';

        copiedTrades.push({
            time: new Date().toISOString(),
            from: wallet.label,
            side,
            price: origPrice,
            size: copySize,
            usd: copySize * origPrice,
            market: market.slice(0, 50),
            orderId: orderResp.orderID || orderResp.id || 'N/A',
            success: true,
        });

        await sendTelegram(`✅ *Copy-trade exécuté!*

👤 Copié de: *${wallet.label}*
📊 *${side}* ${copySize} shares @ ${(origPrice * 100).toFixed(0)}¢
💰 Total: *$${(copySize * origPrice).toFixed(2)}*
🏷️ Marché: ${market.slice(0, 60)}
🆔 Order: \`${orderResp.orderID || orderResp.id || 'OK'}\``);

    } catch (e) {
        console.error('❌ Copy-trade error:', e.message);

        copiedTrades.push({
            time: new Date().toISOString(),
            from: wallet.label,
            error: e.message,
            success: false,
        });

        await sendTelegram(`❌ *Copy-trade échoué!*\n\n👤 Trader: ${wallet.label}\n⚠️ Erreur: ${e.message}`);
    }
}

// ============================================
// INIT
// ============================================
async function init() {
    console.log('🚀 Bot Polymarket Copy-Trader\n');

    loadWallets();
    loadConfig();

    // Auto-init CLOB client if private key is in .env
    if (process.env.POLYMARKET_PRIVATE_KEY) {
        const ok = await initClobClient(
            process.env.POLYMARKET_PRIVATE_KEY,
            process.env.POLYMARKET_FUNDER_ADDRESS || null
        );
        if (ok) console.log('🔑 Clé privée chargée depuis .env');
    }

    telegramBot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
    setupTelegramCommands();
    scheduleDailySummary();

    const copyStatus = clobClient ? '🟢 Prêt (clé configurée)' : '🔴 Non configuré';

    await sendTelegram(`🤖 *Bot Polymarket Copy-Trader*

✨ *Fonctionnalités:*
• Surveillance multi-wallets
• *COPY-TRADING automatique*
• Détection ACHAT/VENTE 🟢🔴
• Résumé journalier à 21h

📋 *Commandes Wallets:*
/add \\<adresse\\> \\<nom\\> - Ajouter un trader
/remove \\<n° ou adresse\\> - Supprimer
/wallets - Liste des wallets suivis

📋 *Commandes Copy-Trading:*
/setkey \\<clé privée\\> - Configurer ta clé
/setfunder \\<adresse\\> - Adresse Polymarket
/copytrading - Activer/désactiver
/setmultiplier \\<x\\> - Multiplicateur (ex: 0.5)
/setmax \\<$\\> - Max par trade copié
/copyhistory - Historique copies

📋 *Autres:*
/start\\_watch - Démarrer
/stop\\_watch - Arrêter
/recent - 5 derniers trades
/summary - Résumé du jour
/status - État complet

🔐 Copy-trading: ${copyStatus}
📂 Wallets: ${wallets.length}`);

    return true;
}

// ============================================
// TELEGRAM COMMANDS
// ============================================
function setupTelegramCommands() {

    // ===== COPY-TRADING COMMANDS =====

    // --- SET PRIVATE KEY ---
    telegramBot.onText(/\/setkey(?:@\S+)?\s+(\S+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;

        // Delete the message containing the private key for security
        try {
            await telegramBot.deleteMessage(msg.chat.id, msg.message_id);
        } catch (e) {}

        const key = match[1].trim();
        if (!/^(0x)?[a-fA-F0-9]{64}$/.test(key)) {
            return await sendTelegram('❌ Clé privée invalide. Format: 64 caractères hex (avec ou sans 0x).');
        }

        const formattedKey = key.startsWith('0x') ? key : '0x' + key;
        await sendTelegram('🔄 Initialisation du client CLOB...');

        const ok = await initClobClient(formattedKey, traderFunderAddress);
        if (ok) {
            const signer = new Wallet(formattedKey);
            await sendTelegram(`✅ *Clé privée configurée!*\n\n🔑 Adresse: \`${signer.address}\`\n\n⚠️ Message avec la clé supprimé pour sécurité.\nUtilisez /setfunder si votre adresse Polymarket est différente.\nPuis /copytrading pour activer.`);
        } else {
            await sendTelegram('❌ Erreur lors de l\'initialisation. Vérifiez votre clé privée.');
        }
    });

    // --- SET FUNDER ADDRESS ---
    telegramBot.onText(/\/setfunder(?:@\S+)?\s+(\S+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        const addr = match[1].trim();
        if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
            return await sendTelegram('❌ Adresse invalide.');
        }
        traderFunderAddress = addr.toLowerCase();
        saveConfig();

        // Reinit client if key exists
        if (traderPrivateKey) {
            await initClobClient(traderPrivateKey, traderFunderAddress);
        }

        await sendTelegram(`✅ *Adresse funder configurée:*\n\`${traderFunderAddress}\``);
    });

    // --- TOGGLE COPY-TRADING ---
    telegramBot.onText(/\/copytrading/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;

        if (!clobClient) {
            return await sendTelegram('❌ Configurez d\'abord votre clé avec /setkey');
        }

        copyTradingEnabled = !copyTradingEnabled;
        const status = copyTradingEnabled ? '🟢 ACTIVÉ' : '🔴 DÉSACTIVÉ';
        await sendTelegram(`🔄 *Copy-trading: ${status}*\n\n• Multiplicateur: x${copyMultiplier}\n• Max par trade: $${maxCopyUSD}\n• Wallets suivis: ${wallets.length}`);
    });

    // --- SET MULTIPLIER ---
    telegramBot.onText(/\/setmultiplier(?:@\S+)?\s+(.+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        const val = parseFloat(match[1]);
        if (isNaN(val) || val <= 0 || val > 100) {
            return await sendTelegram('❌ Valeur invalide. Entre 0.01 et 100.\nExemple: /setmultiplier 0.5');
        }
        copyMultiplier = val;
        saveConfig();
        await sendTelegram(`✅ Multiplicateur: *x${copyMultiplier}*\n\nSi un trader achète pour $100, tu copieras *$${(100 * copyMultiplier).toFixed(2)}*`);
    });

    // --- SET MAX ---
    telegramBot.onText(/\/setmax(?:@\S+)?\s+(.+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        const val = parseFloat(match[1]);
        if (isNaN(val) || val <= 0) {
            return await sendTelegram('❌ Valeur invalide. Exemple: /setmax 200');
        }
        maxCopyUSD = val;
        saveConfig();
        await sendTelegram(`✅ Max par copy-trade: *$${maxCopyUSD}*`);
    });

    // --- COPY HISTORY ---
    telegramBot.onText(/\/copyhistory/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;

        if (copiedTrades.length === 0) {
            return await sendTelegram('📋 *Aucun copy-trade effectué*');
        }

        let msg2 = '📋 *Derniers copy-trades:*\n\n';
        const recent = copiedTrades.slice(-5).reverse();
        for (const ct of recent) {
            if (ct.success) {
                msg2 += `✅ ${ct.side} ${ct.size} @ ${(ct.price * 100).toFixed(0)}¢ ($${ct.usd.toFixed(2)})\n`;
                msg2 += `   👤 ${ct.from} - ${ct.market}\n\n`;
            } else {
                msg2 += `❌ Échec - ${ct.from}\n   ${ct.error}\n\n`;
            }
        }
        await sendTelegram(msg2);
    });

    // --- SET SIGNATURE TYPE ---
    telegramBot.onText(/\/setsigtype(?:@\S+)?\s+(.+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        const val = parseInt(match[1], 10);
        if (![0, 1, 2].includes(val)) {
            return await sendTelegram('❌ Type invalide.\n0 = EOA (MetaMask)\n1 = Magic/Email\n2 = Gnosis Safe');
        }
        signatureType = val;
        saveConfig();
        const labels = { 0: 'EOA (MetaMask)', 1: 'Magic/Email', 2: 'Gnosis Safe' };
        await sendTelegram(`✅ Signature type: *${val}* (${labels[val]})\n\nRelancez /setkey pour appliquer.`);
    });

    // ===== WALLET COMMANDS =====

    telegramBot.onText(/\/add(?:@\S+)?\s+(\S+)\s*(.*)?/, async (msg, match) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        const address = match[1];
        const label = (match[2] || '').trim();
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
            return await sendTelegram('❌ Adresse invalide. Format: `0x` + 40 hex.');
        }
        if (addWallet(address, label)) {
            const displayLabel = label || address.slice(0, 8) + '...';
            await sendTelegram(`✅ Wallet ajouté!\n\n👤 *${displayLabel}*\n\`${address.toLowerCase()}\`\n\n📂 Total: ${wallets.length} wallet(s)`);
        } else {
            await sendTelegram('⚠️ Ce wallet est déjà dans la liste.');
        }
    });

    telegramBot.onText(/\/remove(?:@\S+)?\s+(.+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        const removed = removeWallet(match[1]);
        if (removed) {
            await sendTelegram(`🗑️ Wallet supprimé:\n👤 *${removed.label}*\n\`${removed.address}\`\n\n📂 Restant: ${wallets.length} wallet(s)`);
        } else {
            await sendTelegram('❌ Wallet non trouvé. Utilisez /wallets pour voir la liste.');
        }
    });

    telegramBot.onText(/\/wallets/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        if (wallets.length === 0) {
            return await sendTelegram('📂 *Aucun wallet suivi*\n\nAjoutez-en avec:\n`/add 0x... NomDuTrader`');
        }
        let list = '📂 *Wallets suivis:*\n\n';
        wallets.forEach((w, i) => {
            list += `*${i + 1}.* 👤 ${w.label}\n   \`${w.address}\`\n\n`;
        });
        list += `_Pour supprimer: /remove <n°>_`;
        await sendTelegram(list);
    });

    // ===== WATCH COMMANDS =====

    telegramBot.onText(/\/start_watch/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        if (isRunning) return await sendTelegram('⚠️ Déjà actif');
        if (wallets.length === 0) {
            return await sendTelegram('❌ Aucun wallet à surveiller.\nAjoutez-en d\'abord avec /add');
        }
        isRunning = true;
        const copyStatus = copyTradingEnabled ? '🟢 Copy-trading ACTIF' : '🔴 Copy-trading inactif';
        await sendTelegram(`🟢 *Surveillance activée!*\n${wallets.length} wallet(s) surveillé(s)\nVérification toutes les ${CONFIG.CHECK_INTERVAL / 1000}s\nMinimum: $${CONFIG.MIN_TRADE_USD}\n${copyStatus}`);
        startWatching();
    });

    telegramBot.onText(/\/stop_watch/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        isRunning = false;
        await sendTelegram('🔴 *Surveillance arrêtée*');
    });

    telegramBot.onText(/\/recent/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        await showRecentTrades();
    });

    telegramBot.onText(/\/summary/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        await sendDailySummary();
    });

    telegramBot.onText(/\/setmin(?:@\S+)?\s+(.+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        const value = parseFloat(match[1]);
        if (isNaN(value) || value < 0) {
            return await sendTelegram('❌ Valeur invalide. Exemple: /setmin 20');
        }
        CONFIG.MIN_TRADE_USD = value;
        await sendTelegram(`✅ Minimum changé à *$${value}*`);
    });

    telegramBot.onText(/\/status/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        const copyStatus = copyTradingEnabled ? '🟢 Activé' : '🔴 Désactivé';
        const clobStatus = clobClient ? '🟢 Connecté' : '🔴 Non configuré';
        await sendTelegram(`📊 *Status*
• Surveillance: ${isRunning ? '🟢 Active' : '🔴 Arrêtée'}
• Wallets suivis: ${wallets.length}
• Trades connus: ${[...knownTrades.values()].reduce((s, set) => s + set.size, 0)}
• Trades aujourd'hui: ${dailyTrades.length}
• Minimum: $${CONFIG.MIN_TRADE_USD}

🔄 *Copy-Trading:*
• État: ${copyStatus}
• Client CLOB: ${clobStatus}
• Multiplicateur: x${copyMultiplier}
• Max par trade: $${maxCopyUSD}
• Trades copiés: ${copiedTrades.filter(c => c.success).length}/${copiedTrades.length}`);
    });
}

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
    try {
        const res = await fetch(
            `https://data-api.polymarket.com/activity?user=${walletAddress.toLowerCase()}&limit=30`
        );
        if (res.ok) return await res.json();
    } catch (e) {
        console.error(`API error (${walletAddress.slice(0, 8)}):`, e.message);
    }
    return [];
}

async function fetchMarketInfo(conditionId) {
    try {
        const res = await fetch(
            `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`
        );
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) return data[0];
        }
    } catch (e) {
        console.error('Market info error:', e.message);
    }
    return null;
}

// ============================================
// WATCH
// ============================================
async function startWatching() {
    console.log('🔄 Démarrage surveillance...\n');

    for (const w of wallets) {
        if (!knownTrades.has(w.address)) knownTrades.set(w.address, new Set());
        const initial = await fetchActivity(w.address);
        if (Array.isArray(initial)) {
            for (const t of initial) {
                knownTrades.get(w.address).add(getTradeId(t));
            }
        }
        console.log(`📊 ${w.label}: ${knownTrades.get(w.address).size} trades chargés`);
    }
    console.log('');

    while (isRunning) {
        try {
            const today = new Date().toDateString();
            if (today !== lastDailyReset) {
                dailyTrades = [];
                lastDailyReset = today;
            }
            await checkAllWallets();
        } catch (e) {
            console.error('Error:', e.message);
        }
        await sleep(CONFIG.CHECK_INTERVAL);
    }
}

function getTradeId(t) {
    return `${t.id || ''}-${t.transactionHash || t.transaction_hash || ''}-${t.timestamp || t.createdAt || ''}-${t.conditionId || t.asset_id || ''}`;
}

async function checkAllWallets() {
    for (const w of wallets) {
        if (!isRunning) break;
        await checkNewTrades(w);
    }
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
            console.log(`⏭️ [${wallet.label}] Trade ignoré (< $${CONFIG.MIN_TRADE_USD}): $${usdcSize.toFixed(2)}`);
            continue;
        }

        dailyTrades.push({ ...t, usdcSize, walletLabel: wallet.label, walletAddress: wallet.address });

        // Notify THEN copy
        await notifyTrade(t, wallet);
        await executeCopyTrade(t, wallet);
    }
}

async function notifyTrade(t, wallet) {
    const side = (t.side || t.type || t.action || '').toLowerCase();
    let isBuy = side.includes('buy') || side.includes('bid');
    if (!side) {
        const makerTaker = (t.maker || t.taker || '').toLowerCase();
        if (makerTaker) isBuy = makerTaker.includes('taker');
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
    const priceInCents = Math.round(price * 100);

    let timeStr = 'N/A';
    const ts = t.timestamp || t.createdAt || t.created_at || t.time;
    if (ts) {
        try {
            const date = new Date(typeof ts === 'number' && ts < 10000000000 ? ts * 1000 : ts);
            if (date.getFullYear() > 2020) timeStr = date.toLocaleString('fr-FR');
        } catch (e) {}
    }

    let marketLink = '';
    const slug = t.slug || t.marketSlug || t.market_slug;
    const conditionId = t.conditionId || t.condition_id;
    if (slug) {
        marketLink = `https://polymarket.com/event/${slug}`;
    } else if (conditionId) {
        const marketInfo = await fetchMarketInfo(conditionId);
        if (marketInfo && marketInfo.slug) marketLink = `https://polymarket.com/event/${marketInfo.slug}`;
    }

    const copyTag = copyTradingEnabled ? '\n🔄 _Copy-trade en cours..._' : '';

    const message = `🔔 *NOUVEAU TRADE!*

👤 *Trader:* ${wallet.label}

${emoji}

📊 *Marché:*
${market}

💰 *Détails:*
• Position: ${outcome}
• Prix: ${priceInCents}¢
• Quantité: ${size.toFixed(2)} shares
• Total: *$${usdcSize.toFixed(2)}*

⏰ ${timeStr}
${marketLink ? `\n🔗 [Voir le marché](${marketLink})` : ''}${copyTag}`;

    console.log(`📈 [${wallet.label}] ${emoji} - $${usdcSize.toFixed(2)} - ${market.slice(0, 40)}`);
    await sendTelegram(message);
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
    if (dailyTrades.length === 0) {
        return await sendTelegram(`📊 *Résumé du jour*\n\nAucun trade aujourd'hui.`);
    }

    const totalVolume = dailyTrades.reduce((sum, t) => sum + (t.usdcSize || 0), 0);
    const avgSize = totalVolume / dailyTrades.length;

    let buys = 0, sells = 0;
    for (const t of dailyTrades) {
        const side = (t.side || t.type || t.action || '').toLowerCase();
        if (side.includes('buy')) buys++;
        else sells++;
    }

    const byWallet = {};
    for (const t of dailyTrades) {
        const label = t.walletLabel || 'Inconnu';
        if (!byWallet[label]) byWallet[label] = { count: 0, volume: 0 };
        byWallet[label].count++;
        byWallet[label].volume += t.usdcSize || 0;
    }

    let walletStats = '';
    for (const [label, stats] of Object.entries(byWallet)) {
        walletStats += `• 👤 ${label}: ${stats.count} trades ($${stats.volume.toFixed(2)})\n`;
    }

    const sorted = [...dailyTrades].sort((a, b) => (b.usdcSize || 0) - (a.usdcSize || 0));
    let top3 = '';
    for (const t of sorted.slice(0, 3)) {
        const market = (t.title || t.question || t.market || 'Inconnu').slice(0, 35);
        const label = t.walletLabel || '?';
        top3 += `• $${(t.usdcSize || 0).toFixed(2)} - ${label} - ${market}...\n`;
    }

    // Copy-trading stats
    const todayCopies = copiedTrades.filter(c => {
        try { return new Date(c.time).toDateString() === new Date().toDateString(); } catch (e) { return false; }
    });
    const copyInfo = todayCopies.length > 0
        ? `\n🔄 *Copy-trades:* ${todayCopies.filter(c => c.success).length} réussis / ${todayCopies.length} tentés`
        : '';

    const message = `📊 *Résumé du jour*

📈 *Statistiques:*
• Nombre de trades: ${dailyTrades.length}
• Volume total: *$${totalVolume.toFixed(2)}*
• Taille moyenne: $${avgSize.toFixed(2)}
• Achats: ${buys} | Ventes: ${sells}

👥 *Par trader:*
${walletStats}
🏆 *Top 3 plus gros trades:*
${top3}${copyInfo}`;

    await sendTelegram(message);
}

// ============================================
// RECENT TRADES
// ============================================
async function showRecentTrades() {
    await sendTelegram('🔍 Récupération...');

    let allTrades = [];
    for (const w of wallets) {
        const trades = await fetchActivity(w.address);
        if (Array.isArray(trades)) {
            for (const t of trades) allTrades.push({ ...t, _walletLabel: w.label });
        }
    }

    if (allTrades.length === 0) {
        return await sendTelegram('❌ Aucun trade trouvé');
    }

    allTrades.sort((a, b) => {
        const tsA = a.timestamp || a.createdAt || a.created_at || 0;
        const tsB = b.timestamp || b.createdAt || b.created_at || 0;
        return (typeof tsB === 'number' ? tsB : new Date(tsB).getTime()) -
               (typeof tsA === 'number' ? tsA : new Date(tsA).getTime());
    });

    let msg = '📋 *5 derniers trades (tous wallets):*\n\n';
    for (const t of allTrades.slice(0, 5)) {
        const side = (t.side || t.type || t.action || 'trade').toLowerCase();
        const isBuy = side.includes('buy');
        const emoji = isBuy ? '🟢' : '🔴';
        const market = (t.title || t.question || t.market || 'Inconnu').slice(0, 35);
        const usdcSize = parseFloat(t.usdcSize || t.value || t.total || 0);
        let outcome = t.outcome || '';
        if (!outcome && t.outcomeIndex !== undefined) outcome = t.outcomeIndex === 0 ? 'Yes' : 'No';

        let timeStr = '';
        const ts = t.timestamp || t.createdAt || t.created_at;
        if (ts) {
            try {
                const date = new Date(typeof ts === 'number' && ts < 10000000000 ? ts * 1000 : ts);
                if (date.getFullYear() > 2020) timeStr = date.toLocaleString('fr-FR');
            } catch (e) {}
        }

        msg += `${emoji} 👤 *${t._walletLabel}* - *$${usdcSize.toFixed(2)}* - ${outcome || 'N/A'}\n`;
        msg += `   ${market}...\n`;
        msg += `   ${timeStr}\n\n`;
    }

    await sendTelegram(msg);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============================================
// START
// ============================================
init().catch(e => {
    console.error('❌', e);
    process.exit(1);
});
