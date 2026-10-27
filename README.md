# Clínica Rezeck — agenda e prontuário

Sistema da Clínica Dr. Everson Rezeck: agenda com 4 agendas (Dr. Everson, Simone, Estética,
Depilação a laser), prontuário, pacientes, financeiro (só administrador), estoque, comunicação
interna da equipe, espelho do WhatsApp (Evolution API), lembretes de retorno por procedimento,
aniversários e uma API de agendamento para integrações (IA/WhatsApp).

- **Supabase**: banco Postgres, login, permissões (RLS), realtime e arquivos do prontuário.
- **Vercel**: o app (React + Vite) e as funções em `/api` (API de agendamento, webhook da Evolution,
  disparo diário de lembretes e aniversários).
- Documentação da API: [`docs/API.md`](docs/API.md).

## Estrutura

| Pasta | O que tem |
|---|---|
| `supabase/migrations` | Schema, regras de agenda e lembretes, permissões (aplicar em ordem) |
| `supabase/seed.sql` | Agendas, tipos de atendimento, procedimentos e atalhos iniciais |
| `src/` | App web |
| `api/`, `server/` | Funções da Vercel e a lógica compartilhada |
| `scripts/` | Migração do FastClinic, criação do primeiro admin, banco local |
| `dev/` | Ambiente local que imita o Supabase (só para desenvolvimento/testes) |
| `test/` | Testes do banco, da API, dos webhooks e da migração |

## Implantação

O passo a passo detalhado (com onde achar cada chave) está em
[`docs/IMPLANTACAO.md`](docs/IMPLANTACAO.md). Resumo:

### 1. Supabase
1. Crie o projeto na região **São Paulo (sa-east-1)**.
2. No SQL Editor, cole e rode `supabase/setup.sql` (todas as migrações + seed num arquivo só,
   gerado por `node scripts/build-setup-sql.mjs`). Ou, com a Supabase CLI, `supabase db push` e
   depois `supabase/seed.sql`.
3. Em **Authentication → Sign In / Providers → Email**, desligue *Allow new users to sign up*
   (os logins são criados pelo administrador dentro do sistema).

### 2. Dados do FastClinic
1. Restaure o `.bak` num SQL Server temporário:
   `scripts/restore_fastclinic_backup.sh /caminho/clinica.bak` (precisa de Docker).
2. Rode a migração apontando para a conexão **direta** do Supabase (porta 5432):
   ```bash
   MSSQL_PASSWORD='Prontuario#2026!' DATABASE_URL='postgresql://postgres:SENHA@db.SEU-PROJETO.supabase.co:5432/postgres' \
     npm run migrate:fastclinic
   ```
   Importa horários de atendimento (inclusive os horários "quebrados"), pacientes, prontuários,
   histórico de agendamentos com procedimentos, e bloqueios futuros. Leva menos de 1 minuto.
3. **Na data de corte**, repita com o backup final. O script mostra o que é novo e o que mudou,
   atualiza só isso, não mexe no que já foi editado no sistema novo, mantém os horários das agendas
   já configurados e cancela agendamentos futuros excluídos no FastClinic.

### 3. Primeiros logins
```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DATABASE_URL=... \
  node scripts/create-admin.mjs "Dr. Everson Rezeck" email@exemplo.com "senha-forte" "Dr. Everson Rezeck"
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DATABASE_URL=... \
  node scripts/create-admin.mjs "Suporte" voce@agencia.com "senha-forte" --super
```
- **Super admin** (`--super`, a agência): tudo, inclusive webhooks e API (Ajustes → Integrações).
- **Administrador** (a clínica): tudo, menos as integrações; não altera o login do super admin.
(Também dá para fazer pelo painel do Supabase: veja `docs/IMPLANTACAO.md`, passo 3.)
Os demais logins (secretárias, profissionais) são criados em **Ajustes → Usuários**.

### 4. Vercel
1. Importe o repositório (o `vercel.json` já define build, região São Paulo e o cron diário às 9h).
2. Cadastre as variáveis de `.env.example` em *Settings → Environment Variables*.
   Use o **Transaction pooler** (porta 6543) no `DATABASE_URL`.

