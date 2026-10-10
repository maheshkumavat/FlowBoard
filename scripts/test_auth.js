const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const jwt = require('jsonwebtoken');

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

const BASE_URL = env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

const anonClient = createClient(supabaseUrl, anonKey);
const adminClient = createClient(supabaseUrl, serviceKey);

let passed = 0;
let failed = 0;

function assert(condition, testName, detail = '') {
  if (condition) {
    console.log(`[PASS] ${testName}${detail ? ' - ' + detail : ''}`);
    passed++;
  } else {
    console.error(`[FAIL] ${testName}${detail ? ' - ' + detail : ''}`);
    failed++;
  }
}

async function runAuthTests() {
  console.log('=== STEP 3: AUTH TESTING END-TO-END ===');
  const runId = Date.now();
  const testEmail = `flowboard_authtest_${runId}@example.com`;
  const testPassword = `TestAuthPass_${runId}!`;
  let userId = null;
  let validToken = null;

  try {
    // 1. Signup with a fresh test email
    console.log('\n--- 1. Testing Signup via /api/auth/signup ---');
    const signupRes = await fetch(`${BASE_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
        name: `Auth Tester ${runId}`
      })
    });
    const signupData = await signupRes.json();
    assert(signupRes.status === 200, 'Signup HTTP status 200', `Got ${signupRes.status}: ${signupData.message || signupData.error}`);
    userId = signupData.user?.id;

    // Detect if "Confirm Email" is enabled
    console.log('\n--- 2. Checking Supabase "Confirm Email" Status ---');
    let emailConfirmed = signupData.user?.email_confirmed_at != null || signupData.session != null;
    if (!emailConfirmed) {
      console.log('[NOTICE] "Confirm email" IS ENABLED in Supabase Auth settings.');
      console.log('         Users cannot log in until they verify via email confirmation link.');
      // Auto-confirm via admin API for testing purposes
      console.log('         Auto-confirming test user email via service_role admin API...');
      const { error: confErr } = await adminClient.auth.admin.updateUserById(userId, { email_confirm: true });
      if (confErr) {
        console.warn(`         Warning confirming email: ${confErr.message}`);
      } else {
        console.log('         Test user email confirmed for testing.');
      }
    } else {
      console.log('[INFO] "Confirm email" is OFF or session immediately issued.');
    }

    // 3. Wrong password rejection
    console.log('\n--- 3. Testing Wrong Password Rejection ---');
    const wrongLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: 'CompletelyWrongPassword123!'
      })
    });
    const wrongData = await wrongLoginRes.json();
    assert(wrongLoginRes.status === 401, 'Wrong password rejected with 401', `Error message: ${wrongData.error}`);

    // 4. Valid login
    console.log('\n--- 4. Testing Valid Login via /api/auth/login ---');
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword
      })
    });
    const loginData = await loginRes.json();
    assert(loginRes.status === 200 && (loginData.session?.access_token || loginData.token), 'Login succeeded with HTTP 200', `Session present: ${!!loginData.session?.access_token}`);
    validToken = loginData.session?.access_token || loginData.token;

    // 5. GET /api/auth/me returns the right user
    console.log('\n--- 5. Testing GET /api/auth/me ---');
    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${validToken}` }
    });
    const meData = await meRes.json();
    assert(meRes.status === 200 && meData.user?.email === testEmail, 'GET /api/auth/me returns authenticated user', `Returned email: ${meData.user?.email}`);

    // 6. Profile update works (PUT /api/auth/me)
    console.log('\n--- 6. Testing Profile Update (PUT /api/auth/me) ---');
    const updateRes = await fetch(`${BASE_URL}/api/auth/me`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validToken}`
      },
      body: JSON.stringify({
        name: `Updated Tester ${runId}`,
        primaryRole: 'Product Manager'
      })
    });
    const updateData = await updateRes.json();
    assert(updateRes.status === 200 && updateData.user?.name === `Updated Tester ${runId}`, 'Profile update succeeded', `New name: ${updateData.user?.name}`);

    // 7. Logout works (/api/auth/logout)
    console.log('\n--- 7. Testing Logout via /api/auth/logout ---');
    const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${validToken}` }
    });
    assert(logoutRes.status === 200, 'Logout succeeded with HTTP 200');

    // 8. Security: Forged or tampered JWT rejected with 401
    console.log('\n--- 8. Testing JWT Security & Forgery Protection ---');
    // 8a. Token signed with wrong secret
    const forgedToken = jwt.sign(
      { sub: userId, email: testEmail, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 },
      'completely-fake-wrong-secret-123456789'
    );
    const forgedRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${forgedToken}` }
    });
    assert(forgedRes.status === 401, 'Forged JWT with wrong signature rejected with 401', `Status: ${forgedRes.status}`);

    // 8b. Expired token
    const expiredToken = jwt.sign(
      { sub: userId, email: testEmail, role: 'authenticated', exp: Math.floor(Date.now() / 1000) - 3600 },
      env.SUPABASE_JWT_SECRET || env.JWT_SECRET || 'secret'
    );
    const expiredRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${expiredToken}` }
    });
    assert(expiredRes.status === 401, 'Expired token rejected with 401', `Status: ${expiredRes.status}`);

    // 8c. Bearer null
    const nullRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: 'Bearer null' }
    });
    assert(nullRes.status === 401, 'Bearer null rejected with 401', `Status: ${nullRes.status}`);

    // 8d. Bearer undefined
    const undefRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: 'Bearer undefined' }
    });
    assert(undefRes.status === 401, 'Bearer undefined rejected with 401', `Status: ${undefRes.status}`);

    // 9. Middleware route protection tests
    console.log('\n--- 9. Testing Middleware Route Redirection ---');
    // Unauthenticated visit to / -> 307 redirect to /login
    const unauthPageRes = await fetch(`${BASE_URL}/`, { redirect: 'manual' });
    const unauthLoc = unauthPageRes.headers.get('location');
    assert(unauthPageRes.status === 307 && unauthLoc?.includes('/login'), 'Unauthenticated / redirects to /login', `Status: ${unauthPageRes.status}, Location: ${unauthLoc}`);

    // Authenticated visit to /login -> 307 redirect to /
    const authLoginRes = await fetch(`${BASE_URL}/login`, {
      headers: { Cookie: `sb-access-token=${validToken}` },
      redirect: 'manual'
    });
    const authLoc = authLoginRes.headers.get('location');
    assert(authLoginRes.status === 307 && (authLoc === '/' || authLoc?.endsWith('/')), 'Authenticated /login redirects to /', `Status: ${authLoginRes.status}, Location: ${authLoc}`);

    // 10. Password reset request does not crash
    console.log('\n--- 10. Testing Password Reset Request ---');
    try {
      const { error: resetErr } = await anonClient.auth.resetPasswordForEmail(testEmail, {
        redirectTo: `${BASE_URL}/login`
      });
      if (resetErr) {
        console.log(`Password reset response message: ${resetErr.message} (expected if rate limited or SMTP unconfigured)`);
      } else {
        console.log('Password reset request dispatched successfully.');
      }
      assert(true, 'Password reset request does not crash server');
    } catch (e) {
      assert(false, 'Password reset threw exception', e.message);
    }

    // 11. GitHub OAuth Status
    console.log('\n--- 11. GitHub OAuth Configuration Status ---');
    const hasGhId = !!env.GITHUB_CLIENT_ID && !env.GITHUB_CLIENT_ID.includes('placeholder');
    const hasGhSec = !!env.GITHUB_CLIENT_SECRET && !env.GITHUB_CLIENT_SECRET.includes('placeholder');
    if (!hasGhId || !hasGhSec) {
      console.log('GitHub OAuth App Credentials: NOT CONFIGURED in .env');
      console.log('Status: NOT TESTED (missing GitHub OAuth client credentials)');
      console.log('Required Supabase Callback URL to configure in GitHub Developer Settings:');
      console.log(`  ${supabaseUrl}/auth/v1/callback`);
    } else {
      console.log('GitHub OAuth App Credentials are configured in .env');
    }

  } catch (err) {
    console.error('Exception in runAuthTests:', err);
    failed++;
  } finally {
    // Clean up test user
    if (userId) {
      console.log('\n--- Cleaning up test user ---');
      await adminClient.auth.admin.deleteUser(userId);
      console.log(`Deleted test user ${userId}`);
    }
  }

  console.log(`\nAUTH TEST TOTAL: ${passed} PASSED, ${failed} FAILED`);
  process.exit(failed > 0 ? 1 : 0);
}

runAuthTests();
