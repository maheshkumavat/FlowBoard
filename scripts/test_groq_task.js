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

async function testTaskBreakdown() {
  const systemPrompt = `You are a Senior Technical Project Lead and Principal Software Architect. Decompose the user's high-level goal into 4-6 specific, highly actionable, realistic engineering subtasks. Avoid generic filler. Each subtask title must state the concrete feature/module being built (e.g. "Implement JWT Refresh Token API & Auth Cookie Handler"). Each subtask MUST be classified into one of these EXACT requiredSkill categories: ["Frontend", "Backend", "Database", "DevOps/Infra", "Mobile", "Design/UI"]. Output JSON format ONLY: {"subtasks": [{"title": "Concrete Title", "description": "Specific 1-2 sentence implementation details", "requiredSkill": "Frontend"|"Backend"|"Database"|"DevOps/Infra"|"Mobile"|"Design/UI", "priority": "HIGH"|"MEDIUM"|"LOW", "estimatedDays": 2}]}`;
  const userPrompt = `High-Level Engineering Goal: "Build an end-to-end WebSocket notification service"`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: 'qwen/qwen3.8-27b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    })
  });
  const data = await res.json();
  console.log('Status:', res.status);
  console.log('Response content:', data.choices?.[0]?.message?.content);
}

testTaskBreakdown();
