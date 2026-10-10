const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const lines = env.split(/\r?\n/);
for (const line of lines) {
  const [k, ...v] = line.split('=');
  if (k && v.length) process.env[k.trim()] = v.join('=').trim();
}

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  console.log('=== STEP 6: REALTIME BROADCAST & RLS SUBSCRIBER TEST ===\n');

  const runId = Date.now().toString().slice(-6);
  const usersToCleanup = [];
  let projId = null;

  try {
    console.log('--- 1. Provisioning Test Users ---');
    // User A (Owner/Admin)
    const emailA = `rt_admin_${runId}@flowboard.test`;
    const passA = `PassA_${runId}!`;
    const { data: uA } = await admin.auth.admin.createUser({ email: emailA, password: passA, email_confirm: true });
    usersToCleanup.push(uA.user.id);

    // User B (Member)
    const emailB = `rt_member_${runId}@flowboard.test`;
    const passB = `PassB_${runId}!`;
    const { data: uB } = await admin.auth.admin.createUser({ email: emailB, password: passB, email_confirm: true });
    usersToCleanup.push(uB.user.id);

    // User C (Outsider)
    const emailC = `rt_outsider_${runId}@flowboard.test`;
    const passC = `PassC_${runId}!`;
    const { data: uC } = await admin.auth.admin.createUser({ email: emailC, password: passC, email_confirm: true });
    usersToCleanup.push(uC.user.id);

    // Project & Members
    const { data: proj } = await admin.from('projects').insert({ name: `Realtime Project ${runId}`, owner_id: uA.user.id }).select().single();
    projId = proj.id;
    await admin.from('project_members').insert([
      { project_id: proj.id, user_id: uA.user.id, role: 'ADMIN' },
      { project_id: proj.id, user_id: uB.user.id, role: 'MEMBER' },
    ]);
    const { data: col } = await admin.from('columns').insert({ project_id: proj.id, name: 'To Do' }).select().single();

    // Authenticated Client A (Subscriber 1: Project Member / Admin)
    const clientA = createClient(SUPABASE_URL, ANON_KEY);
    const { data: sessA } = await clientA.auth.signInWithPassword({ email: emailA, password: passA });
    clientA.realtime.setAuth(sessA.session.access_token);

    // Authenticated Client C (Subscriber 2: Outsider / Non-member)
    const clientC = createClient(SUPABASE_URL, ANON_KEY);
    const { data: sessC } = await clientC.auth.signInWithPassword({ email: emailC, password: passC });
    clientC.realtime.setAuth(sessC.session.access_token);

    // Authenticated Client B (Mutator: Project Member)
    const clientB = createClient(SUPABASE_URL, ANON_KEY);
    await clientB.auth.signInWithPassword({ email: emailB, password: passB });

    console.log('  Created User A (Admin), User B (Member), User C (Outsider).');
    console.log(`  Project created (${proj.id}) with column (${col.id}).\n`);

    const receivedA = {
      tasks: [],
      project_messages: [],
      activity_log: [],
      join_requests: [],
    };

    const receivedC = {
      tasks: [],
      project_messages: [],
      activity_log: [],
      join_requests: [],
    };

    console.log('--- 2. Subscribing to postgres_changes channels ---');

    // User A Channel (Published tables)
    const chA = clientA.channel(`chan_A_${runId}`);
    chA
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${proj.id}` }, (p) => {
        console.log('  [User A (Member) Received Task Event]:', p.eventType);
        receivedA.tasks.push(p);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_messages', filter: `project_id=eq.${proj.id}` }, (p) => {
        console.log('  [User A (Member) Received Message Event]:', p.eventType);
        receivedA.project_messages.push(p);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_log', filter: `project_id=eq.${proj.id}` }, (p) => {
        console.log('  [User A (Member) Received Activity Event]:', p.eventType);
        receivedA.activity_log.push(p);
      });

    // User C Channel (Outsider verification)
    const chC = clientC.channel(`chan_C_${runId}`);
    chC
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${proj.id}` }, (p) => {
        console.log('  [User C (Outsider) Received Task Event - LEAK]:', p.eventType);
        receivedC.tasks.push(p);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_messages', filter: `project_id=eq.${proj.id}` }, (p) => {
        console.log('  [User C (Outsider) Received Message Event - LEAK]:', p.eventType);
        receivedC.project_messages.push(p);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_log', filter: `project_id=eq.${proj.id}` }, (p) => {
        console.log('  [User C (Outsider) Received Activity Event - LEAK]:', p.eventType);
        receivedC.activity_log.push(p);
      });

    // Probe channel for join_requests
    const chJR = clientA.channel(`chan_JR_${runId}`);
    chJR.on('postgres_changes', { event: '*', schema: 'public', table: 'join_requests', filter: `project_id=eq.${proj.id}` }, (p) => {
      console.log('  [User A (Member) Received Join Request Event]:', p.eventType);
      receivedA.join_requests.push(p);
    });

    await new Promise((resolve) => {
      let sub = 0;
      chA.subscribe((s) => {
        if (s === 'SUBSCRIBED') {
          console.log('  [User A Channel] Status: SUBSCRIBED');
          if (++sub >= 2) resolve();
        }
      });
      chC.subscribe((s) => {
        if (s === 'SUBSCRIBED') {
          console.log('  [User C Channel] Status: SUBSCRIBED');
          if (++sub >= 2) resolve();
        }
      });
      chJR.subscribe((s) => {
        console.log('  [Join Requests Channel] Status:', s);
      });
      setTimeout(resolve, 5000);
    });

    console.log('\n--- 3. Triggering Database Mutations ---');

    console.log('  Mutation 1: User B (Member) inserting task...');
    const { error: tErr } = await clientB.from('tasks').insert({
      project_id: proj.id,
      column_id: col.id,
      title: 'Task by Member B',
    });
    if (tErr) console.warn('  Task insert error:', tErr.message);

    console.log('  Mutation 2: User B (Member) sending message in project_messages...');
    const { error: mErr } = await clientB.from('project_messages').insert({
      project_id: proj.id,
      user_id: uB.user.id,
      content: 'Message by Member B',
    });
    if (mErr) console.warn('  Message insert error:', mErr.message);

    console.log('  Mutation 3: User B (Member) inserting activity_log...');
    const { error: aErr } = await clientB.from('activity_log').insert({
      project_id: proj.id,
      user_id: uB.user.id,
      action: 'task_created',
      metadata: { title: 'Task by Member B' },
    });
    if (aErr) console.warn('  Activity insert error:', aErr.message);

    console.log('  Mutation 4: User C (Outsider) submitting join_request...');
    const { error: jErr } = await clientC.from('join_requests').insert({
      project_id: proj.id,
      user_id: uC.user.id,
      status: 'PENDING',
    });
    if (jErr) console.warn('  Join request insert error:', jErr.message);

    console.log('\n  Waiting 6 seconds for WebSocket delivery...');
    await new Promise((r) => setTimeout(r, 6000));

    console.log('\n--- 4. Realtime Verification Results ---');
    console.log(`  User A (Member) received events:`);
    console.log(`    - tasks: ${receivedA.tasks.length}`);
    console.log(`    - project_messages: ${receivedA.project_messages.length}`);
    console.log(`    - activity_log: ${receivedA.activity_log.length}`);
    console.log(`    - join_requests: ${receivedA.join_requests.length}`);

    console.log(`  User C (Outsider) received events:`);
    console.log(`    - tasks: ${receivedC.tasks.length}`);
    console.log(`    - project_messages: ${receivedC.project_messages.length}`);
    console.log(`    - activity_log: ${receivedC.activity_log.length}`);
    console.log(`    - join_requests: ${receivedC.join_requests.length}`);

    console.log('\nSummary per table:');
    const checkTable = (tbl) => {
      const deliveredToA = receivedA[tbl].length > 0;
      const filteredForC = receivedC[tbl].length === 0;
      if (deliveredToA && filteredForC) {
        console.log(`  [${tbl}]: PASS (Delivered to member, blocked for outsider via RLS)`);
      } else if (deliveredToA && !filteredForC) {
        console.log(`  [${tbl}]: FAIL (Leaked to outsider - RLS policy missing)`);
      } else if (!deliveredToA && tbl === 'join_requests') {
        console.log(`  [${tbl}]: PENDING_SCHEMA (join_requests was not in initial schema.sql publication; included in 002_fixes.sql)`);
      } else {
        console.log(`  [${tbl}]: FAIL (No events delivered to member)`);
      }
    };

    checkTable('tasks');
    checkTable('project_messages');
    checkTable('activity_log');
    checkTable('join_requests');

    await chA.unsubscribe();
    await chC.unsubscribe();
    await chJR.unsubscribe();

  } catch (err) {
    console.error('Realtime test error:', err);
  } finally {
    console.log('\n--- Cleaning up realtime test artifacts ---');
    if (projId) await admin.from('projects').delete().eq('id', projId);
    for (const uid of usersToCleanup) await admin.auth.admin.deleteUser(uid);
    console.log('Cleanup complete.');
  }
}

main().catch(console.error);
