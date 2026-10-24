#!/usr/bin/env python3
"""Release Vocab-track to the Chrome Web Store from CI.

Run by .github/workflows/release.yml on every push to main and once a day.
One run does at most one release:

1. Ask the store for the item's status. If a version is still in review,
   stop: a new upload would restart a review that takes days, and the next
   run picks the commits up once the queue is clear.
2. If the last v* tag is newer than anything the store has seen, an earlier
   run pushed the tag but did not finish the upload. Upload that tag.
3. Otherwise read the commit subjects since the last tag. feat is a minor
   bump, fix and perf a patch, `!` or BREAKING CHANGE a major. Nothing that
   qualifies, no release.
4. Commit the new version to manifest.json, tag it, and push both BEFORE
   the upload. The other order can burn a store version with no git record:
   the store refuses any version at or below one it has seen.
5. Package the tag with tools/package.sh, upload it, and submit it for
   review. Chrome publishes it on approval.

Usage:
  release.py run [--dry-run]   needs CWS_TOKEN, CWS_PUBLISHER_ID, CWS_ITEM_ID
  release.py selftest          checks the version logic, no network
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

API = 'https://chromewebstore.googleapis.com'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, 'manifest.json')
RELEASE_SUBJECT = 'chore(release): '
# The store processes an upload asynchronously; a few MB takes seconds.
UPLOAD_POLL_SECONDS = 5
UPLOAD_POLL_TRIES = 60
# The upload docs name the in-progress state UPLOAD_IN_PROGRESS, the enum
# reference names it IN_PROGRESS. Accept both.
IN_PROGRESS = {'IN_PROGRESS', 'UPLOAD_IN_PROGRESS'}

CONVENTIONAL = re.compile(r'^(\w+)(\([^)]*\))?(!)?: ')


def parse(version):
    return tuple(int(p) for p in version.split('.'))


def show(version):
    return '.'.join(str(p) for p in version)


def bump_kind(subjects):
    """The largest bump the commit subjects ask for: major, minor, patch or None."""
    kind = None
    for subject in subjects:
        if subject.startswith(RELEASE_SUBJECT):
            continue
        m = CONVENTIONAL.match(subject)
        if not m:
            continue
        if m.group(3) or 'BREAKING CHANGE' in subject:
            return 'major'
        if m.group(1) == 'feat':
            kind = 'minor'
        elif m.group(1) in ('fix', 'perf') and kind is None:
            kind = 'patch'
    return kind


def bump(version, kind):
    major, minor, patch = (list(version) + [0, 0, 0])[:3]
    if kind == 'major':
        return (major + 1, 0, 0)
    if kind == 'minor':
        return (major, minor + 1, 0)
    return (major, minor, patch + 1)


def store_versions(status):
    """Every version the store has seen. A rejected or cancelled one counts:
    its number is burnt."""
    seen = []
    for key in ('publishedItemRevisionStatus', 'submittedItemRevisionStatus'):
        for channel in status.get(key, {}).get('distributionChannels', []):
            if channel.get('crxVersion'):
                seen.append(parse(channel['crxVersion']))
    return seen


def selftest():
    assert bump_kind(['feat(x): a', 'fix: b']) == 'minor'
    assert bump_kind(['fix: b', 'docs: c']) == 'patch'
    assert bump_kind(['docs: c', 'test: d', 'chore(release): v0.3.0']) is None
    assert bump_kind(['refactor!: drop the old store']) == 'major'
    assert bump_kind(['fix: x', 'feat: y\n\nBREAKING CHANGE: z']) == 'major'
    assert bump_kind(['Merge pull request #14 from x/y']) is None
    assert bump((0, 2, 0), 'minor') == (0, 3, 0)
    assert bump((0, 2, 3), 'patch') == (0, 2, 4)
    assert bump((0, 9, 1), 'major') == (1, 0, 0)
    assert parse('0.10.0') > parse('0.9.9')
    status = {
        'publishedItemRevisionStatus': {'distributionChannels': [{'crxVersion': '0.2.0'}]},
        'submittedItemRevisionStatus': {'state': 'REJECTED',
                                        'distributionChannels': [{'crxVersion': '0.3.0'}]},
    }
    assert max(store_versions(status)) == (0, 3, 0)
    assert store_versions({}) == []
    print('release selftest: ok')


def git(*args, cwd=ROOT):
    return subprocess.run(['git', *args], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout.strip()


def last_tag():
    tags = git('tag', '--list', 'v*', '--sort=-v:refname').splitlines()
    if not tags:
        sys.exit('release: no v* tag. Create the bootstrap tag first, see docs/release.md.')
    return tags[0]


def call(method, path, token, body=None, data=None):
    req = urllib.request.Request(API + path, method=method, data=data)
    req.add_header('Authorization', f'Bearer {token}')
    if data is not None:
        req.add_header('Content-Type', 'application/octet-stream')
    if body is not None:
        req.data = json.dumps(body).encode()
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req) as res:
            return json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as err:
        # The store's error body names the cause (version too low, account
        # not added to the dashboard, visibility needs a manual publish).
        sys.exit(f'release: {method} {path} failed with {err.code}:\n{err.read().decode()}')


def package(tag):
    """Build the store zip from the tag, not the working tree."""
    tree = tempfile.mkdtemp(prefix='vt-release-')
    git('worktree', 'add', '--detach', tree, tag)
    out = subprocess.run(['bash', os.path.join(tree, 'tools', 'package.sh')],
                         check=True, capture_output=True, text=True).stdout
    print(out.strip())
    return os.path.join(tree, 'dist', f'vocab-track-{tag[1:]}.zip')


def upload_and_submit(item, token, zip_path):
    with open(zip_path, 'rb') as f:
        res = call('POST', f'/upload/v2/{item}:upload', token, data=f.read())
    print(f'uploaded {res.get("crxVersion")}: {res.get("uploadState")}')
    state = res.get('uploadState')
    for _ in range(UPLOAD_POLL_TRIES):
        if state not in IN_PROGRESS:
            break
        time.sleep(UPLOAD_POLL_SECONDS)
        state = call('GET', f'/v2/{item}:fetchStatus', token).get('lastAsyncUploadState')
    if state != 'SUCCEEDED':
        sys.exit(f'release: upload ended in state {state}')
    # No skipReview: the store answers that with an error for an item that
    # needs review, and this one does (broad host permission).
    res = call('POST', f'/v2/{item}:publish', token, body={'publishType': 'DEFAULT_PUBLISH'})
    print(f'submitted: {res.get("state")}')
    for warning in res.get('warningInfo', {}).get('warnings', []):
        print(f'warning: {warning.get("reason")}: {warning.get("description")}')


def run(dry_run):
    token = os.environ['CWS_TOKEN']
    item = f'publishers/{os.environ["CWS_PUBLISHER_ID"]}/items/{os.environ["CWS_ITEM_ID"]}'

    status = call('GET', f'/v2/{item}:fetchStatus', token)
    submitted = status.get('submittedItemRevisionStatus', {}).get('state')
    seen = store_versions(status)
    store = max(seen) if seen else None
    print(f'store: last version {show(store) if store else "none"}, submission {submitted or "none"}')

    tag = last_tag()
    if dry_run:
        print(f'dry run: last tag {tag}; packaging it to prove the build')
        package(tag)
        return
    if submitted == 'PENDING_REVIEW':
        print('release: a version is still in review. A later run releases once it clears.')
        return

    tagged = parse(tag[1:])
    if store is None or tagged > store:
        print(f'release: {tag} is newer than the store. Finishing its upload.')
        upload_and_submit(item, token, package(tag))
        return

    subjects = git('log', '--no-merges', '--format=%B%x00', f'{tag}..HEAD').split('\x00')
    kind = bump_kind(s.strip() for s in subjects if s.strip())
    if kind is None:
        print(f'release: no feat, fix or perf commit since {tag}. Nothing to release.')
        return

    version = show(bump(max(tagged, store), kind))
    text = open(MANIFEST).read()
    text, n = re.subn(r'("version":\s*")[^"]+(")', rf'\g<1>{version}\2', text, count=1)
    if n != 1:
        sys.exit('release: no "version" field in manifest.json')
    open(MANIFEST, 'w').write(text)
    git('commit', '-am', f'{RELEASE_SUBJECT}v{version}')
    git('tag', f'v{version}')
    git('push', '--atomic', 'origin', 'HEAD:main', f'v{version}')
    print(f'release: v{version} ({kind}) pushed')
    upload_and_submit(item, token, package(f'v{version}'))


if __name__ == '__main__':
    if sys.argv[1:2] == ['selftest']:
        selftest()
    elif sys.argv[1:2] == ['run']:
        run('--dry-run' in sys.argv)
    else:
        sys.exit(__doc__)
