"""Summarize controller/replica-isolate diagnostics, without inferring acceptance.

Usage: python3 docs/evidence/sprint-4/summarize_isolates.py CAMPAIGN_DIRECTORY
RSS is process-wide; do not add worker RSS values together.
"""
import gzip
import json
from pathlib import Path
import sys

campaign = Path(sys.argv[1])
report = {
    'scope': 'Sampled heap maxima are observations, not memory bounds. '
             'Worker traffic event-loop maxima end before oracle validation. '
             'GC entries are filtered to the traffic interval using the verified common clock. '
             'No acceptance decision is inferred from these resource observations.',
    'runs': [],
}
for path in sorted(campaign.glob('shared-richtext-v1-*.telemetry.jsonl.gz')):
    with gzip.open(path, 'rt') as stream:
        data = json.loads(next(stream))
    events = data.get('diagnostics', {}).get('events', [])
    start = next((e for e in events if e['type'] == 'traffic_start'), {})
    end = next((e for e in events if e['type'] == 'traffic_end'), {})
    replicas = []
    for worker in data.get('workers', []):
        diagnostic = worker['diagnostics']
        entries = [e for e in diagnostic['events']
                   if start['atMs'] <= e['atMs'] <= end['atMs']]
        heaps = [e['memory']['heapUsed'] for e in entries if e['type'] == 'replica_heap']
        gc = [e['durationMs'] for e in entries if e['type'] == 'gc']
        replicas.append({
            'indices': worker['indices'],
            'maximumSampledTrafficHeapUsedBytes': max(heaps, default=None),
            'trafficEventLoopMaxMs': worker['trafficEventLoopMaxMs'],
            'gcEntriesInTraffic': len(gc),
            'maximumObservedGcEntryMs': max(gc, default=None),
            'diagnosticEntriesDropped': diagnostic['dropped'],
        })
    launches = [e['launchMs'] for e in events if e['type'] == 'command']
    report['runs'].append({
        'scenario': path.name.removesuffix('.telemetry.jsonl.gz'),
        'replicaClocksAndPlacement': start.get('workers'),
        'replicas': replicas,
        'controllerMaximumCommandLaunchMs': max(launches, default=None),
        'controllerDiagnosticEntriesDropped': data.get('diagnostics', {}).get('dropped'),
        'sourceInterruptions': [e for e in events if e['type'] == 'source_interruption'],
    })
(campaign / 'isolates-summary.json').write_text(json.dumps(report, indent=2) + '\n')
