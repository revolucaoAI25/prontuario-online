import { apiRouter, ApiError } from '../../server/http.js';
import { staffFromRequest } from '../../server/supabase-admin.js';
import {
  whatsappSend, whatsappRetryMedia, whatsappStatus, whatsappConnect, whatsappDisconnect,
} from '../../server/evolution-admin.js';

const adminOnly = (route) => (body, req, staff) => {
  if (staff.role !== 'admin') throw new ApiError(403, 'acesso_negado', 'Apenas o administrador pode desconectar o WhatsApp.');
  return route(body, req, staff);
};

// POST /api/whatsapp/<acao>, called by the app with the logged-in user's
// token. Anyone on the team can (re)connect the number by QR code, since it
// can drop at any time; disconnecting is for admins.
export default apiRouter(
  {
    enviar: whatsappSend,
    midia: whatsappRetryMedia,
    status: whatsappStatus,
    conectar: whatsappConnect,
    desconectar: adminOnly(whatsappDisconnect),
  },
  { authorize: staffFromRequest },
);
