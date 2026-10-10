import { NextResponse } from 'next/server';
import { supabaseAdmin, getServerUser, getProjectMemberRole } from '../../../../lib/supabase';
import { evaluateTaskRisk } from '../../../../lib/ai/riskEvaluator';
import { logActivity } from '../../../../lib/activityLogger';
import { addNotification } from '../../../../lib/notificationsStore';

export const dynamic = 'force-dynamic';

export async function PUT(req, { params }) {
  try {
    const taskId = params.id;
    const body = await req.json();

    const currentUser = await getServerUser(req);
    if (!currentUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const currentUserId = currentUser.id;

    // Fetch existing task to check project_id
    const { data: existingTask, error: fetchErr } = await supabaseAdmin
      .from('tasks')
      .select('project_id, title, description')
      .eq('id', taskId)
      .maybeSingle();

    if (fetchErr || !existingTask) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const targetProjectId = existingTask.project_id || body.projectId;

    const userRole = await getProjectMemberRole(targetProjectId, currentUser);
    if (!userRole) {
      return NextResponse.json({ error: 'Forbidden: You are not a member of this project' }, { status: 403 });
    }
    if (userRole === 'VIEWER') {
      return NextResponse.json({ error: 'Forbidden: Viewers have read-only access' }, { status: 403 });
    }

    // RBAC Check: Assigning task to another member is reserved for ADMIN only
    if (body.assigneeId !== undefined && body.assigneeId && body.assigneeId !== currentUserId) {
      if (userRole !== 'ADMIN') {
        return NextResponse.json(
          { error: 'Only project Admins can assign tasks to other team members. Members may self-assign.' },
          { status: 403 }
        );
      }
    }

    const updateData = {};
    if (body.title !== undefined) updateData.title = body.title.trim();
    if (body.description !== undefined) updateData.description = body.description ? body.description.trim() : null;
    if (body.priority !== undefined) updateData.priority = body.priority;
    if (body.requiredSkill !== undefined) updateData.required_skill = body.requiredSkill ? body.requiredSkill.trim() : null;
    if (body.dueDate !== undefined || body.due_date !== undefined) {
      updateData.due_date = body.dueDate || body.due_date || null;
    }

    if (body.startDate !== undefined || body.start_date !== undefined) {
      const sDate = body.startDate || body.start_date;
      if (sDate) {
        const currentDesc = updateData.description !== undefined ? updateData.description || '' : existingTask?.description || '';
        const cleanDesc = currentDesc.replace(/\[START_DATE:[^\]]+\]/g, '').trim();
        const sDateIso = new Date(sDate).toISOString().split('T')[0];
        updateData.description = `${cleanDesc} [START_DATE:${sDateIso}]`.trim();
      }
    }
    if (body.assigneeId !== undefined) updateData.assignee_id = body.assigneeId || null;
    if (body.columnId !== undefined) updateData.column_id = body.columnId;
    if (body.position !== undefined) updateData.position = parseInt(body.position, 10);

    const { data: updatedTask, error: updateError } = await supabaseAdmin
      .from('tasks')
      .update(updateData)
      .eq('id', taskId)
      .select(`
        *,
        assignee:profiles!assignee_id(id, name, email, github_username),
        comments(id, content, created_at, user:profiles(id, name))
      `)
      .single();

    if (updateError || !updatedTask) {
      return NextResponse.json({ error: updateError?.message || 'Failed to update task' }, { status: 500 });
    }

    if (updatedTask && currentUserId) {
      if (body.columnId !== undefined) {
        const { data: col } = await supabaseAdmin.from('columns').select('name').eq('id', body.columnId).single();
        await logActivity({
          projectId: updatedTask.project_id,
          userId: currentUserId,
          action: 'task_moved',
          metadata: { taskTitle: updatedTask.title, toColumn: col?.name || 'new column' },
        });
      }

      if (body.assigneeId !== undefined && updatedTask.assignee) {
        await logActivity({
          projectId: updatedTask.project_id,
          userId: currentUserId,
          action: 'task_assigned',
          metadata: { taskTitle: updatedTask.title, assigneeName: updatedTask.assignee.name },
        });

        // Create real-time task assignment notification for assignee
        if (body.assigneeId && body.assigneeId !== currentUserId) {
          await addNotification({
            userId: body.assigneeId,
            type: 'task_assigned',
            author: currentUser?.user_metadata?.name || currentUser?.email?.split('@')[0] || 'Admin',
            action: 'assigned you a task',
            text: `You've been assigned to "${updatedTask.title}"`,
            projectId: updatedTask.project_id,
            taskId: updatedTask.id,
          });
        }
      }
    }

    return NextResponse.json({
      task: {
        id: updatedTask.id,
        projectId: updatedTask.project_id,
        columnId: updatedTask.column_id,
        title: updatedTask.title,
        description: updatedTask.description,
        assigneeId: updatedTask.assignee_id,
        assignee: updatedTask.assignee,
        dueDate: updatedTask.due_date,
        priority: updatedTask.priority,
        requiredSkill: updatedTask.required_skill,
        riskFlag: updatedTask.risk_flag,
        comments: updatedTask.comments || [],
      },
    });
  } catch (error) {
    console.error('Task update error:', error);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}
