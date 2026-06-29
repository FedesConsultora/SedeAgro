export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

export class ApiError extends Error {
  constructor({ message, code, status, details, requestId }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}

function normalizeError(error) {
  return {
    title: error.status ? `Error ${error.status}` : 'Error de conexión',
    message: error.message || 'No se pudo contactar al servidor.',
    requestId: error.requestId
  };
}

export function createApiClient(session, feedback) {
  async function request(path, options = {}) {
    feedback?.startLoading();

    try {
      const { body: requestBody, headers, ...requestOptions } = options;
      const hasBody = requestBody !== undefined;
      const response = await fetch(`${API_URL}${path}`, {
        ...requestOptions,
        headers: {
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          ...(session?.token ? { authorization: `Bearer ${session.token}` } : {}),
          ...(session?.tenant?.id ? { 'x-tenant-id': session.tenant.id } : {}),
          ...headers
        },
        ...(hasBody ? { body: JSON.stringify(requestBody) } : {})
      });

      const responseBody = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorMsg = responseBody.error?.message || 'Error de API';

        // Auto-logout on stale session or deleted tenant
        if (response.status === 401 || (response.status === 404 && errorMsg.includes('Tenant no encontrado'))) {
          localStorage.removeItem('sedeagro.session');
          localStorage.setItem('sedeagro.dataMode', 'mock');
          window.location.reload();
          return;
        }

        throw new ApiError({
          message: errorMsg,
          code: responseBody.error?.code,
          status: response.status,
          details: responseBody.error?.details,
          requestId: responseBody.error?.request_id || response.headers.get('x-request-id')
        });
      }
      return responseBody;
    } catch (error) {
      feedback?.showError(normalizeError(error));
      throw error;
    } finally {
      feedback?.stopLoading();
    }
  }


  return {
    request,
    me: () => request('/auth/me'),
    members: () => request('/auth/members'),
    bootstrap: () => request('/catalogs/bootstrap'),
    producers: () => request('/farms/producers'),
    createProducer: (body) => request('/farms/producers', { method: 'POST', body }),
    farms: () => request('/farms'),
    getFarm: (id) => request(`/farms/${id}`),
    createFarm: (body) => request('/farms', { method: 'POST', body }),
    updateFarm: (id, body) => request(`/farms/${id}`, { method: 'PATCH', body }),
    fields: () => request('/fields'),
    getField: (id) => request(`/fields/${id}`),
    createField: (body) => request('/fields', { method: 'POST', body }),
    updateField: (id, body) => request(`/fields/${id}`, { method: 'PATCH', body }),
    createRainfall: (fieldId, body) => request(`/fields/${fieldId}/rainfall`, { method: 'POST', body }),
    createIrrigation: (fieldId, body) => request(`/fields/${fieldId}/irrigation`, { method: 'POST', body }),
    campaigns: () => request('/campaigns'),
    createCampaign: (body) => request('/campaigns', { method: 'POST', body }),
    updateCampaign: (id, body) => request(`/campaigns/${id}`, { method: 'PATCH', body }),
    assignCampaignField: (campaignId, body) => request(`/campaigns/${campaignId}/fields`, { method: 'POST', body }),
    campaignFields: () => request('/campaigns/fields'),
    scoutingRuns: () => request('/scouting/runs'),
    getScoutingRun: (id) => request(`/scouting/runs/${id}`),
    createScoutingRun: (body) => request('/scouting/runs', { method: 'POST', body }),
    updateScoutingRun: (id, body) => request(`/scouting/runs/${id}`, { method: 'PATCH', body }),
    createObservation: (runId, body) => request(`/scouting/runs/${runId}/observations`, { method: 'POST', body }),
    createEvidence: (observationId, body) => request(`/scouting/observations/${observationId}/evidence`, { method: 'POST', body }),
    workOrders: () => request('/work-orders'),
    createWorkOrder: (body) => request('/work-orders', { method: 'POST', body }),
    updateWorkOrderStatus: (workOrderId, body) => request(`/work-orders/${workOrderId}/status`, { method: 'PATCH', body }),
    assignWorkOrderUser: (workOrderId, body) => request(`/work-orders/${workOrderId}/assignees`, { method: 'POST', body }),
    addWorkOrderInput: (workOrderId, body) => request(`/work-orders/${workOrderId}/inputs`, { method: 'POST', body }),
    addWorkOrderMachinery: (workOrderId, body) => request(`/work-orders/${workOrderId}/machinery`, { method: 'POST', body }),
    teams: () => request('/teams'),
    createTeam: (body) => request('/teams', { method: 'POST', body }),
    addTeamMember: (teamId, body) => request(`/teams/${teamId}/members`, { method: 'POST', body }),
    machinery: () => request('/assets/machinery'),
    createMachinery: (body) => request('/assets/machinery', { method: 'POST', body }),
    inputs: () => request('/assets/inputs'),
    createInput: (body) => request('/assets/inputs', { method: 'POST', body }),
    reportTemplates: () => request('/reports/templates'),
    createReportTemplate: (body) => request('/reports/templates', { method: 'POST', body }),
    reportRuns: () => request('/reports/runs'),
    createReportRun: (body) => request('/reports/runs', { method: 'POST', body }),
    getFieldReport: (fieldId) => request(`/reports/field/${fieldId}`),
    satelliteLayers: () => request('/imagery/layers'),
    createSatelliteLayer: (body) => request('/imagery/layers', { method: 'POST', body }),
    syncBatches: () => request('/sync/batches'),
    submitSyncBatch: (body) => request('/sync/batches', { method: 'POST', body }),
    notifications: () => request('/notifications'),
    markNotificationRead: (notificationId) => request(`/notifications/${notificationId}/read`, { method: 'PATCH' }),
    // Platform administration
    getPlatformTenants: () => request('/platform/tenants'),
    getPlatformUsers: () => request('/platform/users'),
    getPlatformPlans: () => request('/platform/plans'),
    updatePlatformTenant: (id, body) => request(`/platform/tenants/${id}`, { method: 'PATCH', body }),
    getPlatformTenantModules: (id) => request(`/platform/tenants/${id}/modules`),
    togglePlatformTenantModule: (id, body) => request(`/platform/tenants/${id}/modules`, { method: 'POST', body })
  };
}
