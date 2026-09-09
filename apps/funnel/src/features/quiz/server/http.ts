import { NextResponse } from 'next/server';

export function errorResponse(
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(fields ? { fields } : {}),
      },
    },
    { status },
  );
}

export function databaseErrorResponse(error: { message: string; code?: string | null }) {
  if (error.message.startsWith('QUIZ_STALE_REVISION:')) {
    const revision = Number(error.message.split(':')[1]);
    return NextResponse.json(
      {
        error: {
          code: 'STALE_SESSION_REVISION',
          message: 'A newer quiz snapshot has already been saved.',
        },
        currentRevision: Number.isInteger(revision) ? revision : undefined,
      },
      { status: 409 },
    );
  }
  if (error.message === 'QUIZ_SESSION_NOT_FOUND' || error.code === 'P0002') {
    return errorResponse(404, 'SESSION_NOT_FOUND', 'Quiz session was not found.');
  }
  if (error.message === 'QUIZ_SESSION_TERMINAL') {
    return errorResponse(409, 'SESSION_ALREADY_COMPLETED', 'Quiz session is no longer active.');
  }

  console.error('[quiz-backend] database operation failed:', error.message);
  return errorResponse(500, 'PERSISTENCE_FAILED', 'The quiz could not be saved.');
}
