const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const lines = env.split(/\r?\n/);
let key = '';
for (const line of lines) {
  if (line.startsWith('GROQ_API_KEY=')) {
    key = line.split('=')[1].trim();
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1);
    }
  }
}

async function testModel(model) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: 'Say hello in json: {"reply": "..."}' }],
      response_format: { type: 'json_object' }
    })
  });
  const data = await res.json();
  console.log(`Model [${model}]: status ${res.status}`, data.choices ? data.choices[0].message.content : data.error?.message);
}

async function run() {
  const models = ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'llama3-8b-8192'];
  for (const m of models) {
    try {
      await testModel(m);
    } catch (e) {
      console.log(`Model [${m}]: err`, e.message);
    }
  }
}
run();
