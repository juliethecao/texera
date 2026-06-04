// Quick unit tests for the blame parsing + reviewer selection logic
// This file is meant to be run with `node .github/workflows/tests/request-review-test.js`

function latestBlameCommit(blameOutput) {
  let latest = null;
  let current = null;

  function finalizeCurrent() {
    if (!current || current.authorTime == null) return;
    if (!latest || current.authorTime > latest.authorTime) {
      latest = current;
    }
  }

  for (const line of blameOutput.split(/\r?\n/)) {
    const header = line.match(/^([0-9a-f^]+)\s+\d+\s+\d+\s+\d+$/);
    if (header) {
      finalizeCurrent();
      current = { sha: header[1].replace(/^\^/, ''), authorTime: null };
      continue;
    }
    const authorTime = line.match(/^author-time\s+(\d+)$/);
    if (authorTime && current) current.authorTime = Number(authorTime[1]);
  }

  finalizeCurrent();
  return latest;
}

// ── latestBlameCommit unit tests ─────────────────────────────────────────────

const sampleBlame = [
  'aaaaaaaa 1 1 1',
  'author Alice',
  'author-time 100',
  '',
  'bbbbbbbb 2 2 2',
  'author Bob',
  'author-time 200',
  '',
].join('\n');

const latest = latestBlameCommit(sampleBlame);
console.log('latest sha:', latest && latest.sha);
console.log('expected sha: bbbbbbbb');

// Missing author-time: latestBlameCommit should return null
const noAuthorTimeBlame = ['cccccccc 1 1 1', 'author Carol', ''].join('\n');
const noTimestamp = latestBlameCommit(noAuthorTimeBlame);
console.log('no-author-time result:', noTimestamp);
console.log('expected no-author-time result: null');

// ── getReviewersFromBlame integration mock ───────────────────────────────────

const MAX_REVIEWERS = 2;

const DEFAULT_BLAME_MAP = {
  'a.txt': ['11111111 1 1 1', 'author X', 'author-time 150', ''].join('\n'),
  'b.txt': ['22222222 1 1 1', 'author Y', 'author-time 250', ''].join('\n'),
  'c.txt': ['33333333 1 1 1', 'author Z', 'author-time 50', ''].join('\n'),
};

const DEFAULT_COMMIT_MAP = {
  '11111111': { author: { login: 'alice', type: 'User' } },
  '22222222': { author: { login: 'bob', type: 'User' } },
  '33333333': { author: { login: 'carol', type: 'User' } },
};

async function getReviewersFromBlameMock({
  files,
  pullBaseSha,
  author,
  blameMap = DEFAULT_BLAME_MAP,
  commitMap = DEFAULT_COMMIT_MAP,
  collaborators = null, // null means all logins pass; otherwise a Set of valid logins
}) {
  function execFileSyncMock(cmd, args) {
    const file = args[args.length - 1];
    if (!blameMap[file]) throw new Error('file not found: ' + file);
    return blameMap[file];
  }

  async function getCommitMock({ ref }) {
    if (!commitMap[ref]) throw new Error('commit not found: ' + ref);
    return { data: commitMap[ref] };
  }

  async function checkCollaboratorMock(login) {
    if (collaborators !== null && !collaborators.has(login.toLowerCase())) {
      throw new Error('not a collaborator');
    }
  }

  const reviewerCounts = new Map();
  for (const filename of files) {
    let blameOutput;
    try {
      blameOutput = execFileSyncMock('git', ['blame', '-p', pullBaseSha, '--', filename]);
    } catch (e) {
      console.warn('blame failed:', e.message);
      continue;
    }
    const latest = latestBlameCommit(blameOutput);
    if (!latest) continue;
    let commit;
    try {
      ({ data: commit } = await getCommitMock({ ref: latest.sha }));
    } catch (e) {
      console.warn('commit lookup failed:', e.message);
      continue;
    }
    const login = commit.author?.login ?? commit.committer?.login;
    if (!login) continue;
    if (login.toLowerCase() === (author || '').toLowerCase()) continue;
    // Check bot-ness only on the identity that supplied login.
    const loginSource = commit.author?.login ? commit.author : commit.committer;
    if (loginSource?.type === 'Bot') continue;

    try {
      await checkCollaboratorMock(login);
    } catch (e) {
      console.warn(`${login} is not a collaborator; skipping.`);
      continue;
    }

    reviewerCounts.set(login, (reviewerCounts.get(login) ?? 0) + 1);
  }

  return [...reviewerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_REVIEWERS)
    .map(([login]) => login);
}

