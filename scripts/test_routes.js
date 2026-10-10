const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const crypto = require('crypto');

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
    console.log(`  [PASS] ${testName}${detail ? ' - ' + detail : ''}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${testName}${detail ? ' - ' + detail : ''}`);
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

async function runStep4() {
  console.log('=== STEP 4: FULL API ROUTES & FEATURES END-TO-END TEST ===\n');

  const runId = Date.now().toString().slice(-6);
  const usersToCleanup = [];
  const projectsToCleanup = [];

  let tokenOwner = null;
  let userOwner = null;

  let tokenMember = null;
  let userMember = null;

  let tokenViewer = null;
  let userViewer = null;

  let tokenOutsider = null;
  let userOutsider = null;

  let projectId = null;
  let colTodoId = null;
  let colProgressId = null;
  let taskId = null;
  let memberRowMember = null;
  let memberRowViewer = null;
  let initialInviteCode = null;

  try {
    // 0. Create 4 Test Users using Admin API with auto-confirmed emails
    console.log('--- 0. Provisioning 4 Test Users ---');
    async function createTestUser(roleLabel) {
      const email = `test_${roleLabel}_${runId}@flowboard.test`;
      const password = `TestPass_${roleLabel}_${runId}!`;
      const { data, error } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name: `User ${roleLabel} ${runId}` },
      });
      if (error) throw error;
      usersToCleanup.push(data.user.id);

      // Sign in to get access token
      const { data: signinData, error: signinErr } = await anonClient.auth.signInWithPassword({
        email,
        password,
      });
      if (signinErr) throw signinErr;
      return { user: data.user, token: signinData.session.access_token };
    }

    const ownerObj = await createTestUser('Owner');
    userOwner = ownerObj.user;
    tokenOwner = ownerObj.token;

    const memberObj = await createTestUser('Member');
    userMember = memberObj.user;
    tokenMember = memberObj.token;

    const viewerObj = await createTestUser('Viewer');
    userViewer = viewerObj.user;
    tokenViewer = viewerObj.token;

    const outsiderObj = await createTestUser('Outsider');
    userOutsider = outsiderObj.user;
    tokenOutsider = outsiderObj.token;

    console.log('  Provisioned Owner, Member, Viewer, Outsider test accounts successfully.\n');

    // 1. PROJECTS
    console.log('--- 1. Testing Projects Routes ---');
    // 1a. Create Project
    const createRes = await request('/api/projects', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOwner}` },
      body: JSON.stringify({
        name: `Sprint Board ${runId}`,
        description: 'E2E Testing Project',
        suggestedSkills: ['React', 'Node.js'],
      }),
    });
    assert(createRes.status === 201 && createRes.body?.project?.id, 'POST /api/projects creates project (201)');
    projectId = createRes.body?.project?.id;
    projectsToCleanup.push(projectId);

    // Verify creator is ADMIN and initial invite code exists
    const { data: pmOwner } = await adminClient.from('project_members').select('*').eq('project_id', projectId).eq('user_id', userOwner.id).single();
    assert(pmOwner?.role === 'ADMIN', 'Project creator automatically assigned ADMIN role in project_members');

    const { data: cols } = await adminClient.from('columns').select('*').eq('project_id', projectId).order('position');
    assert(cols?.length === 4 && cols.map(c => c.name).includes('To Do'), 'Project automatically provisioned with 4 default columns');
    colTodoId = cols?.find(c => c.name === 'To Do')?.id || cols[0]?.id;
    colProgressId = cols?.find(c => c.name === 'In Progress')?.id || cols[1]?.id;

    const { data: invCode } = await adminClient.from('project_invite_codes').select('*').eq('project_id', projectId).maybeSingle();
    assert(!!invCode?.code, 'Initial 5-minute invite code automatically created on project creation');
    initialInviteCode = invCode?.code;

    // Add User Member as MEMBER and User Viewer as VIEWER to project_members
    const { data: memRow } = await adminClient.from('project_members').insert({
      project_id: projectId,
      user_id: userMember.id,
      role: 'MEMBER'
    }).select().single();
    memberRowMember = memRow;

    const { data: viewRow } = await adminClient.from('project_members').insert({
      project_id: projectId,
      user_id: userViewer.id,
      role: 'VIEWER'
    }).select().single();
    memberRowViewer = viewRow;

    // 1b. List Projects
    const listOwnerRes = await request('/api/projects', { headers: { Authorization: `Bearer ${tokenOwner}` } });
    assert(listOwnerRes.status === 200 && listOwnerRes.body?.projects?.some(p => p.id === projectId), 'Owner lists project in GET /api/projects (200)');

    const listMemberRes = await request('/api/projects', { headers: { Authorization: `Bearer ${tokenMember}` } });
    assert(listMemberRes.status === 200 && listMemberRes.body?.projects?.some(p => p.id === projectId), 'Member lists project in GET /api/projects (200)');

    const listOutsiderRes = await request('/api/projects', { headers: { Authorization: `Bearer ${tokenOutsider}` } });
    assert(listOutsiderRes.status === 200 && !listOutsiderRes.body?.projects?.some(p => p.id === projectId), 'Outsider does NOT see project in GET /api/projects (200)');

    // 1c. Get Project by ID
    const getOwnerRes = await request(`/api/projects/${projectId}`, { headers: { Authorization: `Bearer ${tokenOwner}` } });
    assert(getOwnerRes.status === 200 && getOwnerRes.body?.project?.userRole === 'ADMIN', 'Owner GET /api/projects/[id] returns 200 (role: ADMIN)');

    const getMemberRes = await request(`/api/projects/${projectId}`, { headers: { Authorization: `Bearer ${tokenMember}` } });
    assert(getMemberRes.status === 200 && getMemberRes.body?.project?.userRole === 'MEMBER', 'Member GET /api/projects/[id] returns 200 (role: MEMBER)');

    const getViewerRes = await request(`/api/projects/${projectId}`, { headers: { Authorization: `Bearer ${tokenViewer}` } });
    assert(getViewerRes.status === 200 && getViewerRes.body?.project?.userRole === 'VIEWER', 'Viewer GET /api/projects/[id] returns 200 (role: VIEWER)');

    const getOutsiderRes = await request(`/api/projects/${projectId}`, { headers: { Authorization: `Bearer ${tokenOutsider}` } });
    assert(getOutsiderRes.status === 403, 'Outsider GET /api/projects/[id] returns 403 Forbidden');

    // 1d. Update Project (Admin only)
    const updateAdminRes = await request(`/api/projects/${projectId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenOwner}` },
      body: JSON.stringify({ name: `Sprint Board ${runId} (Updated)` })
    });
    assert(updateAdminRes.status === 200, 'Admin updates project name in PUT /api/projects/[id] (200)');

    const updateMemberRes = await request(`/api/projects/${projectId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({ name: 'Hacked Project Name' })
    });
    assert(updateMemberRes.status === 403, 'Member PUT /api/projects/[id] returns 403 Forbidden');

    const updateViewerRes = await request(`/api/projects/${projectId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenViewer}` },
      body: JSON.stringify({ name: 'Hacked Project Name' })
    });
    assert(updateViewerRes.status === 403, 'Viewer PUT /api/projects/[id] returns 403 Forbidden');

    // 1e. Preview by invite code
    if (initialInviteCode) {
      const previewRes = await request(`/api/projects/preview?code=${initialInviteCode}`);
      assert(previewRes.status === 200 && previewRes.body?.valid === true, 'GET /api/projects/preview returns valid project preview (200)');

      const previewWrongRes = await request(`/api/projects/preview?code=WRONGCODE123`);
      assert(previewWrongRes.status === 404, 'GET /api/projects/preview with invalid code returns 404');
    }

    // 2. COLUMNS
    console.log('\n--- 2. Testing Columns Routes ---');
    // Member creates column -> 201 OK
    const colMemberRes = await request('/api/columns', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({ projectId, name: `Testing Col ${runId}` })
    });
    assert(colMemberRes.status === 201 && colMemberRes.body?.column?.id, 'Member POST /api/columns creates column (201)');

    // Viewer creates column -> 403 Forbidden
    const colViewerRes = await request('/api/columns', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenViewer}` },
      body: JSON.stringify({ projectId, name: 'Viewer Col' })
    });
    assert(colViewerRes.status === 403, 'Viewer POST /api/columns returns 403 Forbidden');

    // Outsider creates column -> 403 Forbidden
    const colOutsiderRes = await request('/api/columns', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOutsider}` },
      body: JSON.stringify({ projectId, name: 'Outsider Col' })
    });
    assert(colOutsiderRes.status === 403, 'Outsider POST /api/columns returns 403 Forbidden');

    // 3. TASKS
    console.log('\n--- 3. Testing Tasks Routes ---');
    // Member creates task -> 201 OK
    const taskCreateRes = await request('/api/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({
        projectId,
        columnId: colTodoId,
        title: `Task Alpha ${runId}`,
        description: 'Member created task',
        priority: 'MEDIUM',
      })
    });
    assert(taskCreateRes.status === 201 && taskCreateRes.body?.task?.id, 'Member POST /api/tasks creates single task (201)');
    taskId = taskCreateRes.body?.task?.id;

    // Member batch creates tasks -> 201 OK
    const batchCreateRes = await request('/api/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({
        batch: true,
        projectId,
        columnId: colTodoId,
        tasks: [
          { title: `Batch Task 1 ${runId}`, description: 'Desc 1', priority: 'LOW' },
          { title: `Batch Task 2 ${runId}`, description: 'Desc 2', priority: 'HIGH' },
        ]
      })
    });
    assert(batchCreateRes.status === 201 && batchCreateRes.body?.tasks?.length === 2, 'Member POST /api/tasks batch creates tasks (201)');

    // Viewer creates task -> 403 Forbidden
    const taskViewerRes = await request('/api/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenViewer}` },
      body: JSON.stringify({ projectId, columnId: colTodoId, title: 'Viewer Task' })
    });
    assert(taskViewerRes.status === 403, 'Viewer POST /api/tasks returns 403 Forbidden');

    // Outsider creates task -> 403 Forbidden
    const taskOutsiderRes = await request('/api/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOutsider}` },
      body: JSON.stringify({ projectId, columnId: colTodoId, title: 'Outsider Task' })
    });
    assert(taskOutsiderRes.status === 403, 'Outsider POST /api/tasks returns 403 Forbidden');

    // Member updates task fields -> 200 OK
    const taskUpdateRes = await request(`/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({ title: `Task Alpha ${runId} (Renamed)`, priority: 'URGENT' })
    });
    assert(taskUpdateRes.status === 200 && taskUpdateRes.body?.task?.priority === 'URGENT', 'Member PUT /api/tasks/[id] updates fields (200)');

    // Member moves task between columns -> 200 OK
    const taskMoveRes = await request(`/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({ columnId: colProgressId })
    });
    assert(taskMoveRes.status === 200 && taskMoveRes.body?.task?.columnId === colProgressId, 'Member PUT /api/tasks/[id] moves task to new column (200)');

    // Member self-assigns task -> 200 OK
    const selfAssignRes = await request(`/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({ assigneeId: userMember.id })
    });
    assert(selfAssignRes.status === 200 && selfAssignRes.body?.task?.assigneeId === userMember.id, 'Member PUT /api/tasks/[id] self-assigns task (200)');

    // Member assigning task to another user -> 403 Forbidden
    const memberAssignOtherRes = await request(`/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({ assigneeId: userViewer.id })
    });
    assert(memberAssignOtherRes.status === 403, 'Member assigning task to another user returns 403 Forbidden (Admin only rule)');

    // Admin assigning task to another user -> 200 OK
    const adminAssignOtherRes = await request(`/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenOwner}` },
      body: JSON.stringify({ assigneeId: userViewer.id })
    });
    assert(adminAssignOtherRes.status === 200 && adminAssignOtherRes.body?.task?.assigneeId === userViewer.id, 'Admin assigns task to another team member (200)');

    // Viewer updates task -> 403 Forbidden
    const viewerUpdateRes = await request(`/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenViewer}` },
      body: JSON.stringify({ title: 'Viewer Attempt' })
    });
    assert(viewerUpdateRes.status === 403, 'Viewer PUT /api/tasks/[id] returns 403 Forbidden');

    // Outsider updates task -> 403 Forbidden
    const outsiderUpdateRes = await request(`/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenOutsider}` },
      body: JSON.stringify({ title: 'Outsider Attempt' })
    });
    assert(outsiderUpdateRes.status === 403, 'Outsider PUT /api/tasks/[id] returns 403 Forbidden');

    // 4. COMMENTS
    console.log('\n--- 4. Testing Comments Routes ---');
    // Member adds comment -> 201 OK
    const commentAddRes = await request(`/api/tasks/${taskId}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({ content: 'Member comment text' })
    });
    assert(commentAddRes.status === 201 && commentAddRes.body?.comment?.id, 'Member POST /api/tasks/[id]/comments adds comment (201)');

    // Viewer adds comment -> 403 Forbidden
    const commentViewerAddRes = await request(`/api/tasks/${taskId}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenViewer}` },
      body: JSON.stringify({ content: 'Viewer comment attempt' })
    });
    assert(commentViewerAddRes.status === 403, 'Viewer POST /api/tasks/[id]/comments returns 403 Forbidden');

    // Outsider adds comment -> 403 Forbidden
    const commentOutsiderAddRes = await request(`/api/tasks/${taskId}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOutsider}` },
      body: JSON.stringify({ content: 'Outsider comment attempt' })
    });
    assert(commentOutsiderAddRes.status === 403, 'Outsider POST /api/tasks/[id]/comments returns 403 Forbidden');

    // Member lists comments -> 200 OK
    const commentListMemRes = await request(`/api/tasks/${taskId}/comments`, { headers: { Authorization: `Bearer ${tokenMember}` } });
    assert(commentListMemRes.status === 200 && commentListMemRes.body?.comments?.length > 0, 'Member GET /api/tasks/[id]/comments returns 200');

    // Viewer lists comments -> 200 OK
    const commentListViewRes = await request(`/api/tasks/${taskId}/comments`, { headers: { Authorization: `Bearer ${tokenViewer}` } });
    assert(commentListViewRes.status === 200, 'Viewer GET /api/tasks/[id]/comments returns 200');

    // Outsider lists comments -> 403 Forbidden
    const commentListOutRes = await request(`/api/tasks/${taskId}/comments`, { headers: { Authorization: `Bearer ${tokenOutsider}` } });
    assert(commentListOutRes.status === 403, 'Outsider GET /api/tasks/[id]/comments returns 403 Forbidden');

    // 5. TEAM CHAT MESSAGES
    console.log('\n--- 5. Testing Messages Routes ---');
    // Member sends message -> 201 OK
    const msgSendRes = await request(`/api/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({ content: 'Hello team from member!' })
    });
    assert(msgSendRes.status === 201 && msgSendRes.body?.message?.id, 'Member POST /api/projects/[id]/messages sends message (201)');

    // Viewer sends message -> 403 Forbidden
    const msgViewerRes = await request(`/api/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenViewer}` },
      body: JSON.stringify({ content: 'Viewer message attempt' })
    });
    assert(msgViewerRes.status === 403, 'Viewer POST /api/projects/[id]/messages returns 403 Forbidden');

    // Outsider sends message -> 403 Forbidden
    const msgOutsiderRes = await request(`/api/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOutsider}` },
      body: JSON.stringify({ content: 'Outsider message attempt' })
    });
    assert(msgOutsiderRes.status === 403, 'Outsider POST /api/projects/[id]/messages returns 403 Forbidden');

    // Member lists messages -> 200 OK
    const msgListMemRes = await request(`/api/projects/${projectId}/messages`, { headers: { Authorization: `Bearer ${tokenMember}` } });
    assert(msgListMemRes.status === 200 && msgListMemRes.body?.messages?.length > 0, 'Member GET /api/projects/[id]/messages returns 200');

    // Viewer lists messages -> 200 OK
    const msgListViewRes = await request(`/api/projects/${projectId}/messages`, { headers: { Authorization: `Bearer ${tokenViewer}` } });
    assert(msgListViewRes.status === 200, 'Viewer GET /api/projects/[id]/messages returns 200');

    // Outsider lists messages -> 403 Forbidden
    const msgListOutRes = await request(`/api/projects/${projectId}/messages`, { headers: { Authorization: `Bearer ${tokenOutsider}` } });
    assert(msgListOutRes.status === 403, 'Outsider GET /api/projects/[id]/messages returns 403 Forbidden');

    // 6. ACTIVITY LOG
    console.log('\n--- 6. Testing Activity Log Routes ---');
    // Member lists activity -> 200 OK
    const actListMemRes = await request(`/api/projects/${projectId}/activity`, { headers: { Authorization: `Bearer ${tokenMember}` } });
    assert(actListMemRes.status === 200 && actListMemRes.body?.activity?.length > 0, 'Member GET /api/projects/[id]/activity returns 200 with recorded actions');

    // Viewer lists activity -> 200 OK
    const actListViewRes = await request(`/api/projects/${projectId}/activity`, { headers: { Authorization: `Bearer ${tokenViewer}` } });
    assert(actListViewRes.status === 200, 'Viewer GET /api/projects/[id]/activity returns 200');

    // Outsider lists activity -> 403 Forbidden
    const actListOutRes = await request(`/api/projects/${projectId}/activity`, { headers: { Authorization: `Bearer ${tokenOutsider}` } });
    assert(actListOutRes.status === 403, 'Outsider GET /api/projects/[id]/activity returns 403 Forbidden');

    // Member clears activity -> 403 Forbidden
    const actClearMemRes = await request(`/api/projects/${projectId}/activity`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenMember}` }
    });
    assert(actClearMemRes.status === 403, 'Member DELETE /api/projects/[id]/activity returns 403 Forbidden (Admin only)');

    // Admin clears activity -> 200 OK
    const actClearAdminRes = await request(`/api/projects/${projectId}/activity`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenOwner}` }
    });
    assert(actClearAdminRes.status === 200, 'Admin DELETE /api/projects/[id]/activity returns 200 OK');

    // 7. INVITE CODE & JOIN FLOW
    console.log('\n--- 7. Testing Invite Code & Join Flow ---');
    // Admin gets active invite code -> 200 OK
    const invGetRes = await request(`/api/projects/${projectId}/invite-code`, { headers: { Authorization: `Bearer ${tokenOwner}` } });
    assert(invGetRes.status === 200 && invGetRes.body?.inviteCode?.code, 'Admin GET /api/projects/[id]/invite-code returns 200');
    const validInviteCode = invGetRes.body?.inviteCode?.code;

    // Outsider joins with code -> creates join request
    const joinReqRes = await request('/api/projects/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOutsider}` },
      body: JSON.stringify({ code: validInviteCode })
    });
    assert(joinReqRes.status === 200 || joinReqRes.status === 201, 'Outsider POST /api/projects/join submits join request');
    const joinReqId = joinReqRes.body?.request?.id;

    // Admin lists join requests -> 200 OK
    const joinListAdminRes = await request(`/api/projects/${projectId}/join-requests`, { headers: { Authorization: `Bearer ${tokenOwner}` } });
    assert(joinListAdminRes.status === 200 && joinListAdminRes.body?.requests?.length > 0, 'Admin GET /api/projects/[id]/join-requests returns 200');

    // Member lists join requests -> 403 Forbidden
    const joinListMemRes = await request(`/api/projects/${projectId}/join-requests`, { headers: { Authorization: `Bearer ${tokenMember}` } });
    assert(joinListMemRes.status === 403, 'Member GET /api/projects/[id]/join-requests returns 403 Forbidden');

    // Admin approves join request -> 200 OK
    const joinApproveRes = await request(`/api/projects/${projectId}/join-requests`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOwner}` },
      body: JSON.stringify({
        requestId: joinReqId,
        action: 'accept',
        userId: userOutsider.id,
      })
    });
    assert(joinApproveRes.status === 200, 'Admin POST /api/projects/[id]/join-requests approves request (200)');

    // Verify userOutsider is now in project_members
    const { data: pmOutsiderNow } = await adminClient.from('project_members').select('*').eq('project_id', projectId).eq('user_id', userOutsider.id).maybeSingle();
    assert(!!pmOutsiderNow, 'Approved user is now an active member in project_members');

    // Test rejection with another dummy join request
    const { data: dummyReq } = await adminClient.from('join_requests').insert({
      project_id: projectId,
      user_id: userOutsider.id,
      status: 'pending',
      role: 'MEMBER'
    }).select().single();

    const joinRejectRes = await request(`/api/projects/${projectId}/join-requests`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOwner}` },
      body: JSON.stringify({
        requestId: dummyReq.id,
        action: 'reject',
        userId: userOutsider.id,
      })
    });
    assert(joinRejectRes.status === 200, 'Admin POST /api/projects/[id]/join-requests rejects request (200)');

    // Wrong code is rejected
    const wrongJoinRes = await request('/api/projects/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOutsider}` },
      body: JSON.stringify({ code: 'FAKE999' })
    });
    assert(wrongJoinRes.status === 404, 'POST /api/projects/join with non-existent code returns 404');

    // 8. EMAIL INVITE
    console.log('\n--- 8. Testing Email Invite Flow ---');
    const inviteEmailRes = await request(`/api/projects/${projectId}/invite-email`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOwner}` },
      body: JSON.stringify({
        email: `invited_${runId}@example.com`,
        role: 'MEMBER'
      })
    });
    assert(inviteEmailRes.status === 200 && inviteEmailRes.body?.inviteLink, 'Admin POST /api/projects/[id]/invite-email generates invite link (200)');
    const inviteLink = inviteEmailRes.body?.inviteLink;
    const inviteToken = inviteLink?.match(/token=([a-f0-9]+)/)?.[1];

    if (inviteToken) {
      // Accept invite as logged-in user
      const acceptRes = await request(`/api/invite/accept?token=${inviteToken}`, {
        headers: { Authorization: `Bearer ${tokenOutsider}` }
      });
      assert(acceptRes.status === 200, 'GET /api/invite/accept accepts valid token for logged-in user (200)');

      // Re-using expired / deleted token returns 404
      const reuseRes = await request(`/api/invite/accept?token=${inviteToken}`, {
        headers: { Authorization: `Bearer ${tokenOutsider}` }
      });
      assert(reuseRes.status === 404, 'Re-using consumed/deleted invite token returns 404');
    }

    // Check Resend status
    const hasResend = !!env.RESEND_API_KEY && !env.RESEND_API_KEY.includes('placeholder');
    if (!hasResend) {
      console.log('  [NOTICE] RESEND_API_KEY is not set: Email invite dispatch NOT TESTED (no email sent to live inboxes)');
    } else {
      console.log('  [INFO] RESEND_API_KEY is configured');
    }

    // 9. MEMBERS ROLE MANAGEMENT & REMOVAL
    console.log('\n--- 9. Testing Members Role Management & Removal ---');
    // Admin changes role of User Member to VIEWER -> 200 OK
    const roleChangeAdminRes = await request(`/api/projects/${projectId}/members`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenOwner}` },
      body: JSON.stringify({
        memberId: memberRowMember.id,
        role: 'VIEWER'
      })
    });
    assert(roleChangeAdminRes.status === 200, 'Admin PUT /api/projects/[id]/members updates role to VIEWER (200)');

    // Member attempts role change -> 403 Forbidden
    const roleChangeMemRes = await request(`/api/projects/${projectId}/members`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({
        memberId: memberRowViewer.id,
        role: 'ADMIN'
      })
    });
    assert(roleChangeMemRes.status === 403, 'Non-admin PUT /api/projects/[id]/members returns 403 Forbidden');

    // Member attempts to remove member -> 403 Forbidden
    const removeMemRes = await request(`/api/projects/${projectId}/members?memberId=${memberRowViewer.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenMember}` }
    });
    assert(removeMemRes.status === 403, 'Non-admin DELETE /api/projects/[id]/members returns 403 Forbidden');

    // Admin removes member -> 200 OK
    const removeAdminRes = await request(`/api/projects/${projectId}/members?memberId=${memberRowViewer.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenOwner}` }
    });
    assert(removeAdminRes.status === 200, 'Admin DELETE /api/projects/[id]/members removes member (200)');

    // 10. NOTIFICATIONS
    console.log('\n--- 10. Testing Notifications Routes ---');
    // Fetch notifications for User Member (should have received role update notification)
    const notifGetRes = await request('/api/notifications', { headers: { Authorization: `Bearer ${tokenMember}` } });
    assert(notifGetRes.status === 200 && Array.isArray(notifGetRes.body?.notifications), 'GET /api/notifications returns user notification list');

    // Mark read / delete notification
    const notifDelRes = await request('/api/notifications', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({})
    });
    assert(notifDelRes.status === 200, 'DELETE /api/notifications clears/reads notifications (200)');

    // 11. ACCOUNT DEACTIVATION & DELETION
    console.log('\n--- 11. Testing Account Deactivation & Deletion ---');
    // Notification preferences update
    const prefRes = await request('/api/auth/me', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({
        notificationPreferences: { taskAssigned: false, joinRequests: true, comments: false }
      })
    });
    assert(
      prefRes.status === 200 && prefRes.body?.user?.notificationPreferences?.taskAssigned === false,
      'PUT /api/auth/me saves and returns custom notification preferences'
    );

    // Deactivate account flag
    const deactRes = await request('/api/auth/me', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({ deactivateAccount: true })
    });
    assert(deactRes.status === 200, 'PUT /api/auth/me deactivation flag accepted (200)');

    // Sole Admin deletion block test:
    // UserOwner is sole admin of projectId which still has other members -> MUST BE BLOCKED!
    const delBlockedRes = await request('/api/auth/delete-account', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOwner}` },
      body: JSON.stringify({ confirm: true })
    });
    assert(
      delBlockedRes.status === 400 && delBlockedRes.body?.blockingProjects?.length > 0,
      'POST /api/auth/delete-account BLOCKED when sole admin of project with members (400 with blockingProjects)'
    );

    // Delete account of non-blocking user (UserMember)
    const delMemberRes = await request('/api/auth/delete-account', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenMember}` },
      body: JSON.stringify({ confirm: true })
    });
    assert(delMemberRes.status === 200, 'POST /api/auth/delete-account succeeds for non-blocking user (200)');

    // Verify UserMember is deleted from auth.users
    const { data: checkDeletedUser } = await adminClient.auth.admin.getUserById(userMember.id);
    assert(!checkDeletedUser?.user, 'User record is permanently deleted from auth.users');
    // Remove from usersToCleanup since already deleted
    const memIdx = usersToCleanup.indexOf(userMember.id);
    if (memIdx !== -1) usersToCleanup.splice(memIdx, 1);

    // 12. CLEANUP: Delete test project via API
    console.log('\n--- 12. Deleting Test Project via API ---');
    const delProjRes = await request(`/api/projects/${projectId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenOwner}` }
    });
    assert(delProjRes.status === 200, 'Admin DELETE /api/projects/[id] deletes project (200)');
    const projIdx = projectsToCleanup.indexOf(projectId);
    if (projIdx !== -1) projectsToCleanup.splice(projIdx, 1);

  } catch (err) {
    console.error('Exception in Step 4:', err);
    failed++;
  } finally {
    console.log('\n--- Cleaning up remaining test artifacts ---');
    for (const pid of projectsToCleanup) {
      try {
        await adminClient.from('projects').delete().eq('id', pid);
        console.log(`Deleted project ${pid}`);
      } catch (e) {}
    }
    for (const uid of usersToCleanup) {
      try {
        await adminClient.auth.admin.deleteUser(uid);
        console.log(`Deleted user ${uid}`);
      } catch (e) {}
    }
  }

  console.log(`\nSTEP 4 TOTAL: ${passed} PASSED, ${failed} FAILED`);
  process.exit(failed > 0 ? 1 : 0);
}

runStep4();
