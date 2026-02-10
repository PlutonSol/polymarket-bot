require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    TARGET_WALLET: '0x594edb9112f526fa6a80b8f858a6379c8a2c1c11',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8525426243:AAHfQdqz1jUD4algSX15z2SHvsziOG0rxxs',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '410866851',
    CHECK_INTERVAL: 10000, // 10 secondes (plus rapide)
    MIN_TRADE_USD: 10, // Ignorer trades < $10
};

let telegramBot;
let isRunning = false;
let knownTrades = new Set();
let dailyTrades = []; // Pour le résumé journalier
let lastDailyReset = new Date().toDateString();

// ============================================
// INIT
// ============================================
async function init() {
    console.log('🚀 Bot Polymarket v5\n');
    
    telegramBot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
    setupTelegramCommands();
    
    // Programmer le résumé journalier à 21h
    scheduleDailySummary();
    
    await sendTelegram(`🤖 *Bot Polymarket v5*

✨ *Nouveautés:*
• Détection ACHAT/VENTE 🟢🔴
• Position Yes/No affichée
• Lien direct vers le marché
• Vérification toutes les 10s
• Filtre: trades > $${CONFIG.MIN_TRADE_USD}
• Résumé journalier à 21h

📋 *Commandes:*
/start\\_watch - Démarrer
/stop\\_watch - Arrêter
/recent - 5 derniers trades
/summary - Résumé du jour
/setmin X - Changer minimum ($)`);
    
    return true;
}

// ============================================
// TELEGRAM COMMANDS
// ============================================
function setupTelegramCommands() {
    telegramBot.onText(/\/start_watch/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        if (isRunning) return await sendTelegram('⚠️ Déjà actif');
        isRunning = true;
        await sendTelegram('🟢 *Surveillance activée!*\nVérification toutes les 10s\nMinimum: $' + CONFIG.MIN_TRADE_USD);
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
    
    telegramBot.onText(/\/setmin (.+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        const value = parseFloat(match[1]);
        if (isNaN(value) || value < 0) {
            return await sendTelegram('❌ Valeur invalide. Exemple: /setmin 20');
        }
        CONFIG.MIN_TRADE_USD = value;
        await sendTelegram(`✅ Minimum changé à *$${value}*\nLes trades < $${value} seront ignorés.`);
    });
    
    telegramBot.onText(/\/status/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        await sendTelegram(`📊 *Status*
• État: ${isRunning ? '🟢 Actif' : '🔴 Arrêté'}
• Trades connus: ${knownTrades.size}
• Trades aujourd'hui: ${dailyTrades.length}
• Minimum: $${CONFIG.MIN_TRADE_USD}
• Intervalle: ${CONFIG.CHECK_INTERVAL/1000}s`);
    });
}

async function sendTelegram(message, options = {}) {
    try {
        await telegramBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: false,
            ...options
        });
    } catch (error) {
        console.error('Telegram error:', error.message);
    }
}

