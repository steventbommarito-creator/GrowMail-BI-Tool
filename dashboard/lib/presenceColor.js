// Shared presence/cursor utilities. Kept in one place so the usePresence hook,
// the avatar stack, the useLiveCursors hook, and the cursor overlay all agree
// on the same name formatting and per-user color.

// Deterministic HSL from a user id — same user always gets the same color
// across tabs and sessions. Fixed saturation/lightness keeps contrast roughly
// even; hue is chosen from a 360-degree wheel via a cheap hash.
export function hslFromId(id) {
  let hash = 0;
  for (const c of String(id || '')) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 70% 50%)`;
}

// Display name = the part of an email before "@". steveb@growmail.com -> steveb.
// Falls back to "unknown" if the email is blank or malformed.
export function emailPrefix(email) {
  const s = (email || '').split('@')[0];
  return s || 'unknown';
}
