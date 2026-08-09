import { db, stmts, getSetting } from "./db.js";
import { getChannelVideoSummaries } from "./rss.js";
import { runWithLimit } from "./utils.js";

function getLLMConfig() {
  return {
    provider: getSetting("llm_provider", "ollama"),
    ollama_url: getSetting("ollama_url", "http://localhost:11434"),
    ollama_model: getSetting("ollama_model", "llama3.2:3b"),
    lmstudio_url: getSetting("lmstudio_url", "http://localhost:1234"),
    lmstudio_model: getSetting("lmstudio_model", "default"),
    openrouter_key: getSetting("openrouter_key", ""),
    openrouter_model: getSetting("openrouter_model", "meta-llama/llama-3.1-8b-instruct:free"),
  };
}

function sanitizeUnicode(str) {
  return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function safeTruncate(str, max) {
  if (str.length <= max) return str;
  return sanitizeUnicode(str.substring(0, max));
}

function buildPrompt(topics, videos, feedbackHistory, opts = {}) {
  const maxDesc = opts.maxDesc || 200;
  const maxFeedback = opts.maxFeedback || 10;
  const trimmedFeedback = feedbackHistory.slice(0, maxFeedback);

  let prompt = `Tu es un evaluateur de chaines YouTube. Note la qualite generale d'une chaine.\n`;

  if (videos.length > 0) {
    prompt += `\nVIDEOS RECENTES DE CETTE CHAINE:\n`;
    for (const v of videos) {
      prompt += `- "${sanitizeUnicode(v.titre)}" (${v.vues?.toLocaleString() || 0} vues)\n`;
      if (v.description) {
        prompt += `  Resume: ${safeTruncate(v.description, maxDesc)}\n`;
      }
    }
  } else if (opts.channelDesc) {
    prompt += `\nDESCRIPTION DE LA CHAINE (aucune video disponible):\n${safeTruncate(opts.channelDesc, 1000)}\n`;
  }

  if (trimmedFeedback.length > 0) {
    prompt += `\nREJETS PASSES (eviter des chaines similaires):\n`;
    for (const fb of trimmedFeedback) {
      const reason = safeTruncate(fb.raison || "", 200);
      prompt += `- "${sanitizeUnicode(fb.channel_nom)}" rejetee car : ${reason}\n`;
    }
  }

  if (topics.length > 0) {
    prompt += `\nTHEMES DISPONIBLES:\n`;
    for (const t of topics) {
      prompt += `- ${sanitizeUnicode(t.nom)}${t.description ? `: ${safeTruncate(t.description, 200)}` : ""}\n`;
    }
  }

  prompt += `
TACHE:
1. Note cette chaine de 0 a 100 selon sa qualite generale (contenu, production, engagement, regularite, originalite).
2. Parmi les themes listes ci-dessus, selectionne ceux qui correspondent le mieux a cette chaine. Tu peux en selectionner 0, 1 ou plusieurs. Si aucun theme n'est liste, reponds avec une liste vide.

Reponds UNIQUEMENT avec du JSON valide dans ce format exact :
{
  "score": <nombre 0-100>,
  "summary": "<resume de la chaine en 2-3 phrases en francais>",
  "justification": "<1-2 phrases expliquant la note>",
  "topics": ["nom_theme_1", "nom_theme_2"]
}`;

  return prompt;
}

function truncatePrompt(prompt, maxChars = 6000) {
  if (prompt.length <= maxChars) return prompt;
  const truncated = prompt.substring(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  return (lastNewline > maxChars * 0.8 ? truncated.substring(0, lastNewline) : truncated) + "\n[truncated]";
}

async function callOllama(prompt) {
  const cfg = getLLMConfig();
  const res = await fetch(`${cfg.ollama_url}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.ollama_model,
      prompt,
      stream: false,
      options: { temperature: 0.3, num_predict: 512 },
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (res.status === 422) {
      throw new Error(`Ollama 422: modele ou payload invalide — ${errText}`);
    }
    throw new Error(`Ollama error: ${res.status}`);
  }

  const data = await res.json();
  return data.response;
}

async function callLMStudio(prompt) {
  const cfg = getLLMConfig();
  const res = await fetch(`${cfg.lmstudio_url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.lmstudio_model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 512,
      stream: false,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const err = await res.text();
    if (res.status === 422) {
      throw new Error(`LM Studio 422: requete invalide — ${err}`);
    }
    throw new Error(`LM Studio error: ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callOpenRouter(prompt) {
  const cfg = getLLMConfig();
  if (!cfg.openrouter_key) {
    throw new Error("OpenRouter key not configured");
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.openrouter_key}`,
    },
    body: JSON.stringify({
      model: cfg.openrouter_model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 512,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const err = await res.text();
    if (res.status === 422) {
      throw new Error(`OpenRouter 422: contexte trop grand ou payload invalide — ${err}`);
    }
    throw new Error(`OpenRouter error: ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callLLM(prompt) {
  const provider = getSetting("llm_provider", "ollama");
  switch (provider) {
    case "openrouter":
      return callOpenRouter(prompt);
    case "lmstudio":
      return callLMStudio(prompt);
    default:
      return callOllama(prompt);
  }
}

function parseLLMResponse(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const topics = Array.isArray(parsed.topics) ? parsed.topics.map(String).filter(Boolean) : [];
    return {
      score: Math.min(100, Math.max(0, Number(parsed.score) || 0)),
      summary: String(parsed.summary || ""),
      justification: String(parsed.justification || ""),
      topics,
    };
  } catch {
    return null;
  }
}

function assignTopicsFromLLM(channelId, topicNames) {
  const allTopics = stmts.getAllTopics.all();
  const toAssign = topicNames
    .map(name => allTopics.find(t => t.nom.toLowerCase() === name.toLowerCase()))
    .filter(Boolean);
  db.query(`DELETE FROM channel_topics WHERE channel_id = ?`).run(channelId);
  for (const t of toAssign) {
    stmts.assignTopic.run(channelId, t.id);
  }
  if (toAssign.length > 0) {
    console.log(`[LLM] Assigned topics to ${channelId}: ${toAssign.map(t => t.nom).join(", ")}`);
  }
}

export async function scoreChannel(channelId) {
  const channel = stmts.getChannelByYoutubeId.get(channelId);
  if (!channel) {
    console.error(`[LLM] Channel ${channelId} not found`);
    return { ok: false, reason: 'channel not found in database' };
  }

  const allTopics = stmts.getAllTopics.all();

  console.log(`[LLM] Scoring "${channel.nom}"...`);

  let videos = db.query(
    `SELECT titre, description, vues FROM videos WHERE channel_id = ? ORDER BY date_pub DESC LIMIT 5`
  ).all(channelId);
  if (videos.length === 0) {
    videos = await getChannelVideoSummaries(channelId, 5);
  }
  if (videos.length === 0) {
    const channelDesc = (channel.description || "").trim();
    if (!channelDesc) {
      // Quick check: try fetching the channel page to see if it returns 404
      let reason = 'no videos and no channel description (channel may no longer exist)';
      try {
        const check = await fetch(`https://www.youtube.com/channel/${channelId}`, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8000),
        });
        if (check.status === 404) {
          reason = 'channel no longer exists on YouTube (404)';
        } else if (check.ok) {
          reason = 'channel exists but has no public videos';
        }
      } catch { /* keep default reason */ }
      console.log(`[LLM] No videos or channel description found for "${channel.nom}", skipping`);
      return { ok: false, reason };
    }
    console.log(`[LLM] No videos for "${channel.nom}", falling back to channel description`);
  }
  videos = videos.map((v) => ({ ...v, description: v.description?.substring(0, 500) }));

  const feedbackHistory = stmts.getFeedbackForPrompt.all();

  let prompt = truncatePrompt(buildPrompt(allTopics, videos, feedbackHistory, { channelDesc: channel.description || "" }));

  try {
    const response = await callLLM(prompt).catch(async (err) => {
      if (err.message?.includes("422")) {
        console.warn(`[LLM] 422 for "${channel.nom}" — retrying with reduced context.`);
        prompt = buildPrompt(allTopics, videos.slice(0, 2), feedbackHistory.slice(0, 3), { maxDesc: 100, maxFeedback: 3, channelDesc: channel.description || "" });
        return callLLM(truncatePrompt(prompt, 3000));
      }
      throw err;
    });
    const parsed = parseLLMResponse(response);

    if (!parsed) {
      console.error(`[LLM] Failed to parse response for "${channel.nom}"`);
      return { ok: false, reason: 'failed to parse LLM response' };
    }

    stmts.updateChannelLLM.run({
      $llm_score: parsed.score,
      $llm_summary: `${parsed.summary}\n\nJustification: ${parsed.justification}`,
      $id: channel.id,
    });

    assignTopicsFromLLM(channel.channel_id, parsed.topics);

    console.log(`[LLM] "${channel.nom}" scored ${parsed.score}/100, topics: [${parsed.topics.join(", ")}]`);
    return { ok: true, ...parsed };
  } catch (err) {
    console.error(`[LLM] Error scoring "${channel.nom}":`, err.message);
    return { ok: false, reason: `LLM error: ${err.message}` };
  }
}

async function scoreChannelList(channels, onProgress) {
  const results = [];
  const failures = [];
  let completed = 0;
  let failed = 0;
  onProgress?.({ total: channels.length, completed: 0, scored: 0, failed: 0, failures: [], current: "" });

  const concurrency = Math.max(1, Math.min(10, Number(getSetting("llm_concurrency", "3")) || 3));

  await runWithLimit(
    channels,
    async (ch) => {
      const result = await scoreChannel(ch.channel_id);
      if (result?.ok) {
        results.push({ channel: ch.nom, ...result });
      } else {
        failed++;
        const reason = result?.reason || 'unknown reason';
        failures.push({ channel: ch.nom, reason });
        console.log(`[LLM] Failed to score "${ch.nom}": ${reason}`);
      }
      completed++;
      onProgress?.({
        total: channels.length,
        completed,
        scored: results.length,
        failed,
        failures,
        current: ch.nom,
      });
    },
    concurrency,
    1000
  );
  return results;
}

export async function scoreAllPending(onProgress) {
  const pending = stmts.getPendingChannels.all();
  console.log(`[LLM] Scoring ${pending.length} pending channels...`);
  return scoreChannelList(pending, onProgress);
}

export async function scoreAllUnscored(onProgress) {
  const unscored = stmts.getUnscoredChannels.all();
  console.log(`[LLM] Scoring ${unscored.length} unscored channels...`);
  return scoreChannelList(unscored, onProgress);
}

export async function rescoreAllChannels(onProgress) {
  stmts.resetAllScores.run();
  console.log("[LLM] All scores reset. Rescoring everything...");
  return scoreAllUnscored(onProgress);
}

export async function checkLLMHealth() {
  const cfg = getLLMConfig();
  try {
    switch (cfg.provider) {
      case "ollama": {
        const res = await fetch(`${cfg.ollama_url}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { ok: false, provider: "ollama", error: "Ollama not responding" };
        const data = await res.json();
        return { ok: true, provider: "ollama", models: data.models?.map((m) => m.name) || [] };
      }
      case "lmstudio": {
        const res = await fetch(`${cfg.lmstudio_url}/v1/models`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { ok: false, provider: "lmstudio", error: "LM Studio not responding" };
        const data = await res.json();
        return { ok: true, provider: "lmstudio", models: data.data?.map((m) => m.id) || [] };
      }
      case "openrouter":
        return { ok: !!cfg.openrouter_key, provider: "openrouter" };
      default:
        return { ok: false, provider: cfg.provider, error: "Unknown provider" };
    }
  } catch (err) {
    return { ok: false, provider: cfg.provider, error: err.message };
  }
}
