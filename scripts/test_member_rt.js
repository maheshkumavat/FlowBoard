const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const lines = env.split(/\r?\n/);
for (const line of lines) {
  const [k, ...v] = line.split('=');
  if (k && v.length) process.env[k.trim()] = v.join('=').trim();
}

const { createClient } = require('@supabase/supabase-js');
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function testWithMemberInsert() {
  const runId = Date.now().toString().slice(-6);

  // User A (Owner)
  const emailA = `rta_${runId}@flowboard.test`;
  const passA = `PassA_${runId}!`;
  const { data: uA } = await admin.auth.admin.createUser({ email: emailA, password: passA, email_confirm: true });

  // User B (Member)
  const emailB = `rtb_${runId}@flowboard.test`;
  const passB = `PassB_${runId}!`;
  const { data: uB } = await admin.auth.admin.createUser({ email: emailB, password: passB, email_confirm: true });

  // User C (Outsider)
  const emailC = `rtc_${runId}@flowboard.test`;
  const passC = `PassC_${runId}!`;
  const { data: uC } = await admin.auth.admin.createUser({ email: emailC, password: passC, email_confirm: true });

  // Project & Members
  const { data: proj } = await admin.from('projects').insert({ name: `RT Proj ${runId}`, owner_id: uA.user.id }).select().single();
  await admin.from('project_members').insert([
    { project_id: proj.id, user_id: uA.user.id, role: 'ADMIN' },
    { project_id: proj.id, user_id: uB.user.id, role: 'MEMBER' },
  ]);
  const { data: col } = await admin.from('columns').insert({ project_id: proj.id, name: 'To Do' }).select().single();

  // Client A
  const clientA = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { data: sessA } = await clientA.auth.signInWithPassword({ email: emailA, password: passA });
  clientA.realtime.setAuth(sessA.session.access_token);

  // Client C
  const clientC = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { data: sessC } = await clientC.auth.signInWithPassword({ email: emailC, password: passC });
  clientC.realtime.setAuth(sessC.session.access_token);

  // Client B
  const clientB = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await clientB.auth.signInWithPassword({ email: emailB, password: passB });

  const eventsA = [];
  const eventsC = [];

  const chA = clientA.channel(`chan_A_${runId}`);
  chA.on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${proj.id}` }, (p) => {
    console.log('[User A Received Task]:', p.eventType);
    eventsA.push(p);
  });
  chA.on('postgres_changes', { event: '*', schema: 'public', table: 'project_messages', filter: `project_id=eq.${proj.id}` }, (p) => {
    console.log('[User A Received Message]:', p.eventType);
    eventsA.push(p);
  });
  chA.on('postgres_changes', { event: '*', schema: 'public', table: 'activity_log', filter: `project_id=eq.${proj.id}` }, (p) => {
    console.log('[User A Received Activity]:', p.eventType);
    eventsA.push(p);
  });

  const chC = clientC.channel(`chan_C_${runId}`);
  chC.on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${proj.id}` }, (p) => {
    console.log('[User C Received Task - LEAK]:', p.eventType);
    eventsC.push(p);
  });

  await new Promise((resolve) => {
    let sub = 0;
    chA.subscribe((s) => {
      if (s === 'SUBSCRIBED' && ++sub === 2) resolve();
    });
    chC.subscribe((s) => {
      if (s === 'SUBSCRIBED' && ++sub === 2) resolve();
    });
    setTimeout(resolve, 5000);
  });

  console.log('Inserting with Client B (Member)...');
  const { data: tB, error: tErr } = await clientB.from('tasks').insert({
    project_id: proj.id,
    column_id: col.id,
    title: 'Task by Member B',
  }).select();
  console.log('Task insert by B:', tErr ? tErr.message : 'OK');

  const { error: mErr } = await clientB.from('project_messages').insert({
    project_id: proj.id,
    user_id: uB.user.id,
    content: 'Message by Member B',
  });
  console.log('Message insert by B:', mErr ? mErr.message : 'OK');

  const { error: aErr } = await clientB.from('activity_log').insert({
    project_id: proj.id,
    user_id: uB.user.id,
    action: 'task_created',
    metadata: { title: 'Task by Member B' },
  });
  console.log('Activity insert by B:', aErr ? aErr.message : 'OK');

  console.log('Waiting 6s...');
  await new Promise(r => setTimeout(r, 6000));

  console.log('\nFinal User A count:', eventsA.length);
  console.log('Final User C count:', eventsC.length);

  await admin.from('projects').delete().eq('id', proj.id);
  await admin.auth.admin.deleteUser(uA.user.id);
  await admin.auth.admin.deleteUser(uB.user.id);
  await admin.auth.admin.deleteUser(uC.user.id);
}

testWithMemberInsert().catch(console.error);
