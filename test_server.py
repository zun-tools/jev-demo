import unittest
from server import make_payload, fixture
from verify_runs import verify


class DecisionBoundaryTests(unittest.TestCase):
    def request(self):
        return {'goal': '依頼の案件を開く', 'observation': {'text':'問い合わせ一覧', 'controls':[{'id':'open-T-108','label':'昨日から仕事を始められません'}]}, 'history':[], 'expected_ticket':'SECRET_EXPECTATION', 'api_key':'SECRET_KEY', 'state':{'hidden':'SECRET_STATE'}}

    def test_model_receives_only_visible_context(self):
        payload, mapping = make_payload(self.request())
        self.assertEqual(mapping, {'e1':'open-T-108'})
        serialized = str(payload)
        for hidden in ('SECRET_EXPECTATION','SECRET_KEY','SECRET_STATE','open-T-108'):
            self.assertNotIn(hidden, serialized)
        self.assertIn('昨日から仕事を始められません', serialized)

    def test_duplicate_ids_and_reserved_ids_rejected(self):
        for cid in ('DONE', 'open-T-108'):
            request=self.request()
            request['observation']['controls'].append({'id':cid,'label':'別の候補'})
            with self.assertRaises(ValueError):
                make_payload(request)

    def test_missing_keeps_completed_login_case(self):
        data=fixture('missing')
        self.assertNotIn('T-108',[t['id'] for t in data['tickets']])
        self.assertIn('T-112',[t['id'] for t in data['tickets']])

    def test_changed_reorders_without_changing_records(self):
        normal=fixture()['tickets']
        changed=fixture('changed')['tickets']
        self.assertNotEqual([t['id'] for t in normal],[t['id'] for t in changed])
        self.assertEqual(sorted(normal,key=lambda t:t['id']), sorted(changed,key=lambda t:t['id']))

    def test_audit_rejects_unrequested_status_change(self):
        initial=fixture()['tickets']
        final=[dict(t) for t in initial]
        target=next(t for t in final if t['id']=='T-108')
        target.update(assignee='技術担当', status='対応中')
        self.assertFalse(verify(dict(run_id='test', scenario='normal', original_tickets=initial, final_tickets=final))['state_verified'])

    def test_audit_does_not_accept_preexisting_completed_ticket(self):
        initial=fixture()['tickets']
        self.assertFalse(verify(dict(run_id='test', scenario='normal', original_tickets=initial, final_tickets=initial))['state_verified'])

    def test_missing_requires_every_ticket_unchanged(self):
        initial=fixture('missing')['tickets']
        final=[dict(t) for t in initial]
        final[0]['assignee']='技術担当'
        self.assertFalse(verify(dict(run_id='test', scenario='missing', original_tickets=initial, final_tickets=final))['state_verified'])

    def test_ask_payload_only_takes_inquiry_text(self):
        from server import make_ask_payload
        p=make_ask_payload({'inquiry':' ログインできません ','questions':{'x':1},'model':'other'})
        self.assertEqual(p['state'],'ログインできません')
        self.assertEqual(p['model'],'jev-1.13.0')
        self.assertEqual(set(p['questions']['route']['criteria']),{'technical','billing','other'})
        for bad in ({}, {'inquiry':''}, {'inquiry':'x'*1001}, {'inquiry':3}):
            with self.assertRaises(ValueError):
                make_ask_payload(bad)


if __name__=='__main__':
    unittest.main()
