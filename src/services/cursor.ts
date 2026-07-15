export interface Cursor {
  p: string;
  i: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string): Cursor | null {
  try {
    const obj: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof obj === 'object' &&
      obj !== null &&
      typeof (obj as Cursor).p === 'string' &&
      typeof (obj as Cursor).i === 'string' &&
      !Number.isNaN(Date.parse((obj as Cursor).p))
    ) {
      return { p: (obj as Cursor).p, i: (obj as Cursor).i };
    }
    return null;
  } catch {
    return null;
  }
}
