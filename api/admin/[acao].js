import { apiRouter, ApiError } from '../../server/http.js';
import { staffFromRequest } from '../../server/supabase-admin.js';
import { listUsers, createUser, updateUser, resetPassword } from '../../server/admin.js';
import { testCampaignWebhook, testWebhook } from '../../server/webhook-test.js';

// POST /api/admin/<acao>, called by the app with the logged-in admin's token.
export default apiRouter(
  {
    usuarios: listUsers,
    criar_usuario: createUser,
    atualizar_usuario: updateUser,
    redefinir_senha: resetPassword,
    testar_webhook_campanha: testCampaignWebhook,
    testar_webhook: testWebhook,
  },
  {
    authorize: async (req) => {
      const staff = await staffFromRequest(req);
      if (staff.role !== 'admin') throw new ApiError(403, 'acesso_negado', 'Apenas o administrador pode acessar esta área.');
      return staff;
    },
  },
);