// ============================================
// API
// ============================================
async function fetchActivity() {
    try {
        const res = await fetch(
            `https://data-api.polymarket.com/activity?user=${CONFIG.TARGET_WALLET.toLowerCase()}&limit=30`
        );
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.error('API error:', e.message);
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
    
    // Charger trades existants
    const initial = await fetchActivity();
    if (Array.isArray(initial)) {
        for (const t of initial) {
            knownTrades.add(getTradeId(t));
        }
    }
    console.log(`📊 ${knownTrades.size} trades chargés\n`);
    
    while (isRunning) {
        try {
            // Reset daily trades si nouveau jour
            const today = new Date().toDateString();
            if (today !== lastDailyReset) {
                dailyTrades = [];
                lastDailyReset = today;
            }
            
            await checkNewTrades();
        } catch (e) {
            console.error('Error:', e.message);
        }
        await sleep(CONFIG.CHECK_INTERVAL);
    }
}

function getTradeId(t) {
    return `${t.id || ''}-${t.transactionHash || t.transaction_hash || ''}-${t.timestamp || t.createdAt || ''}-${t.conditionId || t.asset_id || ''}`;
}

async function checkNewTrades() {
    const trades = await fetchActivity();
    if (!Array.isArray(trades)) return;
    
    for (const t of trades) {
        const id = getTradeId(t);
        if (knownTrades.has(id)) continue;
        
        knownTrades.add(id);
        
        // Calculer le montant
        const price = parseFloat(t.price || t.avgPrice || t.avg_price || 0);
        const size = parseFloat(t.size || t.amount || t.shares || 0);
        const usdcSize = parseFloat(t.usdcSize || t.value || t.total || (price * size) || 0);
        
        // Filtrer par montant minimum
        if (usdcSize < CONFIG.MIN_TRADE_USD) {
            console.log(`⏭️ Trade ignoré (< $${CONFIG.MIN_TRADE_USD}): $${usdcSize.toFixed(2)}`);
            continue;
        }
        
        // Ajouter aux trades du jour
        dailyTrades.push({ ...t, usdcSize });
        
        // Envoyer notification
        await notifyTrade(t);
    }
}

async function notifyTrade(t) {
    // Déterminer ACHAT ou VENTE
    const side = (t.side || t.type || t.action || '').toLowerCase();
    let isBuy = side.includes('buy') || side.includes('bid');
    
    // Si pas de side explicite, regarder d'autres indices
    if (!side) {
        // Parfois "maker" = vente, "taker" = achat
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
    
    // Prix en cents
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
        // Essayer de récupérer le slug via l'API
        const marketInfo = await fetchMarketInfo(conditionId);
        if (marketInfo && marketInfo.slug) {
            marketLink = `https://polymarket.com/event/${marketInfo.slug}`;
        }
    }
    
    const message = `🔔 *NOUVEAU TRADE!*

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
    
    console.log(`📈 ${emoji} - $${usdcSize.toFixed(2)} - ${market.slice(0, 40)}`);
    await sendTelegram(message);
}

// ============================================
// DAILY SUMMARY
// ============================================
function scheduleDailySummary() {
    // Vérifier toutes les minutes si c'est l'heure du résumé (21h00)
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
    
    // Calculer les stats
    const totalVolume = dailyTrades.reduce((sum, t) => sum + (t.usdcSize || 0), 0);
    const avgSize = totalVolume / dailyTrades.length;
    
    // Compter achats/ventes
    let buys = 0, sells = 0;
    for (const t of dailyTrades) {
        const side = (t.side || t.type || t.action || '').toLowerCase();
        if (side.includes('buy')) buys++;
        else sells++;
    }
    
    // Top 3 plus gros trades
    const sorted = [...dailyTrades].sort((a, b) => (b.usdcSize || 0) - (a.usdcSize || 0));
    let top3 = '';
    for (const t of sorted.slice(0, 3)) {
        const market = (t.title || t.question || t.market || 'Inconnu').slice(0, 35);
        top3 += `• $${(t.usdcSize || 0).toFixed(2)} - ${market}...\n`;
    }
    
    const message = `📊 *Résumé du jour*

📈 *Statistiques:*
• Nombre de trades: ${dailyTrades.length}
• Volume total: *$${totalVolume.toFixed(2)}*
• Taille moyenne: $${avgSize.toFixed(2)}
• Achats: ${buys} | Ventes: ${sells}

🏆 *Top 3 plus gros trades:*
${top3}`;
    
    await sendTelegram(message);
}

// ============================================
// RECENT TRADES
// ============================================
async function showRecentTrades() {
    await sendTelegram('🔍 Récupération...');
    
    const trades = await fetchActivity();
    if (!Array.isArray(trades) || trades.length === 0) {
        return await sendTelegram('❌ Aucun trade trouvé');
    }
    
    let msg = '📋 *5 derniers trades:*\n\n';
    
    for (const t of trades.slice(0, 5)) {
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
        
        msg += `${emoji} *$${usdcSize.toFixed(2)}* - ${outcome || 'N/A'}\n`;
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
