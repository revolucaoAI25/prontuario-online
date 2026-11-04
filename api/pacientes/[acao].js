import { apiRouter } from '../../server/http.js';
import { findPatients, registerPatient } from '../../server/scheduling.js';
import { patientContext } from '../../server/patient-context.js';
import { reactivationList, markReactivation } from '../../server/reactivation.js';

// POST /api/pacientes/<acao> with header x-api-key. See docs/API.md.
export default apiRouter({
  buscar: findPatients,
  cadastrar: registerPatient,
  contexto: patientContext,
  reativacao: reactivationList,
  marcar_reativacao: markReactivation,
});
