require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8525426243:AAHfQdqz1jUD4algSX15z2SHvsziOG0rxxs',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '410866851',
    CHECK_INTERVAL: 10000, // 10 secondes
    MIN_TRADE_USD: 10,
    WALLETS_FILE: path.join(__dirname, 'wallets.json'),
};

let telegramBot;
let isRunning = false;
let knownTrades = new Map(); // wallet -> Set of trade IDs
let dailyTrades = [];
let lastDailyReset = new Date().toDateString();

// ============================================
// WALLET MANAGEMENT (persistent)
// ============================================
// wallets = [{ address: '0x...', label: 'Nom du trader' }]
let wallets = [];

function loadWallets() {
    try {
        if (fs.existsSync(CONFIG.WALLETS_FILE)) {
            const data = fs.readFileSync(CONFIG.WALLETS_FILE, 'utf-8');
            wallets = JSON.parse(data);
            console.log(`📂 ${wallets.length} wallet(s) chargé(s) depuis wallets.json`);
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

function addWallet(address, label) {
    const addr = address.toLowerCase().trim();
    if (wallets.find(w => w.address === addr)) {
        return false; // already exists
    }
    wallets.push({ address: addr, label: label || addr.slice(0, 8) + '...' });
    knownTrades.set(addr, new Set());
    saveWallets();
    return true;
}

function removeWallet(addressOrIndex) {
    const input = addressOrIndex.trim();
    let removed = null;

    // Try as index (1-based)
    const idx = parseInt(input, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= wallets.length) {
        removed = wallets.splice(idx - 1, 1)[0];
    } else {
        // Try as address
        const addr = input.toLowerCase();
        const i = wallets.findIndex(w => w.address === addr);
        if (i !== -1) {
            removed = wallets.splice(i, 1)[0];
        }
    }

    if (removed) {
        knownTrades.delete(removed.address);
        saveWallets();
    }
    return removed;
}

// ============================================
// INIT
// ============================================
async function init() {
    console.log('🚀 Bot Polymarket Multi-Wallet\n');

    loadWallets();

    telegramBot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
    setupTelegramCommands();

    scheduleDailySummary();

    await sendTelegram(`🤖 *Bot Polymarket Multi-Wallet*

✨ *Fonctionnalités:*
• Surveillance de *plusieurs wallets*
• Ajout/suppression via Telegram
• Détection ACHAT/VENTE 🟢🔴
• Position Yes/No affichée
• Lien direct vers le marché
• Vérification toutes les 10s
• Résumé journalier à 21h

📋 *Commandes:*
/add \\<adresse\\> \\<nom\\> - Ajouter un wallet
/remove \\<n° ou adresse\\> - Supprimer
/wallets - Liste des wallets suivis
/start\\_watch - Démarrer surveillance
/stop\\_watch - Arrêter
/recent - 5 derniers trades (tous wallets)
/summary - Résumé du jour
/setmin X - Changer minimum ($)
/status - État du bot

📂 *Wallets suivis:* ${wallets.length}`);

    return true;
}

// ============================================
// TELEGRAM COMMANDS
// ============================================
function setupTelegramCommands() {
    // --- ADD WALLET ---
    telegramBot.onText(/\/add(?:@\S+)?\s+(\S+)\s*(.*)?/, async (msg, match) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        const address = match[1];
        const label = (match[2] || '').trim();

        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
            return await sendTelegram('❌ Adresse invalide. Format attendu: `0x` suivi de 40 caractères hex.');
        }

        if (addWallet(address, label)) {
            const displayLabel = label || address.slice(0, 8) + '...';
            await sendTelegram(`✅ Wallet ajouté!\n\n👤 *${displayLabel}*\n\`${address.toLowerCase()}\`\n\n📂 Total: ${wallets.length} wallet(s)`);
        } else {
            await sendTelegram('⚠️ Ce wallet est déjà dans la liste.');
        }
    });

    // --- REMOVE WALLET ---
    telegramBot.onText(/\/remove(?:@\S+)?\s+(.+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        const removed = removeWallet(match[1]);
        if (removed) {
            await sendTelegram(`🗑️ Wallet supprimé:\n👤 *${removed.label}*\n\`${removed.address}\`\n\n📂 Restant: ${wallets.length} wallet(s)`);
        } else {
            await sendTelegram('❌ Wallet non trouvé. Utilisez /wallets pour voir la liste.');
        }
    });

    // --- LIST WALLETS ---
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

    // --- START WATCH ---
    telegramBot.onText(/\/start_watch/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        if (isRunning) return await sendTelegram('⚠️ Déjà actif');
        if (wallets.length === 0) {
            return await sendTelegram('❌ Aucun wallet à surveiller.\nAjoutez-en d\'abord avec /add');
        }
        isRunning = true;
        await sendTelegram(`🟢 *Surveillance activée!*\n${wallets.length} wallet(s) surveillé(s)\nVérification toutes les ${CONFIG.CHECK_INTERVAL / 1000}s\nMinimum: $${CONFIG.MIN_TRADE_USD}`);
        startWatching();
    });

    // --- STOP WATCH ---
    telegramBot.onText(/\/stop_watch/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        isRunning = false;
        await sendTelegram('🔴 *Surveillance arrêtée*');
    });

    // --- RECENT ---
    telegramBot.onText(/\/recent/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        await showRecentTrades();
    });

    // --- SUMMARY ---
    telegramBot.onText(/\/summary/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        await sendDailySummary();
    });

    // --- SETMIN ---
    telegramBot.onText(/\/setmin(?:@\S+)?\s+(.+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        const value = parseFloat(match[1]);
        if (isNaN(value) || value < 0) {
            return await sendTelegram('❌ Valeur invalide. Exemple: /setmin 20');
        }
        CONFIG.MIN_TRADE_USD = value;
        await sendTelegram(`✅ Minimum changé à *$${value}*\nLes trades < $${value} seront ignorés.`);
    });

    // --- STATUS ---
    telegramBot.onText(/\/status/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        await sendTelegram(`📊 *Status*
• État: ${isRunning ? '🟢 Actif' : '🔴 Arrêté'}
• Wallets suivis: ${wallets.length}
• Trades connus: ${[...knownTrades.values()].reduce((s, set) => s + set.size, 0)}
• Trades aujourd'hui: ${dailyTrades.length}
• Minimum: $${CONFIG.MIN_TRADE_USD}
• Intervalle: ${CONFIG.CHECK_INTERVAL / 1000}s`);
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
        if (res.ok) {
            return await res.json();
        }
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
            if (Array.isArray(data) && data.length > 0) {
                return data[0];
            }
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

    // Charger trades existants pour chaque wallet
    for (const w of wallets) {
        if (!knownTrades.has(w.address)) {
            knownTrades.set(w.address, new Set());
        }
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
            // Reset daily trades si nouveau jour
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

    if (!knownTrades.has(wallet.address)) {
        knownTrades.set(wallet.address, new Set());
    }
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

        await notifyTrade(t, wallet);
    }
}

