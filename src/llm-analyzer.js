const { CONFIG } = require('./config');
const log = require('./logger');

/**
 * Moteur d'analyse LLM - Analyse les marchés et génère des signaux de trading
 */
class LLMAnalyzer {
    constructor() {
        this.provider = CONFIG.LLM_PROVIDER;
        this.conversationHistory = [];
    }

    /**
     * Appel API LLM (supporte OpenAI et Anthropic)
     */
    async callLLM(systemPrompt, userPrompt, { temperature = 0.3, maxTokens = 2000 } = {}) {
        try {
            if (this.provider === 'anthropic') {
                return await this._callAnthropic(systemPrompt, userPrompt, temperature, maxTokens);
            }
            return await this._callOpenAI(systemPrompt, userPrompt, temperature, maxTokens);
        } catch (error) {
            log.error('Erreur LLM:', error.message);
            return null;
        }
    }

    async _callOpenAI(systemPrompt, userPrompt, temperature, maxTokens) {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: CONFIG.LLM_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature,
                max_tokens: maxTokens,
                response_format: { type: 'json_object' },
            }),
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`OpenAI API ${res.status}: ${errText}`);
        }

        const data = await res.json();
        const content = data.choices[0]?.message?.content;
        log.llm(`Tokens utilisés: ${data.usage?.total_tokens || 'N/A'}`);
        return JSON.parse(content);
    }

    async _callAnthropic(systemPrompt, userPrompt, temperature, maxTokens) {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CONFIG.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: CONFIG.LLM_MODEL,
                max_tokens: maxTokens,
                temperature,
                system: systemPrompt,
                messages: [
                    { role: 'user', content: userPrompt },
                ],
            }),
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Anthropic API ${res.status}: ${errText}`);
        }

        const data = await res.json();
        const content = data.content[0]?.text;
        log.llm(`Tokens utilisés: ${data.usage?.input_tokens + data.usage?.output_tokens || 'N/A'}`);

        // Extraire le JSON de la réponse
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('Pas de JSON dans la réponse Anthropic');
        return JSON.parse(jsonMatch[0]);
    }

    /**
     * Analyse un ensemble de marchés et génère des recommandations de trading
     */
    async analyzeMarkets(enrichedMarkets) {
        const systemPrompt = `Tu es un trader algorithmique expert sur les marchés de prédiction Polymarket.
Ton objectif est de générer du volume de trading en identifiant des opportunités rentables.

RÈGLES:
1. Analyse les marchés par leur liquidité, spread, volume et probabilité
2. Privilégie les marchés à fort volume et faible spread pour le volume
3. Identifie les marchés où le prix semble mal calibré
4. Pour générer du volume, fais des allers-retours (buy puis sell) sur les marchés liquides
5. Ne recommande JAMAIS de trade sur un marché avec spread > ${CONFIG.MAX_SPREAD}%
6. Taille des trades entre $${CONFIG.MIN_TRADE_SIZE} et $${CONFIG.MAX_TRADE_SIZE}
7. Diversifie les trades sur plusieurs marchés

Réponds UNIQUEMENT en JSON avec ce format:
{
  "analysis": "Résumé de ton analyse en 2-3 phrases",
  "trades": [
    {
      "marketId": "condition_id du marché",
      "marketTitle": "titre du marché",
      "tokenId": "token ID à trader",
      "side": "buy" ou "sell",
      "outcome": "Yes" ou "No",
      "price": 0.55,
      "size": 20,
      "confidence": 0.8,
      "reason": "raison courte du trade"
    }
  ],
  "marketInsights": [
    {
      "market": "titre",
      "insight": "observation notable"
    }
  ]
}`;

        const marketsData = enrichedMarkets.map(m => ({
            title: m.question || m.title,
            conditionId: m.conditionId || m.condition_id,
            yesTokenId: m.yesTokenId,
            noTokenId: m.noTokenId,
            yesMid: m.yesMid,
            noMid: m.noMid,
            bestBid: m.bestBid,
            bestAsk: m.bestAsk,
            spread: m.spread ? m.spread.toFixed(2) + '%' : 'N/A',
            volume24h: `$${m.volume24h?.toFixed(0) || 0}`,
            liquidity: `$${m.liquidity?.toFixed(0) || 0}`,
            endDate: m.endDate || m.end_date_iso,
        }));

        const userPrompt = `Voici ${marketsData.length} marchés actifs sur Polymarket.
