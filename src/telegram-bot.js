const TelegramBot = require('node-telegram-bot-api');
const { CONFIG } = require('./config');
const log = require('./logger');

/**
 * Bot Telegram - Interface minimaliste: /start, /off, récap auto
 */
class TelegramController {
    constructor(tradingEngine, polyClient, llmAnalyzer) {
        this.engine = tradingEngine;
        this.poly = polyClient;
        this.llm = llmAnalyzer;
        this.bot = null;
        this.recapInterval = null;
    }

    async initialize() {
        this.bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
        this._setupCommands();
        this._scheduleDailyRecap();
        log.info('Telegram initialisé');

        await this.send(`🤖 *Polymarket Scalping Bot v8*

💰 ${CONFIG.DRY_RUN ? '🧪 DRY RUN' : '🔴 LIVE'}
📊 Buy @ bid → Sell @ bid+${CONFIG.SCALP_TICK * 100}c
📈 Marchés >= $${(CONFIG.MIN_MARKET_VOLUME / 1e6).toFixed(0)}M | spread <= ${CONFIG.MAX_SPREAD_CENTS}c
💳 Max 20% wallet | Cycle ${CONFIG.SCALP_INTERVAL / 1000}s

/start - Démarrer
/off - Arrêter`);
    }

    _auth(msg) {
        const authorized = msg.chat.id.toString() === CONFIG.TELEGRAM_CHAT_ID;
        if (!authorized) {
            log.warn(`Accès non autorisé: chat_id=${msg.chat.id} user=${msg.from?.username || 'unknown'}`);
        }
        return authorized;
    }

    _setupCommands() {
        this.bot.onText(/\/start$/, async (msg) => {
            if (!this._auth(msg)) return;
            const result = await this.engine.start();
            await this.send(`🟢 ${result}`);
        });

        this.bot.onText(/\/off/, async (msg) => {
            if (!this._auth(msg)) return;
            const result = this.engine.stop();
            const s = await this.engine.getStatus();
            await this.send(`🔴 ${result}

${this._formatRecap(s)}`);
        });
    }

    /**
     * Récap envoyé toutes les heures + à 21h (résumé journalier)
     */
    _scheduleDailyRecap() {
        this.recapInterval = setInterval(async () => {
            if (!this.engine.isRunning) return;
            const now = new Date();
            const isHourly = now.getMinutes() === 0;
            const isDailyRecap = now.getHours() === 21 && now.getMinutes() === 0;

            if (isDailyRecap) {
                const s = await this.engine.getStatus();
                await this.send(`📊 *Récap journalier*\n\n${this._formatRecap(s)}`);
            } else if (isHourly) {
                const s = await this.engine.getStatus();
                await this.send(this._formatRecap(s));
            }
        }, 60_000);
    }

    _formatRecap(s) {
        const bar = this._bar(parseFloat(s.dailyProgress));
        return `${bar} ${s.dailyProgress}%
💰 Volume: $${s.dailyVolume.toFixed(0)} / $${s.dailyTarget}
⚡ Scalps: ${s.dailyScalps} | Positions: ${s.activeScalps}
💳 Wallet: $${s.walletBalance.toFixed(2)} USDC
💵 Profit: $${s.dailyProfit.toFixed(4)}`;
    }

    _bar(pct) {
        const f = Math.round(pct / 5);
        return '▓'.repeat(Math.min(f, 20)) + '░'.repeat(20 - Math.min(f, 20));
    }

    async send(message) {
        try {
            await this.bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            });
        } catch (error) {
            log.error('Telegram:', error.message);
        }
    }
}

module.exports = TelegramController;
