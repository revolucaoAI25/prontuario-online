# Passo a passo de implantação

Ordem: **Supabase → dados → primeiro login → Vercel → WhatsApp → webhooks → virada**.
Guarde cada chave num gerenciador de senhas à medida que for criando.

---

## 1. Supabase (banco, login e arquivos)

1. Em [supabase.com](https://supabase.com) → **New project**.
   - Nome: `clinica-rezeck`. Região: **South America (São Paulo)**.
   - Crie uma senha forte para o banco e guarde (é a `SENHA` das conexões abaixo).
   - Plano: pode começar no Free para montar e testar; antes da virada, veja a seção
     **9. Backup** (recomendação: Pro, que tem backup diário automático).
2. **Criar as tabelas.** Abra o arquivo `supabase/setup.sql` no GitHub, clique em **Raw**,
   selecione tudo (Ctrl+A) e copie. No Supabase: **SQL Editor → New query**, cole e clique em
   **Run**. Deve terminar com "Success. No rows returned".
   - É um arquivo só com todas as migrações e os dados iniciais (agendas, procedimentos, atalhos).
   - Se der erro no meio, pode rodar de novo: ele limpa a tentativa anterior antes de começar.
   - Depois que houver pacientes no banco ele se recusa a rodar, para nunca apagar dados reais.
3. **Bloquear cadastro aberto.** **Authentication → Sign In / Providers → Email**: desligue
   **Allow new users to sign up** e salve. (Os logins são criados pelo administrador no sistema.)
4. **Anotar as chaves** (**Project Settings → API Keys** e botão **Connect** no topo):
   - `Project URL` → vai em `VITE_SUPABASE_URL` e `SUPABASE_URL`
   - `anon public` → `VITE_SUPABASE_ANON_KEY`
   - `service_role` (secreta) → `SUPABASE_SERVICE_ROLE_KEY`
   - **Connect → Transaction pooler** (porta **6543**) → `DATABASE_URL` da Vercel
   - **Connect → Direct connection** (porta **5432**) → usada só na importação dos dados

## 2. Importar os dados do FastClinic

Pode ser feito por mim: me envie o backup (como da primeira vez, pelo Drive) e a conexão
**Direct connection** do passo 1.4. O que acontece:

1. O `.bak` é restaurado num SQL Server temporário.
2. Roda `npm run migrate:fastclinic` apontando para o Supabase. Leva ~1 minuto e mostra quantos
   pacientes, prontuários e agendamentos entraram.

O histórico importado aparece na agenda e no prontuário, mas **não gera lembretes nem nenhuma
ação automática** — lembretes só nascem do que for registrado no sistema novo.

## 3. Primeiro login (administrador)

Rodado uma vez (eu faço junto com a importação):
```bash
node scripts/create-admin.mjs "Dr. Everson Rezeck" email-do-everson "senha-inicial" "Dr. Everson Rezeck"
```
Crie também um login de administrador para você (agência), para acessar de fora da clínica:
mesmo comando com seu nome e e-mail, sem o último argumento.
Os demais logins (secretárias, Simone, estética) são criados **dentro do sistema** em
**Ajustes → Usuários**.

## 4. Vercel (o sistema no ar)

1. Em [vercel.com](https://vercel.com) → **Add New → Project** → importe o repositório
   `revolucaoAI25/prontuario-online` (branch principal depois do merge).
   O `vercel.json` já configura tudo (Vite, região São Paulo, cron diário às 9h).
2. Antes de clicar em Deploy, abra **Environment Variables** e cadastre:

   | Variável | Valor |
   |---|---|
   | `VITE_SUPABASE_URL` | Project URL do Supabase |
   | `VITE_SUPABASE_ANON_KEY` | chave `anon public` |
   | `SUPABASE_URL` | Project URL (de novo) |
   | `SUPABASE_SERVICE_ROLE_KEY` | chave `service_role` |
   | `DATABASE_URL` | Transaction pooler (porta 6543), com a senha do banco |
   | `CLINIC_API_KEY` | invente uma chave longa (ex.: gere em um gerador de senhas, 40+ caracteres) |
   | `CRON_SECRET` | outra chave longa |
   | `EVOLUTION_WEBHOOK_SECRET` | outra chave longa |
   | `EVOLUTION_API_URL` | endereço do seu servidor Evolution (ex.: `https://evolution.suaagencia.com`) |
   | `EVOLUTION_API_KEY` | a chave global (`AUTHENTICATION_API_KEY`) do servidor Evolution |
   | `EVOLUTION_INSTANCE` | `clinica-rezeck` (nome da instância nova; não use a de outro projeto) |
   | `WEBHOOK_SIGNING_SECRET` | opcional: assina os envios de lembrete/aniversário |

3. **Deploy**. Ao terminar, abra o endereço gerado e entre com o login do passo 3.
4. (Opcional) **Settings → Domains**: um domínio próprio, ex. `sistema.clinicarezeck.com.br`.
5. Plano: o Hobby (grátis) aguenta tecnicamente, mas os termos da Vercel proíbem uso comercial
   nele; para cliente pagante o correto é o Pro.

## 5. WhatsApp da clínica (Evolution API)

Use o **mesmo servidor Evolution** que você já tem, com uma **instância nova** (cada instância é
um número, com webhook próprio — não interfere no outro projeto).

1. No sistema: **Ajustes → Lembretes e integrações → WhatsApp da clínica → Conectar (mostrar QR
   Code)**. O sistema cria a instância `clinica-rezeck` e já aponta o webhook para ele.
2. No celular da clínica: WhatsApp → **Aparelhos conectados → Conectar um aparelho** → leia o QR.
   O status muda para **Conectado**.
3. Mande uma mensagem de teste para o número da clínica: ela aparece em **WhatsApp** no menu.
4. Pela tela **WhatsApp** a equipe responde, manda fotos, vídeos, documentos e áudios (botão do
   microfone), e vê se a mensagem foi entregue e lida. Arquivos também podem ser colados (Ctrl+V)
   ou arrastados para a conversa. **Nova conversa** começa uma conversa com qualquer paciente.
   O menu mostra quantas mensagens ainda não foram abertas, com aviso sonoro.

Observação: se o número da clínica estiver na API oficial (Cloud API), ele não aceita conexão por
QR Code; nesse caso o espelho precisa ser feito pelo provedor oficial.

## 6. Lembretes, aniversários e API de agendamento

1. **Ajustes → Lembretes e integrações**: preencha
   - **Webhook dos lembretes**: URL do fluxo (n8n/Chatflux) que manda a mensagem de retorno;
   - **Webhook de aniversário**: URL do fluxo de parabéns;
   e salve. O JSON que chega (paciente, procedimento, última vez, data prevista, atendimento de
   origem, histórico, agendamentos) está em `docs/WEBHOOKS.md`. Todo dia às 9h o sistema envia
   os que venceram.
2. **Ajustes → Procedimentos e retornos**: confira os prazos (Botox 4 meses, etc.).
3. **API de agendamento** para a IA: endereço `https://SEU-DOMINIO/api/agenda/...`, cabeçalho
   `x-api-key: <CLINIC_API_KEY>`. Os exemplos de chamada estão em `docs/API.md`.
   Para dar contexto à IA no início de cada conversa, chame `/api/pacientes/contexto` com o
   telefone de quem escreveu.

## 7. Dia da virada

1. Na véspera ou de manhã cedo, exporte o backup final do FastClinic e me envie.
2. Rodo a importação de novo: entram só os pacientes, registros e agendamentos novos ou alterados;
   o que já foi editado no sistema novo é preservado; agendamentos futuros excluídos no FastClinic
   são cancelados.
3. A partir daí, tudo é lançado só no sistema novo.

## 8. Conferência depois de subir

- [ ] Login do Dr. Everson entra e vê **Financeiro** e **Ajustes**; o de uma secretária não vê.
- [ ] Agenda do dia mostra os horários e atendimentos corretos.
- [ ] Prontuário de um paciente antigo mostra o histórico.
- [ ] Marcar um atendimento como **Chegou** com um procedimento cria o lembrete (aba Lembretes).
- [ ] Mensagem em **Equipe** toca o aviso no computador de outra pessoa.
- [ ] WhatsApp conectado e mensagens aparecendo.
- [ ] Uma chamada de teste da IA em `/api/agenda/disponibilidade` responde.

## 9. Backup

Estar na nuvem protege contra o servidor quebrar, mas **não** contra:
- alguém apagar um paciente ou um prontuário por engano;
- uma importação ou um erro de sistema estragar dados;
- perder o acesso à conta (cartão recusado, senha vazada, projeto apagado).

O prontuário precisa ser guardado por 20 anos (Lei 13.787/2018 e normas do CFM), então
**não recomendo ficar sem backup**. As opções:

| Opção | Custo | Quanto pode perder | Como restaura |
|---|---|---|---|
| **Supabase Pro** (recomendado) | US$ 25/mês | até 1 dia | um clique no painel (guarda os últimos 7 dias) |
| Free + cópia semanal própria | grátis | até 7 dias | eu restauro a partir do arquivo |
| Sem backup | grátis | tudo | não tem como |

- No **Pro** é automático: **Database → Backups** mostra as cópias diárias e o botão *Restore*.
- A **cópia própria** é um `pg_dump` (arquivo único com o banco inteiro), criptografado com uma
  senha, guardado fora do Supabase (ex.: no Google Drive da clínica). Pode ser automática toda
  semana. Vale ter também no Pro, uma vez por mês, porque protege contra perder a conta.
- Os arquivos anexados ao prontuário (PDFs, fotos) ficam no *Storage* e **não** entram no backup
  diário do Supabase; a cópia própria pode incluí-los.
