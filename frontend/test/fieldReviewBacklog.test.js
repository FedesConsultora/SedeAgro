import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canOpenFieldReviewOrders, checkedFieldReviewSummary,
  confirmFieldReportResponse, reportAccessContext, visibleFieldReport
} from '../src/services/reportAccessContext.js';

const FIELD = 'b0463d1f-735b-4522-907f-80c3b81b0103';
const OTHER = '69b1cba9-7638-4070-a599-20e32f123b9c';
const ORDER = '6b74b177-30f9-4ed9-b60e-a39651e0c98c';
const EXEC = '8ebd4e5e-1bf9-42f2-9166-2e76310d6f4b';
const actor = Object.freeze({
  authenticated: true, tenant: { id:'tenant-1' }, user: { id: 'actor-1' },
  membership: { id:'member-1', roleCode:'agronomic_coordinator' },
  entitlements:['gis', 'reports', 'work_orders']
});
const row = { execution_id:EXEC, work_order_id:ORDER, field_id:FIELD,
  title:'Revisar control de malezas', finished_at:'2026-11-04T11:00:00.000Z' };
const summary = { submitted:1, verified:2, rejected:3, recentPending:[row] };

test('review action requires LIVE authenticated coordinator/admin, membership, reports AND work orders',()=>{
  assert.equal(canOpenFieldReviewOrders(actor,'live'),true);
  assert.equal(canOpenFieldReviewOrders({...actor,
    membership:{...actor.membership,roleCode:'tenant_admin'}},'live'),true);
  for(const session of [
    {...actor, authenticated:false}, {...actor,user:{}},
    {...actor,tenant:{}}, {...actor,membership:null},
    {...actor,membership:{roleCode:'agronomic_coordinator'}},
    {...actor,membership:{...actor.membership,roleCode:'scout'}},
    {...actor,membership:{...actor.membership,roleCode:'contractor'}},
    {...actor,entitlements:['gis','reports']},
    {...actor,entitlements:['gis','work_orders']}
  ]) assert.equal(canOpenFieldReviewOrders(session,'live'),false);
  assert.equal(canOpenFieldReviewOrders(actor,'mock'),false);
});

test('real five-entry pending list must be exact selected field, UUIDs and whitelisted metadata',()=>{
  assert.equal(checkedFieldReviewSummary(summary,FIELD),summary);
  assert.throws(()=>checkedFieldReviewSummary(summary,OTHER),/ajenas|inválidas/);
  const validEmpty={submitted:0,verified:0,rejected:0,recentPending:[]};
  assert.equal(checkedFieldReviewSummary(validEmpty,FIELD),validEmpty);
  for(const invalid of [
    undefined,{},null,[],{...summary,submitted:-1},
    {...summary,rejected:1.5},{...summary,verified:'2'},
    {...summary,submitted:0},{...summary,recentPending:[row,row]},
    {...summary,recentPending:Array(6).fill(row)},
    {...summary,recentPending:[{...row,field_id:OTHER}]},
    {...summary,recentPending:[{...row,execution_id:'unknown'}]},
    {...summary,recentPending:[{...row,work_order_id:'unknown'}]},
    {...summary,recentPending:[{...row,title:''}]},
    {...summary,recentPending:[{...row,finished_at:'wrong'}]},
    {...summary,recentPending:[{...row,review_note:'private'}]},
    {...summary,recentPending:[{...row,gps:[-34,-58]}]},
    {...summary,recentPending:[{...row,photo_base64:'secret'}]},
    {...summary,tenant:'other'}
  ]) assert.throws(()=>checkedFieldReviewSummary(invalid,FIELD),/inválido|ajenas|inválidas/);
});

test('field report refuses a missing or wrong-tenant review summary and masks changes before React effects',()=>{
  const payload={data:{field:{id:FIELD},reviewSummary:summary}};
  assert.equal(confirmFieldReportResponse(payload,FIELD),payload.data);
  assert.throws(()=>confirmFieldReportResponse({data:{field:{id:FIELD}}},FIELD),/inválido/);
  assert.throws(()=>confirmFieldReportResponse(payload,OTHER),/lote seleccionado/);
  const api={};
  const scope=reportAccessContext(actor,'live',FIELD);
  const saved={scope,api,report:payload.data};
  assert.equal(visibleFieldReport(saved,scope,api),payload.data);
  assert.equal(visibleFieldReport(saved,reportAccessContext({
    ...actor, membership:{...actor.membership,roleCode:'scout'}
  },'live',FIELD),api),null);
  assert.equal(visibleFieldReport(saved,scope,{},),null);
  assert.equal(visibleFieldReport(saved,null,api),null);
});

test('report click delegates only order ID, rechecking Orders access and detail authoritatively',()=>{
  const file=p=>readFileSync(new URL(p,import.meta.url),'utf8');
  const card=file('../src/components/FieldReportCard.jsx');
  const reports=file('../src/pages/ReportsPage.jsx');
  const app=file('../src/App.jsx');
  const orders=file('../src/pages/WorkOrdersPage.jsx');
  const router=file('../../backend/src/modules/reports/router.js');
  const db=file('../../backend/src/modules/reports/fieldReviewSummary.js');
  assert.match(card,/canOpenFieldReviewOrders\(session, dataMode\)/);
  assert.match(card,/reportContext === currentScope\.current/);
  assert.match(card,/api === currentApiRef\.current/);
  assert.match(card,/onOpenWorkOrder\(item\.work_order_id\)/);
  assert.match(reports,/onNavigate\?\.\('orders', \{ id \}\)/);
  assert.match(app,/ReportsPage onNavigate=\{handleViewChange\}/);
  assert.match(orders,/focusOrderId/);
  assert.match(orders,/checkedWorkOrderPrivateRows/);
  assert.match(router,/loadFieldReviewSummary\(req, fieldId\)/);
  assert.match(db,/queryTenantTransaction\(/);
  assert.match(db,/LIMIT :limit/);
  assert.match(db,/execution\.review_status = 'submitted'/);
  assert.doesNotMatch(db,/result_summary|review_note|review_checklist|point|latitude|photo|blob|submitted_by/);
});
