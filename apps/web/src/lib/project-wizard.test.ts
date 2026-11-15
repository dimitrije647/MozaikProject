import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DRAFT_KEY,
  LIMITS,
  WIZARD_DEFAULTS,
  WIZARD_STEPS,
  blockingMessage,
  createDraftAutosave,
  createProjectSubmitter,
  firstStepWithError,
  parseDraft,
  validateStep,
  wizardSchema,
  type DraftStatus,
  type WizardClient,
  type WizardValues,
} from './project-wizard';

const SERBIAN =
  'Flying Dutchman je restoran i bar na obali Dunava u Beogradu.\n' +
  'Nudimo domaću kuhinju, riblje specijalitete, ćevapčiće i šljivovicu; đakonije za porodice, žurke i proslave.\n\n' +
  'Radimo svakog dana od 10 do 24h. Rezervacije: „Čamac” sala za 40 gostiju.\n';

const filled = (over: Partial<WizardValues> = {}): WizardValues => ({
  ...WIZARD_DEFAULTS,
  socials: { ...WIZARD_DEFAULTS.socials },
  productName: 'Flying Dutchman',
  shortDescription: SERBIAN,
  websiteUrl: 'https://flyingdutchman.rs/',
  ...over,
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('project wizard: step 1 (Product)', () => {
  it('a valid step 1 advances: name, multiline Serbian description, website, empty GitHub, no uploads', () => {
    const r = validateStep(filled(), 0);
    assert.deepEqual(r, { ok: true, errors: {} });
  });

  it('a long multiline Serbian description up to the limit is accepted and kept exactly', () => {
    let text = '';
    while (text.length + SERBIAN.length <= LIMITS.shortDescription) text += SERBIAN;
    assert.ok(text.length > 1500 && text.length <= LIMITS.shortDescription);
    assert.equal(validateStep(filled({ shortDescription: text }), 0).ok, true);
    const out = wizardSchema.parse(filled({ shortDescription: text }));
    assert.equal(out.shortDescription, text, 'line breaks and diacritics are not altered');
  });

  it('a description over the limit is blocked with a visible message that says how much to cut', () => {
    const text = SERBIAN.repeat(20);
    const r = validateStep(filled({ shortDescription: text }), 0);
    assert.equal(r.ok, false);
    assert.match(r.errors.shortDescription, new RegExp(`${text.length} characters, the maximum is ${LIMITS.shortDescription}\\. Shorten it by ${text.length - LIMITS.shortDescription}`));
    assert.equal(blockingMessage(Object.keys(r.errors)), 'Please correct this field to continue: Description.');
  });

  it('website URLs: a full https address (also with spaces around it) passes; addresses the API would reject do not', () => {
    for (const ok of ['https://flyingdutchman.rs/', '  https://flyingdutchman.rs  ', 'http://www.example.co.uk/a?b=1', ''])
      assert.equal(validateStep(filled({ websiteUrl: ok }), 0).ok, true, ok);
    assert.equal(wizardSchema.parse(filled({ websiteUrl: ' https://flyingdutchman.rs ' })).websiteUrl, 'https://flyingdutchman.rs');
    for (const bad of ['flyingdutchman.rs', 'javascript:alert(1)', 'ftp://example.com', 'https://localhost']) {
      const r = validateStep(filled({ websiteUrl: bad }), 0);
      assert.equal(r.ok, false, bad);
      assert.match(r.errors.websiteUrl, /https:\/\//);
    }
  });

  it('only the product name is required on step 1; a missing one names the field', () => {
    const r = validateStep(filled({ productName: '', shortDescription: '', websiteUrl: '', githubUrl: '' }), 0);
    assert.deepEqual(Object.keys(r.errors), ['productName']);
    assert.match(r.errors.productName, /name/);
    assert.equal(validateStep(filled({ productName: '  ' }), 0).ok, false, 'spaces are not a name');
    assert.equal(blockingMessage(['productName', 'shortDescription']), 'Please correct these fields to continue: Product name, Description.');
  });

  it('errors of later steps never block step 1, and saving opens the first step with an error', () => {
    const v = filled({ socials: { ...WIZARD_DEFAULTS.socials, instagram: 'not a url' } });
    assert.equal(validateStep(v, 0).ok, true);
    assert.equal(validateStep(v, 1).ok, false);
    assert.equal(firstStepWithError(['socials']), 1);
    assert.equal(firstStepWithError(['targetAudience', 'shortDescription']), 0);
    assert.equal(firstStepWithError([]), null);
  });
});

describe('project wizard: all five steps', () => {
  it('every step of a minimal brief validates, and the whole brief parses', () => {
    assert.equal(WIZARD_STEPS.length, 5);
    const v = filled();
    for (let s = 0; s < WIZARD_STEPS.length; s++) assert.equal(validateStep(v, s).ok, true, WIZARD_STEPS[s].title);
    assert.equal(wizardSchema.safeParse(v).success, true);
  });
});

describe('project wizard: draft', () => {
  it('a saved draft restores exactly (refresh), including multiline Serbian text and social links', () => {
    const v = filled({ socials: { ...WIZARD_DEFAULTS.socials, instagram: 'https://instagram.com/fd' }, marketingGoal: 'leads' });
    assert.deepEqual(parseDraft(JSON.stringify(v)), v);
  });

  it('old or damaged drafts never break the form', () => {
    assert.equal(parseDraft(null), null);
    assert.equal(parseDraft('{not json'), null);
    assert.equal(parseDraft('"text"'), null);
    const d = parseDraft(JSON.stringify({ productName: 'X Co', socials: { tiktok: 'https://tiktok.com/@x' }, enableSeasonalCalendar: 'yes', extra: 1, publishingMode: 'auto' }))!;
    assert.equal(d.productName, 'X Co');
    assert.equal(d.socials.tiktok, 'https://tiktok.com/@x');
    assert.equal(d.socials.instagram, '', 'missing social keys take defaults (an old draft used to leave them undefined)');
    assert.equal(d.enableSeasonalCalendar, false);
    assert.equal(d.publishingMode, 'manual');
    assert.equal('extra' in d, false);
  });

  it('autosave is debounced, writes the latest values and reports its status', async () => {
    const store = new Map<string, string>();
    const statuses: DraftStatus[] = [];
    const a = createDraftAutosave({ setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) }, (s) => statuses.push(s), 20);
    a.schedule({ productName: 'A' });
    a.schedule({ productName: 'AB' });
    assert.equal(store.size, 0);
    await tick(40);
    assert.deepEqual(JSON.parse(store.get(DRAFT_KEY)!), { productName: 'AB' });
    assert.deepEqual(statuses, ['pending', 'pending', 'saved']);
    a.schedule({ productName: 'ABC' });
    a.flush();
    assert.deepEqual(JSON.parse(store.get(DRAFT_KEY)!), { productName: 'ABC' }, 'flush (step change, leaving the page) writes at once');
    a.clear();
    assert.equal(store.has(DRAFT_KEY), false);
  });

  it('an autosave failure is reported, never thrown, and does not stop later saves', async () => {
    let full = true;
    const statuses: DraftStatus[] = [];
    const store = new Map<string, string>();
    const a = createDraftAutosave(
      {
        setItem: (k, v) => {
          if (full) throw new DOMException('quota', 'QuotaExceededError');
          store.set(k, v);
        },
        removeItem: () => {},
      },
      (s) => statuses.push(s),
      5,
    );
    a.schedule({ productName: 'A' });
    await tick(20);
    assert.equal(statuses.at(-1), 'error');
    // Moving through the wizard does not depend on the draft: the step still validates.
    assert.equal(validateStep(filled(), 0).ok, true);
    full = false;
    a.schedule({ productName: 'B' });
    await tick(20);
    assert.equal(statuses.at(-1), 'saved', 'recovers on the next change');
    assert.ok(store.has(DRAFT_KEY));
  });
});

describe('project wizard: saving the project', () => {
  function fakeClient(failOnce?: string) {
    const calls: string[] = [];
    let failed = false;
    let n = 0;
    const call = async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      await tick(5);
      if (failOnce && path.endsWith(failOnce) && !failed) {
        failed = true;
        throw new Error(`${failOnce} failed`);
      }
    };
    const client: WizardClient = {
      post: async <T>(path: string) => {
        await call('POST', path);
        return { id: `p${++n}` } as T;
      },
      put: async <T>(path: string) => (await call('PUT', path)) as T,
      patch: async <T>(path: string) => (await call('PATCH', path)) as T,
      upload: async (id, kind) => call('UPLOAD', `/projects/${id}/assets:${kind}`),
    };
    return { client, calls };
  }
  const out = () => wizardSchema.parse(filled());

  it('creates exactly one project with intake, socials and READY status; no uploads needed', async () => {
    const { client, calls } = fakeClient();
    const id = await createProjectSubmitter(client).submit(out(), { logo: [], doc: [] });
    assert.equal(id, 'p1');
    assert.deepEqual(calls, ['POST /projects', 'PUT /projects/p1/intake', 'PUT /projects/p1/social-profiles', 'PATCH /projects/p1']);
  });

  it('a double click (two saves at once) sends one set of requests and one project', async () => {
    const { client, calls } = fakeClient();
    const s = createProjectSubmitter(client);
    const [a, b] = await Promise.all([s.submit(out(), {}), s.submit(out(), {})]);
    assert.equal(a, b);
    assert.equal(calls.filter((c) => c === 'POST /projects').length, 1);
    assert.equal(calls.length, 4);
  });

  it('a retry after a failed later step reuses the project instead of creating a second one', async () => {
    const { client, calls } = fakeClient('/intake');
    const s = createProjectSubmitter(client);
    await assert.rejects(s.submit(out(), {}), /intake failed/);
    assert.equal(s.busy, false, 'the button is usable again');
    assert.equal(await s.submit(out(), {}), 'p1');
    assert.equal(calls.filter((c) => c === 'POST /projects').length, 1);
  });

  it('uploaded buckets are reported so a retry only re-sends what failed', async () => {
    const { client, calls } = fakeClient('assets:image');
    const s = createProjectSubmitter(client);
    const done: string[] = [];
    const file = {} as File;
    await assert.rejects(s.submit(out(), { logo: [file], image: [file] }, (k) => done.push(k)));
    assert.deepEqual(done, ['logo']);
    await s.submit(out(), { logo: [], image: [file] }, (k) => done.push(k));
    assert.deepEqual(done, ['logo', 'image']);
    assert.equal(calls.filter((c) => c.includes('assets:logo')).length, 1);
  });
});
