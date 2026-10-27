import { apiRouter } from '../../server/http.js';
import {
  listAgendas, listAppointments, availability, book, confirm, cancel, reschedule,
} from '../../server/scheduling.js';

// POST /api/agenda/<acao> with header x-api-key. See docs/API.md.
export default apiRouter({
  agendas: listAgendas,
  agendamentos: listAppointments,
  disponibilidade: availability,
  agendar: book,
  confirmar: confirm,
  cancelar: cancel,
  remarcar: reschedule,
});
