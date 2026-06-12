// Tests for comment-commands.yml logic.
// Run with: ~/.nvm/versions/node/v24.15.0/bin/node .github/tests/test-suggest-reviewers.mjs
//
// Test suites and what each covers:
//
//  Suite 1 — latestBlameCommit: parsing git blame -p output to find the
//            most recently touched commit per file.
//
//  Suite 2 — rankCandidates: sorting candidates by file-touch count and
//            capping at MAX_EACH.
//
//  Suite 3 — buildCommentBody: generating the suggestion comment for all
//            combinations of committer/non-committer lists.
//
//  Suite 4 — find-or-update comment: locating an existing marker comment
//            to update vs. posting a new one.
//
//  Suite 5 — author/bot exclusion: skipping the PR author and bot accounts
//            when building the candidate list.
//
//  Suite 6 — @mention parsing (/request-review): extracting user and team
//            mentions from the command body, normalizing @Copilot, stripping
//            self-mentions, and routing org/team slugs correctly.
//
//  Suite 7 — file status filtering: skipping files whose status means there
//            is no base content to blame (removed, added, and any other
//            non-blameable status).
//
//  Suite 8 — candidate accumulation: counting how many changed files each
//            login most recently touched, ensuring the same login across
//            multiple files increments rather than resets its count.
//
//  Suite 9 — MARKER integrity: confirming the hidden HTML marker survives
//            round-trips and that find() returns the first match when
//            multiple marker comments somehow exist.

let passed = 0;
let failed = 0;

function assert(description, condition) {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    failed++;
  }
}

