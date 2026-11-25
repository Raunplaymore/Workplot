import {
  clearMissingDocumentInputs,
  editorRecoverySchema,
} from '@studio/contracts';

export const editorRecoveryKey = 'workplot.editor-draft.v1';

export function recoveryKey(id?: string | null) {
  return id ? editorRecoveryKey + '.' + id : editorRecoveryKey;
}
export function readEditorRecovery(id?: string | null) {
  try {
    const raw =
      sessionStorage.getItem(recoveryKey(id)) ??
      sessionStorage.getItem(editorRecoveryKey);
    if (!raw) return null;
    const value = JSON.parse(raw);
    const result = editorRecoverySchema.safeParse(value);
    // Preserve whitespace in partially typed instructions and titles.
    if (!result.success || (id && result.data.saved?.id !== id)) return null;
    const recovered = value as typeof result.data;
    recovered.draft.steps = clearMissingDocumentInputs(recovered.draft.steps);
    return recovered;
  } catch {
    return null;
  }
}