Volume journalier cible: $${CONFIG.DAILY_VOLUME_TARGET}
Taille max par trade: $${CONFIG.MAX_TRADE_SIZE}
Spread max: ${CONFIG.MAX_SPREAD}%

MARCHÉS:
${JSON.stringify(marketsData, null, 2)}

Analyse ces marchés et propose des trades pour générer du volume. Propose entre 3 et 8 trades.`;

        log.llm('Analyse de', enrichedMarkets.length, 'marchés...');
        const result = await this.callLLM(systemPrompt, userPrompt);

        if (!result || !result.trades) {
            log.error('Réponse LLM invalide');
            return { analysis: 'Erreur analyse', trades: [], marketInsights: [] };
        }

        log.llm('Analyse terminée:', result.trades.length, 'trades proposés');
        return result;
    }

    /**
     * Évalue si un trade spécifique est bon à exécuter
     */
    async evaluateTrade(market, currentPrice, proposedSide, proposedSize) {
        const systemPrompt = `Tu es un risk manager pour un bot de trading sur Polymarket.
Évalue si ce trade est raisonnable. Réponds en JSON:
{
  "approved": true/false,
  "adjustedPrice": prix ajusté si nécessaire,
  "adjustedSize": taille ajustée si nécessaire,
  "reason": "raison de la décision"
}`;

        const userPrompt = `Trade proposé:
- Marché: ${market.question || market.title}
- Side: ${proposedSide}
- Prix actuel: ${currentPrice}
- Taille proposée: $${proposedSize}
- Spread: ${market.spread?.toFixed(2) || 'N/A'}%
- Volume 24h: $${market.volume24h?.toFixed(0) || 0}
- Liquidité: $${market.liquidity?.toFixed(0) || 0}

Approuves-tu ce trade?`;

        return await this.callLLM(systemPrompt, userPrompt, { temperature: 0.1 });
    }

    /**
     * Génère une stratégie de volume (allers-retours)
     */
    async generateVolumeStrategy(enrichedMarkets, currentVolume, targetVolume) {
        const remaining = targetVolume - currentVolume;
        if (remaining <= 0) return { trades: [], message: 'Volume cible atteint' };

        const systemPrompt = `Tu es un expert en génération de volume sur Polymarket.
Ton objectif est de faire des allers-retours (round-trips) pour générer du volume efficacement.

Stratégie de volume:
1. ROUND-TRIP: Acheter YES puis vendre YES (ou inversement) sur le même marché
2. MARKET-MAKING: Placer des ordres des deux côtés du spread
3. SPREAD-CAPTURE: Profiter du spread bid/ask

Réponds en JSON:
{
  "strategy": "nom de la stratégie",
  "description": "description courte",
  "trades": [
    {
      "marketId": "id",
      "marketTitle": "titre",
      "tokenId": "token",
      "side": "buy/sell",
      "outcome": "Yes/No",
      "price": 0.50,
      "size": 25,
      "type": "entry/exit",
      "pairIndex": 0,
      "reason": "raison"
    }
  ]
}

Les trades avec le même pairIndex forment un aller-retour.`;

        const marketsData = enrichedMarkets
            .filter(m => m.spread !== null && m.spread < CONFIG.MAX_SPREAD && m.liquidity > 100)
            .slice(0, 15)
            .map(m => ({
                title: m.question || m.title,
                conditionId: m.conditionId || m.condition_id,
                yesTokenId: m.yesTokenId,
                noTokenId: m.noTokenId,
                yesMid: m.yesMid,
                bestBid: m.bestBid,
                bestAsk: m.bestAsk,
                spread: m.spread?.toFixed(2) + '%',
                volume24h: `$${m.volume24h?.toFixed(0) || 0}`,
                liquidity: `$${m.liquidity?.toFixed(0) || 0}`,
            }));

        const userPrompt = `Volume restant à générer: $${remaining.toFixed(0)}
Taille max par trade: $${CONFIG.MAX_TRADE_SIZE}
Volume déjà fait aujourd'hui: $${currentVolume.toFixed(0)}

MARCHÉS LIQUIDES:
${JSON.stringify(marketsData, null, 2)}

Propose des allers-retours pour générer $${Math.min(remaining, CONFIG.MAX_TRADE_SIZE * 6).toFixed(0)} de volume.`;

        return await this.callLLM(systemPrompt, userPrompt);
    }
}

module.exports = LLMAnalyzer;
