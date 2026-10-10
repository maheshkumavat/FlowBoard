const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Load .env
const envContent = fs.readFileSync('.env', 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)?$/);
  if (match) {
    let v = match[2] ? match[2].trim() : '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[match[1]] = v;
  }
}

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

const anonClient = createClient(supabaseUrl, anonKey);
const adminClient = createClient(supabaseUrl, serviceKey);

async function runStep2() {
  console.log('=== STEP 2: SUPABASE CONNECTIVITY & DATABASE SCHEMA PROBE ===');

  // 1. Connectivity test
  console.log('\n--- 1. Testing Anon & Service Role Clients ---');
  try {
    const { data: anonData, error: anonErr } = await anonClient.from('projects').select('id').limit(1);
    if (anonErr) {
      console.log(`Anon client query error: ${anonErr.message} (code: ${anonErr.code})`);
    } else {
      console.log(`Anon client: CONNECTED & WORKING (HTTP 200, returned ${Array.isArray(anonData) ? 'array' : typeof anonData})`);
    }
  } catch (e) {
    console.log(`Anon client exception: ${e.message}`);
  }

  try {
    const { data: adminData, error: adminErr } = await adminClient.from('profiles').select('id').limit(1);
    if (adminErr) {
      console.log(`Service Role client query error: ${adminErr.message} (code: ${adminErr.code})`);
    } else {
      console.log(`Service Role client: CONNECTED & WORKING (HTTP 200, returned ${Array.isArray(adminData) ? 'array' : typeof adminData})`);
    }
  } catch (e) {
    console.log(`Service Role client exception: ${e.message}`);
  }

  // 2. Table existence and columns probe
  console.log('\n--- 2. Probing Required Tables & Columns ---');
  const schemaExpected = {
    profiles: ['id', 'name', 'email', 'avatar_url', 'github_username', 'primary_role', 'skill_profile', 'role', 'status', 'notification_preferences', 'created_at', 'updated_at'],
    projects: ['id', 'name', 'description', 'owner_id', 'suggested_skills', 'created_at', 'updated_at'],
    project_members: ['id', 'project_id', 'user_id', 'role', 'joined_at'],
    columns: ['id', 'project_id', 'name', 'position', 'created_at'],
    tasks: ['id', 'project_id', 'column_id', 'title', 'description', 'assignee_id', 'due_date', 'priority', 'status', 'required_skill', 'risk_flag', 'position', 'start_date', 'created_at', 'updated_at'],
    comments: ['id', 'task_id', 'user_id', 'content', 'created_at'],
    project_invite_codes: ['id', 'project_id', 'code', 'role', 'expires_at', 'created_by', 'created_at'],
    activity_log: ['id', 'project_id', 'user_id', 'action', 'metadata', 'created_at'],
    join_requests: ['id', 'project_id', 'user_id', 'invite_code', 'role', 'status', 'created_at', 'updated_at'],
    project_email_invites: ['id', 'project_id', 'email', 'role', 'token', 'expires_at', 'created_by', 'created_at'],
    project_messages: ['id', 'project_id', 'user_id', 'content', 'image_url', 'created_at'],
    notifications: ['id', 'user_id', 'type', 'author', 'action', 'text', 'title', 'message', 'project_id', 'task_id', 'request_id', 'requester_id', 'role', 'status', 'read', 'created_at']
  };

  const missingColumns = [];
  const missingTables = [];

  for (const [table, columns] of Object.entries(schemaExpected)) {
    // Probe table existence
    const { error: tblErr } = await adminClient.from(table).select('count').limit(0);
    if (tblErr && (tblErr.code === '42P01' || tblErr.message.includes('does not exist'))) {
      console.log(`Table '${table}': MISSING!`);
      missingTables.push(table);
      continue;
    }

    // Probe each column individually
    const colStatus = [];
    for (const col of columns) {
      const { error: colErr } = await adminClient.from(table).select(col).limit(0);
      if (colErr && (colErr.code === '42703' || colErr.message.includes('does not exist'))) {
        colStatus.push(`${col}: MISSING`);
        missingColumns.push({ table, column: col });
      } else {
        colStatus.push(`${col}: OK`);
      }
    }
    const missingInTbl = colStatus.filter(s => s.endsWith('MISSING'));
    if (missingInTbl.length > 0) {
      console.log(`Table '${table}': EXISTS, but missing columns: [${missingInTbl.join(', ')}]`);
    } else {
      console.log(`Table '${table}': ALL ${columns.length} COLUMNS VERIFIED`);
    }
  }

  // 3. Test get_project_role function RPC
  console.log('\n--- 3. Testing get_project_role() Function ---');
  const dummyUuid1 = '00000000-0000-0000-0000-000000000000';
  const dummyUuid2 = '00000000-0000-0000-0000-000000000001';
  try {
    const { data: roleData, error: roleErr } = await adminClient.rpc('get_project_role', {
      p_id: dummyUuid1,
      u_id: dummyUuid2
    });
    if (roleErr) {
      console.log(`get_project_role RPC error: ${roleErr.message}`);
    } else {
      console.log(`get_project_role RPC exists and executed successfully (result: ${roleData})`);
    }
  } catch (e) {
    console.log(`get_project_role exception: ${e.message}`);
  }

  // 4. Test handle_new_user trigger via test user signup
  console.log('\n--- 4. Testing handle_new_user Trigger & Profile Creation ---');
  const testEmail = `trigger_test_${Date.now()}@testflowboard.internal`;
  let createdUserId = null;
  try {
    const { data: createData, error: createErr } = await adminClient.auth.admin.createUser({
      email: testEmail,
      password: 'StrongTempPassword123!',
      email_confirm: true,
      user_metadata: {
        name: 'Trigger Tester',
        primary_role: 'Developer'
      }
    });

    if (createErr) {
      console.log(`Admin createUser error: ${createErr.message}`);
    } else if (createData?.user) {
      createdUserId = createData.user.id;
      console.log(`Created test user ${createdUserId}`);

      // Verify profiles table has row created by trigger
      const { data: prof, error: profErr } = await adminClient.from('profiles').select('*').eq('id', createdUserId).single();
      if (profErr) {
        console.log(`handle_new_user trigger check FAILED: profile row not found (${profErr.message})`);
      } else if (prof) {
        console.log(`handle_new_user trigger check PASSED: profile row automatically created! (name: ${prof.name}, role: ${prof.primary_role})`);
      }
    }
  } catch (e) {
    console.log(`Trigger test exception: ${e.message}`);
  } finally {
    if (createdUserId) {
      // Clean up test user
      await adminClient.auth.admin.deleteUser(createdUserId);
      console.log(`Cleaned up test user ${createdUserId}`);
    }
  }

  // 5. Test RLS enforcement (an unauthenticated or anon user cannot view private project or mutate tasks)
  console.log('\n--- 5. Testing RLS Enforcement on Tables ---');
  const { data: anonTasks, error: rlsErr } = await anonClient.from('tasks').select('*');
  console.log(`Anon select from tasks returned ${anonTasks?.length || 0} rows (RLS blocks unauthenticated reads: ${rlsErr ? rlsErr.message : (anonTasks?.length === 0 ? 'Verified empty/isolated' : 'Check RLS')})`);

  console.log('\n--- Summary of Missing Items ---');
  console.log(`Missing tables: ${missingTables.length}`);
  console.log(`Missing columns: ${missingColumns.length}`);
  if (missingColumns.length > 0) {
    console.log('Missing columns list:', JSON.stringify(missingColumns, null, 2));
  }
}

runStep2();
