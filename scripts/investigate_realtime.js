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

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function createAuthUser(label, runId) {
  const email = `rt_${label}_${runId}@flowboard.test`;
  const password = `Pass_${label}_${runId}!`;

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: `Realtime ${label}` },
  });
  if (error) throw error;

  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  });

  const { data: signinData, error: signinErr } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signinErr) throw signinErr;

  // Crucial for Supabase Realtime: set JWT on the realtime socket
  if (client.realtime && client.realtime.setAuth) {
    client.realtime.setAuth(signinData.session.access_token);
  }

  return { user: data.user, client, token: signinData.session.access_token };
}

async function main() {
  console.log('=== REALTIME INVESTIGATION SCRIPT ===\n');
  const runId = Date.now().toString().slice(-6);
  const usersToCleanup = [];
  let projId = null;

  try {
    const userA = await createAuthUser('Admin', runId);
    usersToCleanup.push(userA.user.id);

    const userB = await createAuthUser('Member', runId);
    usersToCleanup.push(userB.user.id);

    const userC = await createAuthUser('Outsider', runId);
    usersToCleanup.push(userC.user.id);

    // Create project
    const { data: proj, error: projErr } = await supabaseAdmin
      .from('projects')
      .insert({
        name: `RT Investigation Proj ${runId}`,
        owner_id: userA.user.id,
      })
      .select()
      .single();
    if (projErr) throw projErr;
    projId = proj.id;

    // User A is ADMIN
    await supabaseAdmin.from('project_members').insert({
      project_id: projId,
      user_id: userA.user.id,
      role: 'ADMIN',
    });

    // User B is MEMBER
    await supabaseAdmin.from('project_members').insert({
      project_id: projId,
      user_id: userB.user.id,
      role: 'MEMBER',
    });

    // Column
    const { data: col, error: colErr } = await supabaseAdmin
      .from('columns')
      .insert({
        project_id: projId,
        name: 'To Do',
        position: 1,
      })
      .select()
      .single();
    if (colErr) throw colErr;

    const receivedA = [];
    const receivedC = [];

    const channelA = userA.client.channel(`project_${projId}_A`);
    channelA
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${projId}` }, (p) => {
        console.log('  [Channel A Received Tasks Event]:', p.eventType);
        receivedA.push({ table: 'tasks', event: p });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_messages', filter: `project_id=eq.${projId}` }, (p) => {
        console.log('  [Channel A Received Messages Event]:', p.eventType);
        receivedA.push({ table: 'project_messages', event: p });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_log', filter: `project_id=eq.${projId}` }, (p) => {
        console.log('  [Channel A Received Activity Event]:', p.eventType);
        receivedA.push({ table: 'activity_log', event: p });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'join_requests', filter: `project_id=eq.${projId}` }, (p) => {
        console.log('  [Channel A Received Join Requests Event]:', p.eventType);
        receivedA.push({ table: 'join_requests', event: p });
      });

    const channelC = userC.client.channel(`project_${projId}_C`);
    channelC
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${projId}` }, (p) => {
        console.log('  [Channel C (Outsider) Received Tasks Event]:', p.eventType);
        receivedC.push({ table: 'tasks', event: p });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_messages', filter: `project_id=eq.${projId}` }, (p) => {
        console.log('  [Channel C (Outsider) Received Messages Event]:', p.eventType);
        receivedC.push({ table: 'project_messages', event: p });
      });

    await new Promise((resolve) => {
      let done = 0;
      channelA.subscribe((s) => {
        console.log('Channel A status:', s);
        if (s === 'SUBSCRIBED' && ++done === 2) resolve();
      });
      channelC.subscribe((s) => {
        console.log('Channel C status:', s);
        if (s === 'SUBSCRIBED' && ++done === 2) resolve();
      });
      setTimeout(resolve, 4000);
    });

    console.log('\nTriggering insertions...');
    // 1. Task insert
    const { data: tData, error: tErr } = await userB.client.from('tasks').insert({
      project_id: projId,
      column_id: col.id,
      title: 'Investigation Task',
      position: 0,
    }).select();
    console.log('Task insert result:', tErr ? tErr.message : 'OK');

    // 2. Message insert
    const { error: mErr } = await userB.client.from('project_messages').insert({
      project_id: projId,
      user_id: userB.user.id,
      content: 'Hello team',
    });
    console.log('Message insert result:', mErr ? mErr.message : 'OK');

    // 3. Activity insert
    const { error: aErr } = await userB.client.from('activity_log').insert({
      project_id: projId,
      user_id: userB.user.id,
      action: 'task_created',
      metadata: { taskTitle: 'Investigation Task' },
    });
    console.log('Activity insert result:', aErr ? aErr.message : 'OK');

    // 4. Join request insert
    const { error: jErr } = await userC.client.from('join_requests').insert({
      project_id: projId,
      user_id: userC.user.id,
      status: 'PENDING',
    });
    console.log('Join request insert result:', jErr ? jErr.message : 'OK');

    console.log('Waiting 5s for realtime delivery...');
    await new Promise((r) => setTimeout(r, 5000));

    console.log('\nTotal events received by User A:', receivedA.length);
    console.log('Total events received by User C:', receivedC.length);

  } finally {
    if (projId) await supabaseAdmin.from('projects').delete().eq('id', projId);
    for (const uid of usersToCleanup) await supabaseAdmin.auth.admin.deleteUser(uid);
    console.log('Cleaned up.');
  }
}

main().catch(console.error);
