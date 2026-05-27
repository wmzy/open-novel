let counter = 0;

export function generateId(prefix: string): string {
  counter = (counter + 1) % 10000;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}${ts}${rand}${counter.toString().padStart(4, '0')}`;
}
