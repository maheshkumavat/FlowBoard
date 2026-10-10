import { NextResponse } from 'next/server';
import { supabaseAdmin, getServerUser, getProjectMemberRole } from '../../../../../lib/supabase';
import { logActivity } from '../../../../../lib/activityLogger';

export async function GET(req, { params }) {
  try {
    const taskId = params.id;
    const currentUser = await getServerUser(req);
    if (!currentUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: task, error: taskErr } = await supabaseAdmin
      .from('tasks')
      .select('project_id')
      .eq('id', taskId)
      .maybeSingle();

    if (taskErr || !task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const role = await getProjectMemberRole(task.project_id, currentUser);
    if (!role) {
      return NextResponse.json({ error: 'Forbidden: You are not a member of this project' }, { status: 403 });
    }

    const { data: comments, error } = await supabaseAdmin
      .from('comments')
      .select('id, content, created_at, user:profiles(id, name, email, github_username)')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return NextResponse.json({ comments: comments || [] });
  } catch (error) {
    console.error('Comments GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch comments' }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const taskId = params.id;
    const currentUser = await getServerUser(req);
    if (!currentUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = currentUser.id;

    const body = await req.json();
    const { content } = body;

    if (!content || content.trim() === '') {
      return NextResponse.json({ error: 'Comment content cannot be empty' }, { status: 400 });
    }

    // Fetch task for project_id and authorization check
    const { data: task, error: taskErr } = await supabaseAdmin
      .from('tasks')
      .select('project_id, title')
      .eq('id', taskId)
      .maybeSingle();

    if (taskErr || !task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const role = await getProjectMemberRole(task.project_id, currentUser);
    if (!role) {
      return NextResponse.json({ error: 'Forbidden: You are not a member of this project' }, { status: 403 });
    }
    if (role === 'VIEWER') {
      return NextResponse.json({ error: 'Forbidden: Viewers have read-only access' }, { status: 403 });
    }

    const { data: comment, error: insertError } = await supabaseAdmin
      .from('comments')
      .insert({
        task_id: taskId,
        user_id: userId,
        content: content.trim(),
      })
      .select('id, content, created_at, user:profiles(id, name, email)')
      .single();

    if (insertError || !comment) {
      return NextResponse.json({ error: insertError?.message || 'Failed to add comment' }, { status: 500 });
    }

    await logActivity({
      projectId: task.project_id,
      userId,
      action: 'comment_added',
      metadata: { taskTitle: task.title, commentContent: content.trim().slice(0, 40) },
    });

    return NextResponse.json({
      comment: {
        id: comment.id,
        content: comment.content,
        createdAt: comment.created_at,
        user: comment.user ? { id: comment.user.id, name: comment.user.name, email: comment.user.email } : null,
      },
    }, { status: 201 });
  } catch (error) {
    console.error('Comment POST error:', error);
    return NextResponse.json({ error: 'Failed to add comment' }, { status: 500 });
  }
}
