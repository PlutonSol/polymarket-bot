const TelegramBot = require('node-telegram-bot-api');
const { CONFIG } = require('./config');
const log = require('./logger');

/**
 * Bot Telegram - /market pour définir le marché, /start et /off pour contrôler
 */
class TelegramController {
    constructor(tradingEngine, polyClient) {
        this.engine = tradingEngine;
        this.poly = polyClient;
        this.bot = null;
        this.recapInterval = null;
    }

    async initialize() {
        this.bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, {
            polling: {
                autoStart: true,
                params: { timeout: 30 },
            },
        });

        this._pollingErrors = 0;
        this.bot.on('polling_error', (error) => {
            this._pollingErrors++;
            if (this._pollingErrors <= 3 || this._pollingErrors % 100 === 0) {
                log.error(`Telegram polling error (${this._pollingErrors}x): ${error.message}`);
            }
        });

        this._setupCommands();
        this._scheduleDailyRecap();
        log.info('Telegram initialisé');

        await this.send(`*Polymarket Scalping Bot v9*

${CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE'}
Buy @ bid -> Sell @ bid+${CONFIG.SCALP_TICK * 100}c
Spread max: ${CONFIG.MAX_SPREAD_CENTS}c | Cycle ${CONFIG.SCALP_INTERVAL / 1000}s

/market <slug> - Definir le marche cible
/start - Demarrer le scalping
/off - Arreter`);
    }

    _auth(msg) {
        const chatOk = msg.chat.id.toString() === CONFIG.TELEGRAM_CHAT_ID;
        const userOk = !CONFIG.TELEGRAM_USER_ID || msg.from?.id?.toString() === CONFIG.TELEGRAM_USER_ID;
        const authorized = chatOk && userOk;
        if (!authorized) {
            log.warn(`Acces non autorise: chat_id=${msg.chat.id} user_id=${msg.from?.id} username=${msg.from?.username || 'unknown'}`);
        }
        return authorized;
    }

    _setupCommands() {
        // /market <slug ou texte de recherche>
        this.bot.onText(/\/market(?:\s+(.+))?/, async (msg, match) => {
            if (!this._auth(msg)) return;

            const query = match[1]?.trim();
            if (!query) {
                const current = this.engine.targetMarket;
                if (current) {
                    await this.send(`Marche actuel: ${current.question}\n\nUsage: /market <slug ou recherche>`);
                } else {
                    await this.send('Aucun marche defini.\n\nUsage: /market <slug ou recherche>');
                }
                return;
            }

            await this.send(`Recherche: "${query}"...`);

            const market = await this.poly.getMarketByQuery(query);
            if (!market) {
                await this.send(`Aucun marche trouve pour: "${query}"`);
                return;
            }

            const result = await this.engine.setTargetMarket(market);
            const enriched = this.engine.targetMarket;

            let info = `${result}\n`;
            if (enriched) {
                if (enriched.yesBook) {
                    info += `\nYES: bid=${enriched.yesBook.bestBid} ask=${enriched.yesBook.bestAsk} spread=${enriched.yesBook.spreadCents}c depth=$${enriched.yesBook.bidDepthUsd?.toFixed(0)}`;
                }
                if (enriched.noBook) {
                    info += `\nNO: bid=${enriched.noBook.bestBid} ask=${enriched.noBook.bestAsk} spread=${enriched.noBook.spreadCents}c depth=$${enriched.noBook.bidDepthUsd?.toFixed(0)}`;
                }
            }

            await this.send(info);
        });

        this.bot.onText(/\/start$/, async (msg) => {
            if (!this._auth(msg)) return;
            const result = await this.engine.start();
            await this.send(result);
        });

        this.bot.onText(/\/off/, async (msg) => {
            if (!this._auth(msg)) return;
            const result = this.engine.stop();
            const s = await this.engine.getStatus();
            await this.send(`${result}\n\n${this._formatRecap(s)}`);
        });
    }

    _scheduleDailyRecap() {
        this.recapInterval = setInterval(async () => {
            if (!this.engine.isRunning) return;
            const now = new Date();
            const isHourly = now.getMinutes() === 0;
            const isDailyRecap = now.getHours() === 21 && now.getMinutes() === 0;

            if (isDailyRecap) {
                const s = await this.engine.getStatus();
                await this.send(`*Recap journalier*\n\n${this._formatRecap(s)}`);
            } else if (isHourly) {
                const s = await this.engine.getStatus();
                await this.send(this._formatRecap(s));
            }
        }, 60_000);
    }

    _formatRecap(s) {
        const bar = this._bar(parseFloat(s.dailyProgress));
        return `${bar} ${s.dailyProgress}%
Marche: ${s.targetMarket}
Volume: $${s.dailyVolume.toFixed(0)} / $${s.dailyTarget}
Scalps: ${s.dailyScalps} | Positions: ${s.activeScalps}
Wallet: $${s.walletBalance.toFixed(2)} USDC
Profit: $${s.dailyProfit.toFixed(4)}`;
    }

    _bar(pct) {
        const f = Math.round(pct / 5);
        return '|'.repeat(Math.min(f, 20)) + '.'.repeat(20 - Math.min(f, 20));
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
