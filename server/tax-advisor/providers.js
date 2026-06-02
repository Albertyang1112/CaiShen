'use strict';
/**
 * providers.js — Unified LLM provider abstraction for the tax advisor
 *
 * Three backends behind one interface:
 *   - ollama     (local, free)            — OpenAI-compatible /v1/chat/completions
 *   - groq       (cloud, free tier)       — OpenAI-compatible /openai/v1/chat/completions
 *   - anthropic  (paid, escalation only)  — Messages API via @anthropic-ai/sdk
 *
 * Unified call:
 *   provider.complete({ system, messages, tools }) → {
 *     text, toolCalls: [{ id, name, args }], usage: { input, output }, raw, model
 *   }
 *
 * `messages` use a neutral shape: { role: 'user'|'assistant'|'tool', content, ... }.
 * Tool results are passed back as { role:'tool', toolCallId, name, content }.
 *
 * Config via env (see .env.example): AI_PROVIDER, OLLAMA_URL, OLLAMA_CHAT_MODEL,
 * GROQ_API_KEY, GROQ_MODEL, ANTHROPIC_API_KEY.
 */

// ─── Config ─────────────────────────────────────────────────────────────────────
const OLLAMA_URL        = process.env.OLLAMA_URL        || 'http://localhost:11434';
const OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'qwen2.5:32b-instruct';
const GROQ_API_KEY      = process.env.GROQ_API_KEY      || null;
const GROQ_MODEL        = process.env.GROQ_MODEL        || 'llama-3.3-70b-versatile';
const GROQ_BASE         = 'https://api.groq.com/openai/v1';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-sonnet-4-5';

const anthropicConfigured = !!(ANTHROPIC_API_KEY &&
  ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here');

// ─── Tool schema conversion ───────────────────────────────────────────────────
// Neutral tool def: { name, description, parameters (JSON schema) }

function toOpenAITools(tools) {
  if (!tools?.length) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function toAnthropicTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map(t => ({
    name: t.name, description: t.description, input_schema: t.parameters,
  }));
}

// ─── OpenAI-compatible provider (Ollama + Groq) ─────────────────────────────────

function makeOpenAICompatible({ name, baseUrl, model, apiKey }) {
  return {
    name,
    model,

    async complete({ system, messages, tools, temperature = 0.2, maxTokens = 1500 }) {
      // Build OpenAI-style message list
      const msgs = [];
      if (system) msgs.push({ role: 'system', content: system });
      for (const m of messages) {
        if (m.role === 'tool') {
          msgs.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
        } else if (m.role === 'assistant' && m.toolCalls?.length) {
          msgs.push({
            role: 'assistant',
            content: m.content || '',
            tool_calls: m.toolCalls.map(tc => ({
              id: tc.id, type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
            })),
          });
        } else {
          msgs.push({ role: m.role, content: m.content });
        }
      }

      const body = {
        model, messages: msgs, temperature, max_tokens: maxTokens,
      };
      const oaTools = toOpenAITools(tools);
      if (oaTools) { body.tools = oaTools; body.tool_choice = 'auto'; }

      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`${name} HTTP ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      const choice = data.choices?.[0]?.message || {};
      const toolCalls = (choice.tool_calls || []).map(tc => ({
        id: tc.id,
        name: tc.function?.name,
        args: safeParse(tc.function?.arguments),
      }));
      return {
        text: choice.content || '',
        toolCalls,
        usage: {
          input:  data.usage?.prompt_tokens ?? null,
          output: data.usage?.completion_tokens ?? null,
        },
        model,
        raw: data,
      };
    },
  };
}

// ─── Anthropic provider ─────────────────────────────────────────────────────────

function makeAnthropic() {
  let client = null;
  function getClient() {
    if (!client) {
      const Anthropic = require('@anthropic-ai/sdk');
      client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    }
    return client;
  }

  return {
    name: 'anthropic',
    model: ANTHROPIC_MODEL,

    async complete({ system, messages, tools, temperature = 0.2, maxTokens = 1500 }) {
      // Convert neutral messages → Anthropic format
      const amsgs = [];
      for (const m of messages) {
        if (m.role === 'tool') {
          amsgs.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
          });
        } else if (m.role === 'assistant' && m.toolCalls?.length) {
          const content = [];
          if (m.content) content.push({ type: 'text', text: m.content });
          for (const tc of m.toolCalls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
          }
          amsgs.push({ role: 'assistant', content });
        } else {
          amsgs.push({ role: m.role, content: m.content });
        }
      }

      const req = {
        model: ANTHROPIC_MODEL, max_tokens: maxTokens, temperature,
        system, messages: amsgs,
      };
      const atools = toAnthropicTools(tools);
      if (atools) req.tools = atools;

      const resp = await getClient().messages.create(req);

      let text = '';
      const toolCalls = [];
      for (const block of resp.content || []) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, args: block.input });
        }
      }
      return {
        text,
        toolCalls,
        usage: {
          input:  resp.usage?.input_tokens ?? null,
          output: resp.usage?.output_tokens ?? null,
        },
        model: ANTHROPIC_MODEL,
        raw: resp,
      };
    },
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────────

/**
 * Get a provider by name. Falls back to the configured default (AI_PROVIDER).
 * @param {string} [name] 'ollama'|'groq'|'anthropic'
 */
function getProvider(name) {
  const choice = (name || process.env.AI_PROVIDER || 'ollama').toLowerCase();
  switch (choice) {
    case 'groq':
      if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');
      return makeOpenAICompatible({ name: 'groq', baseUrl: GROQ_BASE, model: GROQ_MODEL, apiKey: GROQ_API_KEY });
    case 'anthropic':
      if (!anthropicConfigured) throw new Error('ANTHROPIC_API_KEY not configured');
      return makeAnthropic();
    case 'ollama':
    default:
      return makeOpenAICompatible({ name: 'ollama', baseUrl: `${OLLAMA_URL}/v1`, model: OLLAMA_CHAT_MODEL, apiKey: null });
  }
}

/** Which providers are usable right now (config-only check, no network). */
function configuredProviders() {
  return {
    ollama:    true, // assumed local; status endpoint verifies reachability
    groq:      !!GROQ_API_KEY,
    anthropic: anthropicConfigured,
    default:   (process.env.AI_PROVIDER || 'ollama').toLowerCase(),
    models: {
      ollama:    OLLAMA_CHAT_MODEL,
      groq:      GROQ_MODEL,
      anthropic: ANTHROPIC_MODEL,
    },
  };
}

function safeParse(s) {
  if (typeof s !== 'string') return s || {};
  try { return JSON.parse(s); } catch { return {}; }
}

module.exports = {
  getProvider, configuredProviders, toOpenAITools, toAnthropicTools,
  // exported for tests
  _makeOpenAICompatible: makeOpenAICompatible,
};