function assertEq(description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ─── Functions under test (copied verbatim from the workflow) ─────────────────

function latestBlameCommit(blameOutput) {
  let latest = null;
  let current = null;

  function finalizeCurrent() {
    if (!current || current.authorTime == null) return;
    if (!latest || current.authorTime > latest.authorTime) latest = current;
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

const MARKER = '<!-- texera-reviewer-suggestion -->';

function buildCommentBody(committers, nonCommitters) {
  let body = `${MARKER}\n`;
  body += `**Suggested reviewers** (based on \`git blame\` of changed files):\n\n`;

  if (committers.length) {
    body += `**Committers** — can be formally requested: ${committers.map(l => `@${l}`).join(', ')}\n\n`;
  } else {
    body += `**Committers** — none identified\n\n`;
  }

  if (nonCommitters.length) {
    body += `**Non-committer contributors** — cc to notify: ${nonCommitters.map(l => `@${l}`).join(', ')}\n\n`;
  }

  if (committers.length) {
    body += `Use \`/request-review @${committers[0]}\` to request a review`;
    if (nonCommitters.length) {
      body += `, or cc ${nonCommitters.map(l => `@${l}`).join(' ')} to notify them`;
    }
    body += '.';
  } else if (nonCommitters.length) {
    body += `Cc ${nonCommitters.map(l => `@${l}`).join(' ')} to notify them.`;
  } else {
    body += `No candidates found from blame history.`;
  }

  return body;
}

function rankCandidates(counts, max) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([l]) => l);
}

// @mention parser from the /request-review job (copied verbatim).
function parseMentions(bodyRest, author) {
  const reviewers = [];
  const team_reviewers = [];
  for (const [, h] of bodyRest.matchAll(/@([\w-]+(?:\/[\w.-]+)?)/g)) {
    if (h.includes('/')) team_reviewers.push(h.split('/')[1]);
    else if (h.toLowerCase() === 'copilot') reviewers.push('Copilot');
    else if (h.toLowerCase() !== author.toLowerCase()) reviewers.push(h);
  }
  return { reviewers, team_reviewers };
}

// ─── Suite 1: latestBlameCommit ───────────────────────────────────────────────

console.log('\nSuite 1: latestBlameCommit');
console.log('  Parses git blame -p output and returns the commit with the');
console.log('  highest author-time across all blame blocks in a file.\n');

{
  const r = latestBlameCommit('');
  assertEq('empty input → null', r, null);
}

{
  const blame = [
    'abc1234567890000 1 1 3',
    'author Alice',
    'author-time 1700000000',
    'filename src/foo.ts',
    '\tline',
  ].join('\n');
  const r = latestBlameCommit(blame);
  assertEq('single block: correct sha', r?.sha, 'abc1234567890000');
  assertEq('single block: correct authorTime', r?.authorTime, 1700000000);
}

{
  const blame = ['^deadbeef12345678 1 1 1', 'author-time 1600000000'].join('\n');
  const r = latestBlameCommit(blame);
  assertEq('^ boundary prefix stripped from sha', r?.sha, 'deadbeef12345678');
}

{
  const blame = [
    'aaaa0000 1 1 1', 'author-time 1500000000', '\told',
    'bbbb0000 2 2 1', 'author-time 1700000000', '\tnew',
  ].join('\n');
  assertEq('two blocks: later commit wins (second block)', latestBlameCommit(blame)?.sha, 'bbbb0000');
}

{
  const blame = [
    'aaaa0000 1 1 1', 'author-time 1700000000', '\tnew',
    'bbbb0000 2 2 1', 'author-time 1500000000', '\told',
  ].join('\n');
  assertEq('two blocks: later commit wins (first block)', latestBlameCommit(blame)?.sha, 'aaaa0000');
}

{
  const blame = [
    'aaaa0000 1 1 1', 'author No Time', '\tline',
    'bbbb0000 2 2 1', 'author-time 1700000000', '\tline',
  ].join('\n');
  assertEq('block missing author-time is skipped', latestBlameCommit(blame)?.sha, 'bbbb0000');
}

{
  const blame = ['aaaa0000 1 1 1', 'author No Time', '\tline'].join('\n');
  assertEq('all blocks missing author-time → null', latestBlameCommit(blame), null);
}

{
  const blame = ['aaaa0000 1 1 1', 'author-time 1700000000', '\tline'].join('\r\n');
  assertEq('CRLF line endings handled', latestBlameCommit(blame)?.sha, 'aaaa0000');
}

{
  const times = [100, 500, 200, 999, 300, 50, 800];
  const blocks = times.map((t, i) =>
    [`${'a'.repeat(7)}${i}000 ${i + 1} ${i + 1} 1`, `author-time ${t}`, `\tline`].join('\n'),
  ).join('\n');
  assertEq('many blocks: max author-time wins', latestBlameCommit(blocks)?.authorTime, 999);
}

{
  const blame = [
    'aaaa0000 1 1 1', 'author-time 1700000000', '\tline',
    'bbbb0000 2 2 1', 'author-time 1700000000', '\tline',
  ].join('\n');
  const r = latestBlameCommit(blame);
  assert('tie in authorTime: returns one of the tied shas', r?.sha === 'aaaa0000' || r?.sha === 'bbbb0000');
}

// ─── Suite 2: rankCandidates ──────────────────────────────────────────────────

console.log('\nSuite 2: rankCandidates');
console.log('  Ranks logins by file-touch count (descending) and caps the');
console.log('  result at MAX_EACH to keep the suggestion comment concise.\n');

{
  const counts = new Map([['alice', 3], ['bob', 5], ['carol', 1]]);
  assertEq('sorts descending by count', rankCandidates(counts, 3), ['bob', 'alice', 'carol']);
}

{
  const counts = new Map([['alice', 3], ['bob', 5], ['carol', 1]]);
  assertEq('caps at max', rankCandidates(counts, 2), ['bob', 'alice']);
}

{
  assertEq('empty map → empty array', rankCandidates(new Map(), 3), []);
}

{
  const counts = new Map([['alice', 1]]);
  assertEq('single entry always returned', rankCandidates(counts, 3), ['alice']);
}

{
  const counts = new Map([['alice', 5], ['bob', 3]]);
  assertEq('max=0 → empty array', rankCandidates(counts, 0), []);
}

{
  const counts = new Map([['alice', 2], ['bob', 1]]);
  assertEq('max larger than entries → return all', rankCandidates(counts, 10), ['alice', 'bob']);
}

// ─── Suite 3: buildCommentBody ────────────────────────────────────────────────

console.log('\nSuite 3: buildCommentBody');
console.log('  Constructs the GitHub comment for every combination of');
console.log('  committer and non-committer lists, including edge cases.\n');

{
  const body = buildCommentBody(['alice', 'bob'], ['carol']);
  assert('contains MARKER', body.includes(MARKER));
  assert('lists all committers with @', body.includes('@alice') && body.includes('@bob'));
  assert('lists non-committers with @', body.includes('@carol'));
  assert('/request-review uses first committer', body.includes('/request-review @alice'));
  assert('cc line mentions non-committers', body.includes('cc @carol'));
}

{
  const body = buildCommentBody(['alice'], []);
  assert('committers-only: /request-review present', body.includes('/request-review @alice'));
  assert('committers-only: no cc line', !body.includes('cc'));
  assert('committers-only: no non-committer section', !body.includes('Non-committer'));
}

{
  const body = buildCommentBody([], ['carol', 'dave']);
  assert('non-committers-only: committers section says none identified', body.includes('none identified'));
  assert('non-committers-only: Cc line present', body.includes('Cc @carol'));
  assert('non-committers-only: no /request-review', !body.includes('/request-review'));
  assert('non-committers-only: all non-committers listed', body.includes('@carol') && body.includes('@dave'));
}

{
  const body = buildCommentBody([], []);
  assert('empty: fallback message present', body.includes('No candidates found'));
  assert('empty: no /request-review', !body.includes('/request-review'));
  assert('empty: no Non-committer section', !body.includes('Non-committer'));
}

{
  const body = buildCommentBody(['first', 'second', 'third'], []);
  assert('multiple committers: first used in /request-review', body.includes('/request-review @first'));
  assert('multiple committers: all listed', body.includes('@second') && body.includes('@third'));
}

{
  const body = buildCommentBody(['user_123'], ['org-member-2']);
  assert('underscores/hyphens/numbers in usernames handled', body.includes('@user_123') && body.includes('@org-member-2'));
}

{
  const body = buildCommentBody(['alice'], ['bob']);
  assertEq('MARKER appears exactly once', (body.match(/<!-- texera-reviewer-suggestion -->/g) || []).length, 1);
}

// ─── Suite 4: find-or-update comment logic ────────────────────────────────────

console.log('\nSuite 4: find-or-update comment logic');
console.log('  Finds an existing marker comment to update in-place rather');
console.log('  than posting a second comment on every PR push.\n');

{
  const comments = [
    { id: 1, body: 'some other comment' },
    { id: 2, body: `${MARKER}\nold suggestion` },
    { id: 3, body: 'another comment' },
  ];
  assertEq('finds existing marker comment by id', comments.find(c => c.body?.includes(MARKER))?.id, 2);
}

{
  const comments = [{ id: 1, body: 'no marker' }, { id: 2, body: 'also none' }];
  assertEq('no existing marker → undefined', comments.find(c => c.body?.includes(MARKER)), undefined);
}

{
  assertEq('empty comment list → undefined', [].find(c => c.body?.includes(MARKER)), undefined);
}

{
  const comments = [{ id: 1, body: null }, { id: 2, body: undefined }];
  assertEq('null/undefined bodies handled safely', comments.find(c => c.body?.includes(MARKER)), undefined);
}

{
  const comments = [
    { id: 10, body: `${MARKER}\nfirst` },
    { id: 20, body: `${MARKER}\nsecond` },
  ];
  assertEq('two markers: first one is updated', comments.find(c => c.body?.includes(MARKER))?.id, 10);
}

{
  const comments = [{ id: 5, body: `preamble\n${MARKER}\nbody` }];
  assertEq('marker found when not at start of body', comments.find(c => c.body?.includes(MARKER))?.id, 5);
}

// ─── Suite 5: author/bot exclusion ───────────────────────────────────────────

console.log('\nSuite 5: author/bot exclusion');
console.log('  The PR author and GitHub bot accounts must never appear in');
console.log('  the candidate list or receive a review request.\n');

function shouldSkip(login, loginSourceType, author) {
  if (login.toLowerCase() === author.toLowerCase()) return true;
  if (loginSourceType === 'Bot') return true;
  return false;
}

assert('skips PR author (exact match)', shouldSkip('alice', 'User', 'alice'));
assert('skips PR author (case-insensitive)', shouldSkip('Alice', 'User', 'alice'));
assert('skips PR author regardless of bot type', shouldSkip('BOB', 'Bot', 'bob'));
assert('skips bot account even if different from author', shouldSkip('github-actions', 'Bot', 'alice'));
assert('does not skip a different human user', !shouldSkip('bob', 'User', 'alice'));
assert('does not skip human with similar but different name', !shouldSkip('alice2', 'User', 'alice'));

// ─── Suite 6: @mention parsing (/request-review) ─────────────────────────────

console.log('\nSuite 6: @mention parsing (/request-review)');
console.log('  Extracts individual user and org/team @mentions from the');
console.log('  command body, normalizes @Copilot, and strips self-mentions.\n');

{
  const { reviewers, team_reviewers } = parseMentions(' @bob', 'alice');
  assertEq('single @user parsed', reviewers, ['bob']);
  assertEq('no teams for user mention', team_reviewers, []);
}

{
  const { reviewers } = parseMentions(' @bob @carol @dave', 'alice');
  assertEq('multiple @users parsed', reviewers, ['bob', 'carol', 'dave']);
}

{
  const { reviewers, team_reviewers } = parseMentions(' @myorg/my-team', 'alice');
  assertEq('org/team: reviewers empty', reviewers, []);
  assertEq('org/team: team slug extracted', team_reviewers, ['my-team']);
}

{
  const { reviewers, team_reviewers } = parseMentions(' @bob @myorg/reviewers', 'alice');
  assertEq('mixed: user captured', reviewers, ['bob']);
  assertEq('mixed: team slug captured', team_reviewers, ['reviewers']);
}

{
  for (const mention of ['@copilot', '@Copilot', '@COPILOT']) {
    const { reviewers } = parseMentions(` ${mention}`, 'alice');
    assertEq(`${mention} normalized to Copilot`, reviewers, ['Copilot']);
  }
}

{
  const { reviewers } = parseMentions(' @alice @bob', 'alice');
  assertEq('self-mention stripped', reviewers, ['bob']);
}

{
  const { reviewers } = parseMentions(' @Alice @bob', 'alice');
  assertEq('self-mention stripped case-insensitively', reviewers, ['bob']);
}

{
  const { reviewers, team_reviewers } = parseMentions('', 'alice');
  assertEq('no mentions → empty reviewers', reviewers, []);
  assertEq('no mentions → empty team_reviewers', team_reviewers, []);
}

{
  const { reviewers } = parseMentions(' please review @bob and @carol', 'alice');
  assertEq('mentions in prose text extracted', reviewers, ['bob', 'carol']);
}

// ─── Suite 7: file status filtering ──────────────────────────────────────────

console.log('\nSuite 7: file status filtering');
console.log('  Files that have no content at the base commit must be skipped');
console.log('  before git blame is attempted, preventing a fatal error.\n');

function shouldBlame(status) {
  if (status === 'removed' || status === 'added') return false;
  return true;
}

assert('removed files skipped (no content at base)', !shouldBlame('removed'));
assert('added files skipped (did not exist at base)', !shouldBlame('added'));
assert('modified files are blamed', shouldBlame('modified'));
assert('renamed files are blamed (content existed at base)', shouldBlame('renamed'));
assert('copied files are blamed', shouldBlame('copied'));
assert('changed files are blamed', shouldBlame('changed'));

// ─── Suite 8: candidate accumulation ─────────────────────────────────────────

console.log('\nSuite 8: candidate accumulation');
console.log('  Each file contributes one vote to the login that most recently');
console.log('  touched it. The same login across multiple files increments its');
console.log('  count rather than resetting it.\n');

{
  const committerCounts = new Map();
  const nonCommitterCounts = new Map();

  const fileResults = [
    { login: 'alice', isCollaborator: true },
    { login: 'bob',   isCollaborator: false },
    { login: 'alice', isCollaborator: true },
    { login: 'carol', isCollaborator: true },
    { login: 'bob',   isCollaborator: false },
  ];

  for (const { login, isCollaborator } of fileResults) {
    if (isCollaborator) committerCounts.set(login, (committerCounts.get(login) ?? 0) + 1);
    else nonCommitterCounts.set(login, (nonCommitterCounts.get(login) ?? 0) + 1);
  }

  assertEq('alice (collaborator) count = 2', committerCounts.get('alice'), 2);
  assertEq('carol (collaborator) count = 1', committerCounts.get('carol'), 1);
  assertEq('bob (non-collaborator) count = 2', nonCommitterCounts.get('bob'), 2);
  assertEq('bob not in committer bucket', committerCounts.has('bob'), false);
  assertEq('alice not in non-committer bucket', nonCommitterCounts.has('alice'), false);

  assertEq('committers ranked: alice first', rankCandidates(committerCounts, 3), ['alice', 'carol']);
  assertEq('non-committers ranked: bob first', rankCandidates(nonCommitterCounts, 3), ['bob']);
}

{
  const committerCounts = new Map();
  const author = 'alice';

  const fileResults = [
    { login: 'alice', isCollaborator: true },
    { login: 'bob',   isCollaborator: true },
  ];

  for (const { login, isCollaborator } of fileResults) {
    if (login.toLowerCase() === author.toLowerCase()) continue;
    if (isCollaborator) committerCounts.set(login, (committerCounts.get(login) ?? 0) + 1);
  }

  assertEq('author not accumulated', committerCounts.has('alice'), false);
  assertEq('other collaborator accumulated', committerCounts.get('bob'), 1);
}

// ─── Suite 9: MARKER integrity ────────────────────────────────────────────────

console.log('\nSuite 9: MARKER integrity');
console.log('  The hidden HTML comment used to identify the suggestion comment');
console.log('  must be stable and not visible to readers.\n');

{
  assert('MARKER is an HTML comment', MARKER.startsWith('<!--') && MARKER.endsWith('-->'));
}

{
  const body = buildCommentBody([], []);
  assert('MARKER present in built comment body', body.includes(MARKER));
}

{
  const stored = buildCommentBody(['alice'], ['bob']);
  assert('stored body detectable via includes(MARKER)', stored.includes(MARKER));
}

{
  const oldBody = buildCommentBody(['alice'], []);
  const newBody = buildCommentBody(['alice', 'bob'], ['carol']);
  assert('updated body still contains MARKER', newBody.includes(MARKER));
  assert('updated body differs from old body', oldBody !== newBody);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
