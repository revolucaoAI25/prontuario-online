import { apiRouter, ApiError } from '../../server/http.js';
import { staffFromRequest } from '../../server/supabase-admin.js';
import { listUsers, createUser, updateUser, resetPassword } from '../../server/admin.js';
import { whatsappStatus, whatsappConnect, whatsappDisconnect } from '../../server/evolution-admin.js';

// POST /api/admin/<acao>, called by the app with the logged-in admin's token.
export default apiRouter(
  {
    usuarios: listUsers,
    criar_usuario: createUser,
    atualizar_usuario: updateUser,
    redefinir_senha: resetPassword,
    whatsapp_status: whatsappStatus,
    whatsapp_conectar: whatsappConnect,
    whatsapp_desconectar: whatsappDisconnect,
  },
  {
    authorize: async (req) => {
      const staff = await staffFromRequest(req);
      if (staff.role !== 'admin') throw new ApiError(403, 'acesso_negado', 'Apenas o administrador pode acessar esta área.');
      return staff;
    },
  },
);
