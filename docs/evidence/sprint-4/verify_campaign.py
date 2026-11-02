"""Independent raw coverage/timing check using only Python's standard library.

Usage: python3 docs/evidence/sprint-4/verify_campaign.py CAMPAIGN_DIRECTORY
State/presence/durability checks are recorded by the versioned Yjs harness, not
independently reconstructible from latency tuples. This checker says so.
"""
from collections import Counter
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys

campaign = Path(sys.argv[1])
manifest = json.loads((campaign / 'manifest.json').read_text())
assert manifest['suite'] == 'full' and not manifest['source']['dirty']
assert manifest['cleanedUp'] and not manifest.get('fatal')
assert manifest['runtime'] == 'containers' and manifest['clientExecution'] == 'workers'
assert not manifest.get('controllerPauseMs')
pids = [c['hostPid'] for c in manifest['environment']['containers']
        if c['service'] in ['server1', 'server2', 'server3', 'server4']]
assert len(pids) == len(set(pids)) == 4 and all(p > 0 for p in pids)

def rows(path):
    with gzip.open(path, 'rt') as stream:
        for line in stream:
            yield json.loads(line)

def nearest(values, fraction):
    values = sorted(values)
    return values[math.ceil(len(values) * fraction) - 1]

report = {
    'scope': 'Independent recomputation of raw operation/sample coverage, membership, '
             'source scheduling and latency percentiles. State, presence, connections '
             'and committed-save correctness are checked by the versioned harness; '
             'latency tuples alone cannot independently reconstruct them.',
    'verifierSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'measuredCommit': manifest['source']['commit'],
    'sourceSha256': manifest['source']['sourceSha256'],
    'loads': [],
}
for name in [f'shared-richtext-v1-{i}' for i in range(1, 4)] + [
        'five-documents-v1-1', 'large-richtext-v1-1']:
    summary = json.loads((campaign / (name + '.summary.json')).read_text())
    profile = summary['profile']
    primary = name.startswith('shared-')
    assert profile['writers'] == 50 and profile['rate'] == 2
    assert profile['warmupSeconds'] == (30 if primary else 10)
    assert profile['measureSeconds'] == (120 if primary else 30)
    assert profile['documents'] == (5 if name.startswith('five-') else 1)
    operations = list(rows(campaign / (name + '.operations.jsonl.gz')))
    expected_ops = profile['measureSeconds'] * 100
    assert len(operations) == expected_ops
    assert Counter(o['writer'] for o in operations) == Counter({w: expected_ops // 50 for w in range(50)})
    for index, op in enumerate(operations):
        assert op['index'] == index and op['writer'] == index % 50
        writer = op['writer']
        assert op['node'] == (0 if writer < 13 else 1 if writer < 26 else 2 if writer < 38 else 3)
        assert op['document'] == writer % profile['documents']
        assert op['sequence'] == profile['warmupSeconds'] * 2 + index // 50 + 1
        sequence = op['sequence']
        assert op['kind'] == ('delete' if sequence % 5 == 0 else 'format' if sequence % 5 == 4 else 'insert')
        assert isinstance(op['updateBytes'], int) and op['updateBytes'] > 0
        assert op['scheduledMs'] == profile['warmupSeconds'] * 1000 + index * 10
        assert math.isfinite(op['startedMs']) and op['startedMs'] - op['scheduledMs'] < 500
        assert op['startedMs'] - profile['warmupSeconds'] * 1000 <= summary['actualWindowMs']
    assert summary['actualWindowMs'] <= profile['measureSeconds'] * 1000 + 1000
    seen = bytearray(expected_ops * 50)
    values = []
    for index, recipient, value in rows(campaign / (name + '.samples.jsonl.gz')):
        assert isinstance(index, int) and 0 <= index < expected_ops
        assert isinstance(recipient, int) and 0 <= recipient < 50
        op = operations[index]
        assert recipient != op['writer'] and recipient % profile['documents'] == op['document']
        assert math.isfinite(value) and value >= 0
        slot = index * 50 + recipient
        assert not seen[slot]
        seen[slot] = 1
        values.append(value)
    expected_samples = expected_ops * (50 // profile['documents'] - 1)
    assert len(values) == expected_samples
    p95 = nearest(values, .95)
    assert p95 == summary['latencyMs']['p95']
    assert summary['correctness'] and summary['offeredLoadValid'] and not summary['errors']
    assert summary['durableQuiescenceMs'] is not None
    if primary:
        assert p95 < 100
    report['loads'].append({'name': name, 'operations': len(operations),
                            'samples': len(values), 'p95Ms': p95,
                            'maximumSourceLagMs': max(max(0, o['startedMs'] - o['scheduledMs']) for o in operations)})

reconnect = json.loads((campaign / 'migration-reconnect-v1.summary.json').read_text())
assert not reconnect['errors'] and reconnect['completed'] == 30 and reconnect['missing'] == 0
assert reconnect['timeouts'] == reconnect['failed'] == 0
assert len(reconnect['trials']) == 30
for index, trial in enumerate(reconnect['trials'], 1):
    assert trial['trial'] == index and trial['converged'] and trial['underTarget']
    assert math.isfinite(trial['elapsedMs']) and 0 <= trial['elapsedMs'] < 2000
durations = [t['elapsedMs'] for t in reconnect['trials']]
report['reconnect'] = {'trials': 30, 'p95Ms': nearest(durations, .95), 'maxMs': max(durations)}
report['primarySamples'] = sum(r['samples'] for r in report['loads'][:3])
assert report['primarySamples'] == 1764000
report['passed'] = True
(campaign / 'independent-check.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
