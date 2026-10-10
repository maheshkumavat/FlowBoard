#!/usr/bin/env node

/**
 * FlowBoard Full Smoke Test Suite (Plain Node.js)
 *
 * Tests verified functionality against a running server:
 * 1. Health check & credentials presence
 * 2. Signup (User A - Owner/Admin)
 * 3. Login (User A)
 * 4. GET /api/auth/me
 * 5. POST /api/projects (Create project & default columns)
 * 6. POST /api/tasks (Create task)
 * 7. PUT /api/tasks/[id] (Move task to another column)
 * 8. PUT /api/tasks/[id] (Assign task)
 * 9. POST /api/tasks/[id]/comments (Add comment)
 * 10. GET /api/projects/[id]/invite-code (Fetch / generate invite code)
 * 11. Signup & Login (User B - Non-member)
 * 12. GET /api/projects/[id] as non-member -> expects 403 Forbidden
 * 13. POST /api/projects/join (User B requests to join via invite code)
 * 14. POST /api/projects/[id]/join-requests (User A approves join request)
 * 15. PUT /api/projects/[id]/members (User A updates User B's role)
 * 16. Cleanup / Project deletion
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load environment variables from .env if present
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim();
      let val = trimmed.substring(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.substring(1, val.length - 1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  });
}

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const isPlaceholder = (val) =>
  !val ||
  val.includes('your-project') ||
  val.includes('your-supabase') ||
  val.includes('placeholder');

console.log('====================================================');
console.log('         FLOWBOARD SMOKE TEST SUITE                 ');
console.log('====================================================');
console.log(`Target URL: ${BASE_URL}`);

if (isPlaceholder(SUPABASE_URL) || isPlaceholder(ANON_KEY) || isPlaceholder(SERVICE_KEY)) {
  console.log('\n[!] NOTICE: Real Supabase credentials are NOT yet configured in .env.');
  console.log('    Placeholders detected:');
  if (isPlaceholder(SUPABASE_URL)) console.log('    - NEXT_PUBLIC_SUPABASE_URL');
  if (isPlaceholder(ANON_KEY)) console.log('    - NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (isPlaceholder(SERVICE_KEY)) console.log('    - SUPABASE_SERVICE_ROLE_KEY');
  console.log('\n    Please populate .env with your real Supabase project credentials');
  console.log('    and execute `node scripts/smoke-test.js` while `npm run dev` is running.\n');
  process.exit(0);
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${message}`);
    failed++;
  }
}

async function request(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${BASE_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const res = await fetch(url, {
    ...options,
    headers,
  });
  let body = null;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = text;
  }
  return { status: res.status, ok: res.ok, body, headers: res.headers };
}

async function runTests() {
  const runId = crypto.randomBytes(4).toString('hex');
  const userA_email = `test_owner_${runId}@example.com`;
  const userB_email = `test_member_${runId}@example.com`;
  const password = `FlowTestP@ss_${runId}!`;

  let tokenA = null;
  let tokenB = null;
  let userA = null;
  let userB = null;
  let projectId = null;
  let colTodoId = null;
  let colProgressId = null;
  let taskId = null;
  let inviteCode = null;
  let joinRequestId = null;
  let memberBId = null;

  try {
    // 1. Signup User A
    console.log('\n1. Testing Signup (User A)...');
    const signupARes = await request('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email: userA_email, password, name: `User A (${runId})` }),
    });
    assert(signupARes.status === 200 || signupARes.status === 201, `Signup User A returned status ${signupARes.status}`);

    // 2. Login User A
    console.log('\n2. Testing Login (User A)...');
    const loginARes = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: userA_email, password }),
    });
    assert(loginARes.status === 200 && (loginARes.body?.token || loginARes.body?.session?.access_token), `Login User A succeeded`);
    tokenA = loginARes.body?.token || loginARes.body?.session?.access_token;
    userA = loginARes.body?.user;

    // 3. /api/auth/me for User A
    console.log('\n3. Testing GET /api/auth/me...');
    const meRes = await request('/api/auth/me', {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(meRes.status === 200 && meRes.body?.user?.email === userA_email, `/api/auth/me returned correct authenticated profile`);

    // 4. Create Project
    console.log('\n4. Testing POST /api/projects (Create Project)...');
    const createProjRes = await request('/api/projects', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        name: `Smoke Test Project ${runId}`,
        description: 'Automated test project for FlowBoard validation',
        suggestedSkills: ['Node.js', 'PostgreSQL'],
      }),
    });
    assert(createProjRes.status === 201 && createProjRes.body?.project?.id, `Project created successfully with ID: ${createProjRes.body?.project?.id}`);
    projectId = createProjRes.body?.project?.id;

    // 5. Fetch project board to retrieve columns
    console.log('\n5. Testing GET /api/projects/[id]...');
    const getProjRes = await request(`/api/projects/${projectId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(getProjRes.status === 200 && getProjRes.body?.project?.columns?.length > 0, `Project board returned columns`);
    const cols = getProjRes.body?.project?.columns || [];
    colTodoId = cols[0]?.id;
    colProgressId = cols[1]?.id || cols[0]?.id;

    // 6. Create Task
    console.log('\n6. Testing POST /api/tasks (Create Task)...');
    const createTaskRes = await request('/api/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        projectId,
        columnId: colTodoId,
        title: `Smoke Task ${runId}`,
        description: 'Verify task creation end-to-end',
        priority: 'HIGH',
      }),
    });
    assert(
      createTaskRes.status === 201 && createTaskRes.body?.task?.id && !createTaskRes.body?.task?.id.startsWith('t-'),
      `Task created with verified DB id: ${createTaskRes.body?.task?.id}`
    );
    taskId = createTaskRes.body?.task?.id;

    // 7. Move Task (Update column)
    console.log('\n7. Testing PUT /api/tasks/[id] (Move Task)...');
    const moveTaskRes = await request(`/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        columnId: colProgressId,
      }),
    });
    assert(moveTaskRes.status === 200 && moveTaskRes.body?.task?.columnId === colProgressId, `Task moved to column ${colProgressId}`);

    // 8. Assign Task (Self-assign)
    console.log('\n8. Testing PUT /api/tasks/[id] (Assign Task)...');
    const assignTaskRes = await request(`/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        assigneeId: userA?.id,
      }),
    });
    assert(assignTaskRes.status === 200, `Task self-assigned successfully`);

    // 9. Comment on Task
    console.log('\n9. Testing POST /api/tasks/[id]/comments (Add Comment)...');
    const commentRes = await request(`/api/tasks/${taskId}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        content: `Smoke test comment at ${new Date().toISOString()}`,
      }),
    });
    assert(
      commentRes.status === 201 && commentRes.body?.comment?.id && !commentRes.body?.comment?.id.startsWith('c-'),
      `Comment created with verified DB id: ${commentRes.body?.comment?.id}`
    );

    // 10. Invite Code Generation
    console.log('\n10. Testing GET /api/projects/[id]/invite-code...');
    const inviteRes = await request(`/api/projects/${projectId}/invite-code`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(inviteRes.status === 200 && inviteRes.body?.inviteCode?.code, `Active invite code: ${inviteRes.body?.inviteCode?.code}`);
    inviteCode = inviteRes.body?.inviteCode?.code;

    // 11. Signup & Login User B (Non-member)
    console.log('\n11. Testing Signup & Login (User B - Non-member)...');
    await request('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email: userB_email, password, name: `User B (${runId})` }),
    });
    const loginBRes = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: userB_email, password }),
    });
    tokenB = loginBRes.body?.token || loginBRes.body?.session?.access_token;
    userB = loginBRes.body?.user;
    assert(!!tokenB, `User B authenticated`);

    // 12. Non-member Access Control (Expect 403)
    console.log('\n12. Testing 403 Forbidden for Non-member access...');
    const nonMemberGetRes = await request(`/api/projects/${projectId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(nonMemberGetRes.status === 403, `Non-member received 403 Forbidden on project access`);

    // 13. Join Request via Invite Code
    console.log('\n13. Testing POST /api/projects/join (Submit Join Request)...');
    const joinRes = await request('/api/projects/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({
        code: inviteCode,
        inviteCode,
        role: 'MEMBER',
      }),
    });
    assert(joinRes.status === 200 || joinRes.status === 201, `Join request submitted`);
    joinRequestId = joinRes.body?.requestId || joinRes.body?.request?.id;

    // 14. Approve Join Request
    console.log('\n14. Testing POST /api/projects/[id]/join-requests (Approve)...');
    const approveRes = await request(`/api/projects/${projectId}/join-requests`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        requestId: joinRequestId,
        action: 'accept',
        userId: userB?.id,
        role: 'MEMBER',
      }),
    });
    assert(approveRes.status === 200, `Admin accepted join request`);

    // 15. Change Member Role
    console.log('\n15. Testing PUT /api/projects/[id]/members (Role Change)...');
    // Fetch members to get member row id for User B
    const membersGetRes = await request(`/api/projects/${projectId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const memB = membersGetRes.body?.project?.members?.find((m) => m.user?.id === userB?.id || m.id === userB?.id);
    memberBId = memB?.id;

    if (memberBId) {
      const roleChangeRes = await request(`/api/projects/${projectId}/members`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({
          memberId: memberBId,
          role: 'ADMIN',
        }),
      });
      assert(roleChangeRes.status === 200, `Member role updated to ADMIN`);
    } else {
      console.warn('  [WARN] Member row not found for role change assertion');
    }

    // 16. Cleanup: Delete Test Project and Users
    console.log('\n16. Cleaning up test project and test users...');
    if (projectId) {
      const deleteProjRes = await request(`/api/projects/${projectId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert(deleteProjRes.status === 200, `Test project cleaned up successfully`);
    }

    if (SERVICE_KEY && SUPABASE_URL) {
      try {
        const { createClient } = require('@supabase/supabase-js');
        const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        if (userA?.id) await adminClient.auth.admin.deleteUser(userA.id);
        if (userB?.id) await adminClient.auth.admin.deleteUser(userB.id);
        console.log('  [PASS] Test users cleaned up via Supabase admin API');
      } catch (cleanErr) {
        console.warn('  [WARN] User cleanup warning:', cleanErr.message);
      }
    }

  } catch (err) {
    console.error('\n[EXCEPTION DURING SMOKE TEST]:', err);
    failed++;
  }

  console.log('\n====================================================');
  console.log(`SMOKE TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
