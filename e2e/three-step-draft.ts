import type { Page } from '@playwright/test';
import sample from '../qa/workflow.json' with { type: 'json' };

export async function prepareThreeStepDraft(page: Page) {
  const definition = {
    ...sample,
    steps: sample.steps.map((step) =>
      step.id === 'review' ? { ...step, title: '초안 검토' } : step,
    ),
  };
  await page.addInitScript((draft) => {
    if (sessionStorage.getItem('three-step-fixture')) return;
    sessionStorage.setItem('three-step-fixture', '1');
    sessionStorage.setItem(
      'workplot.editor-draft.v1',
      JSON.stringify({
        draft,
        baseline: draft,
        saved: null,
        selected: 'draft',
        flowSettings: false,
      }),
    );
  }, definition);
}
