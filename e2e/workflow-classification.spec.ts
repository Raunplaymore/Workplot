import { expect, test } from '@playwright/test';
import { prepareThreeStepDraft } from './three-step-draft.js';

test('saves searchable project and tags with the workflow version', async ({
  page,
}) => {
  await prepareThreeStepDraft(page);
  await page.goto('/#/design');
  await page
    .getByRole('button', { name: 'Workflow settings', exact: true })
    .click();
  await page
    .getByLabel('흐름 이름', { exact: true })
    .fill('Classification review QA');
  await page.getByLabel('Project', { exact: true }).fill('Winter planning');
  const tags = page.getByLabel('Tags', { exact: true });
  await tags.fill('triage, regression, triage');
  await tags.press('Tab');
  await expect(tags).toHaveValue('triage, regression');
  await page
    .locator('main > header')
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page.getByText('Saved · v1', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  const search = page.getByRole('searchbox');
  for (const term of ['WINTER PLANNING', '#regression', 'regression']) {
    await search.fill(term);
    await expect(
      page.getByRole('button', {
        name: 'Classification review QA',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel('Classification', { exact: true })).toHaveText(
      'Winter planning · #triage · #regression',
    );
  }
  await page.reload();
  await expect(search).toHaveValue('regression');
  await page.getByRole('button', { name: 'Edit saved v1' }).click();
  await page
    .getByRole('button', { name: 'Workflow settings', exact: true })
    .click();
  await expect(tags).toHaveValue('triage, regression');
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue(
    'Winter planning',
  );
});
