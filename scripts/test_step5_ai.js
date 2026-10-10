const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
  }
}
loadEnv();

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BASE_URL = 'http://localhost:3000';

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const supabaseAnon = createClient(SUPABASE_URL, ANON_KEY);

async function main() {
  console.log('=== STEP 5: AI FEATURES END-TO-END TEST ===\n');

  console.log('Environment configuration for AI:');
  console.log(`- GROQ_API_KEY: ${GROQ_API_KEY ? 'SET (format check: ' + GROQ_API_KEY.startsWith('gsk_') + ')' : 'MISSING'}`);
  console.log(`- GEMINI_API_KEY: ${GEMINI_API_KEY ? 'SET' : 'NOT SET (optional secondary provider)'}\n`);

  // 1. Create a test user & sign in to get valid Supabase Auth token
  const runId = Date.now().toString().slice(-6);
  const testEmail = `test_ai_${runId}@flowboard.test`;
  const testPass = `Pass_AI_${runId}!`;

  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email: testEmail,
    password: testPass,
    email_confirm: true,
    user_metadata: { name: `AI Test User ${runId}` },
  });

  if (authErr) {
    console.error('Failed to create test user for AI testing:', authErr);
    process.exit(1);
  }
  const testUser = authData.user;

  const { data: signinData, error: signinErr } = await supabaseAnon.auth.signInWithPassword({
    email: testEmail,
    password: testPass,
  });

  if (signinErr) {
    console.error('Failed to sign in test user:', signinErr);
    await supabaseAdmin.auth.admin.deleteUser(testUser.id);
    process.exit(1);
  }

  const token = signinData.session.access_token;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  // Create test project
  const { data: projData, error: projErr } = await supabaseAdmin
    .from('projects')
    .insert({
      name: `AI Workspace ${runId}`,
      description: 'A Next.js, React, Supabase real-time Kanban board application with PostgreSQL backend.',
      owner_id: testUser.id,
    })
    .select()
    .single();

  if (projErr) {
    console.error('Failed to create test project:', projErr);
    await supabaseAdmin.auth.admin.deleteUser(testUser.id);
    process.exit(1);
  }

  await supabaseAdmin.from('project_members').insert({
    project_id: projData.id,
    user_id: testUser.id,
    role: 'ADMIN',
  });

  let passCount = 0;
  let failCount = 0;

  // -------------------------------------------------------------
  // Test 1: Direct Groq API Connectivity & Latency
  // -------------------------------------------------------------
  console.log('--- 1. Testing Groq Engine Directly ---');
  const t0 = Date.now();
  try {
    const { callGroqLLM } = require('../lib/ai/groqEngine');
    const directGroqRes = await callGroqLLM({
      systemPrompt: 'You are a test evaluator. Respond with JSON: {"status": "ok", "provider": "Groq"}',
      userPrompt: 'Ping test',
      timeoutMs: 8000,
    });
    const parsedDirect = JSON.parse(directGroqRes);
    const dLatency = Date.now() - t0;
    if (parsedDirect.status === 'ok') {
      console.log(`  [PASS] Groq LLM responded in ${dLatency}ms with valid JSON:`, parsedDirect);
      passCount++;
    } else {
      console.log(`  [FAIL] Groq LLM unexpected response:`, parsedDirect);
      failCount++;
    }
  } catch (err) {
    console.log(`  [FAIL] Groq direct call failed: ${err.message}`);
    failCount++;
  }

  // -------------------------------------------------------------
  // Test 2: POST /api/ai/task-breakdown
  // -------------------------------------------------------------
  console.log('\n--- 2. Testing /api/ai/task-breakdown ---');
  const t1 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/ai/task-breakdown`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        goal: 'Build an end-to-end WebSocket notification service with retry queues and telemetry dashboard',
      }),
    });
    const latency1 = Date.now() - t1;
    const body = await res.json();

    if (res.status === 200 && Array.isArray(body.subtasks) && body.subtasks.length >= 3) {
      // Check if it's the static template fallback
      const isStaticTemplate = body.subtasks.some((s) => s.title && s.title.includes('Plan & Architecture:'));
      console.log(`  Status: ${res.status} | Latency: ${latency1}ms`);
      console.log(`  Returned ${body.subtasks.length} subtasks.`);
      console.log(`  Sample subtask: "${body.subtasks[0].title}" [${body.subtasks[0].requiredSkill}]`);
      if (isStaticTemplate) {
        console.log(`  [WARNING] Task breakdown used Priority 3 Static Template Fallback.`);
      } else {
        console.log(`  [PASS] Task breakdown generated dynamically by real Groq LLM inference.`);
        passCount++;
      }
    } else {
      console.log(`  [FAIL] /api/ai/task-breakdown returned status ${res.status}:`, body);
      failCount++;
    }
  } catch (err) {
    console.log(`  [FAIL] /api/ai/task-breakdown error: ${err.message}`);
    failCount++;
  }

  // -------------------------------------------------------------
  // Test 3: POST /api/ai/project-description
  // -------------------------------------------------------------
  console.log('\n--- 3. Testing /api/ai/project-description ---');
  const t2 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/ai/project-description`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'Distributed Log Aggregator and Stream Analytics Platform',
        keyPoints: 'Kafka ingestion, ClickHouse storage, Grafana dashboards, alerting webhooks',
        projectType: 'DevOps / Data Pipeline',
        complexity: 'Enterprise SaaS',
      }),
    });
    const latency2 = Date.now() - t2;
    const body = await res.json();

    if (res.status === 200 && body.description && Array.isArray(body.suggestedSkills)) {
      console.log(`  Status: ${res.status} | Latency: ${latency2}ms`);
      console.log(`  isFallback flag: ${body.isFallback}`);
      console.log(`  Suggested skills (${body.suggestedSkills.length}): ${body.suggestedSkills.slice(0, 6).join(', ')}`);
      if (body.isFallback === false) {
        console.log(`  [PASS] Project description generated dynamically by real Groq LLM inference.`);
        passCount++;
      } else {
        console.log(`  [WARNING] Route returned fallback template description.`);
      }
    } else {
      console.log(`  [FAIL] /api/ai/project-description returned status ${res.status}:`, body);
      failCount++;
    }
  } catch (err) {
    console.log(`  [FAIL] /api/ai/project-description error: ${err.message}`);
    failCount++;
  }

  // -------------------------------------------------------------
  // Test 4: POST /api/ai/recommend-assignees
  // -------------------------------------------------------------
  console.log('\n--- 4. Testing /api/ai/recommend-assignees ---');
  const t3 = Date.now();
  try {
    // Populate the test user's profile with a skill profile
    await supabaseAdmin.from('profiles').update({
      skill_profile: {
        'Frontend': { 'React': 0.9, 'Next.js': 0.85 },
        'Backend': { 'Node.js': 0.8 },
      },
    }).eq('id', testUser.id);

    const res = await fetch(`${BASE_URL}/api/ai/recommend-assignees`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        projectId: projData.id,
        requiredSkill: 'Frontend',
      }),
    });
    const latency3 = Date.now() - t3;
    const body = await res.json();

    if (res.status === 200 && Array.isArray(body.recommendations)) {
      console.log(`  Status: ${res.status} | Latency: ${latency3}ms`);
      console.log(`  Found ${body.recommendations.length} recommended member(s).`);
      if (body.recommendations.length > 0) {
        const top = body.recommendations[0];
        console.log(`  Top match: ${top.user?.name} (Score: ${Math.round(top.matchScore * 100)}%, Category: ${top.primaryCategory})`);
      }
      console.log(`  [PASS] Candidate ranking algorithm executed successfully.`);
      passCount++;
    } else {
      console.log(`  [FAIL] /api/ai/recommend-assignees returned status ${res.status}:`, body);
      failCount++;
    }
  } catch (err) {
    console.log(`  [FAIL] /api/ai/recommend-assignees error: ${err.message}`);
    failCount++;
  }

  // -------------------------------------------------------------
  // Test 5: POST /api/ai/github-skills
  // -------------------------------------------------------------
  console.log('\n--- 5. Testing /api/ai/github-skills ---');
  const t4 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/ai/github-skills`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        githubUsername: 'octocat',
      }),
    });
    const latency4 = Date.now() - t4;
    const body = await res.json();

    if (res.status === 200 && body.skillProfile && body.githubSummary) {
      console.log(`  Status: ${res.status} | Latency: ${latency4}ms`);
      console.log(`  GitHub repos analyzed: ${body.githubSummary.reposAnalyzed}`);
      console.log(`  Top languages detected: ${body.githubSummary.topLanguages.join(', ')}`);
      console.log(`  Skill profile categories: ${Object.keys(body.skillProfile).join(', ')}`);
      console.log(`  [PASS] GitHub repo analysis and AI skill profiling generated.`);
      passCount++;
    } else {
      console.log(`  [FAIL] /api/ai/github-skills returned status ${res.status}:`, body);
      failCount++;
    }
  } catch (err) {
    console.log(`  [FAIL] /api/ai/github-skills error: ${err.message}`);
    failCount++;
  }

  // -------------------------------------------------------------
  // Test 6: Fallback path observation & error handling analysis
  // -------------------------------------------------------------
  console.log('\n--- 6. Fallback Behavior & Provider Error Handling Analysis ---');
  if (!GEMINI_API_KEY) {
    console.log('  [NOTICE] GEMINI_API_KEY is not configured: Secondary LLM provider fallback NOT TESTED.');
  } else {
    console.log('  [NOTICE] GEMINI_API_KEY is set. Testing secondary provider directly...');
    try {
      const { callGeminiLLM } = require('../lib/ai/geminiEngine');
      const gRes = await callGeminiLLM({
        systemPrompt: 'Respond with JSON: {"status": "ok"}',
        userPrompt: 'Ping',
        timeoutMs: 6000,
      });
      console.log('  [PASS] Gemini fallback responded successfully.');
    } catch (e) {
      console.log(`  [FAIL] Gemini call failed: ${e.message}`);
    }
  }

  console.log('\n  [AUDIT NOTE on Silent Fallbacks]:');
  console.log('  - In /api/ai/task-breakdown: If LLM fails or times out, it falls back to hardcoded template tasks WITHOUT indicating `isFallback: true` in the JSON response.');
  console.log('  - In /api/ai/project-description: Correctly flags `isFallback: true/false` in the response payload.');
  console.log('  - In /api/ai/github-skills: If LLM fails, it falls back to deterministic GitHub language weighting.');

  // Cleanup
  console.log('\n--- Cleaning up test user and project ---');
  await supabaseAdmin.from('projects').delete().eq('id', projData.id);
  await supabaseAdmin.auth.admin.deleteUser(testUser.id);
  console.log('Cleanup completed.\n');

  console.log(`STEP 5 TOTAL: ${passCount} PASSED, ${failCount} FAILED`);
}

main().catch(console.error);
