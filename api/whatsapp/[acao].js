import { apiRouter } from '../../server/http.js';
import { staffFromRequest } from '../../server/supabase-admin.js';
import { whatsappSend } from '../../server/evolution-admin.js';

// POST /api/whatsapp/<acao>, called by the app with the logged-in user's token.
export default apiRouter({ enviar: whatsappSend }, { authorize: staffFromRequest });
