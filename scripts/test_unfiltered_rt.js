const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const lines = env.split(/\r?\n/);
for (const line of lines) {
  const [k, ...v] = line.split('=');
  if (k && v.length) process.env[k.trim()] = v.join('=').trim();
}

const { createClient } = require('@supabase/supabase-js');
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function testUnfiltered() {
  console.log('Testing Realtime with admin client and unfiltered channel...');
  
  const { data: u } = await admin.auth.admin.createUser({ email: `rt_probe_${Date.now()}@test.com`, password: 'Password123!', email_confirm: true });
  const { data: p } = await admin.from('projects').insert({ name: 'Probe RT Proj', owner_id: u.user.id }).select().single();
  const { data: col } = await admin.from('columns').insert({ project_id: p.id, name: 'To Do' }).select().single();

  const ch = admin.channel('admin-test-all');
  let events = [];

  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, (payload) => {
    console.log('[Admin Tasks Event received!]:', payload.eventType);
    events.push(payload);
  });

  await new Promise((resolve) => {
    ch.subscribe((status) => {
      console.log('Admin channel status:', status);
      if (status === 'SUBSCRIBED') resolve();
    });
    setTimeout(resolve, 4000);
  });

  console.log('Inserting test task with admin client...');
  const { data: t, error } = await admin.from('tasks').insert({
    project_id: p.id,
    column_id: col.id,
    title: 'Admin Realtime Probe Task',
  }).select().single();

  console.log('Insert error:', error ? error.message : 'none');

  console.log('Waiting 6s for event...');
  await new Promise(r => setTimeout(r, 6000));

  console.log('Total events received:', events.length);

  await admin.from('projects').delete().eq('id', p.id);
  await ch.unsubscribe();
}

testUnfiltered().catch(console.error);
