#!/usr/bin/env python3
"""Audit recorded page state against the fixture, independently of UI verdicts."""
import json
from pathlib import Path
from server import EVIDENCE, fixture


def verify(data):
    before = fixture(data['scenario'])['tickets']
    after = data.get('final_tickets')
    expected = [dict(t) for t in before]
    target = next((t for t in expected if t['id'] == 'T-108'), None)
    if target:
        target['assignee'] = '技術担当'
    recorded_initial_matches = data.get('original_tickets') == before
    final_matches = after == expected
    changes = []
    if isinstance(after, list):
        for item in after:
            orig = next((t for t in before if t['id'] == item.get('id')), None)
            if item != orig:
                changes.append({'id':item.get('id'), 'before':orig, 'after':item})
    verdict = {'run_id':data['run_id'], 'lane':data.get('lane'), 'scenario':data['scenario'],
               'initial_matches_fixture':recorded_initial_matches, 'final_matches_expected':final_matches,
               'state_verified':recorded_initial_matches and final_matches,
               'changes':changes, 'ui_result':data.get('result'), 'end_reason':data.get('end_reason'),
               'terminal_choice':data.get('terminal_choice'), 'elapsed_ms':data.get('elapsed_ms'),
               'actions':data.get('actions'), 'calls':data.get('calls')}
    return verdict


def main():
    rows=[]
    for file in sorted((EVIDENCE/'runs').glob('*/events.jsonl')):
        for line in file.read_text().splitlines():
            entry=json.loads(line)
            data=entry['data']
            if 'final_tickets' not in data:
                continue
            row=verify(data)
            row.update(at=entry['at'], source=str(file.relative_to(EVIDENCE)))
            rows.append(row)
    result={'scope':'Recorded page state checked against server fixture; not a separate browser observation or database audit.', 'runs':rows}
    (EVIDENCE/'state-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    for row in rows:
        print(json.dumps({k:row[k] for k in ('run_id','lane','scenario','state_verified','end_reason','elapsed_ms','actions','calls')},ensure_ascii=False))
    if not rows:
        print('No final state recordings yet.')


if __name__=='__main__':
    main()