async function notifyTrade(t, wallet) {
    // Déterminer ACHAT ou VENTE
    const side = (t.side || t.type || t.action || '').toLowerCase();
    let isBuy = side.includes('buy') || side.includes('bid');

    if (!side) {
        const makerTaker = (t.maker || t.taker || '').toLowerCase();
        if (makerTaker) {
            isBuy = makerTaker.includes('taker');
        }
    }

    const emoji = isBuy ? '🟢 ACHAT' : '🔴 VENTE';

    // Marché
    let market = t.title || t.question || t.market || t.description || 'Marché inconnu';
    if (market.length > 80) market = market.slice(0, 80) + '...';

    // Position (Yes/No)
    let outcome = t.outcome || '';
    if (!outcome && t.outcomeIndex !== undefined) {
        outcome = t.outcomeIndex === 0 ? 'Yes ✅' : 'No ❌';
    }
    if (!outcome && t.outcome_index !== undefined) {
        outcome = t.outcome_index === 0 ? 'Yes ✅' : 'No ❌';
    }
    if (outcome.toLowerCase() === 'yes') outcome = 'Yes ✅';
    if (outcome.toLowerCase() === 'no') outcome = 'No ❌';
    if (!outcome) outcome = 'N/A';

    // Valeurs
    const price = parseFloat(t.price || t.avgPrice || t.avg_price || 0);
    const size = parseFloat(t.size || t.amount || t.shares || 0);
    const usdcSize = parseFloat(t.usdcSize || t.value || t.total || (price * size) || 0);
    const priceInCents = Math.round(price * 100);

    // Timestamp
    let timeStr = 'N/A';
    const ts = t.timestamp || t.createdAt || t.created_at || t.time;
    if (ts) {
        try {
            const date = new Date(typeof ts === 'number' && ts < 10000000000 ? ts * 1000 : ts);
            if (date.getFullYear() > 2020) {
                timeStr = date.toLocaleString('fr-FR');
            }
        } catch (e) {}
    }

    // Lien vers le marché
    let marketLink = '';
    const slug = t.slug || t.marketSlug || t.market_slug;
    const conditionId = t.conditionId || t.condition_id;

    if (slug) {
        marketLink = `https://polymarket.com/event/${slug}`;
    } else if (conditionId) {
        const marketInfo = await fetchMarketInfo(conditionId);
        if (marketInfo && marketInfo.slug) {
            marketLink = `https://polymarket.com/event/${marketInfo.slug}`;
        }
    }

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
${marketLink ? `\n🔗 [Voir le marché](${marketLink})` : ''}`;

    console.log(`📈 [${wallet.label}] ${emoji} - $${usdcSize.toFixed(2)} - ${market.slice(0, 40)}`);
    await sendTelegram(message);
}

// ============================================
// DAILY SUMMARY
// ============================================
function scheduleDailySummary() {
    setInterval(async () => {
        const now = new Date();
        if (now.getHours() === 21 && now.getMinutes() === 0) {
            await sendDailySummary();
        }
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

    // Stats par wallet
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

    // Top 3
    const sorted = [...dailyTrades].sort((a, b) => (b.usdcSize || 0) - (a.usdcSize || 0));
    let top3 = '';
    for (const t of sorted.slice(0, 3)) {
        const market = (t.title || t.question || t.market || 'Inconnu').slice(0, 35);
        const label = t.walletLabel || '?';
        top3 += `• $${(t.usdcSize || 0).toFixed(2)} - ${label} - ${market}...\n`;
    }

    const message = `📊 *Résumé du jour*

📈 *Statistiques:*
• Nombre de trades: ${dailyTrades.length}
• Volume total: *$${totalVolume.toFixed(2)}*
• Taille moyenne: $${avgSize.toFixed(2)}
• Achats: ${buys} | Ventes: ${sells}

👥 *Par trader:*
${walletStats}
🏆 *Top 3 plus gros trades:*
${top3}`;

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
            for (const t of trades) {
                allTrades.push({ ...t, _walletLabel: w.label });
            }
        }
    }

    if (allTrades.length === 0) {
        return await sendTelegram('❌ Aucun trade trouvé');
    }

    // Trier par timestamp décroissant
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
        if (!outcome && t.outcomeIndex !== undefined) {
            outcome = t.outcomeIndex === 0 ? 'Yes' : 'No';
        }

        let timeStr = '';
        const ts = t.timestamp || t.createdAt || t.created_at;
        if (ts) {
            try {
                const date = new Date(typeof ts === 'number' && ts < 10000000000 ? ts * 1000 : ts);
                if (date.getFullYear() > 2020) {
                    timeStr = date.toLocaleString('fr-FR');
                }
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
