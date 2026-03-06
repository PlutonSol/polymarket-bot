const { CONFIG } = require('./config');
const log = require('./logger');

// Rate limiter pour les appels LLM (max 3/min pour éviter les coûts explosifs)
let llmCallTimestamps = [];
const LLM_MAX_CALLS_PER_MIN = 10;

async function llmRateLimit() {
    const now = Date.now();
    llmCallTimestamps = llmCallTimestamps.filter(t => now - t < 60000);
    if (llmCallTimestamps.length >= LLM_MAX_CALLS_PER_MIN) {
        const waitTime = llmCallTimestamps[0] + 60000 - now;
        log.warn(`LLM rate limit: attente ${(waitTime / 1000).toFixed(1)}s`);
        await new Promise(r => setTimeout(r, waitTime));
    }
    llmCallTimestamps.push(Date.now());
}

/**
 * LLM Analyzer - Sélectionne les meilleurs marchés pour le scalping
 * et optimise les paramètres (prix d'entrée, taille, token Yes/No)
 */
class LLMAnalyzer {
    constructor() {
        this.provider = CONFIG.LLM_PROVIDER;
    }

    async callLLM(systemPrompt, userPrompt, { temperature = 0.2, maxTokens = 2000 } = {}) {
        try {
            await llmRateLimit();
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
            throw new Error(`OpenAI API error ${res.status}`);
        }

        const data = await res.json();
        log.llm(`Tokens: ${data.usage?.total_tokens || '?'}`);
        return JSON.parse(data.choices[0]?.message?.content);
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
                messages: [{ role: 'user', content: userPrompt }],
            }),
        });

        if (!res.ok) {
            throw new Error(`Anthropic API error ${res.status}`);
        }

        const data = await res.json();
        log.llm(`Tokens: ${(data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)}`);
        const content = data.content[0]?.text;
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('Pas de JSON dans la réponse');
        return JSON.parse(jsonMatch[0]);
    }

    /**
     * Sélectionne les meilleurs marchés pour scalper parmi ceux enrichis.
     * Le LLM analyse les orderbooks et décide où scalper et avec quel token (Yes/No).
     */
    async selectScalpTargets(enrichedMarkets) {
        const systemPrompt = `Tu es un algorithme de scalping sur les marchés de prédiction Polymarket.

STRATÉGIE: Acheter au best bid et revendre immédiatement ${CONFIG.SCALP_TICK * 100} cent(s) plus cher.
On cible les marchés ULTRA-LIQUIDES avec un spread très serré (<= ${CONFIG.MAX_SPREAD_CENTS}c).

CRITÈRES DE SÉLECTION (par ordre de priorité):
1. SPREAD <= ${CONFIG.MAX_SPREAD_CENTS} cent(s): On veut des marchés très liquides avec spread serré
2. LIQUIDITÉ: La profondeur du book doit être >= $${CONFIG.MIN_BOOK_DEPTH_USD} des deux côtés
3. VOLUME 24H élevé: Plus de volume = plus de chances d'être fill rapidement
4. Choisir le token (Yes ou No) qui a le MEILLEUR orderbook pour scalper
5. Ne JAMAIS recommander un marché avec spread > ${CONFIG.MAX_SPREAD_CENTS} cent(s)
6. Privilégier les marchés où le bestBidSize est élevé (plus de liquidité au bid)

Pour chaque marché, choisis le meilleur token à scalper (Yes ou No) selon:
- Quel token a le spread le plus serré (mais > 0)
- Quel token a la meilleure profondeur de liquidité
- Le prix d'entrée optimal (au best bid)

Réponds UNIQUEMENT en JSON:
{
  "targets": [
    {
      "conditionId": "id du marché",
      "market": "titre court du marché",
      "token": "yes" ou "no",
      "tokenId": "l'ID du token choisi",
      "buyPrice": 0.52,
      "sellPrice": 0.53,
      "sizeUsd": 50,
      "score": 95,
      "reason": "raison courte"
    }
  ],
  "skipped": ["raison marché X skip", "raison marché Y skip"]
}

Classe les targets par score décroissant. Max 5 targets.`;

        const marketsData = enrichedMarkets.map(m => ({
            conditionId: m.conditionId,
            title: m.question,
            totalVolume: `$${(m.totalVolume / 1e6).toFixed(1)}M`,
            volume24h: `$${(m.volume24h / 1e3).toFixed(0)}K`,
            yesTokenId: m.yesTokenId,
            noTokenId: m.noTokenId,
            yesBook: m.yesBook ? {
                bestBid: m.yesBook.bestBid,
                bestAsk: m.yesBook.bestAsk,
                spreadCents: m.yesBook.spreadCents,
                bestBidSize: m.yesBook.bestBidSize?.toFixed(0),
                bestAskSize: m.yesBook.bestAskSize?.toFixed(0),
                bidDepthUsd: `$${m.yesBook.bidDepthUsd?.toFixed(0)}`,
                askDepthUsd: `$${m.yesBook.askDepthUsd?.toFixed(0)}`,
            } : null,
            noBook: m.noBook ? {
                bestBid: m.noBook.bestBid,
                bestAsk: m.noBook.bestAsk,
                spreadCents: m.noBook.spreadCents,
                bestBidSize: m.noBook.bestBidSize?.toFixed(0),
                bestAskSize: m.noBook.bestAskSize?.toFixed(0),
                bidDepthUsd: `$${m.noBook.bidDepthUsd?.toFixed(0)}`,
                askDepthUsd: `$${m.noBook.askDepthUsd?.toFixed(0)}`,
            } : null,
        }));

        const userPrompt = `Voici ${marketsData.length} marchés avec volume >= $1M.
Taille de scalp: $${CONFIG.TRADE_SIZE_USD}
Tick: +${CONFIG.SCALP_TICK * 100} cent(s)
Spread max: ${CONFIG.MAX_SPREAD_CENTS} cents
Profondeur min: $${CONFIG.MIN_BOOK_DEPTH_USD}

MARCHÉS ET ORDERBOOKS:
${JSON.stringify(marketsData, null, 2)}

Sélectionne les meilleurs marchés pour scalper maintenant.`;

        log.llm(`Analyse scalping de ${enrichedMarkets.length} marchés...`);
        const result = await this.callLLM(systemPrompt, userPrompt);

        if (!result || !result.targets) {
            log.warn('LLM: pas de targets');
            return { targets: [], skipped: [] };
        }

        // Valider les targets
        const validTargets = result.targets.filter(t => {
            if (!t.tokenId || !t.buyPrice || !t.sellPrice) return false;
            const diff = t.sellPrice - t.buyPrice;
            // Vérifier que le sell est bien +0.01 au-dessus du buy
            if (Math.abs(diff - CONFIG.SCALP_TICK) > 0.005) {
                log.warn(`LLM target corrigé: ${t.market} buy=${t.buyPrice} sell=${t.sellPrice} diff=${diff.toFixed(3)}`);
                t.sellPrice = +(t.buyPrice + CONFIG.SCALP_TICK).toFixed(2);
            }
            return true;
        });

        log.llm(`${validTargets.length} targets valides sur ${result.targets.length} proposés`);
        return { targets: validTargets, skipped: result.skipped || [] };
    }

    /**
     * Analyse rapide: le marché est-il encore bon pour scalper?
     * (Utilisé avant chaque scalp pour vérifier que le book n'a pas changé)
     */
    async quickBookCheck(bookAnalysis, marketTitle) {
        // Pas besoin du LLM pour ça - logique pure
        if (!bookAnalysis) return { ok: false, reason: 'Pas de book' };
        if (bookAnalysis.spreadCents <= 0) {
            return { ok: false, reason: `Spread nul` };
        }
        if (bookAnalysis.spreadCents > CONFIG.MAX_SPREAD_CENTS) {
            return { ok: false, reason: `Spread trop large: ${bookAnalysis.spreadCents}c > ${CONFIG.MAX_SPREAD_CENTS}c` };
        }
        if (bookAnalysis.bidDepthUsd < CONFIG.MIN_BOOK_DEPTH_USD) {
            return { ok: false, reason: `Bid depth faible: $${bookAnalysis.bidDepthUsd.toFixed(0)}` };
        }
        if (bookAnalysis.askDepthUsd < CONFIG.MIN_BOOK_DEPTH_USD) {
            return { ok: false, reason: `Ask depth faible: $${bookAnalysis.askDepthUsd.toFixed(0)}` };
        }
        return { ok: true };
    }
}

module.exports = LLMAnalyzer;
