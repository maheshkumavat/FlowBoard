const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const lines = env.split(/\r?\n/);
let url = '', key = '';
for (const l of lines) {
  if (l.startsWith('NEXT_PUBLIC_SUPABASE_URL=')) url = l.split('=')[1].trim().replace(/^['"]|['"]$/g, '');
  if (l.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) key = l.split('=')[1].trim().replace(/^['"]|['"]$/g, '');
}
const { createClient } = require('@supabase/supabase-js');
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function verifyEmpty() {
  const { data: users } = await admin.auth.admin.listUsers();
  const testUsers = (users?.users || []).filter(u => u.email?.includes('flowboard') || u.email?.includes('test') || u.email?.includes('rt_'));
  console.log('Total auth users:', users?.users?.length, '| Test users remaining:', testUsers.length);
  if (testUsers.length > 0) {
    for (const u of testUsers) {
      await admin.auth.admin.deleteUser(u.id);
      console.log('Cleaned residual user:', u.email);
    }
  }

  const { data: projs } = await admin.from('projects').select('id, name');
  const testProjs = (projs || []).filter(p => p.name?.includes('Test') || p.name?.includes('Smoke') || p.name?.includes('Probe') || p.name?.includes('RT'));
  console.log('Total projects:', projs?.length, '| Test projects remaining:', testProjs.length);
  if (testProjs.length > 0) {
    for (const p of testProjs) {
      await admin.from('projects').delete().eq('id', p.id);
      console.log('Cleaned residual project:', p.name);
    }
  }

  const { data: profiles } = await admin.from('profiles').select('id, email');
  console.log('Total profile rows remaining in DB:', profiles?.length || 0);
}
verifyEmpty().catch(console.error);