// ── integration test cases ───────────────────────────────────────────────────

(async () => {
  // Three files, all count=1 — top MAX_REVIEWERS (2) returned by insertion order
  const result = await getReviewersFromBlameMock({
    files: ['a.txt', 'b.txt', 'c.txt'],
    pullBaseSha: 'base',
    author: 'david',
  });
  console.log('mock reviewers:', result);
  console.log('expected reviewers: ["alice","bob"]');

  // Author-is-filtered: PR author matches blame login — excluded from results
  const authorFilteredResult = await getReviewersFromBlameMock({
    files: ['a.txt'],
    pullBaseSha: 'base',
    author: 'alice',
  });
  console.log('author-filtered reviewers:', authorFilteredResult);
  console.log('expected author-filtered reviewers: []');

  // Case-insensitive author filter: author casing differs from blame login
  const caseInsensitiveResult = await getReviewersFromBlameMock({
    files: ['a.txt'],
    pullBaseSha: 'base',
    author: 'Alice',
  });
  console.log('case-insensitive author-filtered reviewers:', caseInsensitiveResult);
  console.log('expected case-insensitive author-filtered reviewers: []');

  // Bot author filtered: blame points to a bot account — excluded from results
  const botResult = await getReviewersFromBlameMock({
    files: ['bot.txt'],
    pullBaseSha: 'base',
    author: 'david',
    blameMap: { 'bot.txt': ['44444444 1 1 1', 'author-time 999', ''].join('\n') },
    commitMap: { '44444444': { author: { login: 'github-actions[bot]', type: 'Bot' } } },
  });
  console.log('bot-filtered reviewers:', botResult);
  console.log('expected bot-filtered reviewers: []');

  // Bot committer, human author: login comes from author — should NOT be filtered
  const botCommitterResult = await getReviewersFromBlameMock({
    files: ['patch.txt'],
    pullBaseSha: 'base',
    author: 'david',
    blameMap: { 'patch.txt': ['55555555 1 1 1', 'author-time 500', ''].join('\n') },
    commitMap: {
      '55555555': {
        author:    { login: 'eve', type: 'User' },
        committer: { login: 'patch-bot', type: 'Bot' },
      },
    },
  });
  console.log('bot-committer reviewers:', botCommitterResult);
  console.log('expected bot-committer reviewers: ["eve"]');

  // Blame throws for one file (e.g. new file not present at base) — skipped,
  // other files still contribute reviewers
  const partialBlameResult = await getReviewersFromBlameMock({
    files: ['new-file.txt', 'b.txt'],
    pullBaseSha: 'base',
    author: 'david',
  });
  console.log('partial-blame reviewers:', partialBlameResult);
  console.log('expected partial-blame reviewers: ["bob"]');

  // Frequency ranking: alice touches 2 files, bob and carol 1 each
  // — alice ranked first, then bob (insertion order among equal counts)
  const frequencyResult = await getReviewersFromBlameMock({
    files: ['a.txt', 'a2.txt', 'b.txt', 'c.txt'],
    pullBaseSha: 'base',
    author: 'david',
    blameMap: {
      ...DEFAULT_BLAME_MAP,
      'a2.txt': ['11111111 1 1 1', 'author X', 'author-time 160', ''].join('\n'),
    },
  });
  console.log('frequency-ranked reviewers:', frequencyResult);
  console.log('expected frequency-ranked reviewers: ["alice","bob"]');

  // Non-collaborator filtered: alice is not in the collaborators set — excluded
  const nonCollaboratorResult = await getReviewersFromBlameMock({
    files: ['a.txt', 'b.txt'],
    pullBaseSha: 'base',
    author: 'david',
    collaborators: new Set(['bob']),
  });
  console.log('non-collaborator-filtered reviewers:', nonCollaboratorResult);
  console.log('expected non-collaborator-filtered reviewers: ["bob"]');

  // No blame candidates survive filters — empty result
  const allFilteredResult = await getReviewersFromBlameMock({
    files: ['a.txt', 'b.txt'],
    pullBaseSha: 'base',
    author: 'alice',
    blameMap: {
      'a.txt': DEFAULT_BLAME_MAP['a.txt'],
      'b.txt': ['22222222 1 1 1', 'author-time 250', ''].join('\n'),
    },
    commitMap: {
      '11111111': DEFAULT_COMMIT_MAP['11111111'],
      '22222222': { author: { login: 'alice', type: 'User' } },
    },
  });
  console.log('all-filtered reviewers:', allFilteredResult);
  console.log('expected all-filtered reviewers: []');
})();
