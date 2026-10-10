const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const lines = env.split(/\r?\n/);
for (const line of lines) {
  const [k, ...v] = line.split('=');
  if (k && v.length) process.env[k.trim()] = v.join('=').trim();
}

const { createClient } = require('@supabase/supabase-js');
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

async function testAuthRealtime() {
  const runId = Date.now().toString().slice(-6);

  // 1. Create User A (Owner/Admin)
  const emailA = `rta_${runId}@flowboard.test`;
  const passA = `PassA_${runId}!`;
  const { data: uA } = await admin.auth.admin.createUser({ email: emailA, password: passA, email_confirm: true });
  
  // 2. Create User C (Outsider)
  const emailC = `rtc_${runId}@flowboard.test`;
  const passC = `PassC_${runId}!`;
  const { data: uC } = await admin.auth.admin.createUser({ email: emailC, password: passC, email_confirm: true });

  // 3. User A signs in
  const clientA = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { data: sessA } = await clientA.auth.signInWithPassword({ email: emailA, password: passA });
  clientA.realtime.setAuth(sessA.session.access_token);

  // 4. User C signs in
  const clientC = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { data: sessC } = await clientC.auth.signInWithPassword({ email: emailC, password: passC });
  clientC.realtime.setAuth(sessC.session.access_token);

  // 5. Create Project & Column
  const { data: proj } = await admin.from('projects').insert({ name: `Auth RT Proj ${runId}`, owner_id: uA.user.id }).select().single();
  await admin.from('project_members').insert({ project_id: proj.id, user_id: uA.user.id, role: 'ADMIN' });
  const { data: col } = await admin.from('columns').insert({ project_id: proj.id, name: 'To Do' }).select().single();

  const eventsA = [];
  const eventsC = [];

  const chA = clientA.channel(`proj_A_${runId}`);
  chA.on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${proj.id}` }, (p) => {
    console.log('[User A (Member) Task Event]:', p.eventType);
    eventsA.push(p);
  });
  chA.on('postgres_changes', { event: '*', schema: 'public', table: 'project_messages', filter: `project_id=eq.${proj.id}` }, (p) => {
    console.log('[User A (Member) Message Event]:', p.eventType);
    eventsA.push(p);
  });
  chA.on('postgres_changes', { event: '*', schema: 'public', table: 'activity_log', filter: `project_id=eq.${proj.id}` }, (p) => {
    console.log('[User A (Member) Activity Event]:', p.eventType);
    eventsA.push(p);
  });

  const chC = clientC.channel(`proj_C_${runId}`);
  chC.on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${proj.id}` }, (p) => {
    console.log('[User C (Outsider) Task Event - SHOULD NOT RECEIVE]:', p.eventType);
    eventsC.push(p);
  });
  chC.on('postgres_changes', { event: '*', schema: 'public', table: 'project_messages', filter: `project_id=eq.${proj.id}` }, (p) => {
    console.log('[User C (Outsider) Message Event - SHOULD NOT RECEIVE]:', p.eventType);
    eventsC.push(p);
  });

  await new Promise((resolve) => {
    let sub = 0;
    chA.subscribe((s) => {
      console.log('chA status:', s);
      if (s === 'SUBSCRIBED' && ++sub === 2) resolve();
    });
    chC.subscribe((s) => {
      console.log('chC status:', s);
      if (s === 'SUBSCRIBED' && ++sub === 2) resolve();
    });
    setTimeout(resolve, 5000);
  });

  console.log('\nInserting task as admin for project...');
  await admin.from('tasks').insert({
    project_id: proj.id,
    column_id: col.id,
    title: 'Task by Member',
  });

  console.log('Inserting message as admin for project...');
  await admin.from('project_messages').insert({
    project_id: proj.id,
    user_id: uA.user.id,
    content: 'Message by Member',
  });

  console.log('Inserting activity as admin for project...');
  await admin.from('activity_log').insert({
    project_id: proj.id,
    user_id: uA.user.id,
    action: 'task_created',
    metadata: { title: 'Task by Member' },
  });

  console.log('Waiting 6s for realtime delivery...');
  await new Promise(r => setTimeout(r, 6000));

  console.log('\nUser A received count:', eventsA.length);
  console.log('User C received count:', eventsC.length);

  await admin.from('projects').delete().eq('id', proj.id);
  await admin.auth.admin.deleteUser(uA.user.id);
  await admin.auth.admin.deleteUser(uC.user.id);
}

testAuthRealtime().catch(console.error);