### 5. Integrações
- **Webhook dos lembretes** e **webhook de aniversário** (Ajustes → Integrações, só super admin):
  URLs (n8n, Chatflux…) que recebem um `POST` por envio, uma vez por dia. Formato do JSON abaixo.
- **WhatsApp (Evolution API)**: com `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` definidos, o botão
  **Conectar** na tela WhatsApp (qualquer usuário) cria a instância da clínica, configura o webhook
  e mostra o QR Code; desconectar é só para administrador. Pode ser o mesmo
  servidor Evolution de outro projeto (instância separada). Na tela **WhatsApp** a equipe vê as
  conversas e envia texto, fotos, vídeos, documentos e áudios pelo número da clínica. Os arquivos
  recebidos são copiados para o Storage (pasta `whatsapp/` do bucket `prontuario`).

## Lembretes de retorno
- Só contam atendimentos registrados no sistema novo: o histórico importado do FastClinic não gera
  lembretes (a não ser que a equipe marque o status aqui depois da importação).
- Contam a partir do último atendimento em que o paciente **chegou** com aquele procedimento,
  usando o prazo do procedimento (Ajustes → Procedimentos; padrão 6 meses).
- Repetir o procedimento reinicia só aquele lembrete; os dos outros procedimentos continuam.
- Se o "chegou" for desmarcado ou o procedimento removido, o lembrete se corrige sozinho.
- Paciente com agendamento futuro tem o envio adiado; quem pediu para não receber mensagens ou não
  tem telefone não recebe. Lembretes com mais de 30 dias de atraso não são enviados (ficam como
  "vencidos").
- A fila pode ser ajustada na tela **Lembretes** e no prontuário de cada paciente: mudar data ou
  procedimento, não enviar, criar a partir da lista de procedimentos.

Exemplo de envio (resumido; o JSON completo está em [`docs/WEBHOOKS.md`](docs/WEBHOOKS.md)):
```json
{
  "tipo": "lembrete_retorno",
  "lembrete_id": "…",
  "paciente": { "id": "…", "nome": "Maria Souza", "primeiro_nome": "Maria", "whatsapp": "5531999990000", "…": "…" },
  "procedimento": { "id": "…", "nome": "Botox", "retorno_em_meses": 4 },
  "data_ultima_vez": "2026-06-27",
  "dias_desde_ultima_vez": 122,
  "data_retorno_prevista": "2026-10-27",
  "atendimento_de_origem": { "agenda": { "nome": "Dr. Everson Rezeck" }, "data": "2026-06-27", "inicio": "15:20", "procedimentos": ["Botox"], "…": "…" },
  "agendamentos_futuros": [],
  "historico": { "total_atendimentos": 12, "…": "…" },
  "resumo": "Maria Souza, 40 anos. Paciente desde 2015, …"
}
```
Aniversário: `{ "tipo": "aniversario", "paciente": {…}, "data_nascimento": "1985-11-02", "idade": 41, "agendamentos_futuros": [] }`.
Com `WEBHOOK_SIGNING_SECRET` definido, cada envio traz `x-clinica-assinatura: sha256=<HMAC do corpo>`.
Respostas fora de 2xx são reenviadas mais tarde (até 5 tentativas).

## Desenvolvimento local
Precisa de Node 20+ e Postgres 17 local (a mesma versão do Supabase) (usuário `postgres`/`postgres`).
```bash
npm install
npm run db:reset                      # cria o banco "prontuario" com migrações e seed
psql -U postgres -d prontuario -f dev/seed-users.sql   # logins de teste (senha: senha123)
psql -U postgres -d prontuario -f dev/demo-data.sql    # opcional: pacientes e agenda fictícios
POSTGREST_BIN=/caminho/postgrest node dev/stack.mjs    # imita o Supabase + /api
npm run dev                           # app em http://localhost:5173 (copie as VITE_* que o stack imprime para .env.local)
npm test                              # testes (usam o banco prontuario_test)
```
