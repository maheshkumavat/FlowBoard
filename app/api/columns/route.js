import { NextResponse } from 'next/server';
import { supabaseAdmin, getServerUser, getProjectMemberRole } from '../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    const user = await getServerUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { projectId, name } = body;

    if (!projectId || !name || name.trim() === '') {
      return NextResponse.json({ error: 'Project ID and column name are required' }, { status: 400 });
    }

    // Verify user role in project
    const role = await getProjectMemberRole(projectId, user);
    if (!role) {
      return NextResponse.json({ error: 'Forbidden: You are not a member of this project' }, { status: 403 });
    }

    if (role === 'VIEWER') {
      return NextResponse.json({ error: 'Forbidden: Viewers have read-only access' }, { status: 403 });
    }

    const { data: cols } = await supabaseAdmin
      .from('columns')
      .select('position')
      .eq('project_id', projectId)
      .order('position', { ascending: false })
      .limit(1);

    const nextPos = cols && cols.length > 0 ? cols[0].position + 1 : 0;

    const { data: col, error } = await supabaseAdmin
      .from('columns')
      .insert({
        project_id: projectId,
        name: name.trim(),
        position: nextPos,
      })
      .select()
      .single();

    if (error || !col) {
      return NextResponse.json({ error: error?.message || 'Failed to create column' }, { status: 500 });
    }

    return NextResponse.json({ column: { ...col, tasks: [] } }, { status: 201 });
  } catch (error) {
    console.error('Column creation error:', error);
    return NextResponse.json({ error: 'Failed to create column' }, { status: 500 });
  }
}

