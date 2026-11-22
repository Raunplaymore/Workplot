import type { WorkflowVersion } from '@studio/contracts';

type MaterialDraft = {
  name: string;
  paste: string;
  answers: Record<string, string>;
};
export const emptyMaterialDraft: MaterialDraft = {
  name: '',
  paste: '',
  answers: {},
};
function key(v: WorkflowVersion) {
  return 'workplot.material.' + v.id + '.' + v.version;
}
export function readMaterialDraft(v: WorkflowVersion): MaterialDraft {
  try {
    const raw = sessionStorage.getItem(key(v));
    if (raw) {
      const d = JSON.parse(raw);
      if (
        typeof d?.name === 'string' &&
        typeof d.paste === 'string' &&
        d.answers &&
        typeof d.answers === 'object' &&
        !Array.isArray(d.answers) &&
        Object.values(d.answers).every((a) => typeof a === 'string')
      )
        return d;
    }
  } catch {
    /* The form remains usable without tab storage. */
  }
  return emptyMaterialDraft;
}
export function storeMaterialDraft(v: WorkflowVersion, d: MaterialDraft) {
  try {
    if (d.name || d.paste || Object.values(d.answers).some(Boolean))
      sessionStorage.setItem(key(v), JSON.stringify(d));
    else sessionStorage.removeItem(key(v));
    return true;
  } catch {
    return false;
  }
}
