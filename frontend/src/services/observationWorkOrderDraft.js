import { workOrderCreateScope } from './workOrderCreateSafety.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBSERVATION_TYPES = Object.freeze({
  weed: 'malezas', pest: 'plagas', disease: 'enfermedad',
  phenology: 'fenología', nutrition: 'nutrición',
  water: 'agua', general: 'campo'
});
const SEVERITY_PRIORITIES = Object.freeze({
  low: 'low', medium: 'normal', high: 'high', critical: 'urgent'
});

const validUUID = value => typeof value === 'string' && UUID.test(value);

// Navigation carries ONLY authenticated backend IDs and enum values. It must
// never copy notes, GPS, camera bytes, private evidence, session credentials,
// or a one-time API receipt to a different module or browser storage.
export function observationWorkOrderDraft(run, observation, session, dataMode) {
  const scope = workOrderCreateScope(session, dataMode);
  if (dataMode !== 'live' || !scope ||
      (!session?.entitlements?.includes('scouting') ||
       !session?.entitlements?.includes('gis')) ||
      !validUUID(session?.tenant?.id) ||
      run?.tenant_id !== session.tenant.id ||
      (observation?.tenant_id != null && observation.tenant_id !== session.tenant.id)) return null;
  const runId = run?.id;
  const observationId = observation?.id;
  const campaignFieldId = run?.campaign_field_id;
  const fieldId = run?.CampaignField?.Field?.id;
  if (!validUUID(runId) || !validUUID(observationId) ||
      !validUUID(campaignFieldId) || !validUUID(fieldId) ||
      run?.CampaignField?.id !== campaignFieldId ||
      (observation?.scouting_run_id != null && observation.scouting_run_id !== runId) ||
      !Object.hasOwn(OBSERVATION_TYPES, observation?.observation_type) ||
      !Object.hasOwn(SEVERITY_PRIORITIES, observation?.severity) ||
      !run?.ScoutingObservations?.some(item => item?.id === observationId)) return null;
  return Object.freeze({
    scope, tenantId: session.tenant.id, membershipId: session.membership.id,
    runId, observationId,
    campaignFieldId, fieldId,
    observationType: observation.observation_type,
    severity: observation.severity
  });
}

// Revalidate both the principal and the structure *after* navigating. This
// protects the prefilled form if the operator switched tenant/role/API while
// React was rendering. Backend capability + tenant RLS always remain final.
export function workOrderFormFromObservationDraft(draft, session, dataMode) {
  if (dataMode !== 'live' || !draft || typeof draft !== 'object' ||
      draft.scope !== workOrderCreateScope(session, dataMode) ||
      draft.tenantId !== session?.tenant?.id ||
      !session?.membership?.id || draft.membershipId !== session.membership.id ||
      !session?.entitlements?.includes('scouting') ||
      ![draft.runId, draft.observationId, draft.campaignFieldId, draft.fieldId]
        .every(validUUID) ||
      !Object.hasOwn(OBSERVATION_TYPES, draft.observationType) ||
      !Object.hasOwn(SEVERITY_PRIORITIES, draft.severity)) return null;

  return Object.freeze({
    field_id: draft.fieldId,
    campaign_field_id: draft.campaignFieldId,
    origin_observation_id: draft.observationId,
    type: 'inspection', // Never prescribe pesticide, irrigation or other action.
    priority: SEVERITY_PRIORITIES[draft.severity],
    title: 'Verificar hallazgo de ' + OBSERVATION_TYPES[draft.observationType],
    instructions: 'Origen: recorrida ' + draft.runId + ', observación ' + draft.observationId +
      '. Revisar el hallazgo en el lote y definir la intervención con criterio profesional.',
    due_at: ''
  });
}
