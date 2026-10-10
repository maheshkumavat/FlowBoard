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
console.log('Key length:', key.length, 'prefix:', key.slice(0, 4));

fetch('https://api.groq.com/openai/v1/models', {
  headers: { Authorization: 'Bearer ' + key }
}).then(r => r.json()).then(d => {
  if (d.data) {
    console.log('Available models count:', d.data.length);
    console.log('Models:', d.data.map(m => m.id).join(', '));
  } else {
    console.log('Response:', d);
  }
}).catch(err => console.error(err));
