/**
 * Groq LLM API Engine (console.groq.com)
 * Model: llama-3.3-70b-versatile (Selected for ultra-fast inference & high accuracy)
 * API Endpoint: https://api.groq.com/openai/v1/chat/completions
 */

async function callGroqLLM({ systemPrompt, userPrompt, temperature = 0.2, timeoutMs = 8000 }) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || apiKey.trim() === '') {
    throw new Error('GROQ_API_KEY is not set or empty');
  }

  const candidateModels = Array.from(new Set([
    process.env.GROQ_MODEL,
    'llama-3.3-70b-versatile',
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-120b'
  ].filter(Boolean)));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let lastError = null;

  try {
    for (const model of candidateModels) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey.trim()}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature,
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        });

        if (res.status === 404 || res.status === 400) {
          const errText = await res.text();
          if (errText.includes('model_not_found') || errText.includes('does not exist') || errText.includes('decommissioned')) {
            console.warn(`[Groq Engine] Model "${model}" not accessible on this account (${res.status}). Trying alternative...`);
            lastError = new Error(`Groq model ${model} unavailable: ${errText}`);
            continue;
          }
          throw new Error(`Groq API HTTP ${res.status}: ${errText}`);
        }

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Groq API HTTP ${res.status}: ${errText}`);
        }

        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error('Groq returned empty response content');
        }

        clearTimeout(timeoutId);
        return content;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastError = err;
      }
    }
    clearTimeout(timeoutId);
    throw lastError || new Error('All Groq candidate models failed');
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`Groq LLM call timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

module.exports = { callGroqLLM };
