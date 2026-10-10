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

async function checkUserB() {
  const email = `rt_check_${Date.now()}@test.com`;
  const pass = 'Pass123!@#';
  const { data: u } = await admin.auth.admin.createUser({ email, password: pass, email_confirm: true });
  
  const clientB = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { data: signin, error: sErr } = await clientB.auth.signInWithPassword({ email, password: pass });
  console.log('SignIn error:', sErr ? sErr.message : 'none');

  const { data: proj } = await admin.from('projects').insert({ name: 'Check Proj', owner_id: u.user.id }).select().single();
  await admin.from('project_members').insert({ project_id: proj.id, user_id: u.user.id, role: 'MEMBER' });
  const { data: col } = await admin.from('columns').insert({ project_id: proj.id, name: 'To Do' }).select().single();

  const { data: t, error: tErr } = await clientB.from('tasks').insert({
    project_id: proj.id,
    column_id: col.id,
    title: 'Test Task by User B',
    position: 0,
  }).select();

  console.log('User B Task insert error:', tErr ? tErr : 'SUCCESS');

  await admin.from('projects').delete().eq('id', proj.id);
  await admin.auth.admin.deleteUser(u.user.id);
}

checkUserB().catch(console.error);
