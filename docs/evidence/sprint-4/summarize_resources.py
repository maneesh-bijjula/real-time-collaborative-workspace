"""Summarize recorded primary-scenario resources; uses only the Python standard library.

Usage: python3 docs/evidence/sprint-4/summarize_resources.py CAMPAIGN_DIRECTORY
Samples include warmup and post-traffic checks, not just the latency window.
"""
import gzip
import json
from pathlib import Path
import re
import statistics
import sys

campaign = Path(sys.argv[1])
manifest = json.loads((campaign / 'manifest.json').read_text())
result = {
    'scope': 'Entire primary load scenarios, including warmup and post-traffic checks. '
             'CPU 100% means one logical CPU; container CPU includes its other processes/healthchecks. '
             'Interval event-loop p99 maxima are not whole-run p99 values. '
             'Controller RSS is measured at scenario completion, not a peak. '
             'Native server network/block I/O is not sampled.',
    'runtime': manifest['runtime'],
    'sourceSha256': manifest['source']['sourceSha256'],
    'repeats': [],
}
for path in sorted(campaign.glob('shared-richtext-v1-*.telemetry.jsonl.gz')):
    with gzip.open(path, 'rt') as stream:
        data = json.loads(next(stream))
    servers = {str(node): {'cpu': [], 'rss': [], 'lag': []} for node in range(4)}
    dependencies = {}
    for sample in data['samples']:
        if sample['type'] == 'resources':
            for value in sample['values']:
                service = value['service']
                if service.startswith('server'):
                    node = servers[str(int(service[6:]) - 1)]
                    node['cpu'].append(value['cpuPercent'])
                    if 'rssBytes' in value:
                        node['rss'].append(value['rssBytes'])
                else:
                    dependencies.setdefault(service, []).append(value['cpuPercent'])
        elif sample['type'] == 'metrics':
            for value in sample['values']:
                node = servers[str(value['node'])]
                for metric, field, scale in [
                    ('resident_memory_bytes', 'rss', 1),
                    ('event_loop_delay_p99_seconds', 'lag', 1000),
                ]:
                    match = re.search(r'^commonplace_' + metric + r' ([\d.eE+-]+)$',
                                      value.get('text', ''), re.M)
                    if match:
                        node[field].append(float(match[1]) * scale)
    result['repeats'].append({
        'scenario': path.name.removesuffix('.telemetry.jsonl.gz'),
        'controller': data['controller'],
        'servers': {key: {
            'cpuMeanPercent': statistics.mean(value['cpu']) if value['cpu'] else None,
            'cpuMaxPercent': max(value['cpu'], default=None),
            'rssMaxObservedBytes': max(value['rss'], default=None),
            'maximumObservedIntervalP99Ms': max(value['lag'], default=None),
        } for key, value in servers.items()},
        'dependencyCpu': {key: {'meanPercent': statistics.mean(value), 'maxPercent': max(value)}
                          for key, value in dependencies.items()},
        'dependenciesBefore': data.get('dependenciesBefore'),
        'dependenciesAfter': data.get('dependenciesAfter'),
    })
(campaign / 'resources-summary.json').write_text(json.dumps(result, indent=2) + '\n')
